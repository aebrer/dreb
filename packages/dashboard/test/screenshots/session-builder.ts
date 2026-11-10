/**
 * Deterministic builder for synthetic dreb session transcripts.
 *
 * README screenshots render only pre-baked, fictional sessions. Building them here
 * (instead of committing opaque JSONL blobs) keeps every entry type-checked against
 * the real session-file and message types, so a format change fails `tsgo` rather
 * than silently producing a degraded screenshot. The harness materializes these
 * entries as ordinary current-version JSONL files and reads them back through the
 * real SessionManager.
 */

import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionEntry,
	type SessionMessageEntry,
} from "@dreb/coding-agent";

type AgentMessage = SessionMessageEntry["message"];
export type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type AssistantContent = AssistantMessage["content"][number];
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

export interface FixtureModel {
	provider: string;
	id: string;
	api: AssistantMessage["api"];
}

export interface SessionFixtureOptions {
	/** Stable UUID for the session header and file name. */
	id: string;
	/** Fictional project directory recorded in the header. */
	cwd: string;
	/** Session start (ms epoch). */
	startedAt: number;
	name?: string;
	model: FixtureModel;
	thinkingLevel?: string;
	agentType?: string;
}

export interface SessionFixture {
	id: string;
	cwd: string;
	/** `<timestamp>_<id>.jsonl`, matching SessionManager's on-disk naming. */
	fileName: string;
	entries: FileEntry[];
	/** Messages in transcript order (what buildSessionContext yields for this linear session). */
	messages: AgentMessage[];
	/** Timestamp (ms) of the last entry. */
	endedAt: number;
}

export type ToolCallBlock = Extract<AssistantContent, { type: "toolCall" }>;

/** Text block helper. */
export function text(value: string): AssistantContent {
	return { type: "text", text: value };
}

/** Thinking block helper. */
export function thinking(value: string): AssistantContent {
	return { type: "thinking", thinking: value };
}

/** Tool-call block helper. */
export function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCallBlock {
	return { type: "toolCall", id, name, arguments: args };
}

function sessionFileName(startedAt: number, id: string): string {
	return `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;
}

/**
 * Builds a linear session. Every message advances an explicit clock so the
 * resulting timestamps are fixed relative to the scenario instant.
 */
export class SessionBuilder {
	private readonly entries: SessionEntry[] = [];
	private readonly messages: AgentMessage[] = [];
	private clock: number;
	private lastId: string | null = null;
	private counter = 0;

	constructor(private readonly options: SessionFixtureOptions) {
		this.clock = options.startedAt;
		this.push({
			type: "model_change",
			provider: options.model.provider,
			modelId: options.model.id,
		});
		if (options.thinkingLevel) this.push({ type: "thinking_level_change", thinkingLevel: options.thinkingLevel });
		if (options.name) this.push({ type: "session_info", name: options.name });
	}

	/** Advance the session clock. */
	after(seconds: number): this {
		this.clock += seconds * 1000;
		return this;
	}

	user(content: string): this {
		return this.message({ role: "user", content: [{ type: "text", text: content }], timestamp: this.clock });
	}

	assistant(
		content: AssistantContent[],
		usage: { input: number; output: number; cacheRead?: number },
		stopReason: AssistantMessage["stopReason"] = content.some((block) => block.type === "toolCall")
			? "toolUse"
			: "stop",
	): this {
		const cacheRead = usage.cacheRead ?? 0;
		// Plausible per-million pricing; values only feed displayed cost strings.
		const cost = {
			input: (usage.input * 3) / 1_000_000,
			output: (usage.output * 15) / 1_000_000,
			cacheRead: (cacheRead * 0.3) / 1_000_000,
			cacheWrite: 0,
			total: 0,
		};
		cost.total = cost.input + cost.output + cost.cacheRead;
		const message: AssistantMessage = {
			role: "assistant",
			content,
			api: this.options.model.api,
			provider: this.options.model.provider,
			model: this.options.model.id,
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead,
				cacheWrite: 0,
				totalTokens: usage.input + usage.output + cacheRead,
				cost,
			},
			stopReason,
			timestamp: this.clock,
		};
		return this.message(message);
	}

	toolResult(call: ToolCallBlock, output: string, details?: unknown, isError = false): this {
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: output }],
			...(details === undefined ? {} : { details }),
			isError,
			timestamp: this.clock,
		};
		return this.message(message);
	}

	build(): SessionFixture {
		const header: FileEntry = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.options.id,
			timestamp: new Date(this.options.startedAt).toISOString(),
			cwd: this.options.cwd,
			...(this.options.agentType ? { agentType: this.options.agentType } : {}),
		};
		return {
			id: this.options.id,
			cwd: this.options.cwd,
			fileName: sessionFileName(this.options.startedAt, this.options.id),
			entries: [header, ...this.entries],
			messages: [...this.messages],
			endedAt: this.clock,
		};
	}

	private message(message: AgentMessage): this {
		this.messages.push(message);
		return this.push({ type: "message", message });
	}

	private push(entry: DistributiveOmit<SessionEntry, "id" | "parentId" | "timestamp">): this {
		this.counter += 1;
		// Deterministic 8-hex entry ids derived from the session id and position.
		const id = `${this.options.id.slice(0, 4)}${this.counter.toString(16).padStart(4, "0")}`;
		this.entries.push({
			...entry,
			id,
			parentId: this.lastId,
			timestamp: new Date(this.clock).toISOString(),
		} as SessionEntry);
		this.lastId = id;
		return this;
	}
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Serialize a fixture as JSONL, exactly as SessionManager would persist it. */
export function toJsonl(fixture: SessionFixture): string {
	return `${fixture.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
