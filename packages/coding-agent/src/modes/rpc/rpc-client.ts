/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AgentMessage, ThinkingLevel } from "@dreb/agent-core";
import type { ImageContent } from "@dreb/ai";
import type { SessionStats } from "../../core/agent-session.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
	RpcAgentTypeInfo,
	RpcBackgroundAgentInfo,
	RpcCommand,
	RpcContextTrustEvaluation,
	RpcContextTrustMutationResult,
	RpcDashboardSnapshot,
	RpcDashboardSnapshotBarrierEvent,
	RpcEvent,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcPendingMessages,
	RpcResources,
	RpcResponse,
	RpcSessionInfo,
	RpcSessionState,
	RpcSettingsSetResult,
	RpcSettingsSnapshot,
	RpcSettingsUpdate,
	RpcSlashCommand,
	RpcTreeNode,
	RpcTrustedFolderRemovalResult,
} from "./rpc-types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Grace period (ms) start() waits for the child to initialize before treating
 * it as alive. An 'error'/'exit' event during this window rejects start() early.
 */
const INIT_GRACE_MS = 100;

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
	/**
	 * Run the agent child process under this OS user id.
	 * Forwarded directly to `child_process.spawn`. The parent process must hold
	 * `CAP_SETUID` (typically by running as root) for this to succeed; otherwise
	 * the spawn fails and `start()` rejects. Omitted when unset (default behavior).
	 */
	uid?: number;
	/**
	 * Run the agent child process under this OS group id.
	 * Forwarded directly to `child_process.spawn`. The parent process must hold
	 * `CAP_SETGID` (typically by running as root) for this to succeed; otherwise
	 * the spawn fails and `start()` rejects. Omitted when unset (default behavior).
	 */
	gid?: number;
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

/**
 * Listener for non-response messages streamed by the RPC server. The wire carries
 * the full {@link RpcEvent} union: session events, extension UI requests, and
 * RPC-specific ordering markers such as `dashboard_snapshot_barrier`.
 */
export type RpcEventListener = (event: RpcEvent) => void;

export type RpcExitInfo =
	| { code: number | null; signal: NodeJS.Signals | null; error?: undefined }
	| { code?: undefined; signal?: undefined; error: Error };

export type RpcExitListener = (info: RpcExitInfo) => void;

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcResponseMessage(value: unknown): value is RpcResponse {
	return isJsonRecord(value) && value.type === "response";
}

function isRpcDashboardSnapshotBarrierEvent(value: unknown): value is RpcDashboardSnapshotBarrierEvent {
	return isJsonRecord(value) && value.type === "dashboard_snapshot_barrier" && typeof value.snapshotId === "string";
}

function isRpcExtensionUIRequestMessage(value: unknown): value is RpcExtensionUIRequest {
	return (
		isJsonRecord(value) &&
		value.type === "extension_ui_request" &&
		typeof value.id === "string" &&
		typeof value.method === "string"
	);
}

function isRpcEvent(value: unknown): value is RpcEvent {
	if (!isJsonRecord(value) || typeof value.type !== "string" || value.type === "response") {
		return false;
	}
	if (value.type === "dashboard_snapshot_barrier") {
		return isRpcDashboardSnapshotBarrierEvent(value);
	}
	if (value.type === "extension_ui_request") {
		return isRpcExtensionUIRequestMessage(value);
	}
	return true;
}

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private exitListeners = new Set<RpcExitListener>();
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	private requestId = 0;
	private stderr = "";
	private _dead = false;
	private spawnError: Error | null = null;

	constructor(private options: RpcClientOptions = {}) {}

	/**
	 * Start the RPC agent process.
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		this.process = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
			...(this.options.uid != null ? { uid: this.options.uid } : {}),
			...(this.options.gid != null ? { gid: this.options.gid } : {}),
		});

		this._dead = false;
		this.spawnError = null;

		// Collect stderr for debugging
		this.process.stderr?.on("data", (data) => {
			this.stderr += data.toString();
		});

		// Detect process exit and spawn failures for the whole session lifecycle —
		// reject pending requests so callers don't hang. Capture the process
		// reference so stale handlers from a previous process don't clobber state
		// after a stop()/start() cycle.
		const procRef = this.process;
		procRef.on("exit", (code, signal) => {
			// Guard: skip if this handler belongs to an old, already-stopped process
			if (this.process !== procRef) return;
			this.failPendingRequests(`RPC process exited with code ${code}, signal ${signal}`);
			this.notifyExitListeners({ code, signal });
		});

		// Spawn failures surface asynchronously as an 'error' event rather than a
		// thrown exception (e.g. EPERM when dropping to a uid/gid the parent lacks
		// CAP_SETUID/CAP_SETGID for, or unsupported on Windows). Without a listener
		// an 'error' event would crash the process; record the cause so start() can
		// fail loudly and a later send() can report the real reason instead of a
		// generic "not running".
		procRef.on("error", (err) => {
			// Guard: skip if this handler belongs to an old, already-stopped process
			if (this.process !== procRef) return;
			this.spawnError = err;
			this.failPendingRequests(`RPC process failed to spawn: ${err.message}`);
			this.notifyExitListeners({ error: err });
		});

		// Set up strict JSONL reader for stdout.
		this.stopReadingStdout = attachJsonlLineReader(this.process.stdout!, (line) => {
			this.handleLine(line);
		});

		// Give the process a moment to initialize, but settle as soon as an
		// 'error' or 'exit' event arrives. Racing the grace period against those
		// events (instead of a blind fixed sleep) guarantees that a failed
		// privilege drop (uid/gid EPERM) rejects start() loudly no matter when
		// libuv delivers the event — a fixed sleep could expire first and let
		// start() resolve despite the child never running.
		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => {
				cleanup();
				reject(new Error(`Agent process failed to spawn: ${err.message}. Stderr: ${this.stderr}`));
			};
			const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
				cleanup();
				reject(
					new Error(
						`Agent process exited immediately with code ${code}, signal ${signal}. Stderr: ${this.stderr}`,
					),
				);
			};
			const timer = setTimeout(() => {
				cleanup();
				resolve();
			}, INIT_GRACE_MS);
			const cleanup = () => {
				clearTimeout(timer);
				procRef.off("error", onError);
				procRef.off("exit", onExit);
			};
			procRef.once("error", onError);
			procRef.once("exit", onExit);
		});

		// Belt-and-suspenders: a process that exited exactly as the grace timer
		// fired (so the race resolved instead of rejecting) still surfaces loudly.
		if (this.process.exitCode !== null) {
			throw new Error(`Agent process exited immediately with code ${this.process.exitCode}. Stderr: ${this.stderr}`);
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	async stop(): Promise<void> {
		if (!this.process) return;

		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.process.kill("SIGTERM");

		// Wait for process to exit
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
		this._dead = true;
		this.pendingRequests.clear();
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to child process death/spawn-failure notifications.
	 */
	onExit(listener: RpcExitListener): () => void {
		this.exitListeners.add(listener);
		return () => {
			this.exitListeners.delete(listener);
		};
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "prompt", message, images });
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/**
	 * Capture a dashboard recovery snapshot. The RPC stream emits a matching
	 * `dashboard_snapshot_barrier` immediately before this response; consumers
	 * need that event's EventHub sequence before applying the snapshot.
	 */
	async getDashboardSnapshot(): Promise<RpcDashboardSnapshot> {
		const response = await this.send({ type: "get_dashboard_snapshot" });
		return this.getData(response);
	}

	/**
	 * Get loaded context/resources metadata (paths/names only, no file contents).
	 */
	async getResources(): Promise<RpcResources> {
		const response = await this.send({ type: "get_resources" });
		return this.getData(response);
	}

	/**
	 * Get current git branch for the agent cwd.
	 */
	async getGitBranch(): Promise<string | null> {
		const response = await this.send({ type: "get_git_branch" });
		return this.getData<{ branch: string | null }>(response).branch;
	}

	/**
	 * Get cached same-day cost across all sessions, primed by the server on first call.
	 */
	async getDailyCost(): Promise<number> {
		const response = await this.send({ type: "get_daily_cost" });
		return this.getData<{ cost: number }>(response).cost;
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Resolve a model pattern using the same logic as CLI/TUI.
	 * Runs server-side so API keys never leave the process.
	 * Returns null if no match found.
	 */
	async resolveModel(pattern: string): Promise<{ model: ModelInfo; warning?: string } | null> {
		const response = await this.send({ type: "resolve_model", pattern });
		return this.getData<{ model: ModelInfo; warning?: string } | null>(response);
	}

	/**
	 * Hatch a new buddy companion. Runs inside the agent process
	 * so API keys never leave the process boundary.
	 */
	async buddyHatch(): Promise<import("../../core/buddy/buddy-types.js").BuddyState> {
		const response = await this.send({ type: "buddy_hatch" });
		return this.getData<{ state: import("../../core/buddy/buddy-types.js").BuddyState }>(response).state;
	}

	/**
	 * Reroll the buddy companion. Runs inside the agent process
	 * so API keys never leave the process boundary.
	 */
	async buddyReroll(): Promise<import("../../core/buddy/buddy-types.js").BuddyState> {
		const response = await this.send({ type: "buddy_reroll" });
		return this.getData<{ state: import("../../core/buddy/buddy-types.js").BuddyState }>(response).state;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Get pending steering and follow-up messages without clearing them.
	 */
	async getPendingMessages(): Promise<RpcPendingMessages> {
		const response = await this.send({ type: "get_pending_messages" });
		return this.getData<RpcPendingMessages>(response);
	}

	/**
	 * Clear pending steering and follow-up messages, returning the cleared text.
	 */
	async clearPendingMessages(): Promise<RpcPendingMessages> {
		const response = await this.send({ type: "clear_pending_messages" });
		return this.getData<RpcPendingMessages>(response);
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Abort in-progress compaction.
	 */
	async abortCompaction(): Promise<void> {
		await this.send({ type: "abort_compaction" });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * Get performance statistics.
	 */
	async getPerformanceStats(): Promise<{
		models: Array<{ provider: string; modelId: string; median: number; mean: number; count: number }>;
	}> {
		const response = await this.send({ type: "get_performance_stats" });
		return this.getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * Delete a session file, trying trash first and falling back to unlink.
	 * Throws on failure, including when attempting to delete the active session.
	 */
	async deleteSession(sessionPath: string): Promise<{ method: "trash" | "unlink" }> {
		const response = await this.send({ type: "delete_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * Fork from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/**
	 * Get messages available for forking.
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get the session tree and current leaf.
	 */
	async getTree(): Promise<{ roots: RpcTreeNode[]; leafId: string | null }> {
		const response = await this.send({ type: "get_tree" });
		return this.getData(response);
	}

	/**
	 * Navigate to a session tree entry.
	 * @param targetId Entry ID to navigate to
	 * @param options Navigation options; timeoutMs is client-side only and is not sent over RPC
	 * @returns Object with `cancelled: true` if navigation was cancelled, and `editorText` when re-editing a message
	 */
	async navigateTree(
		targetId: string,
		options?: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
			timeoutMs?: number;
		},
	): Promise<{ cancelled: boolean; editorText?: string }> {
		const { timeoutMs = 300000, ...commandOptions } = options ?? {};
		const response = await this.send({ type: "navigate_tree", targetId, ...commandOptions }, timeoutMs);
		return this.getData(response);
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * Set the session display name.
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * Get all messages in the session.
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get available commands (extension commands, prompt templates, skills).
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	/**
	 * List sessions for the current working directory.
	 * Returns sessions sorted by most recently modified first.
	 */
	async listSessions(): Promise<RpcSessionInfo[]> {
		const response = await this.send({ type: "list_sessions" });
		return this.getData<{ sessions: RpcSessionInfo[] }>(response).sessions;
	}

	/**
	 * List sessions across all projects.
	 * Returns sessions sorted by most recently modified first. May be slow with many sessions.
	 */
	async listAllSessions(): Promise<RpcSessionInfo[]> {
		const response = await this.send({ type: "list_all_sessions" });
		return this.getData<{ sessions: RpcSessionInfo[] }>(response).sessions;
	}

	/**
	 * List background subagents tracked by the server's registry (running and
	 * recently completed), including session dir/file paths where known.
	 */
	async listBackgroundAgents(): Promise<RpcBackgroundAgentInfo[]> {
		const response = await this.send({ type: "list_background_agents" });
		return this.getData<{ agents: RpcBackgroundAgentInfo[] }>(response).agents;
	}

	/**
	 * List discoverable subagent types for the server's current working directory.
	 */
	async listAgentTypes(): Promise<RpcAgentTypeInfo[]> {
		const response = await this.send({ type: "list_agent_types" });
		return this.getData<{ agentTypes: RpcAgentTypeInfo[] }>(response).agentTypes;
	}

	/**
	 * Answer an extension UI request (select/confirm/input/editor) previously
	 * received as an `extension_ui_request` event. Fire-and-forget: the server
	 * does not send a response to this message.
	 */
	sendExtensionUIResponse(response: RpcExtensionUIResponse): void {
		if (this._dead || !this.process?.stdin) {
			const cause = this.spawnError ? ` Spawn error: ${this.spawnError.message}.` : "";
			throw new Error(`RPC process is not running.${cause} Stderr: ${this.stderr}`);
		}
		this.process.stdin.write(serializeJsonLine(response));
	}

	/**
	 * Get the dreb version.
	 */
	async getVersion(): Promise<string> {
		const response = await this.send({ type: "get_version" });
		return this.getData<{ version: string }>(response).version;
	}

	/**
	 * Get the persistent default settings (SettingsManager-backed).
	 * These seed fresh runtimes — for live session state use getState().
	 */
	async getSettings(): Promise<RpcSettingsSnapshot> {
		const response = await this.send({ type: "get_settings" });
		return this.getData<RpcSettingsSnapshot>(response);
	}

	/**
	 * Update persistent default settings. Validates the whole payload before applying
	 * anything (atomic: on any invalid field, nothing changes). Does NOT touch live
	 * session state — use setModel/setThinkingLevel/etc. for that.
	 * Returns the full settings snapshot after the write, plus any loud warnings
	 * (for example project-level agent model overrides shadowing global writes).
	 */
	async setSettings(settings: RpcSettingsUpdate): Promise<RpcSettingsSetResult> {
		const response = await this.send({ type: "set_settings", settings });
		return this.getData<RpcSettingsSetResult>(response);
	}

	/** Evaluate an existing directory against the server's global context-trust policy. */
	async evaluateContextTrust(path: string): Promise<RpcContextTrustEvaluation> {
		const response = await this.send({ type: "evaluate_context_trust", path });
		return this.getData<RpcContextTrustEvaluation>(response);
	}

	/** Add an existing directory as a canonical global trusted context root. */
	async trustContextFolder(path: string): Promise<RpcContextTrustMutationResult> {
		const response = await this.send({ type: "trust_context_folder", path });
		return this.getData<RpcContextTrustMutationResult>(response);
	}

	/** Remove the root that currently grants the directory context trust. */
	async untrustContextFolder(path: string): Promise<RpcContextTrustMutationResult> {
		const response = await this.send({ type: "untrust_context_folder", path });
		return this.getData<RpcContextTrustMutationResult>(response);
	}

	/** Remove a configured trusted-folder string exactly as stored. */
	async removeTrustedContextFolder(path: string): Promise<RpcTrustedFolderRemovalResult> {
		const response = await this.send({ type: "remove_trusted_context_folder", path });
		return this.getData<RpcTrustedFolderRemovalResult>(response);
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_end event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<RpcEvent[]> {
		return new Promise((resolve, reject) => {
			const events: RpcEvent[] = [];
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<RpcEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	/**
	 * Mark the client dead and reject every in-flight request with `message`.
	 * Shared by the 'exit' and 'error' handlers so both failure paths surface
	 * loudly and consistently instead of leaving callers hanging.
	 */
	private failPendingRequests(message: string): void {
		this._dead = true;
		for (const pending of this.pendingRequests.values()) {
			pending.reject(new Error(message));
		}
		this.pendingRequests.clear();
	}

	private notifyExitListeners(info: RpcExitInfo): void {
		for (const listener of this.exitListeners) {
			listener(info);
		}
	}

	private handleLine(line: string): void {
		try {
			const data: unknown = JSON.parse(line);

			// Check if it's a response to a pending request. Unknown/unsolicited
			// response frames are not events and should not be forwarded to listeners.
			if (isRpcResponseMessage(data)) {
				if (typeof data.id === "string" && this.pendingRequests.has(data.id)) {
					const pending = this.pendingRequests.get(data.id)!;
					this.pendingRequests.delete(data.id);
					pending.resolve(data);
				}
				return;
			}

			if (!isRpcEvent(data)) {
				return;
			}

			for (const listener of this.eventListeners) {
				listener(data);
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	private async send(command: RpcCommandBody, timeoutMs = 30000): Promise<RpcResponse> {
		if (this._dead || !this.process?.stdin) {
			// Surface the real spawn cause (e.g. uid/gid EPERM) if one was captured,
			// rather than a generic message that hides why the process is gone.
			throw new Error(
				this.spawnError ? `RPC process not running: ${this.spawnError.message}` : "RPC process not running",
			);
		}

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, timeoutMs);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			this.process!.stdin!.write(serializeJsonLine(fullCommand));
		});
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
