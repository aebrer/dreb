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
import { RpcClient } from "@dreb/coding-agent/rpc";
import type {
	BackgroundAgentDto,
	RuntimeInfoDto,
	RuntimeStatsSummaryDto,
	SessionStateDto,
} from "../shared/protocol.js";

/** Resolve the absolute path to the dreb CLI (RpcClient defaults to a cwd-relative path). */
export function resolveDrebCliPath(): string {
	const resolved = import.meta.resolve("@dreb/coding-agent");
	return join(dirname(fileURLToPath(resolved)), "cli.js");
}

export type RuntimeEventListener = (key: string, event: Record<string, unknown>) => void;

export interface RuntimeHandle {
	key: string;
	cwd: string;
	client: RpcClient;
	/** Session start time (ms epoch) — stable tiebreak for deterministic fleet ordering. */
	createdAt: number;
	lastActivity: number;
	/** Needs-attention sources, keyed so they can be cleared independently. */
	attention: Map<string, string>;
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
	private utility?: RuntimeHandle;
	private utilityPromise?: Promise<RuntimeHandle>;

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
		await client.start();
		this.runtimes.set(key, handle);
		return handle;
	}

	/** Stop a runtime and remove it from the pool. */
	async stop(key: string): Promise<boolean> {
		const handle = this.runtimes.get(key);
		if (!handle) return false;
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
	async ensureUtilityRuntime(): Promise<RuntimeHandle> {
		const existing = this.runtimes.values().next().value as RuntimeHandle | undefined;
		if (existing) return existing;
		if (this.utility) return this.utility;
		if (!this.utilityPromise) {
			this.utilityPromise = (async () => {
				const cwd = homedir();
				const args = ["--ui", "dashboard", ...this.baseArgs];
				const client = this.clientFactory({ cliPath: this.cliPath, cwd, args });
				const handle: RuntimeHandle = {
					key: "utility",
					cwd,
					client,
					createdAt: Date.now(),
					lastActivity: Date.now(),
					attention: new Map(),
					backgroundAgents: new Map(),
				};
				await client.start();
				this.utility = handle;
				return handle;
			})().catch((err) => {
				// Allow a retry on the next request instead of caching the failure.
				this.utilityPromise = undefined;
				throw err;
			});
		}
		return this.utilityPromise;
	}

	async stopAll(): Promise<void> {
		const keys = [...this.runtimes.keys()];
		await Promise.allSettled(keys.map((k) => this.stop(k)));
		if (this.utility) {
			const utility = this.utility;
			this.utility = undefined;
			this.utilityPromise = undefined;
			await utility.client.stop().catch(() => {});
		}
	}

	private handleEvent(handle: RuntimeHandle, event: Record<string, unknown>): void {
		handle.lastActivity = Date.now();
		const type = event.type as string;

		// Track needs-attention sources (SPEC §1: extension UI requests, parent
		// paused, error states).
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

	/** Snapshot a runtime for the fleet endpoint. */
	async describe(handle: RuntimeHandle): Promise<RuntimeInfoDto> {
		const state = (await handle.client.getState()) as unknown as SessionStateDto;
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
			lastAssistantText,
			createdAt: new Date(handle.createdAt).toISOString(),
			lastActivity: new Date(handle.lastActivity).toISOString(),
		};
	}
}
