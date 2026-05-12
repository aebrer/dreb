/**
 * Suggest next command tool.
 *
 * Allows the agent to suggest a command the user might want to run next.
 * The suggestion is shown as ghost text in the editor prompt (Tab to accept).
 */

import { Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";

// ============================================================================
// Types

export interface SuggestNextDetails {
	suggestion: string;
}

export type SuggestNextCallback = (suggestion: string) => void;

// ============================================================================
// Schema

const suggestNextSchema = Type.Object({
	command: Type.String({
		description: "The suggested command for the user to run next (e.g. /skill:mach6-push, /compact)",
	}),
});

export type SuggestNextInput = Static<typeof suggestNextSchema>;

// ============================================================================
// Render helpers

function formatSuggestNextCall(args: { command?: string } | undefined, theme: any): string {
	const cmd = args?.command ?? "";
	return `${theme.fg("toolTitle", theme.bold("suggest_next"))} ${theme.fg("accent", cmd)}`;
}

function formatSuggestNextResult(
	result: { content: Array<{ type: string; text?: string }>; details?: SuggestNextDetails },
	theme: any,
): string {
	const details = result.details;
	if (!details) {
		const text = result.content?.[0];
		return text?.type === "text" && text.text ? theme.fg("toolOutput", text.text) : "";
	}
	return theme.fg("toolOutput", `→ ${details.suggestion}`);
}

// ============================================================================
// Tool definition factory

export function createSuggestNextToolDefinition(
	onSuggest: SuggestNextCallback,
): ToolDefinition<typeof suggestNextSchema, SuggestNextDetails | undefined> {
	return {
		name: "suggest_next",
		label: "suggest_next",
		description:
			"Suggest a command for the user to run next. Shows as ghost text in the prompt that the user can Tab-accept.",

		parameters: suggestNextSchema,

		promptSnippet: "Suggest a next command (shown as ghost text the user can Tab-accept)",

		promptGuidelines: [
			"Call suggest_next at the end of your turn when there's a clear next action the user might want",
			"Use full command syntax: /skill:name args, /compact, etc.",
			"Only suggest one command — pick the most likely next step",
			"Don't suggest if the conversation is open-ended with no obvious next action",
		],

		async execute(_toolCallId, { command }: SuggestNextInput, _signal?, _onUpdate?, _ctx?) {
			if (!command || !command.startsWith("/")) {
				return {
					content: [{ type: "text" as const, text: "Error: command must start with /" }],
					details: undefined,
				};
			}

			onSuggest(command);

			return {
				content: [{ type: "text" as const, text: `Suggestion registered: ${command}` }],
				details: { suggestion: command },
			};
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSuggestNextCall(args, theme));
			return text;
		},

		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSuggestNextResult(result as any, theme));
			return text;
		},
	};
}
