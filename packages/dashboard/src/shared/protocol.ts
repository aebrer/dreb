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

/** On-disk session inventory, independent of live runtime state. */
export interface SessionInventoryDto {
	sessions: SessionInfoDto[];
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

/**
 * Shared eviction cap for completed/failed background agents. The server
 * prunes its registry to this bound and the client applies the same cap as
 * defense-in-depth — the two sides must agree on how many completed agents
 * survive, so the constant lives here.
 */
export const MAX_COMPLETED_BACKGROUND_AGENTS = 20;

/** Maximum JSON prompt request body accepted by the dashboard server. */
export const MAX_PROMPT_BODY_BYTES = 25 * 1024 * 1024;

/** Maximum accepted JSON body for optional, payload-free SSE client diagnostics. */
export const MAX_CLIENT_DIAGNOSTIC_BYTES = 4 * 1024;

export type EventConnectionState =
	| "connecting"
	| "connected"
	| "retrying"
	| "resyncing"
	| "disconnected"
	| "auth_failed";

/**
 * Deliberately payload-free client connection telemetry. It is useful for
 * correlating stream failures with server logs, without sending prompts,
 * cookies, tool data, or SSE event contents back to the server.
 */
export interface ClientConnectionDiagnosticDto {
	connectionId: string;
	state: EventConnectionState;
	previousState?: EventConnectionState;
	attempt: number;
	delayMs?: number;
	visibility: "visible" | "hidden";
	lastAppliedSeq?: number;
	heartbeatAgeMs?: number;
	eventCount: number;
	eventRatePerMinute: number;
	processingLagTotalMs: number;
	processingLagMaxMs: number;
}

/**
 * Inline images are base64-encoded inside the JSON prompt body. Base64 expands
 * raw bytes by 4/3, so a 25 MiB body can carry at most floor(25 MiB * 3/4) =
 * 18.75 MiB of raw image data before JSON syntax and prompt text. Reserve the
 * remaining 0.75 MiB for that overhead and advertise an 18 MiB aggregate raw
 * image budget to the browser.
 */
export const MAX_TOTAL_IMAGE_BYTES = Math.floor((MAX_PROMPT_BODY_BYTES * 3) / 4) - 768 * 1024;

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

export interface ImageAttachmentDto {
	data: string;
	mimeType: string;
}

export interface QueuedMessageDto {
	text: string;
	images?: ImageAttachmentDto[];
}

export interface PendingMessagesDto {
	/** Text-only compatibility view. */
	steering: string[];
	/** Text-only compatibility view. */
	followUp: string[];
	/** Full queued payloads, including inline image attachments. */
	steeringMessages?: QueuedMessageDto[];
	/** Full queued payloads, including inline image attachments. */
	followUpMessages?: QueuedMessageDto[];
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

/** Current task list (mirrors RpcSessionTask). */
export interface SessionTaskDto {
	id: string;
	title: string;
	status: "pending" | "in_progress" | "completed";
}

/** Live session state (mirrors RpcSessionState, model reduced to id fields). */
export interface SessionStateDto {
	model?: { provider: string; id: string; name?: string; reasoning?: boolean };
	scopedModels?: ScopedModelDto[];
	usingSubscription?: boolean;
	/** Current task list, atomically replaced by tasks_update events. */
	tasks: SessionTaskDto[];
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
	/** Runtime-level error that should survive browser reloads. */
	error?: string;
	/** Last assistant text, truncated for fleet-card previews. */
	lastAssistantText?: string;
	/** Session start timestamp (ISO) — stable tiebreak for deterministic fleet ordering. */
	createdAt: string;
	/** Last activity timestamp (ISO). */
	lastActivity: string;
}

/**
 * Lightweight, event-derived live-runtime view for fleet SSE updates.
 *
 * Unlike RuntimeInfoDto, this deliberately excludes RPC-fetched stats and
 * assistant preview text: RuntimePool can build it synchronously from its
 * in-memory runtime registry.
 */
export interface FleetRuntimeSnapshotDto {
	key: string;
	cwd: string;
	state: SessionStateDto;
	backgroundAgents: BackgroundAgentDto[];
	needsAttention: boolean;
	error?: string;
	createdAt: string;
	lastActivity: string;
}

/** Coalesced fleet update published on the dashboard SSE stream. */
export interface FleetSnapshotEventDto {
	type: "fleet_snapshot";
	runtimes: FleetRuntimeSnapshotDto[];
}

/** Fleet snapshot: live runtimes + on-disk inventory. */
export interface FleetDto {
	runtimes: RuntimeInfoDto[];
	diskSessions: SessionInfoDto[];
}

/**
 * Atomic parent-session snapshot for drill-in hydration. Its barrier sequence
 * marks the SSE ordering point captured by the matching RPC snapshot marker.
 */
export interface RuntimeHydrationDto {
	key: string;
	state: SessionStateDto;
	messages: unknown[];
	backgroundAgents: BackgroundAgentDto[];
	barrierSeq: number;
}

/** Parent/subagent data restored by an authoritative recovery snapshot. */
export interface ActiveRuntimeSnapshotDto extends RuntimeHydrationDto {
	subagent?: { agentId: string; agent: BackgroundAgentDto; messages: unknown[]; barrierSeq: number };
}

/** Fleet refresh plus the active runtime's explicitly ordered snapshot. */
export interface DashboardResyncDto {
	fleet: FleetDto;
	active?: ActiveRuntimeSnapshotDto;
	/** The global barrier to await before applying the payload. */
	barrierSeq: number;
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
export interface ContextTrustEvaluationDto {
	/** Canonical existing directory evaluated by the utility RPC runtime. */
	canonicalTarget: string;
	/** Whether nested context is untrusted, granted by a root, or globally unrestricted. */
	state: "untrusted" | "trusted-root" | "unrestricted";
	/** Canonical root granting trusted-root access, including inherited access. */
	grantingRoot?: string;
}

/** Result of changing a context-trust root through the utility RPC runtime. */
export interface ContextTrustMutationResultDto {
	evaluation: ContextTrustEvaluationDto;
	settings: SettingsDto;
	addedRoot?: string;
	removedRoot?: string;
}

/** Result of removing a configured trusted-folder string exactly as stored. */
export interface TrustedFolderRemovalResultDto {
	settings: SettingsDto;
	removedFolder: string;
}

/** Directory listing response. */
export interface DirListingDto {
	/** Canonicalized absolute path of the listed directory. */
	path: string;
	entries: FileEntryDto[];
	/** Current global nested-context trust for this canonical directory. */
	contextTrust: ContextTrustEvaluationDto;
}

/** Auth mode reported to the client. */
export interface AuthStatusDto {
	mode: "local" | "remote";
	/** Identity string for remote devices (e.g. Tailscale login name). */
	identity?: string;
	device?: string;
}

/** Current rotating pairing code, readable only from the host/local dashboard. */
export interface PairingCodeDto {
	enabled: boolean;
	code?: string;
	expiresInMs?: number;
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
	/** Global configured trusted context folders, including invalid legacy entries. */
	trustedContextFolders?: string[];
	/** Canonical existing trusted roots currently enforced by the runtime. */
	effectiveTrustedContextRoots?: string[];
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
