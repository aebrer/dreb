/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AgentEvent, AgentMessage, ThinkingLevel } from "@dreb/agent-core";
import type { ImageContent } from "@dreb/ai";
import type { SessionStats } from "../../core/agent-session.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type { RpcCommand, RpcResponse, RpcSessionInfo, RpcSessionState, RpcSlashCommand } from "./rpc-types.js";

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

export type RpcEventListener = (event: AgentEvent) => void;

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
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
	 * Get the dreb version.
	 */
	async getVersion(): Promise<string> {
		const response = await this.send({ type: "get_version" });
		return this.getData<{ version: string }>(response).version;
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
	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		return new Promise((resolve, reject) => {
			const events: AgentEvent[] = [];
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
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
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

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);

			// Check if it's a response to a pending request
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}

			// Otherwise it's an event
			for (const listener of this.eventListeners) {
				listener(data as AgentEvent);
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	private async send(command: RpcCommandBody): Promise<RpcResponse> {
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
			}, 30000);

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
