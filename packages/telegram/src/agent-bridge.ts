/**
 * Agent bridge — manages the RPC connection to a dreb agent process.
 * One bridge per user, handles lifecycle, event subscription, and session management.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient, type RpcSessionInfo } from "@dreb/coding-agent/rpc";
import type { Config } from "./config.js";
import { log } from "./util/telegram.js";

/**
 * Resolve the absolute path to the dreb CLI entry point.
 * RpcClient defaults to "dist/cli.js" (relative to cwd), but we need
 * the absolute path since the bot's working dir differs from the dreb repo.
 */
function resolveDrebCliPath(): string {
	// import.meta.resolve finds @dreb/coding-agent/dist/index.js
	const resolved = import.meta.resolve("@dreb/coding-agent");
	const distDir = dirname(fileURLToPath(resolved));
	return join(distDir, "cli.js");
}

/** RPC events include both AgentEvent and session-specific events */
type RpcEvent = { type: string; [key: string]: any };

export type AgentEventListener = (event: RpcEvent) => void;

export class AgentBridge {
	private client: RpcClient | null = null;
	private eventListeners: AgentEventListener[] = [];
	private _isStreaming = false;
	private _sessionFile: string | undefined;
	private _sessionId: string | undefined;
	private exited = false;

	constructor(private config: Config) {}

	/** Whether the RPC process is alive */
	get isAlive(): boolean {
		return this.client !== null && !this.exited;
	}

	/** Whether the agent is currently streaming a response */
	get isStreaming(): boolean {
		return this._isStreaming;
	}

	/** Current session file path */
	get sessionFile(): string | undefined {
		return this._sessionFile;
	}

	/** Current session ID */
	get sessionId(): string | undefined {
		return this._sessionId;
	}

	/**
	 * Start the RPC process. Does NOT resume a session — call resumeLatest() or newSession() after.
	 */
	async start(): Promise<void> {
		if (this.client) return;

		this.client = new RpcClient({
			cliPath: resolveDrebCliPath(),
			cwd: this.config.workingDir,
			provider: this.config.provider,
			model: this.config.model,
			args: ["--ui", "telegram"],
		});

		this.exited = false;
		await this.client.start();

		// Subscribe to events and forward to listeners
		// Cast: RpcClient types events as AgentEvent but actually forwards all AgentSessionEvent types
		this.client.onEvent((event) => {
			this.handleEvent(event as RpcEvent);
		});

		// Detect process exit
		// RpcClient doesn't expose a direct "on exit" — we detect it when send() fails
		log("[BRIDGE] RPC process started");
	}

	/**
	 * Resume the most recent session, or do nothing if no sessions exist.
	 */
	async resumeLatest(): Promise<boolean> {
		if (!this.client) return false;
		try {
			const sessions = await this.client.listSessions();
			if (sessions.length === 0) return false;

			const latest = sessions[0]; // Already sorted by modified desc
			const result = await this.client.switchSession(latest.path);
			if (!result.cancelled) {
				this._sessionFile = latest.path;
				this._sessionId = latest.id;
				log(`[BRIDGE] Resumed session ${latest.id.slice(0, 8)}`);
				return true;
			}
		} catch (e) {
			log(`[BRIDGE] Failed to resume latest session: ${e}`);
		}
		return false;
	}

	/**
	 * List available sessions.
	 */
	async listSessions(): Promise<RpcSessionInfo[]> {
		if (!this.client) return [];
		try {
			return await this.client.listSessions();
		} catch (e) {
			log(`[BRIDGE] Failed to list sessions: ${e}`);
			return [];
		}
	}

	/**
	 * Switch to a specific session by path.
	 */
	async switchSession(sessionPath: string): Promise<boolean> {
		if (!this.client) return false;
		try {
			const result = await this.client.switchSession(sessionPath);
			if (!result.cancelled) {
				this._sessionFile = sessionPath;
				const state = await this.client.getState();
				this._sessionId = state.sessionId;
				return true;
			}
		} catch (e) {
			log(`[BRIDGE] Failed to switch session: ${e}`);
		}
		return false;
	}

	/**
	 * Create a new session.
	 */
	async newSession(): Promise<boolean> {
		if (!this.client) return false;
		try {
			const result = await this.client.newSession();
			if (!result.cancelled) {
				const state = await this.client.getState();
				this._sessionFile = state.sessionFile;
				this._sessionId = state.sessionId;
				log(`[BRIDGE] New session ${state.sessionId.slice(0, 8)}`);
				return true;
			}
		} catch (e) {
			log(`[BRIDGE] Failed to create new session: ${e}`);
		}
		return false;
	}

	/**
	 * Send a prompt to the agent.
	 */
	async prompt(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
		await this.ensureAlive();
		try {
			await this.client!.prompt(message, images);
		} catch (e) {
			this.handleProcessError(e);
			throw e;
		}
	}

	/**
	 * Abort the current operation.
	 */
	async abort(): Promise<void> {
		if (!this.client) return;
		try {
			await this.client.abort();
		} catch {
			// Process may have already exited
		}
	}

	/**
	 * Get the dreb version.
	 */
	async getVersion(): Promise<string> {
		await this.ensureAlive();
		try {
			return await this.client!.getVersion();
		} catch (e) {
			this.handleProcessError(e);
			throw e;
		}
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<any> {
		if (!this.client) return null;
		try {
			return await this.client.getSessionStats();
		} catch (e) {
			this.handleProcessError(e);
			throw e;
		}
	}

	/**
	 * Get current state.
	 */
	async getState(): Promise<any> {
		if (!this.client) return null;
		try {
			return await this.client.getState();
		} catch (e) {
			this.handleProcessError(e);
			throw e;
		}
	}

	/**
	 * Get available commands (skills, extensions, prompt templates).
	 */
	async getCommands(): Promise<any[]> {
		if (!this.client) return [];
		try {
			return await this.client.getCommands();
		} catch (e) {
			this.handleProcessError(e);
			throw e;
		}
	}

	/**
	 * Compact context.
	 */
	async compact(): Promise<any> {
		if (!this.client) return null;
		try {
			return await this.client.compact();
		} catch (e) {
			this.handleProcessError(e);
			throw e;
		}
	}

	/**
	 * Get available models.
	 */
	async getAvailableModels(): Promise<any[]> {
		if (!this.client) return [];
		try {
			return await this.client.getAvailableModels();
		} catch (e) {
			this.handleProcessError(e);
			throw e;
		}
	}

	/**
	 * Set model.
	 */
	async setModel(provider: string, modelId: string): Promise<any> {
		if (!this.client) return null;
		try {
			return await this.client.setModel(provider, modelId);
		} catch (e) {
			this.handleProcessError(e);
			throw e;
		}
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: string): Promise<void> {
		if (!this.client) return;
		try {
			await this.client.setThinkingLevel(level as any);
		} catch (e) {
			this.handleProcessError(e);
			throw e;
		}
	}

	/**
	 * Get all messages.
	 */
	async getMessages(): Promise<any[]> {
		if (!this.client) return [];
		try {
			return await this.client.getMessages();
		} catch (e) {
			this.handleProcessError(e);
			throw e;
		}
	}

	/**
	 * Get last assistant text.
	 */
	async getLastAssistantText(): Promise<string | null> {
		if (!this.client) return null;
		try {
			return await this.client.getLastAssistantText();
		} catch (e) {
			this.handleProcessError(e);
			throw e;
		}
	}

	/**
	 * Refresh session info from the RPC process state.
	 */
	async refreshSessionInfo(): Promise<void> {
		if (!this.client) return;
		try {
			const state = await this.client.getState();
			this._sessionFile = state.sessionFile;
			this._sessionId = state.sessionId;
		} catch (e) {
			this.handleProcessError(e);
			// Non-critical — don't re-throw
		}
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: AgentEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const idx = this.eventListeners.indexOf(listener);
			if (idx !== -1) this.eventListeners.splice(idx, 1);
		};
	}

	/**
	 * Stop the RPC process.
	 */
	async stop(): Promise<void> {
		if (this.client) {
			try {
				await this.client.stop();
			} catch {
				// Ignore
			}
			this.client = null;
			this.exited = true;
			this.eventListeners = [];
			log("[BRIDGE] RPC process stopped");
		}
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private handleEvent(event: RpcEvent): void {
		// Track streaming state
		if (event.type === "agent_start") this._isStreaming = true;
		if (event.type === "agent_end") {
			this._isStreaming = false;
			// Capture session info from agent_end messages
			// Session file/id updates happen via getState after prompt
		}

		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch (e) {
				log(`[BRIDGE] Event listener error: ${e}`);
			}
		}
	}

	private handleProcessError(e: unknown): void {
		const msg = e instanceof Error ? e.message : String(e);
		if (
			msg.includes("not started") ||
			msg.includes("not running") ||
			msg.includes("EPIPE") ||
			msg.includes("write after end") ||
			msg.includes("Timeout waiting for response") ||
			msg.includes("RPC process exited")
		) {
			log(`[BRIDGE] RPC process exited or hung: ${msg.slice(0, 100)}`);
			// Kill the child process before dropping the reference to prevent orphans
			if (this.client) {
				this.client.stop().catch(() => {});
			}
			this.exited = true;
			this.client = null;
		}
	}

	private async ensureAlive(): Promise<void> {
		if (!this.client || this.exited) {
			log("[BRIDGE] Restarting dead RPC process");
			this.client = null;
			this.exited = false;
			await this.start();
			// Session selection is handled by ensureBridgeWithSession — not here.
			// The previous session is still the latest and will be picked up by
			// resumeLatest() on the next message.
		}
	}
}
