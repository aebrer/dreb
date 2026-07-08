/**
 * Wire types shared between the dashboard server and the browser client.
 *
 * These are standalone definitions (not imports from @dreb/coding-agent) so the
 * client bundle stays free of node-flavored type resolution. Server code maps
 * RPC DTOs onto these shapes; TypeScript structural typing enforces
 * compatibility at the mapping sites.
 */

/** Session metadata (mirrors RpcSessionInfo). */
export interface SessionInfoDto {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

/** Background agent metadata (mirrors RpcBackgroundAgentInfo). */
export interface BackgroundAgentDto {
	agentId: string;
	agentType: string;
	taskSummary: string;
	startedAt: string;
	status: "running" | "completed" | "failed";
	sessionDir?: string;
	sessionFile?: string;
	cwd?: string;
}

/** Context usage (mirrors ContextUsage — the numbers the TUI footer shows). */
export interface ContextUsageDto {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface ScopedModelDto {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
}

export interface SessionStatsDto {
	sessionFile?: string;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsageDto;
}

export interface PerformanceStatsDto {
	models: Array<{ provider: string; modelId: string; median: number; mean: number; count: number }>;
}

export interface ResourcesDto {
	contextFiles: Array<{ path: string }>;
	skills: Array<{ name: string; description: string }>;
	extensions: Array<{ name?: string; path: string }>;
	promptTemplates: Array<{ name: string; description?: string }>;
	systemPromptPresent: boolean;
}

export interface PendingMessagesDto {
	steering: string[];
	followUp: string[];
}

export interface ImageAttachmentDto {
	data: string;
	mimeType: string;
}

export interface CommandDto {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
}

export interface RuntimeStatsSummaryDto {
	tokensTotal: number;
	cost: number;
}

/** Live session state (mirrors RpcSessionState, model reduced to id fields). */
export interface SessionStateDto {
	model?: { provider: string; id: string; name?: string; reasoning?: boolean };
	scopedModels?: ScopedModelDto[];
	usingSubscription?: boolean;
	thinkingLevel: string;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
	contextUsage?: ContextUsageDto;
	modelFallbackMessage?: string;
}

/** A live runtime managed by the dashboard server's pool. */
export interface RuntimeInfoDto {
	/** Pool key — stable identity for API calls and SSE envelopes. */
	key: string;
	cwd: string;
	state: SessionStateDto;
	/** Lean session stats for fleet cards; omitted when the runtime stats call fails. */
	stats?: RuntimeStatsSummaryDto;
	/** Background agents known to this runtime. */
	backgroundAgents: BackgroundAgentDto[];
	/** Server-derived needs-attention flag (extension UI pending, paused, error). */
	needsAttention: boolean;
	/** Last assistant text, truncated for fleet-card previews. */
	lastAssistantText?: string;
	/** Last activity timestamp (ISO). */
	lastActivity: string;
}

/** Fleet snapshot: live runtimes + on-disk inventory. */
export interface FleetDto {
	runtimes: RuntimeInfoDto[];
	diskSessions: SessionInfoDto[];
}

/**
 * SSE envelope. Every event on the dashboard stream wraps a session event with
 * the runtime key it came from plus a monotonically increasing sequence number
 * used for Last-Event-ID catch-up on reconnect.
 */
export interface EventEnvelope {
	seq: number;
	key: string;
	/** An AgentSessionEvent (or dashboard-synthesized event) as emitted by the runtime. */
	event: Record<string, unknown>;
}

/** File listing entry. */
export interface FileEntryDto {
	name: string;
	type: "file" | "dir" | "symlink" | "other";
	size: number;
	modified: string;
}

/** Directory listing response. */
export interface DirListingDto {
	/** Canonicalized absolute path of the listed directory. */
	path: string;
	entries: FileEntryDto[];
}

/** Auth mode reported to the client. */
export interface AuthStatusDto {
	mode: "local" | "remote";
	/** Identity string for remote devices (e.g. Tailscale login name). */
	identity?: string;
	device?: string;
}

/** A paired device (settings → devices). */
export interface PairedDeviceDto {
	id: string;
	identity: string;
	device?: string;
	createdAt: string;
	expiresAt: string;
}

/** Dashboard settings snapshot (mirrors RpcSettingsSnapshot). */
export interface SettingsDto {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	compactionEnabled?: boolean;
	retryEnabled?: boolean;
	imageAutoResize?: boolean;
	blockImages?: boolean;
	enableSkillCommands?: boolean;
	autoLoadNestedContext?: boolean;
	transport?: "sse" | "websocket" | "auto";
	hideThinkingBlock?: boolean;
	agentModels?: Record<string, string[]>;
}

export type SettingsSaveResultDto = SettingsDto & { warnings?: string[] };

/** Available model entry (mirrors ModelInfo). */
export interface ModelInfoDto {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	reasoning: boolean;
}

/** Agent definition metadata (mirrors RpcAgentTypeInfo). */
export interface AgentTypeDto {
	name: string;
	description: string;
}
