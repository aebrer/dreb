/**
 * Event display — translates RPC agent events into Telegram messages.
 *
 * Manages an ephemeral status message that shows tool use, task lists,
 * and subagent activity. Text from the agent is sent as permanent messages.
 */

import { existsSync } from "node:fs";
import type { Api } from "grammy";
import { InputFile } from "grammy";
import type { TrackedAgent } from "../types.js";
import { extractSendFiles } from "../util/files.js";
import { DebouncedEditor, log, safeDelete } from "../util/telegram.js";

/** Callback to queue a message for delivery — never blocks the event chain */
export type SendFn = (text: string, long?: boolean) => void;

/**
 * RPC events include both core AgentEvent and session-specific events
 * (tasks_update, background_agent_*, auto_compaction_*).
 * We type loosely here since the RPC client types onEvent as AgentEvent
 * but actually forwards all AgentSessionEvent types.
 */
type RpcEvent = { type: string; [key: string]: any };

// Tool emoji mapping (tool names are lowercase in definitions)
const TOOL_EMOJI: Record<string, string> = {
	bash: "🔧",
	read: "📖",
	edit: "✏️",
	write: "📝",
	grep: "🔎",
	find: "🔍",
	ls: "📂",
	web_search: "🌐",
	web_fetch: "🌐",
	subagent: "🤖",
	tasks_update: "📋",
	skill: "⚡",
};

function toolEmoji(name: string): string {
	return TOOL_EMOJI[name] || "🔧";
}

/** Format a tool call for display */
function formatTool(name: string, args: Record<string, any>): string {
	const emoji = toolEmoji(name);
	switch (name) {
		case "bash": {
			const cmd = args.command || "";
			return `${emoji} *bash*\n\`${cmd.slice(0, 500)}\``;
		}
		case "read":
			return `${emoji} *read*: \`${args.path || "?"}\``;
		case "edit":
			return `${emoji} *edit*: \`${args.path || "?"}\``;
		case "write":
			return `${emoji} *write*: \`${args.path || "?"}\``;
		case "grep":
			return `${emoji} *grep*: \`${args.pattern || "?"}\``;
		case "find":
			return `${emoji} *find*: \`${args.pattern || "?"}\``;
		case "ls":
			return `${emoji} *ls*: \`${args.path || "."}\``;
		case "web_search":
			return `${emoji} *web\\_search*: ${args.query || "?"}`;
		case "web_fetch":
			return `${emoji} *web\\_fetch*: ${(args.url || "?").slice(0, 80)}`;
		case "subagent":
			return `${emoji} *subagent* (${args.agent || "?"}): ${(args.task || args.tasks?.[0]?.task || "?").slice(0, 200)}`;
		case "skill":
			return `${emoji} *skill*: ${args.skill || "?"}`;
		default:
			return `${emoji} *${name}*`;
	}
}

/** Format task list as checklist */
function formatTaskList(tasks: Array<{ id: string; title: string; status: string }>): string {
	if (!tasks.length) return "📋 *Tasks*: (empty)";
	const lines = ["📋 *Tasks*:"];
	for (const task of tasks) {
		if (task.status === "completed") lines.push(`  ✅ ${task.title}`);
		else if (task.status === "in_progress") lines.push(`  🔄 ${task.title}`);
		else lines.push(`  ⬜ ${task.title}`);
	}
	return lines.join("\n");
}

export interface EventDisplayState {
	/** Chat ID to send messages to */
	chatId: number;
	/** Message ID to reply to */
	replyToId: number;
	/** Ephemeral status message ID (edited in-place) */
	statusMessageId: number | null;
	/** Tool messages accumulated since last text */
	toolsSinceText: string[];
	/** Total tool count */
	toolCount: number;
	/** All text blocks received */
	textBlocks: string[];
	/** Current task list */
	tasks: Array<{ id: string; title: string; status: string }>;
	/** Background agents */
	backgroundAgents: Map<string, TrackedAgent>;
	/** Whether agent has finished */
	done: boolean;
	/** Debounced editor instance */
	editor: DebouncedEditor;
	/** Whether auto-retry is in progress (Layer 1: reactive) */
	retryInProgress: boolean;
	/** Current retry attempt number for display */
	retryAttempt: number;
}

/**
 * Check if an error message looks retryable (overloaded, rate limit, server errors).
 * Mirrors the core's _isRetryableError check as a defensive Layer 2.
 */
const RETRYABLE_ERROR_PATTERN =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay/i;

function isRetryableError(errorMessage: string): boolean {
	return RETRYABLE_ERROR_PATTERN.test(errorMessage);
}

/**
 * Create a fresh event display state for a new agent run.
 */
export function createEventDisplay(
	api: Api,
	chatId: number,
	replyToId: number,
	statusMessageId: number | null,
): EventDisplayState {
	return {
		chatId,
		replyToId,
		statusMessageId,
		toolsSinceText: [],
		toolCount: 0,
		textBlocks: [],
		tasks: [],
		backgroundAgents: new Map(),
		done: false,
		editor: new DebouncedEditor(api),
		retryInProgress: false,
		retryAttempt: 0,
	};
}

/**
 * Process an agent event and update the display.
 */
export async function handleAgentEvent(
	send: SendFn,
	api: Api,
	state: EventDisplayState,
	event: RpcEvent,
): Promise<void> {
	switch (event.type) {
		case "tool_execution_start": {
			const name = event.toolName || "?";
			const args = event.args || {};
			state.toolCount++;

			// tasks_update is shown via the separate tasks_update event — skip from tool summary
			if (name !== "tasks_update") {
				const toolMsg = formatTool(name, args);
				state.toolsSinceText.push(toolMsg);
			}

			// Update status with tool count and recent tools
			updateStatus(state);
			break;
		}

		case "message_end": {
			const msg = event.message;

			// Show subagent results — the parent agent references these but the
			// Telegram user can't see them otherwise. Send the full content.
			if (msg?.role === "toolResult" && msg?.toolName === "subagent") {
				const content = msg?.content;
				if (content && Array.isArray(content)) {
					for (const block of content) {
						if (block.type === "text" && block.text?.trim()) {
							send(`🤖 *Subagent result:*\n${block.text.trim()}`, true);
						}
					}
				}
				break;
			}

			// Show background agent completion results — these arrive as user
			// messages injected by agent-session.ts via prompt()/steer() and
			// contain the actual subagent output the model sees.
			if (msg?.role === "user") {
				const content = msg?.content;
				if (content && Array.isArray(content)) {
					for (const block of content) {
						if (block.type === "text" && block.text?.includes("<background-agent-complete>")) {
							// Extract the content between the XML tags
							const match = block.text.match(
								/<background-agent-complete>\n?([\s\S]*?)\n?<\/background-agent-complete>/,
							);
							if (match?.[1]?.trim()) {
								send(`🤖 *Background agent complete:*\n${match[1].trim()}`, true);
							}
						}
					}
				}
				break;
			}

			// Only display assistant messages — user messages are echoed back by RPC
			if (msg?.role !== "assistant") break;
			const content = msg?.content;
			if (!content || !Array.isArray(content)) break;

			for (const block of content) {
				// Display thinking blocks (collapsed summary)
				if (block.type === "thinking" && block.thinking?.trim() && !block.redacted) {
					const thinking = block.thinking.trim();
					send(`💭 _${thinking}_`, true);
				}

				if (block.type === "text" && block.text?.trim()) {
					const text = block.text.trim();

					// Flush accumulated tools as permanent summary
					if (state.toolsSinceText.length > 0) {
						const summary = `📋 *${state.toolsSinceText.length} tools*:\n${state.toolsSinceText.join("\n")}`;
						send(summary, true);
						state.toolsSinceText = [];
					}

					// Send the text as a permanent message
					state.textBlocks.push(text);

					// Check for file send markers
					const [cleanText, filePaths] = extractSendFiles(text);
					if (cleanText) {
						send(cleanText, true);
					}

					// Send any requested files (silently skip non-existent paths —
					// the pattern may appear in explanatory text)
					for (const filePath of filePaths) {
						try {
							if (existsSync(filePath)) {
								await api.sendDocument(state.chatId, new InputFile(filePath));
							}
						} catch (e) {
							log(`[EVENTS] Failed to send file ${filePath}: ${e}`);
						}
					}
				}
			}
			break;
		}

		case "tasks_update": {
			state.tasks = (event as any).tasks || [];
			updateStatus(state);
			break;
		}

		case "background_agent_start": {
			const { agentId, agentType, taskSummary } = event as any;
			state.backgroundAgents.set(agentId, {
				agentId,
				agentType,
				taskSummary,
				startTime: Date.now(),
			});
			updateStatus(state);
			break;
		}

		case "background_agent_end": {
			const { agentId } = event as any;
			state.backgroundAgents.delete(agentId);
			// Background agents completing does not end the parent's turn.
			// Only agent_end sets done — same as TUI behavior.
			updateStatus(state);
			break;
		}

		case "auto_compaction_start": {
			updateStatusText(state, "🗜 _Compacting context..._");
			break;
		}

		case "auto_compaction_end": {
			const result = (event as any).result;
			if (result) {
				const before = result.tokensBefore || 0;
				const msg = `🗜 Context compacted (was ${Math.round(before / 1000)}k tokens)`;
				send(msg);
			}
			break;
		}

		// =====================================================================
		// Auto-retry — prevents agent_end from marking done during retries
		// =====================================================================

		case "auto_retry_start": {
			const { attempt, maxAttempts, delayMs, errorMessage } = event as any;
			state.retryInProgress = true;
			state.retryAttempt = attempt;
			const delaySec = Math.round(delayMs / 1000);
			const shortErr = errorMessage?.length > 80 ? `${errorMessage.slice(0, 80)}…` : errorMessage;
			updateStatusText(state, `🔄 _Retrying (${attempt}/${maxAttempts}) in ${delaySec}s — ${shortErr || "error"}_`);
			break;
		}

		case "auto_retry_end": {
			const { success, attempt, finalError } = event as any;
			state.retryInProgress = false;
			state.retryAttempt = 0;
			if (!success && finalError) {
				// Max retries exhausted — show final error
				send(`❌ _Retry failed (${attempt} attempts):_ ${finalError}`, true);
			}
			// On success, the retry's agent_start/agent_end cycle will handle display normally
			break;
		}

		case "agent_end": {
			// Flush any remaining tools
			if (state.toolsSinceText.length > 0) {
				const summary = `📋 *${state.toolsSinceText.length} tools*:\n${state.toolsSinceText.join("\n")}`;
				send(summary, true);
				state.toolsSinceText = [];
			}

			// Check for error in agent_end messages
			const errorMsg = (event.messages as any[])?.find(
				(m: any) => m.stopReason === "error" || m.stopReason === "aborted",
			);

			// Layer 2 (defensive): If this error looks retryable and we're not already
			// tracking a retry via Layer 1, don't mark done — the core will auto-retry
			// and emit a new agent_start/agent_end cycle.
			const errorIsRetryable = errorMsg?.errorMessage && isRetryableError(errorMsg.errorMessage);

			if (errorMsg?.errorMessage) {
				// Suppress the scary error message during retry — user already saw the
				// auto_retry_start status. Only show the error if retry tracking missed it
				// (defensive: shouldn't happen, but better than silence).
				if (!state.retryInProgress && !errorIsRetryable) {
					const provider = errorMsg.provider ? `${errorMsg.provider}/${errorMsg.model}` : "";
					const prefix = provider ? `${provider}: ` : "";
					const errLower = errorMsg.errorMessage.toLowerCase();
					const hint =
						errLower.includes("connection") || errLower.includes("timeout") || errLower.includes("network")
							? "\n_Provider may be down — try /model to switch._"
							: "";
					send(`❌ ${prefix}${errorMsg.errorMessage}${hint}`, true);
				}
			} else if (state.textBlocks.length === 0 && state.backgroundAgents.size === 0) {
				// Only show "(No response)" when truly done — not between agent cycles
				if (!state.retryInProgress && !errorIsRetryable) {
					send("(No response)");
				}
			}

			// Don't mark done if auto-retry is in progress (Layer 1) or the error
			// looks retryable (Layer 2 — defensive catch in case events were missed).
			// The core will emit a new agent_start/agent_end cycle for the retry.
			if (state.retryInProgress || errorIsRetryable) {
				// Reset per-cycle state for the next agent loop
				state.textBlocks = [];
				state.toolCount = 0;
				break;
			}

			// If background agents are still running, keep the subscription alive
			// and reset per-cycle state for the next agent loop
			if (state.backgroundAgents.size > 0) {
				state.textBlocks = [];
				state.toolCount = 0;
				break;
			}

			// Delete ephemeral status before signaling done
			if (state.statusMessageId) {
				await state.editor.flush(state.chatId, state.statusMessageId);
				await safeDelete(api, state.chatId, state.statusMessageId);
				state.statusMessageId = null;
			}

			// Clean up editor
			state.editor.clear();

			// Signal done AFTER cleanup — waitForCompletion checks this flag,
			// so setting it last ensures status message is deleted before DONE is sent
			state.done = true;
			break;
		}

		// Handle error responses that leak through RPC (async prompt errors)
		case "response": {
			const resp = event as any;
			if (!resp.success && resp.error) {
				send(`❌ ${resp.error}`, true);
			}
			break;
		}
	}
}

/**
 * Build and push a status update to the ephemeral message.
 */
function updateStatus(state: EventDisplayState): void {
	if (!state.statusMessageId) return;

	const parts: string[] = [];

	// Tool count header
	if (state.toolCount > 0) {
		parts.push(`🔧 *Tool ${state.toolCount}*`);
	}

	// Task list
	if (state.tasks.length > 0) {
		parts.push(formatTaskList(state.tasks));
	}

	// Background agents
	if (state.backgroundAgents.size > 0) {
		for (const agent of state.backgroundAgents.values()) {
			parts.push(`🤖 *${agent.agentType}*: ${agent.taskSummary.slice(0, 200)}`);
		}
	}

	// Recent tools (last 5)
	if (state.toolsSinceText.length > 0) {
		const recent = state.toolsSinceText.slice(-5);
		parts.push(recent.join("\n\n"));
	}

	if (parts.length === 0) return;

	const text = parts.join("\n\n").slice(0, 4000);
	state.editor.edit(state.chatId, state.statusMessageId, text);
}

function updateStatusText(state: EventDisplayState, text: string): void {
	if (!state.statusMessageId) return;
	state.editor.edit(state.chatId, state.statusMessageId, text);
}
