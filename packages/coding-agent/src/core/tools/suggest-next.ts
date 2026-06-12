/**
 * Suggest next command tool.
 *
 * Allows the agent to suggest a command the user might want to run next.
 * The suggestion is shown as ghost text in the editor prompt (Tab to accept).
 */

import { Container, Markdown, Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import { getMarkdownTheme } from "../../modes/interactive/theme/theme.js";
import type { ToolDefinition } from "../extensions/types.js";

// ============================================================================
// Types

export interface SuggestNextDetails {
	suggestion: string;
	summary?: string;
}

export type SuggestNextCallback = (suggestion: string) => void;

// ============================================================================
// Schema

const suggestNextSchema = Type.Object({
	command: Type.String({
		description: "The suggested command for the user to run next (e.g. /skill:mach6-push, /compact, npm run build)",
	}),
	summary: Type.Optional(
		Type.String({
			description:
				"Brief markdown summary of the work done this turn. Displayed to the user as the final message before the suggestion.",
		}),
	),
});

export type SuggestNextInput = Static<typeof suggestNextSchema>;

// ============================================================================
// Render helpers

function formatSuggestNextCall(args: { command?: string } | undefined, theme: any): string {
	const cmd = args?.command ?? "";
	return `${theme.fg("toolTitle", theme.bold("suggest_next"))} ${theme.fg("accent", cmd)}`;
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
			"Suggest a command the user can run: /skill:name args, /compact, npm run build, etc.",
			"Only suggest one command — pick the most likely next step",
			"Don't suggest if the conversation is open-ended with no obvious next action",
			"Include a brief summary of work done in the `summary` parameter — this is your last chance to communicate before the turn ends",
			"Calling this tool ends your turn automatically — do not call wait afterwards",
		],

		async execute(_toolCallId, { command: rawCommand, summary }: SuggestNextInput, _signal?, _onUpdate?, _ctx?) {
			// Strip control characters (newlines, tabs, etc.) that would corrupt TUI rendering
			const command = rawCommand?.replace(/[\x00-\x1f\x7f]/g, "").trim();
			if (!command) {
				return {
					content: [{ type: "text" as const, text: "Error: command is empty" }],
					details: undefined,
					endTurn: true,
				};
			}

			onSuggest(command);

			// Convert literal \n sequences to actual newlines (LLMs emit these in XML tool calls),
			// then strip control characters (preserve only newlines for markdown)
			const sanitizedSummary =
				summary
					?.replace(/\\n/g, "\n")
					.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "")
					.trim() || undefined;

			return {
				content: [{ type: "text" as const, text: `Suggestion registered: ${command}` }],
				details: { suggestion: command, summary: sanitizedSummary },
				endTurn: true,
			};
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSuggestNextCall(args, theme));
			return text;
		},

		renderResult(result, _options, theme, context) {
			const details = (result as any).details as SuggestNextDetails | undefined;
			if (!details) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				const content = result.content?.[0];
				const msg = content?.type === "text" && content.text ? content.text : "";
				text.setText(theme.fg("toolOutput", msg));
				return text;
			}

			if (details.summary) {
				const container = (context.lastComponent as Container | undefined) ?? new Container();
				container.clear();
				container.addChild(new Markdown(details.summary, 0, 0, getMarkdownTheme()));
				container.addChild(new Text(theme.fg("toolOutput", `→ ${details.suggestion}`), 0, 0));
				return container;
			}

			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolOutput", `→ ${details.suggestion}`));
			return text;
		},
	};
}
