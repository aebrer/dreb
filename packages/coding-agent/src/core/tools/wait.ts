/**
 * Wait tool — explicit no-op for models that don't know how to end a turn.
 *
 * Some models (notably Kimi) invent useless `bash` calls to simulate waiting.
 * This tool gives them a sanctioned no-op action that cleanly ends the turn.
 */

import { Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";

// ============================================================================
// Types

/** Minimal shape of a running background agent (avoids importing from subagent.ts to prevent circular deps). */
export interface WaitAgentInfo {
	agentId: string;
	agentType: string;
	taskSummary: string;
}

export interface WaitToolDetails {
	reason: string | undefined;
	runningAgents: readonly WaitAgentInfo[];
}

export interface WaitToolOptions {
	/** Returns currently running background agents. Injected by the factory to avoid circular imports. */
	getRunningAgents?: () => readonly WaitAgentInfo[];
}

// ============================================================================
// Schema

const waitSchema = Type.Object({
	reason: Type.Optional(
		Type.String({
			description: "Optional reason for waiting (e.g. 'background subagent still running')",
		}),
	),
});

export type WaitToolInput = Static<typeof waitSchema>;

// ============================================================================
// Render helpers

export function formatWaitCall(args: { reason?: string } | undefined, theme: any): string {
	const reason = args?.reason;
	if (reason) {
		return `${theme.fg("toolTitle", theme.bold("wait"))} ${theme.fg("muted", reason)}`;
	}
	return theme.fg("toolTitle", theme.bold("wait"));
}

export function formatWaitResult(
	result: { content: Array<{ type: string; text?: string }>; details?: WaitToolDetails },
	theme: any,
): string {
	const agents = result.details?.runningAgents ?? [];
	if (agents.length > 0) {
		const agentList = agents.map((a) => `${a.agentId.slice(0, 12)} ${a.agentType}`).join(", ");
		return theme.fg("muted", `→ doing nothing (waiting on: ${agentList})`);
	}
	return theme.fg("muted", "→ doing nothing — no subagents running");
}

// ============================================================================
// Tool definition (singleton — no cwd or callback dependencies)

export const waitToolDefinition: ToolDefinition<typeof waitSchema, WaitToolDetails | undefined> = {
	name: "wait",
	label: "wait",
	description:
		"Do nothing and end your turn. Use this when you are explicitly told to wait, or when background subagents are running and you have no other work to do.",

	parameters: waitSchema,

	promptSnippet: "Do nothing and end your turn (use when waiting for background work to complete)",

	promptGuidelines: [
		"Use `wait` only when explicitly told to wait, or when background subagents are still running and you have no other work to do",
		"Do NOT use `wait` as a general-purpose delay or sleep — it returns immediately",
		"If you need to wait for something, call `wait` once — do not loop or call it repeatedly",
	],

	async execute(_toolCallId, params: WaitToolInput, _signal?, _onUpdate?, _ctx?) {
		const reason = params.reason?.trim() || undefined;
		const text = reason ? `Waiting: ${reason}` : "Waiting…";

		return {
			content: [{ type: "text" as const, text }],
			details: { reason, runningAgents: [] as WaitAgentInfo[] },
			endTurn: true,
		};
	},

	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0, undefined, true);
		text.setText(formatWaitCall(args, theme));
		return text;
	},

	renderResult(result, _options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0, undefined, true);
		text.setText(formatWaitResult(result as any, theme));
		return text;
	},
};

// ============================================================================
// Factory — accepts optional getRunningAgents callback to show background agent
// status in the result. The callback is injected here (rather than imported from
// subagent.ts) to avoid a circular dependency through model-resolver → args → index.

export function createWaitToolDefinition(
	options?: WaitToolOptions,
): ToolDefinition<typeof waitSchema, WaitToolDetails | undefined> {
	if (!options?.getRunningAgents) return waitToolDefinition;

	return {
		...waitToolDefinition,
		async execute(_toolCallId, params: WaitToolInput, _signal?, _onUpdate?, _ctx?) {
			const reason = params.reason?.trim() || undefined;
			const runningAgents = options.getRunningAgents!();
			const text = reason ? `Waiting: ${reason}` : "Waiting…";

			return {
				content: [{ type: "text" as const, text }],
				details: { reason, runningAgents },
				endTurn: true,
			};
		},
	};
}
