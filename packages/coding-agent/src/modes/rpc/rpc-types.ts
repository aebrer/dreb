/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@dreb/agent-core";
import type { ImageContent, Model, Transport } from "@dreb/ai";
import type { SessionStats } from "../../core/agent-session.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { ContextUsage } from "../../core/extensions/types.js";
import type { SessionEntry } from "../../core/session-manager.js";
import type { SourceInfo } from "../../core/source-info.js";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_resources" }
	| { id?: string; type: "get_git_branch" }
	| { id?: string; type: "get_daily_cost" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "resolve_model"; pattern: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Buddy — hatch/reroll run inside the agent process so API keys never leave
	| { id?: string; type: "buddy_hatch" }
	| { id?: string; type: "buddy_reroll" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "get_pending_messages" }
	| { id?: string; type: "clear_pending_messages" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }
	| { id?: string; type: "abort_compaction" }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "get_performance_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "delete_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_tree" }
	| {
			id?: string;
			type: "navigate_tree";
			targetId: string;
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
	  }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" }

	// Session listing
	| { id?: string; type: "list_sessions" }
	| { id?: string; type: "list_all_sessions" }

	// Background agents
	| { id?: string; type: "list_background_agents" }
	| { id?: string; type: "list_agent_types" }

	// Settings (persistent defaults)
	| { id?: string; type: "get_settings" }
	| { id?: string; type: "set_settings"; settings: RpcSettingsUpdate }

	// Version
	| { id?: string; type: "get_version" };

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: SourceInfo;
}

export interface RpcScopedModel {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
}

export interface RpcResources {
	contextFiles: Array<{ path: string }>;
	skills: Array<{ name: string; description: string }>;
	extensions: Array<{ name?: string; path: string }>;
	promptTemplates: Array<{ name: string; description?: string }>;
	systemPromptPresent: boolean;
}

export interface RpcQueuedMessage {
	text: string;
	images?: ImageContent[];
}

export interface RpcPendingMessages {
	/** Text-only compatibility view for existing clients. */
	steering: string[];
	/** Text-only compatibility view for existing clients. */
	followUp: string[];
	/** Full queued payloads, including inline image attachments. */
	steeringMessages?: RpcQueuedMessage[];
	/** Full queued payloads, including inline image attachments. */
	followUpMessages?: RpcQueuedMessage[];
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model<any>;
	scopedModels: RpcScopedModel[];
	/** Whether local/self-hosted model injection is enabled for agent fallback lists */
	localOnlyMode?: boolean;
	/** The local model ID to inject (provider/model format) */
	localOnlyModel?: string;
	usingSubscription: boolean;
	thinkingLevel: ThinkingLevel;
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
	/**
	 * Context window usage computed by the session — the exact numbers the TUI footer
	 * renders (AgentSession.getContextUsage()). `tokens`/`percent` are null when usage
	 * is unknown (e.g. right after compaction, before the next LLM response). Undefined
	 * when no model is set or the model has no context window.
	 */
	contextUsage?: ContextUsage;
	/** Non-empty when the model was changed from the user's saved preference
	 *  (e.g. saved model unavailable after restart). */
	modelFallbackMessage?: string;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| { id?: string; type: "response"; command: "get_resources"; success: true; data: RpcResources }
	| { id?: string; type: "response"; command: "get_git_branch"; success: true; data: { branch: string | null } }
	| { id?: string; type: "response"; command: "get_daily_cost"; success: true; data: { cost: number } }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "resolve_model";
			success: true;
			data: { model: Model<any>; warning?: string } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }

	// Buddy
	| {
			id?: string;
			type: "response";
			command: "buddy_hatch";
			success: true;
			data: { state: import("../../core/buddy/buddy-types.js").BuddyState };
	  }
	| {
			id?: string;
			type: "response";
			command: "buddy_reroll";
			success: true;
			data: { state: import("../../core/buddy/buddy-types.js").BuddyState };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "get_pending_messages"; success: true; data: RpcPendingMessages }
	| { id?: string; type: "response"; command: "clear_pending_messages"; success: true; data: RpcPendingMessages }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }
	| { id?: string; type: "response"; command: "abort_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| {
			id?: string;
			type: "response";
			command: "get_performance_stats";
			success: true;
			data: { models: Array<{ provider: string; modelId: string; median: number; mean: number; count: number }> };
	  }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "delete_session"; success: true; data: { method: "trash" | "unlink" } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_tree";
			success: true;
			data: { roots: RpcTreeNode[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "navigate_tree";
			success: true;
			data: { cancelled: boolean; editorText?: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }

	// Session listing
	| {
			id?: string;
			type: "response";
			command: "list_sessions";
			success: true;
			data: { sessions: RpcSessionInfo[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "list_all_sessions";
			success: true;
			data: { sessions: RpcSessionInfo[] };
	  }

	// Background agents
	| {
			id?: string;
			type: "response";
			command: "list_background_agents";
			success: true;
			data: { agents: RpcBackgroundAgentInfo[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "list_agent_types";
			success: true;
			data: { agentTypes: RpcAgentTypeInfo[] };
	  }

	// Settings
	| { id?: string; type: "response"; command: "get_settings"; success: true; data: RpcSettingsSnapshot }
	| { id?: string; type: "response"; command: "set_settings"; success: true; data: RpcSettingsSetResult }

	// Version
	| { id?: string; type: "response"; command: "get_version"; success: true; data: { version: string } }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Session Info (for list_sessions response)
// ============================================================================

/** Session metadata returned by list_sessions */
export interface RpcSessionInfo {
	/** Full path to the session JSONL file */
	path: string;
	/** Session UUID */
	id: string;
	/** Working directory where the session was started */
	cwd: string;
	/** User-defined display name */
	name?: string;
	/** ISO timestamp of session creation */
	created: string;
	/** ISO timestamp of last modification */
	modified: string;
	/** Number of messages in the session */
	messageCount: number;
	/** First user message text */
	firstMessage: string;
}

/** Background agent metadata returned by list_background_agents */
export interface RpcBackgroundAgentInfo {
	/** Registry ID (hex) used in background_agent_* events */
	agentId: string;
	/** Agent type name (e.g. "Explore") */
	agentType: string;
	/** Short human-readable task label */
	taskSummary: string;
	/** ISO timestamp of launch */
	startedAt: string;
	/** Lifecycle status */
	status: "running" | "completed" | "failed";
	/** Directory containing the agent's session JSONL file (known at spawn time) */
	sessionDir?: string;
	/** Path to the agent's session JSONL file (available after the child exits) */
	sessionFile?: string;
	/** Working directory the agent runs in */
	cwd?: string;
}

/** Agent type metadata returned by list_agent_types */
export interface RpcAgentTypeInfo {
	/** Agent type name, e.g. "Explore" */
	name: string;
	/** Human-readable description from the agent frontmatter */
	description: string;
}

/** Serializable session tree node returned by get_tree. Stable DTO — no raw entry payloads. */
export interface RpcTreeNode {
	/** Entry id */
	id: string;
	/**
	 * Parent entry id, or null for a root. Orphaned roots (broken parent chains) keep their
	 * original non-null parentId, which references an entry not present in the tree — prefer
	 * the nested `children` structure over parentId when reconstructing hierarchy.
	 */
	parentId: string | null;
	/** Session entry type */
	type: SessionEntry["type"];
	/** Message role, present only when type === "message" (user, assistant, toolResult, bashExecution, ...) */
	role?: string;
	/** Short single-line content preview (whitespace-collapsed, max 200 chars) */
	preview: string;
	/** ISO timestamp of the entry */
	timestamp: string;
	/** Resolved label, if any */
	label?: string;
	/** Child nodes, oldest first */
	children: RpcTreeNode[];
}

// ============================================================================
// Settings (persistent defaults)
// ============================================================================

/**
 * Snapshot of persistent default settings returned by `get_settings` and `set_settings`.
 *
 * These are the values persisted via SettingsManager (merged global + project view) that
 * seed fresh runtimes — NOT the live session state. For the current runtime state
 * (active model, effective thinking level, modes in effect), use `get_state`.
 */
export interface RpcSettingsSnapshot {
	/** Default provider used at startup (absent if never set) */
	defaultProvider?: string;
	/** Default model id used at startup (absent if never set) */
	defaultModel?: string;
	/** Default thinking level applied at startup (absent if never set) */
	defaultThinkingLevel?: ThinkingLevel;
	/** How queued steering messages are delivered */
	steeringMode: "all" | "one-at-a-time";
	/** How queued follow-up messages are delivered */
	followUpMode: "all" | "one-at-a-time";
	/** Whether automatic context compaction is enabled */
	compactionEnabled: boolean;
	/** Whether automatic retry on transient errors is enabled */
	retryEnabled: boolean;
	/** Whether image inputs are automatically resized before sending to providers */
	imageAutoResize?: boolean;
	/** Whether image inputs are blocked from being sent to providers */
	blockImages?: boolean;
	/** Whether skills are registered as slash commands */
	enableSkillCommands?: boolean;
	/** Whether nested AGENTS.md/CLAUDE.md context auto-loads when tools enter subdirectories */
	autoLoadNestedContext?: boolean;
	/** Preferred model transport */
	transport?: Transport;
	/** Whether raw thinking blocks are hidden in rendered transcripts */
	hideThinkingBlock?: boolean;
	/** Per-agent model fallback lists, merged global + project with project entries winning */
	agentModels?: Record<string, string[]>;
	/** Whether local/self-hosted model injection is enabled for agent fallback lists */
	localOnlyMode?: boolean;
	/** The local model ID to inject (provider/model format) */
	localOnlyModel?: string;
	/** When true, final fallback to local model (appended at end of fallback list) */
	finalFallbackToLocalModel?: boolean;
}

/** Settings snapshot returned by `set_settings`; warnings are present for loud shadowing notices. */
export type RpcSettingsSetResult = RpcSettingsSnapshot & { warnings?: string[] };

/**
 * Partial update payload for `set_settings`. All fields optional, but at least one
 * must be present. `defaultProvider` and `defaultModel` must be supplied together.
 * Writes persistent defaults only — never touches live session state.
 */
export interface RpcSettingsUpdate {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	compactionEnabled?: boolean;
	retryEnabled?: boolean;
	imageAutoResize?: boolean;
	blockImages?: boolean;
	enableSkillCommands?: boolean;
	autoLoadNestedContext?: boolean;
	transport?: Transport;
	hideThinkingBlock?: boolean;
	agentModels?: Record<string, string[]>;
	localOnlyMode?: boolean;
	localOnlyModel?: string;
	finalFallbackToLocalModel?: boolean;
}

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
