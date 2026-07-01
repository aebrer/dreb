export type EventCategory = "lifecycle" | "message" | "stream" | "tool" | "task" | "suggestion" | "subagent" | "system";

export type JsonRecord = Record<string, unknown>;

export interface DashboardMessage extends JsonRecord {
	role?: string;
	content?: unknown;
	timestamp?: number;
}

export interface DashboardTask extends JsonRecord {
	id?: string;
	title?: string;
	status?: string;
}

export interface DashboardSubagent {
	id: string;
	agentType: string;
	taskSummary: string;
	status: "running" | "succeeded" | "failed";
	startedAt: number;
	endedAt?: number;
	lastEvent?: JsonRecord;
}

export interface DashboardRuntimeState extends JsonRecord {
	model?: { provider?: string; id?: string };
	thinkingLevel?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	messageCount?: number;
	pendingMessageCount?: number;
	modelFallbackMessage?: string;
}

export interface EventLogEntry {
	id: number;
	category: EventCategory;
	type: string;
	timestamp: number;
	event: JsonRecord;
}

export interface ParentPauseInfo {
	runningAgentCount: number;
	turnsUsed: number;
	turnLimit: number;
	updatedAt: number;
}

export interface DashboardClientState {
	runtime?: DashboardRuntimeState;
	messages: DashboardMessage[];
	streamMessage?: DashboardMessage;
	tasks: DashboardTask[];
	suggestions: string[];
	subagents: DashboardSubagent[];
	parentPause?: ParentPauseInfo;
	events: EventLogEntry[];
	isStreaming: boolean;
	lastEventId: number;
}

export function createInitialDashboardState(): DashboardClientState {
	return {
		messages: [],
		tasks: [],
		suggestions: [],
		subagents: [],
		events: [],
		isStreaming: false,
		lastEventId: 0,
	};
}

export function hydrateRuntimeState(
	state: DashboardClientState,
	runtime: DashboardRuntimeState | undefined,
): DashboardClientState {
	return {
		...state,
		runtime,
		isStreaming: Boolean(runtime?.isStreaming),
	};
}

export function hydrateMessages(state: DashboardClientState, messages: DashboardMessage[]): DashboardClientState {
	return {
		...state,
		messages: [...messages],
		streamMessage: undefined,
	};
}

export function categorizeEvent(event: JsonRecord): EventCategory {
	switch (event.type) {
		case "agent_start":
		case "agent_end":
		case "turn_start":
		case "turn_end":
		case "auto_compaction_start":
		case "auto_compaction_end":
		case "auto_retry_start":
		case "auto_retry_end":
		case "stream_retry":
		case "length_retry":
			return "lifecycle";
		case "message_start":
		case "message_end":
			return "message";
		case "message_update":
			return "stream";
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
			return "tool";
		case "tasks_update":
			return "task";
		case "suggest_next":
			return "suggestion";
		case "background_agent_start":
		case "background_agent_end":
		case "parent_paused_for_background_agents":
			return "subagent";
		default:
			return "system";
	}
}

export function applyDashboardEvent(
	state: DashboardClientState,
	event: JsonRecord,
	now = Date.now(),
): DashboardClientState {
	const type = typeof event.type === "string" ? event.type : "unknown";
	const next: DashboardClientState = appendEvent(state, event, type, now);

	switch (type) {
		case "agent_start":
			return { ...next, isStreaming: true, runtime: { ...next.runtime, isStreaming: true } };
		case "agent_end": {
			const messages = Array.isArray(event.messages) ? asMessages(event.messages) : next.messages;
			return {
				...next,
				messages,
				streamMessage: undefined,
				isStreaming: false,
				runtime: { ...next.runtime, isStreaming: false },
			};
		}
		case "message_start":
			return upsertEventMessage(next, event, false);
		case "message_update": {
			const message = asMessage(event.message);
			if (!message) return next;
			return { ...next, streamMessage: message, isStreaming: true, runtime: { ...next.runtime, isStreaming: true } };
		}
		case "message_end":
			return { ...upsertEventMessage(next, event, true), streamMessage: undefined };
		case "turn_end":
			return upsertEventMessage(next, event, true);
		case "tasks_update":
			return { ...next, tasks: Array.isArray(event.tasks) ? asTasks(event.tasks) : [] };
		case "suggest_next": {
			const command = typeof event.command === "string" ? event.command : undefined;
			if (!command || next.suggestions.includes(command)) return next;
			return { ...next, suggestions: [...next.suggestions, command].slice(-8) };
		}
		case "background_agent_start":
			return startSubagent(next, event, now);
		case "background_agent_end":
			return endSubagent(next, event, now);
		case "parent_paused_for_background_agents":
			return {
				...next,
				parentPause: {
					runningAgentCount: numberField(event.runningAgentCount),
					turnsUsed: numberField(event.turnsUsed),
					turnLimit: numberField(event.turnLimit),
					updatedAt: now,
				},
			};
		default:
			return next;
	}
}

export function clearSuggestion(state: DashboardClientState, command: string): DashboardClientState {
	return { ...state, suggestions: state.suggestions.filter((candidate) => candidate !== command) };
}

function appendEvent(state: DashboardClientState, event: JsonRecord, type: string, now: number): DashboardClientState {
	const id = state.lastEventId + 1;
	const entry: EventLogEntry = {
		id,
		category: categorizeEvent(event),
		type,
		timestamp: now,
		event,
	};
	return {
		...state,
		lastEventId: id,
		events: [...state.events, entry].slice(-120),
	};
}

function upsertEventMessage(
	state: DashboardClientState,
	event: JsonRecord,
	preferReplace: boolean,
): DashboardClientState {
	const message = asMessage(event.message);
	if (!message) return state;
	return { ...state, messages: upsertMessage(state.messages, message, preferReplace) };
}

function upsertMessage(
	messages: DashboardMessage[],
	message: DashboardMessage,
	preferReplace: boolean,
): DashboardMessage[] {
	const key = messageKey(message);
	const existingIndex = key ? messages.findIndex((candidate) => messageKey(candidate) === key) : -1;
	if (existingIndex >= 0) {
		const next = [...messages];
		next[existingIndex] = preferReplace ? message : { ...next[existingIndex], ...message };
		return next;
	}
	return [...messages, message];
}

function messageKey(message: DashboardMessage): string | undefined {
	if (typeof message.timestamp === "number" && typeof message.role === "string")
		return `${message.role}:${message.timestamp}`;
	const toolCallId = message.toolCallId;
	if (typeof toolCallId === "string") return `tool:${toolCallId}`;
	return undefined;
}

function startSubagent(state: DashboardClientState, event: JsonRecord, now: number): DashboardClientState {
	const id = typeof event.agentId === "string" ? event.agentId : "unknown";
	const subagent: DashboardSubagent = {
		id,
		agentType: typeof event.agentType === "string" ? event.agentType : "agent",
		taskSummary: typeof event.taskSummary === "string" ? event.taskSummary : "Background agent",
		status: "running",
		startedAt: now,
		lastEvent: event,
	};
	return { ...state, subagents: [...state.subagents.filter((candidate) => candidate.id !== id), subagent] };
}

function endSubagent(state: DashboardClientState, event: JsonRecord, now: number): DashboardClientState {
	const id = typeof event.agentId === "string" ? event.agentId : "unknown";
	const status = event.success === false ? "failed" : "succeeded";
	const existing = state.subagents.find((candidate) => candidate.id === id);
	const subagent: DashboardSubagent = {
		id,
		agentType: typeof event.agentType === "string" ? event.agentType : (existing?.agentType ?? "agent"),
		taskSummary: existing?.taskSummary ?? "Background agent",
		status,
		startedAt: existing?.startedAt ?? now,
		endedAt: now,
		lastEvent: event,
	};
	return { ...state, subagents: [...state.subagents.filter((candidate) => candidate.id !== id), subagent] };
}

function asMessage(value: unknown): DashboardMessage | undefined {
	if (!isRecord(value)) return undefined;
	return value as DashboardMessage;
}

function asMessages(values: unknown[]): DashboardMessage[] {
	return values.filter(isRecord) as DashboardMessage[];
}

function asTasks(values: unknown[]): DashboardTask[] {
	return values.filter(isRecord) as DashboardTask[];
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
