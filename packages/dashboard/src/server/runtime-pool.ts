/**
 * RPC runtime pool — one `dreb --mode rpc` child process per live session.
 *
 * dreb's RPC mode is strictly one-session-per-process (switch_session repoints
 * the same process; it never multiplexes), so the pool spawns N children keyed
 * by an opaque runtime key. The telegram bridge is the in-repo precedent.
 */

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient, type RpcExitInfo } from "@dreb/coding-agent/rpc";
import {
	type BackgroundAgentDto,
	MAX_COMPLETED_BACKGROUND_AGENTS,
	type RuntimeInfoDto,
	type RuntimeStatsSummaryDto,
	type SessionStateDto,
} from "../shared/protocol.js";

/** Resolve the absolute path to the dreb CLI (RpcClient defaults to a cwd-relative path). */
export function resolveDrebCliPath(): string {
	const resolved = import.meta.resolve("@dreb/coding-agent");
	return join(dirname(fileURLToPath(resolved)), "cli.js");
}

function formatRpcExit(info: RpcExitInfo): string {
	if (info.error) return `RPC process failed: ${info.error.message}`;
	return `RPC process exited (code ${info.code}, signal ${info.signal})`;
}

export type RuntimeEventListener = (key: string, event: Record<string, unknown>) => void;

export { MAX_COMPLETED_BACKGROUND_AGENTS };

export interface RuntimeHandle {
	key: string;
	cwd: string;
	client: RpcClient;
	/** Session start time (ms epoch) — stable tiebreak for deterministic fleet ordering. */
	createdAt: number;
	lastActivity: number;
	/** Needs-attention sources, keyed so they can be cleared independently. */
	attention: Map<string, string>;
	/** Last runtime-level error, persisted server-side so fleet refreshes stay honest. */
	error?: string;
	/** Last known state, used to keep failed runtime cards renderable. */
	lastState?: SessionStateDto;
	/** Background agents seen via events (agentId → latest info). */
	backgroundAgents: Map<string, BackgroundAgentDto>;
}

export interface RuntimePoolOptions {
	cliPath?: string;
	/** Extra args for every runtime (e.g. --provider). */
	baseArgs?: string[];
	/** RpcClient factory override for tests. */
	clientFactory?: (options: { cliPath: string; cwd: string; args: string[] }) => RpcClient;
	logger?: (line: string) => void;
}

export class RuntimePool {
	private readonly runtimes = new Map<string, RuntimeHandle>();
	private readonly listeners: RuntimeEventListener[] = [];
	private readonly cliPath: string;
	private readonly baseArgs: string[];
	private readonly clientFactory: (options: { cliPath: string; cwd: string; args: string[] }) => RpcClient;
	private readonly logger: (line: string) => void;
	/**
	 * A single lazily-spawned utility runtime used to service settings/model/
	 * agent-type endpoints when no user session is live. Kept out of `runtimes`
	 * (and therefore out of the fleet) so it never shows as a session card.
	 */
	private readonly utilities = new Map<string, RuntimeHandle>();
	private readonly utilityPromises = new Map<string, Promise<RuntimeHandle>>();
	private readonly starting = new Set<RuntimeHandle>();
	private readonly startupPromises = new Set<Promise<unknown>>();
	private readonly exitedHandles = new WeakSet<RuntimeHandle>();
	private closing = false;

	constructor(options: RuntimePoolOptions = {}) {
		this.cliPath = options.cliPath ?? resolveDrebCliPath();
		this.baseArgs = options.baseArgs ?? [];
		this.clientFactory =
			options.clientFactory ?? ((o) => new RpcClient({ cliPath: o.cliPath, cwd: o.cwd, args: o.args }));
		this.logger = options.logger ?? ((line) => console.warn(`[dashboard] ${line}`));
	}

	/** Subscribe to events from every runtime, tagged with the runtime key. */
	onEvent(listener: RuntimeEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const i = this.listeners.indexOf(listener);
			if (i !== -1) this.listeners.splice(i, 1);
		};
	}

	list(): RuntimeHandle[] {
		return [...this.runtimes.values()];
	}

	get(key: string): RuntimeHandle | undefined {
		return this.runtimes.get(key);
	}

	/** Spawn a new runtime in `cwd`, optionally opening an existing session file. */
	async create(cwd: string, sessionPath?: string): Promise<RuntimeHandle> {
		if (this.closing) throw new Error("Runtime pool is closing");
		const key = randomBytes(6).toString("hex");
		const args = ["--ui", "dashboard", ...this.baseArgs];
		if (sessionPath) args.push("--session", sessionPath);
		const client = this.clientFactory({ cliPath: this.cliPath, cwd, args });
		const handle: RuntimeHandle = {
			key,
			cwd,
			client,
			createdAt: Date.now(),
			lastActivity: Date.now(),
			attention: new Map(),
			backgroundAgents: new Map(),
		};
		client.onEvent((event) => this.handleEvent(handle, event as unknown as Record<string, unknown>));
		client.onExit((info) => this.handleRuntimeExit(handle, info));

		const startup = this.startSessionRuntime(handle);
		this.startupPromises.add(startup);
		try {
			return await startup;
		} finally {
			this.startupPromises.delete(startup);
		}
	}

	private async startSessionRuntime(handle: RuntimeHandle): Promise<RuntimeHandle> {
		this.starting.add(handle);
		try {
			if (this.closing) throw new Error("Runtime pool is closing");
			await handle.client.start();
			if (this.closing) {
				await handle.client.stop();
				throw new Error("Runtime pool is closing");
			}
			await this.seedBackgroundAgents(handle);
			if (this.closing) {
				await handle.client.stop();
				throw new Error("Runtime pool is closing");
			}
			this.runtimes.set(handle.key, handle);
			return handle;
		} finally {
			this.starting.delete(handle);
		}
	}

	/** Stop a runtime and remove it from the pool. */
	async stop(key: string): Promise<boolean> {
		const handle = this.runtimes.get(key);
		if (!handle) return false;
		this.handleEvent(handle, { type: "runtime_removed" });
		this.runtimes.delete(key);
		await handle.client.stop();
		return true;
	}

	/**
	 * Return any live runtime suitable for process-global settings work, spawning
	 * a hidden utility runtime (in the home directory) if no user session exists.
	 * This is what lets the settings page — models, agent types, defaults — work
	 * with zero sessions open, instead of 503-ing.
	 */
	async ensureUtilityRuntime(cwd = homedir()): Promise<RuntimeHandle> {
		if (this.closing) throw new Error("Runtime pool is closing");
		const existing = this.utilities.get(cwd);
		if (existing) return existing;
		let promise = this.utilityPromises.get(cwd);
		if (!promise) {
			const args = ["--ui", "dashboard", ...this.baseArgs];
			const client = this.clientFactory({ cliPath: this.cliPath, cwd, args });
			const handle: RuntimeHandle = {
				key: `utility:${cwd}`,
				cwd,
				client,
				createdAt: Date.now(),
				lastActivity: Date.now(),
				attention: new Map(),
				backgroundAgents: new Map(),
			};
			const startup = this.startUtilityRuntime(cwd, handle);
			this.startupPromises.add(startup);
			promise = startup
				.catch((err) => {
					// Allow a retry on the next request instead of caching the failure.
					this.utilityPromises.delete(cwd);
					throw err;
				})
				.finally(() => {
					this.startupPromises.delete(startup);
				});
			this.utilityPromises.set(cwd, promise);
		}
		return promise;
	}

	private async startUtilityRuntime(cwd: string, handle: RuntimeHandle): Promise<RuntimeHandle> {
		this.starting.add(handle);
		try {
			if (this.closing) throw new Error("Runtime pool is closing");
			await handle.client.start();
			if (this.closing) {
				await handle.client.stop();
				throw new Error("Runtime pool is closing");
			}
			this.utilities.set(cwd, handle);
			return handle;
		} finally {
			this.starting.delete(handle);
		}
	}

	async stopAll(): Promise<void> {
		this.closing = true;
		const handles = new Set<RuntimeHandle>([
			...this.runtimes.values(),
			...this.utilities.values(),
			...this.starting.values(),
		]);
		const startupPromises = new Set<Promise<unknown>>([...this.startupPromises, ...this.utilityPromises.values()]);
		this.runtimes.clear();
		this.utilities.clear();
		this.utilityPromises.clear();
		await Promise.allSettled([...handles].map((handle) => handle.client.stop()));
		await Promise.allSettled([...startupPromises]);
	}

	private handleRuntimeExit(handle: RuntimeHandle, info: RpcExitInfo): void {
		if (this.closing || this.exitedHandles.has(handle) || !this.isLiveHandle(handle)) return;
		this.exitedHandles.add(handle);
		const message = formatRpcExit(info);
		this.recordRuntimeError(handle, message);
		this.logger(`runtime ${handle.key} ${message}`);
		this.handleEvent(handle, { type: "agent_end", messages: [], aborted: true, errorMessage: message });
	}

	private isLiveHandle(handle: RuntimeHandle): boolean {
		return (
			this.runtimes.get(handle.key) === handle ||
			this.utilities.get(handle.cwd) === handle ||
			this.starting.has(handle)
		);
	}

	private handleEvent(handle: RuntimeHandle, event: Record<string, unknown>): void {
		handle.lastActivity = Date.now();
		const type = event.type as string;

		// Track needs-attention sources: extension UI requests, parent
		// paused, error states.
		if (type === "extension_ui_request") {
			const method = event.method as string;
			if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
				handle.attention.set(`ui:${event.id}`, `extension ${method} awaiting response`);
			}
		}
		if (type === "extension_ui_response_handled") {
			handle.attention.delete(`ui:${event.id}`);
		}
		if (type === "agent_start") {
			// A new turn clears prior UI-request attention (requests were resolved or timed out).
			for (const k of [...handle.attention.keys()]) {
				if (k.startsWith("ui:")) handle.attention.delete(k);
			}
			handle.attention.delete("paused");
			handle.attention.delete("suggest");
			handle.attention.delete("error");
			handle.error = undefined;
		}
		if (type === "suggest_next") {
			// suggest_next as the ending action = "your move": mark needs-attention
			// so the fleet card doesn't read idle. Cleared on the next agent_start.
			handle.attention.set("suggest", "suggested command awaiting");
		}
		if (type === "parent_paused_for_background_agents") {
			handle.attention.set("paused", `paused — ${event.runningAgentCount} background agents running`);
		}
		if (type === "agent_end") {
			handle.attention.delete("paused");
		}
		if (type === "auto_retry_end" && event.success === false && event.finalError) {
			this.recordRuntimeError(handle, String(event.finalError));
		}
		if (type === "auto_compaction_end" && event.errorMessage) {
			this.recordRuntimeError(handle, String(event.errorMessage));
		}

		// Track background agents from lifecycle events.
		if (type === "background_agent_start") {
			handle.backgroundAgents.set(event.agentId as string, {
				agentId: event.agentId as string,
				agentType: event.agentType as string,
				taskSummary: event.taskSummary as string,
				startedAt: new Date().toISOString(),
				status: "running",
				sessionDir: event.sessionDir as string | undefined,
			});
		}
		if (type === "background_agent_end") {
			const existing = handle.backgroundAgents.get(event.agentId as string);
			if (existing) {
				existing.status = event.success ? "completed" : "failed";
				existing.sessionFile = (event.sessionFile as string | undefined) ?? existing.sessionFile;
				this.pruneCompletedBackgroundAgents(handle);
			}
		}

		for (const listener of this.listeners) {
			try {
				listener(handle.key, event);
			} catch {
				// A broken SSE subscriber must not break event distribution.
			}
		}
	}

	private recordRuntimeError(handle: RuntimeHandle, message: string): void {
		handle.error = message;
		handle.attention.set("error", message);
	}

	private pruneCompletedBackgroundAgents(handle: RuntimeHandle): void {
		const evictable = [...handle.backgroundAgents.values()]
			.map((agent, index) => {
				const startedAtMs = Date.parse(agent.startedAt);
				return { agent, index, startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : 0 };
			})
			.filter(({ agent }) => agent.status !== "running")
			.sort((a, b) => a.startedAtMs - b.startedAtMs || a.index - b.index);
		const excess = evictable.length - MAX_COMPLETED_BACKGROUND_AGENTS;
		if (excess <= 0) return;
		for (const { agent } of evictable.slice(0, excess)) {
			handle.backgroundAgents.delete(agent.agentId);
		}
	}

	private fallbackState(handle: RuntimeHandle): SessionStateDto {
		return {
			sessionId: handle.lastState?.sessionId ?? handle.key,
			sessionName: handle.lastState?.sessionName,
			thinkingLevel: handle.lastState?.thinkingLevel ?? "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: handle.lastState?.steeringMode ?? "all",
			followUpMode: handle.lastState?.followUpMode ?? "all",
			sessionFile: handle.lastState?.sessionFile,
			autoCompactionEnabled: handle.lastState?.autoCompactionEnabled ?? false,
			messageCount: handle.lastState?.messageCount ?? 0,
			pendingMessageCount: handle.lastState?.pendingMessageCount ?? 0,
			contextUsage: handle.lastState?.contextUsage,
			model: handle.lastState?.model,
			modelFallbackMessage: handle.lastState?.modelFallbackMessage,
		};
	}

	private async seedBackgroundAgents(handle: RuntimeHandle): Promise<void> {
		try {
			const agents = (await handle.client.listBackgroundAgents()) as unknown as BackgroundAgentDto[];
			for (const agent of agents) {
				handle.backgroundAgents.set(agent.agentId, agent);
			}
			this.pruneCompletedBackgroundAgents(handle);
		} catch (err) {
			this.logger(
				`runtime ${handle.key} background-agent registry unavailable: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/** Snapshot a runtime for the fleet endpoint. */
	async describe(handle: RuntimeHandle): Promise<RuntimeInfoDto> {
		let state: SessionStateDto;
		try {
			state = (await handle.client.getState()) as unknown as SessionStateDto;
			handle.lastState = state;
			if (handle.error?.startsWith("RPC process")) {
				handle.error = undefined;
				handle.attention.delete("error");
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.recordRuntimeError(handle, message);
			this.logger(`runtime ${handle.key} state unavailable for fleet card: ${message}`);
			state = this.fallbackState(handle);
		}
		let stats: RuntimeStatsSummaryDto | undefined;
		try {
			const sessionStats = await handle.client.getSessionStats();
			stats = { tokensTotal: sessionStats.tokens.total, cost: sessionStats.cost };
		} catch (err) {
			this.logger(
				`runtime ${handle.key} stats unavailable for fleet card: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		let lastAssistantText: string | undefined;
		try {
			const text = await handle.client.getLastAssistantText();
			lastAssistantText = text ? text.slice(0, 200) : undefined;
		} catch (err) {
			this.logger(
				`runtime ${handle.key} last assistant text unavailable for fleet card: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return {
			key: handle.key,
			cwd: handle.cwd,
			state,
			stats,
			backgroundAgents: [...handle.backgroundAgents.values()],
			needsAttention: handle.attention.size > 0,
			error: handle.error,
			lastAssistantText,
			createdAt: new Date(handle.createdAt).toISOString(),
			lastActivity: new Date(handle.lastActivity).toISOString(),
		};
	}
}
