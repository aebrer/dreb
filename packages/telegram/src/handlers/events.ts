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
import { DebouncedEditor, log, safeDelete, safeSend, sendLong } from "../util/telegram.js";

/**
 * RPC events include both core AgentEvent and session-specific events
 * (tasks_update, background_agent_*, auto_compaction_*).
 * We type loosely here since the RPC client types onEvent as AgentEvent
 * but actually forwards all AgentSessionEvent types.
 */
type RpcEvent = { type: string; [key: string]: any };

// Tool emoji mapping
const TOOL_EMOJI: Record<string, string> = {
	Bash: "🔧",
	Read: "📖",
	Edit: "✏️",
	Write: "📝",
	Grep: "🔎",
	find: "🔍",
	ls: "📂",
	web_search: "🌐",
	web_fetch: "🌐",
	subagent: "🤖",
	tasks_update: "📋",
	Skill: "⚡",
};

function toolEmoji(name: string): string {
	return TOOL_EMOJI[name] || "🔧";
}

/** Format a tool call for display */
function formatTool(name: string, args: Record<string, any>): string {
	const emoji = toolEmoji(name);
	switch (name) {
		case "Bash": {
			const cmd = args.command || "";
			return `${emoji} *Bash*\n\`${cmd.slice(0, 500)}\``;
		}
		case "Read":
			return `${emoji} *Read*: \`${args.path || args.file_path || "?"}\``;
		case "Edit":
			return `${emoji} *Edit*: \`${args.path || args.file_path || "?"}\``;
		case "Write":
			return `${emoji} *Write*: \`${args.path || args.file_path || "?"}\``;
		case "Grep":
			return `${emoji} *Grep*: \`${args.pattern || "?"}\``;
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
		case "tasks_update":
			return formatTaskList(args.tasks || []);
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
	};
}

/**
 * Process an agent event and update the display.
 */
export async function handleAgentEvent(api: Api, state: EventDisplayState, event: RpcEvent): Promise<void> {
	switch (event.type) {
		case "tool_execution_start": {
			const name = event.toolName || "?";
			const args = event.args || {};
			state.toolCount++;
			const toolMsg = formatTool(name, args);
			state.toolsSinceText.push(toolMsg);

			// Update status with tool count and recent tools
			updateStatus(state);
			break;
		}

		case "message_end": {
			// Only display assistant messages — user messages are echoed back by RPC
			const msg = event.message;
			if (msg?.role !== "assistant") break;
			const content = msg?.content;
			if (!content || !Array.isArray(content)) break;

			for (const block of content) {
				if (block.type === "text" && block.text?.trim()) {
					const text = block.text.trim();

					// Flush accumulated tools as permanent summary
					if (state.toolsSinceText.length > 0) {
						const summary = `📋 *${state.toolsSinceText.length} tools*:\n${state.toolsSinceText.join("\n")}`;
						await safeSend(api, state.chatId, summary.slice(0, 4000));
						state.toolsSinceText = [];
					}

					// Send the text as a permanent message
					state.textBlocks.push(text);

					// Check for file send markers
					const [cleanText, filePaths] = extractSendFiles(text);
					if (cleanText) {
						await sendLong(api, state.chatId, cleanText);
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
				await safeSend(api, state.chatId, msg);
			}
			break;
		}

		case "agent_end": {
			// Flush any remaining tools
			if (state.toolsSinceText.length > 0) {
				const summary = `📋 *${state.toolsSinceText.length} tools*:\n${state.toolsSinceText.join("\n")}`;
				await safeSend(api, state.chatId, summary.slice(0, 4000));
				state.toolsSinceText = [];
			}

			// Check for error in agent_end messages
			const errorMsg = (event.messages as any[])?.find(
				(m: any) => m.stopReason === "error" || m.stopReason === "aborted",
			);

			if (errorMsg?.errorMessage) {
				await safeSend(api, state.chatId, `❌ ${errorMsg.errorMessage.slice(0, 500)}`);
			} else if (state.textBlocks.length === 0 && state.backgroundAgents.size === 0) {
				// Only show "(No response)" when truly done — not between agent cycles
				await safeSend(api, state.chatId, "(No response)");
			}

			// If background agents are still running, keep the subscription alive
			// and reset per-cycle state for the next agent loop
			if (state.backgroundAgents.size > 0) {
				state.textBlocks = [];
				state.toolCount = 0;
				break;
			}

			// Truly done — no background agents pending
			state.done = true;

			// Delete ephemeral status
			if (state.statusMessageId) {
				await state.editor.flush(state.chatId, state.statusMessageId);
				await safeDelete(api, state.chatId, state.statusMessageId);
				state.statusMessageId = null;
			}

			// Clean up editor
			state.editor.clear();
			break;
		}

		// Handle error responses that leak through RPC (async prompt errors)
		case "response": {
			const resp = event as any;
			if (!resp.success && resp.error) {
				await safeSend(api, state.chatId, `❌ ${resp.error.slice(0, 500)}`);
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
