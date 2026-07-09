/**
 * Event reducer — pure TypeScript state machine turning agent session events
 * into per-session render state. No DOM, no framework: unit-testable in
 * plain node. The Solid layer (store.ts) owns the session map and applies
 * these mutations through `produce` for fine-grained reactive updates.
 *
 * Transcript model (structural reference: core/export-html renderEntry):
 * entries are append-only; streaming updates mutate the last entry in place.
 */

import type { BackgroundAgentDto, ContextUsageDto } from "../../shared/protocol.js";

// ---------------------------------------------------------------------------
// Transcript entry model
// ---------------------------------------------------------------------------

export interface UserEntry {
	kind: "user";
	text: string;
	timestamp?: number;
}

export interface AgentResultEntry {
	kind: "agent-result";
	/** Markdown body extracted from the background-agent completion wrapper. */
	text: string;
	/** Human-readable status line, e.g. "Background agent bg1 (Explore) completed." */
	header?: string;
	/** Original wrapped message text, retained for dedupe/debugging. */
	raw: string;
	timestamp?: number;
}

export interface AssistantBlock {
	kind: "text" | "thinking";
	text: string;
}

export interface AssistantEntry {
	kind: "assistant";
	blocks: AssistantBlock[];
	model?: string;
	streaming: boolean;
	timestamp?: number;
}

export interface ToolEntry {
	kind: "tool";
	toolCallId: string;
	toolName: string;
	args: unknown;
	status: "running" | "done" | "error";
	/** Result text (or partial output while running). */
	resultText: string;
	details?: unknown;
	startedAt: number;
	endedAt?: number;
}

export interface SummaryEntry {
	kind: "summary";
	label: "compaction" | "branch";
	text: string;
	tokensBefore?: number;
}

export interface CustomEntry {
	kind: "custom";
	tag: string;
	text: string;
}

export type TranscriptEntry = UserEntry | AgentResultEntry | AssistantEntry | ToolEntry | SummaryEntry | CustomEntry;

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export interface StatusLineEntry {
	key: string;
	text: string;
	tone: "info" | "warning" | "error";
}

export interface ExtensionUiRequest {
	id: string;
	method: "select" | "confirm" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	prefill?: string;
	placeholder?: string;
}

export interface Toast {
	id: number;
	text: string;
	tone: "info" | "warning" | "error";
}

export interface SessionTaskItem {
	title: string;
	status: "pending" | "in_progress" | "completed";
}

export interface SessionViewState {
	key: string;
	entries: TranscriptEntry[];
	streaming: boolean;
	compacting: boolean;
	/** Working text for the status line (e.g. current tool + elapsed). */
	workingText?: string;
	workingSince?: number;
	statusEntries: StatusLineEntry[];
	tasks: SessionTaskItem[];
	suggestedCommand?: string;
	backgroundAgents: Record<string, BackgroundAgentDto>;
	uiRequests: ExtensionUiRequest[];
	toasts: Toast[];
	widgets: { above: string[]; below: string[] };
	/** Live AgentSession display name from session_name_changed events. */
	sessionName?: string;
	/** Extension UI title; distinct from the AgentSession display name. */
	title?: string;
	composerPrefill?: string;
	needsAttention: boolean;
	lastError?: string;
	contextUsage?: ContextUsageDto;
	model?: string;
	/** Sub-view states for background agents (agentId → view). */
	subagents: Record<string, SubagentViewState>;
}

export interface SubagentViewState {
	agentId: string;
	entries: TranscriptEntry[];
	streaming: boolean;
	model?: string;
}

export function createSessionViewState(key: string): SessionViewState {
	return {
		key,
		entries: [],
		streaming: false,
		compacting: false,
		statusEntries: [],
		tasks: [],
		backgroundAgents: {},
		uiRequests: [],
		toasts: [],
		widgets: { above: [], below: [] },
		needsAttention: false,
		subagents: {},
	};
}

// ---------------------------------------------------------------------------
// Message → entries (hydration from get_messages and message_end events)
// ---------------------------------------------------------------------------

interface MessageLike {
	role: string;
	content?: unknown;
	timestamp?: number;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	details?: unknown;
	[key: string]: unknown;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p): p is { type: string; text: string } => typeof (p as any)?.text === "string")
		.map((p) => p.text)
		.join("\n");
}

function parseBackgroundAgentResult(raw: string, timestamp?: number): AgentResultEntry | undefined {
	const match = raw.match(/<background-agent-complete>\n?([\s\S]*?)\n?<\/background-agent-complete>/);
	const inner = match?.[1]?.trim();
	if (!inner) return undefined;
	const lines = inner.split("\n");
	const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
	let header: string | undefined;
	let text = inner;
	if (firstContentLine >= 0 && /^Background agent .+\.$/.test(lines[firstContentLine]?.trim() ?? "")) {
		header = lines[firstContentLine]!.trim();
		text =
			lines
				.slice(firstContentLine + 1)
				.join("\n")
				.trim() || header;
	}
	return { kind: "agent-result", text, header, raw, timestamp };
}

function userMessageToEntry(message: MessageLike): UserEntry | AgentResultEntry {
	const text = contentToText(message.content);
	return parseBackgroundAgentResult(text, message.timestamp) ?? { kind: "user", text, timestamp: message.timestamp };
}

/** Convert a full message list (get_messages) into transcript entries. */
export function messagesToEntries(messages: MessageLike[]): TranscriptEntry[] {
	const entries: TranscriptEntry[] = [];
	const toolEntries = new Map<string, ToolEntry>();

	for (const message of messages) {
		if (message.role === "user") {
			entries.push(userMessageToEntry(message));
		} else if (message.role === "assistant") {
			let blocks: AssistantBlock[] = [];
			const flushAssistant = () => {
				if (blocks.length === 0) return;
				entries.push({
					kind: "assistant",
					blocks,
					model: message.model,
					streaming: false,
					timestamp: message.timestamp,
				});
				blocks = [];
			};
			if (Array.isArray(message.content)) {
				for (const part of message.content as Array<Record<string, unknown>>) {
					if (part.type === "text" && typeof part.text === "string") {
						blocks.push({ kind: "text", text: part.text });
					} else if (part.type === "thinking" && typeof part.thinking === "string") {
						blocks.push({ kind: "thinking", text: part.thinking });
					} else if (part.type === "toolCall") {
						flushAssistant();
						const call = part as { id?: string; name?: string; arguments?: unknown };
						const entry: ToolEntry = {
							kind: "tool",
							toolCallId: String(call.id ?? ""),
							toolName: String(call.name ?? "tool"),
							args: call.arguments,
							status: "running",
							resultText: "",
							startedAt: message.timestamp ?? Date.now(),
						};
						toolEntries.set(entry.toolCallId, entry);
						entries.push(entry);
					}
				}
			}
			flushAssistant();
		} else if (message.role === "toolResult") {
			const entry = toolEntries.get(String(message.toolCallId));
			if (entry) {
				entry.status = message.isError ? "error" : "done";
				entry.resultText = contentToText(message.content);
				entry.details = message.details;
				entry.endedAt = message.timestamp;
			}
		} else if (message.role === "bashExecution") {
			const m = message as { command?: string; output?: string; excludeFromContext?: boolean };
			entries.push({
				kind: "tool",
				toolCallId: `bash-exec-${entries.length}`,
				toolName: "bash (user)",
				args: { command: m.command },
				status: "done",
				resultText: m.output ?? "",
				startedAt: message.timestamp ?? Date.now(),
			});
		} else if (message.role === "custom") {
			const m = message as { customType?: string; displayText?: string };
			entries.push({
				kind: "custom",
				tag: m.customType ?? "extension",
				text: m.displayText ?? contentToText(message.content),
			});
		}
	}
	return entries;
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

let toastCounter = 0;

// The UI renders only the newest few global toasts; keep a bounded per-session
// backing list so older, undismissable notifications do not accumulate forever.
const MAX_TOASTS = 20;
export const MAX_COMPLETED_BACKGROUND_AGENTS = 20;

function capToasts(state: SessionViewState): void {
	const extra = state.toasts.length - MAX_TOASTS;
	if (extra > 0) state.toasts.splice(0, extra);
}

function startedAtTime(agent: BackgroundAgentDto): number {
	const time = Date.parse(agent.startedAt);
	return Number.isFinite(time) ? time : 0;
}

export function capBackgroundAgents(state: SessionViewState): void {
	const completed = Object.values(state.backgroundAgents)
		.filter((agent) => agent.status !== "running")
		.sort((a, b) => startedAtTime(a) - startedAtTime(b) || a.agentId.localeCompare(b.agentId));
	const evictCount = completed.length - MAX_COMPLETED_BACKGROUND_AGENTS;
	if (evictCount <= 0) return;
	for (const agent of completed.slice(0, evictCount)) {
		delete state.backgroundAgents[agent.agentId];
		delete state.subagents[agent.agentId];
	}
}

/** Derive needs-attention from current state. */
function updateAttention(state: SessionViewState): void {
	state.needsAttention =
		state.uiRequests.length > 0 ||
		state.statusEntries.some((s) => s.tone === "error") ||
		// A suggest_next as the agent's final action is a "your move" signal —
		// the card should read needs-attention, not idle, until the next turn.
		!!state.suggestedCommand;
}

function lastAssistant(state: { entries: TranscriptEntry[] }): AssistantEntry | undefined {
	for (let i = state.entries.length - 1; i >= 0; i--) {
		const entry = state.entries[i];
		if (entry.kind === "assistant") return entry;
	}
	return undefined;
}

function findTool(state: { entries: TranscriptEntry[] }, toolCallId: string): ToolEntry | undefined {
	for (let i = state.entries.length - 1; i >= 0; i--) {
		const entry = state.entries[i];
		if (entry.kind === "tool" && entry.toolCallId === toolCallId) return entry;
	}
	return undefined;
}

/**
 * Apply one AgentSessionEvent to a transcript-bearing view (session or
 * subagent drill-in — both share the streaming/message/tool logic).
 */
function applyTranscriptEvent(state: { entries: TranscriptEntry[]; streaming: boolean }, event: any): void {
	switch (event.type) {
		case "agent_start": {
			state.streaming = true;
			break;
		}
		case "agent_end": {
			state.streaming = false;
			const tail = lastAssistant(state);
			if (tail) tail.streaming = false;
			break;
		}
		case "message_start": {
			const message = event.message as MessageLike | undefined;
			if (message?.role === "user") {
				state.entries.push(userMessageToEntry(message));
			} else if (message?.role === "assistant") {
				state.entries.push({
					kind: "assistant",
					blocks: [],
					model: message.model,
					streaming: true,
					timestamp: message.timestamp,
				});
			}
			break;
		}
		case "message_update": {
			const streamEvent = event.assistantMessageEvent as
				| { type: string; contentIndex?: number; delta?: string; content?: string }
				| undefined;
			if (!streamEvent) break;
			let tail = lastAssistant(state);
			if (!tail || !tail.streaming) {
				tail = { kind: "assistant", blocks: [], streaming: true };
				state.entries.push(tail);
			}
			if (streamEvent.type === "text_start") tail.blocks.push({ kind: "text", text: "" });
			else if (streamEvent.type === "thinking_start") tail.blocks.push({ kind: "thinking", text: "" });
			else if (streamEvent.type === "text_delta" || streamEvent.type === "thinking_delta") {
				const block = tail.blocks[tail.blocks.length - 1];
				if (block) block.text += streamEvent.delta ?? "";
			} else if (streamEvent.type === "text_end" || streamEvent.type === "thinking_end") {
				const block = tail.blocks[tail.blocks.length - 1];
				if (block && typeof streamEvent.content === "string") block.text = streamEvent.content;
			}
			break;
		}
		case "message_end": {
			const message = event.message as MessageLike | undefined;
			if (message?.role === "assistant") {
				const tail = lastAssistant(state);
				if (tail?.streaming) {
					// Replace streamed blocks with the authoritative final content.
					const final = messagesToEntries([message]);
					const finalAssistant = final.find((e): e is AssistantEntry => e.kind === "assistant");
					if (finalAssistant) {
						tail.blocks = finalAssistant.blocks;
						tail.model = finalAssistant.model;
					}
					tail.streaming = false;
				} else if (!tail) {
					state.entries.push(...messagesToEntries([message]));
				}
			} else if (message?.role === "user") {
				// Steered/background-delivered user messages arrive via message_end
				// without a preceding message_start in some paths; dedupe by checking
				// the last entry.
				const last = state.entries[state.entries.length - 1];
				const entry = userMessageToEntry(message);
				if (entry.kind === "agent-result") {
					if (!(last?.kind === "agent-result" && last.raw === entry.raw)) state.entries.push(entry);
				} else if (!(last?.kind === "user" && last.text === entry.text)) {
					state.entries.push(entry);
				}
			}
			break;
		}
		case "tool_execution_start": {
			state.entries.push({
				kind: "tool",
				toolCallId: String(event.toolCallId),
				toolName: String(event.toolName),
				args: event.args,
				status: "running",
				resultText: "",
				startedAt: Date.now(),
			});
			break;
		}
		case "tool_execution_update": {
			const entry = findTool(state, String(event.toolCallId));
			if (entry) {
				const partial = event.partialResult as { content?: unknown } | string | undefined;
				entry.resultText =
					typeof partial === "string"
						? partial
						: partial?.content
							? contentToText(partial.content)
							: entry.resultText;
			}
			break;
		}
		case "tool_execution_end": {
			const entry = findTool(state, String(event.toolCallId));
			if (entry) {
				entry.status = event.isError ? "error" : "done";
				const result = event.result as { content?: unknown } | string | undefined;
				entry.resultText =
					typeof result === "string" ? result : result?.content ? contentToText(result.content) : entry.resultText;
				entry.details = (event.result as { details?: unknown } | undefined)?.details;
				entry.endedAt = Date.now();
			}
			break;
		}
		default:
			break;
	}
}

/** Apply one envelope-wrapped event to the session view state. */
export function applySessionEvent(state: SessionViewState, event: any): void {
	applyTranscriptEvent(state, event);

	switch (event.type) {
		case "agent_start": {
			state.workingText = "working";
			state.workingSince = Date.now();
			state.lastError = undefined;
			state.suggestedCommand = undefined;
			// New turn resolves prior blocking UI requests server-side.
			state.uiRequests = [];
			break;
		}
		case "agent_end": {
			state.workingText = undefined;
			state.workingSince = undefined;
			state.statusEntries = state.statusEntries.filter((s) => s.key !== "retry" && s.key !== "paused");
			break;
		}
		case "tool_execution_start": {
			state.workingText = `${event.toolName}`;
			break;
		}
		case "auto_compaction_start": {
			state.compacting = true;
			state.statusEntries.push({ key: "compaction", text: "compacting context…", tone: "info" });
			break;
		}
		case "auto_compaction_end": {
			state.compacting = false;
			state.statusEntries = state.statusEntries.filter((s) => s.key !== "compaction");
			const result = event.result as { tokensBefore?: number; summary?: string } | undefined;
			if (result && !event.aborted) {
				state.entries.push({
					kind: "summary",
					label: "compaction",
					text: result.summary ?? "context compacted",
					tokensBefore: result.tokensBefore,
				});
			}
			if (event.errorMessage) {
				state.statusEntries.push({ key: "compaction-error", text: String(event.errorMessage), tone: "error" });
			}
			break;
		}
		case "auto_retry_start": {
			state.statusEntries = state.statusEntries.filter((s) => s.key !== "retry");
			state.statusEntries.push({
				key: "retry",
				text: `retrying (${event.attempt}/${event.maxAttempts}) — ${event.errorMessage}`,
				tone: "warning",
			});
			break;
		}
		case "auto_retry_end": {
			state.statusEntries = state.statusEntries.filter((s) => s.key !== "retry");
			if (!event.success && event.finalError) {
				state.statusEntries.push({ key: "error", text: String(event.finalError), tone: "error" });
				state.lastError = String(event.finalError);
			}
			break;
		}
		case "stream_retry": {
			state.statusEntries = state.statusEntries.filter((s) => s.key !== "retry");
			state.statusEntries.push({
				key: "retry",
				text: `stream dropped, retrying (${event.attempt}/${event.maxAttempts})`,
				tone: "warning",
			});
			// Discarded partial: remove the streaming tail so the retry re-streams it.
			const tail = lastAssistant(state);
			if (tail?.streaming) state.entries.splice(state.entries.indexOf(tail), 1);
			break;
		}
		case "length_retry": {
			state.statusEntries = state.statusEntries.filter((s) => s.key !== "retry");
			state.statusEntries.push({
				key: "retry",
				text: `response truncated, retrying with larger budget (${event.attempt}/${event.maxAttempts})`,
				tone: "warning",
			});
			const tail = lastAssistant(state);
			if (tail?.streaming) state.entries.splice(state.entries.indexOf(tail), 1);
			break;
		}
		case "tasks_update": {
			state.tasks = (event.tasks as SessionTaskItem[]) ?? [];
			break;
		}
		case "suggest_next": {
			state.suggestedCommand = String(event.command);
			break;
		}
		case "session_name_changed": {
			state.sessionName = String(event.name ?? "");
			break;
		}
		case "background_agent_start": {
			state.backgroundAgents[String(event.agentId)] = {
				agentId: String(event.agentId),
				agentType: String(event.agentType),
				taskSummary: String(event.taskSummary),
				startedAt: new Date().toISOString(),
				status: "running",
				sessionDir: event.sessionDir as string | undefined,
			};
			break;
		}
		case "background_agent_end": {
			const agent = state.backgroundAgents[String(event.agentId)];
			if (agent) {
				agent.status = event.success ? "completed" : "failed";
				agent.sessionFile = (event.sessionFile as string | undefined) ?? agent.sessionFile;
			}
			const sub = state.subagents[String(event.agentId)];
			if (sub) sub.streaming = false;
			capBackgroundAgents(state);
			break;
		}
		case "background_agent_event": {
			const agentId = String(event.agentId);
			let sub = state.subagents[agentId];
			if (!sub) {
				sub = { agentId, entries: [], streaming: true };
				state.subagents[agentId] = sub;
			}
			const child = event.event as any;
			if (child?.type === "session") break; // header — no transcript effect
			if (child?.type === "agent_start" && child.model) sub.model = child.model.id;
			applyTranscriptEvent(sub, child);
			break;
		}
		case "parent_paused_for_background_agents": {
			state.statusEntries = state.statusEntries.filter((s) => s.key !== "paused");
			state.statusEntries.push({
				key: "paused",
				text: `paused — waiting on ${event.runningAgentCount} background agent${event.runningAgentCount === 1 ? "" : "s"}`,
				tone: "warning",
			});
			break;
		}
		case "extension_ui_request": {
			const method = event.method as string;
			if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
				state.uiRequests.push({
					id: String(event.id),
					method,
					title: String(event.title ?? ""),
					message: event.message as string | undefined,
					options: event.options as string[] | undefined,
					prefill: event.prefill as string | undefined,
					placeholder: event.placeholder as string | undefined,
				});
			} else if (method === "notify") {
				toastCounter += 1;
				const tone = (event.notifyType as "info" | "warning" | "error" | undefined) ?? "info";
				state.toasts.push({ id: toastCounter, text: String(event.message ?? ""), tone });
				capToasts(state);
			} else if (method === "setStatus") {
				const key = `ext:${event.statusKey ?? "default"}`;
				state.statusEntries = state.statusEntries.filter((s) => s.key !== key);
				if (event.statusText) state.statusEntries.push({ key, text: String(event.statusText), tone: "info" });
			} else if (method === "setWidget") {
				const placement = event.widgetPlacement === "belowEditor" ? "below" : "above";
				state.widgets[placement] = Array.isArray(event.widgetLines) ? (event.widgetLines as string[]) : [];
			} else if (method === "setTitle") {
				state.title = String(event.title ?? "");
			} else if (method === "set_editor_text") {
				state.composerPrefill = String(event.text ?? "");
			}
			break;
		}
		case "extension_error": {
			toastCounter += 1;
			state.toasts.push({ id: toastCounter, text: `extension error: ${event.error}`, tone: "error" });
			capToasts(state);
			break;
		}
		default:
			break;
	}

	updateAttention(state);
}

/** Dismiss a toast notification. */
export function dismissToast(state: SessionViewState, id: number): void {
	state.toasts = state.toasts.filter((toast) => toast.id !== id);
}

/** Dismiss a resolved/answered UI request. */
export function resolveUiRequest(state: SessionViewState, id: string): void {
	state.uiRequests = state.uiRequests.filter((r) => r.id !== id);
	updateAttention(state);
}
