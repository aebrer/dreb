/**
 * ask_user tool.
 *
 * Lets the agent pause and ask the user one or more structured clarifying
 * questions in a single call — each with optional multiple-choice options,
 * single- or multi-select, and a "type your own answer" free-text field —
 * rendered natively as a wizard in the TUI, the Dashboard, and over RPC. The
 * whole batch is answered together and returned as one result. Answering,
 * stopping the turn, aborting, or timing out always settles cleanly so the
 * agent never deadlocks on an absent user. Unanswered questions come back
 * flagged as skipped rather than blocking the turn.
 */

import { Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import type { AskQuestion, AskRequest, AskResult, ExtensionContext, ToolDefinition } from "../extensions/types.js";

// ============================================================================
// Types

/** One question's outcome, surfaced in the tool result details. */
export interface AskUserAnswerDetail {
	question: string;
	title?: string;
	selected: string[];
	customText?: string;
	/** True when this question closed without an answer. */
	skipped: boolean;
}

export interface AskUserDetails {
	/** One entry per question asked, in order. */
	answers: AskUserAnswerDetail[];
	/** True when no interactive UI was available (headless/print mode). */
	unavailable: boolean;
	/** True when the UI host or response protocol failed. */
	failed?: boolean;
}

// ============================================================================
// Schema

const questionSchema = Type.Object({
	question: Type.String({
		description: "The Markdown-formatted question to ask the user. Be specific about what you need to decide.",
	}),
	title: Type.Optional(
		Type.String({
			description: "Short bold header shown above this question.",
		}),
	),
	options: Type.Optional(
		Type.Array(Type.String({ minLength: 1, pattern: "^.*[^ \\t\\r\\n].*$" }), {
			minItems: 2,
			maxItems: 4,
			description: "2-4 nonblank suggested answers the user can pick from.",
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
});

const askUserSchema = Type.Object({
	questions: Type.Array(questionSchema, {
		minItems: 1,
		maxItems: 10,
		description:
			"One or more clarifying questions to ask together in a single wizard. " +
			"Batch every question you need answered in one call — the user answers them all and submits once.",
	}),
	timeoutSeconds: Type.Optional(
		Type.Number({
			minimum: 5,
			maximum: 3600,
			description:
				"Optional: stop the current agent turn after this many seconds if the user does not respond. " +
				"Shows a live countdown. Omit to wait indefinitely.",
		}),
	),
});

export type AskUserInput = Static<typeof askUserSchema>;
type AskUserQuestion = Static<typeof questionSchema>;

// ============================================================================
// Normalization

/**
 * Normalize a single question so every rendered surface has at least one usable
 * answer control and no impossible flag combinations survive.
 */
function normalizeQuestion(q: AskUserQuestion): AskQuestion {
	const hasOptions = (q.options?.length ?? 0) > 0;
	return {
		question: q.question,
		title: q.title,
		options: q.options,
		// Guarantee at least one answer control: with no options, free text must
		// be offered regardless of the requested flag, otherwise a question would
		// render only a Skip control and no way to answer.
		allowFreeText: hasOptions ? q.allowFreeText : true,
		// multiSelect is only meaningful with options; multiline only with free
		// text — normalize away impossible combinations.
		multiSelect: hasOptions ? q.multiSelect : undefined,
		multiline: hasOptions ? (q.allowFreeText === false ? undefined : q.multiline) : q.multiline,
	};
}

// ============================================================================
// Result helpers

function textResult(text: string, details: AskUserDetails) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function skippedAnswer(q: AskQuestion): AskUserAnswerDetail {
	return { question: q.question, title: q.title, selected: [], skipped: true };
}

function unavailableResult(questions: AskQuestion[]) {
	return textResult(
		"The ask_user tool requires an interactive UI, which is not available in this mode. " +
			"Proceed using your best judgment without waiting for an answer.",
		{ answers: questions.map(skippedAnswer), unavailable: true },
	);
}

function unansweredResult(questions: AskQuestion[]) {
	return textResult("The questions closed without an answer.", {
		answers: questions.map(skippedAnswer),
		unavailable: false,
	});
}

function failedResult(questions: AskQuestion[]) {
	return textResult(
		"The questions could not be delivered because the interactive UI or response protocol failed. " +
			"Continue without this input.",
		{ answers: questions.map(skippedAnswer), unavailable: false, failed: true },
	);
}

/** Build a per-question detail entry from the user's answer. */
function toAnswerDetail(q: AskQuestion, answer: AskResult["answers"][number] | undefined): AskUserAnswerDetail {
	if (!answer || answer.skipped) return skippedAnswer(q);
	const customText = answer.customText?.trim() || undefined;
	const selected = answer.selected ?? [];
	if (selected.length === 0 && !customText) return skippedAnswer(q);
	return { question: q.question, title: q.title, selected, customText, skipped: false };
}

/** Compose the model-facing summary, one block per question. */
function summarizeAnswers(details: AskUserAnswerDetail[]): string {
	const blocks = details.map((d) => {
		const heading = (d.title || d.question || "").replace(/\s+/g, " ").trim();
		if (d.skipped) return `**${heading}** → (no answer)`;
		const parts: string[] = [];
		if (d.selected.length > 0) parts.push(`Selected: ${d.selected.join(", ")}`);
		if (d.customText) parts.push(`wrote: "${d.customText}"`);
		return `**${heading}** → ${parts.join(" / ")}`;
	});
	return blocks.join("\n");
}

function answeredResult(questions: AskQuestion[], result: AskResult) {
	const details = questions.map((q, i) => toAnswerDetail(q, result.answers[i]));
	return textResult(summarizeAnswers(details), { answers: details, unavailable: false });
}

// ============================================================================
// Render helpers

function callLabel(args: { questions?: Array<{ title?: string; question?: string }> } | undefined): string {
	const questions = args?.questions ?? [];
	const count = questions.length;
	if (count === 1) {
		const first = questions[0];
		const label = (first?.title || first?.question || "").replace(/\s+/g, " ").trim();
		return label.length > 80 ? `${label.slice(0, 79)}…` : label;
	}
	return `${count} questions`;
}

function formatCall(
	args: { questions?: Array<{ title?: string; question?: string }> } | undefined,
	theme: any,
): string {
	return `${theme.fg("toolTitle", theme.bold("ask_user"))} ${theme.fg("accent", callLabel(args))}`;
}

function formatResult(details: AskUserDetails, theme: any): string {
	if (details.unavailable) return theme.fg("toolOutput", "no interactive UI — continued without asking");
	if (details.failed) return theme.fg("toolOutput", "interactive UI failed — continued without an answer");
	const answered = details.answers.filter((a) => !a.skipped);
	if (answered.length === 0) return theme.fg("toolOutput", "closed without an answer");
	if (details.answers.length === 1) {
		const parts: string[] = [];
		if (answered[0].selected.length > 0) parts.push(answered[0].selected.join(", "));
		if (answered[0].customText) parts.push(`"${answered[0].customText}"`);
		return theme.fg("toolOutput", `→ ${parts.join(" + ")}`);
	}
	return theme.fg("toolOutput", `→ answered ${answered.length} of ${details.answers.length}`);
}

// ============================================================================
// Tool definition factory

/**
 * Create an `ask_user` tool definition.
 *
 * One call carries one or more questions, collected together in a single
 * wizard and returned as a batch of answers. Every path — answer, skip, abort,
 * timeout, or host failure — settles gracefully and never orphans a promise.
 */
export function createAskUserToolDefinition(): ToolDefinition<typeof askUserSchema, AskUserDetails | undefined> {
	return {
		name: "ask_user",
		label: "ask_user",
		description:
			"Pause and ask the user one or more structured clarifying questions in a single call, each with " +
			"optional multiple-choice options and a free-text answer. The questions are shown together as one " +
			"wizard and answered as a batch. Use only when genuinely blocked by ambiguity with multiple viable " +
			"paths — not for routine confirmation.",

		parameters: askUserSchema,

		promptSnippet:
			"Ask the user one or more clarifying questions with optional multiple-choice options and free text",

		promptGuidelines: [
			"Call ask_user ONLY when you are genuinely blocked by ambiguity and there are multiple viable paths forward",
			"Do NOT use it for routine confirmation, permission, or things you can reasonably decide yourself",
			"Batch everything you need in ONE call: put each distinct decision in the `questions` array — the user answers them all and submits once",
			"Provide 2-4 concrete `options` per question when there are clear candidate answers; the user can always type their own",
			"Set `multiSelect: true` when several options can be combined; `multiline: true` for open-ended answers",
			"The user may stop the current turn instead of answering; never treat that as an answer, and unanswered questions come back as skipped",
		],

		async execute(_toolCallId, input: AskUserInput, signal, _onUpdate, ctx?: ExtensionContext) {
			const questions = input.questions.map(normalizeQuestion);
			const request: AskRequest = { questions };

			// Optional auto-stop timeout, forwarded to every UI surface (TUI
			// countdown, RPC/Dashboard). Model-facing units are seconds.
			const timeout = input.timeoutSeconds && input.timeoutSeconds > 0 ? input.timeoutSeconds * 1000 : undefined;

			// Headless / print / no-host modes: never block on an unreachable UI.
			if (!ctx?.hasUI) {
				return unavailableResult(questions);
			}

			// A call whose signal already aborted settles without ever opening the
			// UI; the parent turn is already stopping.
			if (signal?.aborted) return unansweredResult(questions);

			try {
				const answer = await ctx.ui.ask(request, { signal, timeout });
				if (!answer) return unansweredResult(questions);
				return answeredResult(questions, answer);
			} catch {
				// Host/protocol failure must still settle and never deadlock, but it
				// must not masquerade as an intentional user skip.
				return failedResult(questions);
			}
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
