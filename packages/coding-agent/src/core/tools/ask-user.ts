/**
 * ask_user tool.
 *
 * Lets the agent pause and ask the user a structured clarifying question —
 * with optional multiple-choice options, single- or multi-select, and a
 * "type your own answer" free-text field — rendered natively in the TUI, the
 * Dashboard, and over RPC. Cancelling, skipping, aborting, or timing out
 * always resolves gracefully so the agent never deadlocks on an absent user.
 *
 * Concurrent calls are serialized through a per-session FIFO queue: only one
 * question is ever shown at a time, and a queued call whose signal aborts
 * resolves as skipped without opening any UI.
 */

import { Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import type { AskRequest, AskResult, ExtensionContext, ToolDefinition } from "../extensions/types.js";

// ============================================================================
// Types

export interface AskUserDetails {
	question: string;
	title?: string;
	selected: string[];
	customText?: string;
	/** True when the user skipped/cancelled/timed out. */
	skipped: boolean;
	/** True when no interactive UI was available (headless/print mode). */
	unavailable: boolean;
}

// ============================================================================
// Schema

const askUserSchema = Type.Object({
	question: Type.String({
		description: "The question to ask the user. Be specific about what you need to decide.",
	}),
	title: Type.Optional(
		Type.String({
			description: "Short bold header shown above the question.",
		}),
	),
	options: Type.Optional(
		Type.Array(Type.String(), {
			minItems: 2,
			maxItems: 4,
			description: "2-4 suggested answers the user can pick from.",
		}),
	),
	allowFreeText: Type.Optional(
		Type.Boolean({
			description: "Offer a 'type your own answer' field. Defaults to true.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Allow selecting multiple options (checkboxes). Only meaningful with options.",
		}),
	),
	multiline: Type.Optional(
		Type.Boolean({
			description: "Use a large multi-line text area for open-ended answers.",
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			minimum: 5,
			maximum: 3600,
			description:
				"Optional: auto-skip the question after this many seconds if the user does not respond. " +
				"Shows a live countdown. Omit to wait indefinitely.",
		}),
	),
});

export type AskUserInput = Static<typeof askUserSchema>;

// ============================================================================
// Result helpers

function textResult(text: string, details: AskUserDetails) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function baseDetails(input: AskUserInput): Omit<AskUserDetails, "selected" | "skipped" | "unavailable"> {
	return { question: input.question, title: input.title };
}

function unavailableResult(input: AskUserInput) {
	return textResult(
		"The ask_user tool requires an interactive UI, which is not available in this mode. " +
			"Proceed using your best judgment without waiting for an answer.",
		{ ...baseDetails(input), selected: [], skipped: true, unavailable: true },
	);
}

function skippedResult(input: AskUserInput) {
	return textResult("The user skipped the question without answering. Continue without this input.", {
		...baseDetails(input),
		selected: [],
		skipped: true,
		unavailable: false,
	});
}

function answeredResult(input: AskUserInput, answer: AskResult) {
	const customText = answer.customText?.trim() || undefined;
	const selected = answer.selected;
	const parts: string[] = [];
	if (selected.length > 0) {
		parts.push(
			selected.length === 1 ? `The user selected: ${selected[0]}` : `The user selected: ${selected.join(", ")}`,
		);
	}
	if (customText) {
		parts.push(selected.length > 0 ? `They also wrote: "${customText}"` : `The user answered: "${customText}"`);
	}
	return textResult(parts.join(" "), {
		...baseDetails(input),
		selected,
		customText,
		skipped: false,
		unavailable: false,
	});
}

// ============================================================================
// Render helpers

function formatCall(args: { question?: string; title?: string } | undefined, theme: any): string {
	const label = (args?.title || args?.question || "").replace(/\s+/g, " ").trim();
	const shown = label.length > 80 ? `${label.slice(0, 79)}…` : label;
	return `${theme.fg("toolTitle", theme.bold("ask_user"))} ${theme.fg("accent", shown)}`;
}

function formatResult(details: AskUserDetails, theme: any): string {
	if (details.unavailable) return theme.fg("toolOutput", "no interactive UI — continued without asking");
	if (details.skipped) return theme.fg("toolOutput", "user skipped");
	const parts: string[] = [];
	if (details.selected.length > 0) parts.push(details.selected.join(", "));
	if (details.customText) parts.push(`"${details.customText}"`);
	return theme.fg("toolOutput", `→ ${parts.join(" + ")}`);
}

// ============================================================================
// Tool definition factory

/**
 * Create an `ask_user` tool definition. Each call creates an isolated FIFO
 * queue, so concurrent `ask_user` calls in a single session are shown strictly
 * one at a time.
 */
export function createAskUserToolDefinition(): ToolDefinition<typeof askUserSchema, AskUserDetails | undefined> {
	// Per-session serialization: only one question is ever open at a time.
	let tail: Promise<void> = Promise.resolve();
	const serialize = <T>(run: () => Promise<T>): Promise<T> => {
		const result = tail.then(run, run);
		// Always advance the queue, whether the call resolved, cancelled, timed
		// out, or threw — so a failure can never wedge later questions.
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	return {
		name: "ask_user",
		label: "ask_user",
		description:
			"Pause and ask the user a structured clarifying question with optional multiple-choice options and a " +
			"free-text answer. Use only when genuinely blocked by ambiguity with multiple viable paths — not for routine confirmation.",

		parameters: askUserSchema,

		promptSnippet: "Ask the user a clarifying question with optional multiple-choice options and free text",

		promptGuidelines: [
			"Call ask_user ONLY when you are genuinely blocked by ambiguity and there are multiple viable paths forward",
			"Do NOT use it for routine confirmation, permission, or things you can reasonably decide yourself",
			"Provide 2-4 concrete `options` when there are clear candidate answers; the user can always type their own",
			"Set `multiSelect: true` when several options can be combined; `multiline: true` for open-ended answers",
			"The user may skip — always handle a skipped answer gracefully and continue with a sensible default",
			"Prefer one focused question over many; the question blocks the turn until the user responds or skips",
		],

		async execute(_toolCallId, input: AskUserInput, signal, _onUpdate, ctx?: ExtensionContext) {
			const hasOptions = (input.options?.length ?? 0) > 0;
			const request: AskRequest = {
				question: input.question,
				title: input.title,
				options: input.options,
				// Guarantee at least one answer control: with no options, free text
				// must be offered regardless of the requested flag, otherwise both
				// surfaces would render only a Skip button and no way to answer.
				allowFreeText: hasOptions ? input.allowFreeText : true,
				// multiSelect is only meaningful with options; multiline only with
				// free text — normalize away impossible combinations.
				multiSelect: hasOptions ? input.multiSelect : undefined,
				multiline: hasOptions ? (input.allowFreeText === false ? undefined : input.multiline) : input.multiline,
			};

			// Optional auto-skip timeout, forwarded to every UI surface (TUI
			// countdown, RPC/Dashboard). Model-facing units are seconds.
			const timeout = input.timeoutSeconds && input.timeoutSeconds > 0 ? input.timeoutSeconds * 1000 : undefined;

			// Headless / print / no-host modes: never block on an unreachable UI.
			if (!ctx?.hasUI) {
				return unavailableResult(input);
			}

			return serialize(async () => {
				// A queued call whose signal already aborted resolves as skipped
				// without ever opening the UI.
				if (signal?.aborted) return skippedResult(input);
				try {
					const answer = await ctx.ui.ask(request, { signal, timeout });
					if (!answer || (answer.selected.length === 0 && !answer.customText?.trim())) {
						return skippedResult(input);
					}
					return answeredResult(input, answer);
				} catch {
					// Host failure must still release the queue and never deadlock.
					return skippedResult(input);
				}
			});
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0, undefined, true);
			text.setText(formatCall(args, theme));
			return text;
		},

		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0, undefined, true);
			const details = (result as any).details as AskUserDetails | undefined;
			if (details) {
				text.setText(formatResult(details, theme));
			} else {
				const content = result.content?.[0];
				text.setText(theme.fg("toolOutput", content?.type === "text" ? content.text : ""));
			}
			return text;
		},
	};
}
