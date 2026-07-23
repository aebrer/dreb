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
	type FleetRuntimeSnapshotDto,
	type FleetSnapshotEventDto,
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

/** Listener for coalesced, synchronous fleet runtime snapshots. */
export type FleetSnapshotListener = (event: FleetSnapshotEventDto) => void;

export { MAX_COMPLETED_BACKGROUND_AGENTS };

interface RpcDashboardSnapshot {
	snapshotId: string;
	state: SessionStateDto;
	messages: unknown[];
	backgroundAgents: BackgroundAgentDto[];
}

type DashboardSnapshotClient = RpcClient & { getDashboardSnapshot(): Promise<RpcDashboardSnapshot> };

export interface DashboardRuntimeSnapshot {
	key: string;
	barrierSeq: number;
	snapshot: RpcDashboardSnapshot;
}

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
	/** Last authoritative state, patched only with event-derivable fields between RPC reads. */
	lastState?: SessionStateDto;
	/** Resume-path fallback; events must never invent or overwrite session identity. */
	sessionFileFallback?: string;
	/** Background agents seen via events (agentId → latest info). */
	backgroundAgents: Map<string, BackgroundAgentDto>;
}

export const DEFAULT_DASHBOARD_BARRIER_TTL_MS = 5 * 60_000;
export const DEFAULT_DASHBOARD_BARRIER_LIMIT = 1000;
export const DEFAULT_FLEET_SNAPSHOT_DEBOUNCE_MS = 200;

/** Events that mutate a field carried by the lightweight fleet snapshot. */
const FLEET_SNAPSHOT_EVENT_TYPES = new Set([
	"agent_start",
	"agent_end",
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_end",
	"background_agent_start",
	"background_agent_end",
	"extension_ui_request",
	"extension_ui_response_handled",
	"message_start",
	"parent_paused_for_background_agents",
	"runtime_removed",
	"session_name_changed",
	"suggest_next",
	"tasks_update",
]);

export interface RuntimePoolOptions {
	cliPath?: string;
	/** Extra args for every runtime (e.g. --provider). */
	baseArgs?: string[];
	/** RpcClient factory override for tests. */
	clientFactory?: (options: { cliPath: string; cwd: string; args: string[] }) => RpcClient;
	logger?: (line: string) => void;
	/** Bounds unclaimed RPC snapshot ordering records. */
	dashboardBarrierTtlMs?: number;
	dashboardBarrierLimit?: number;
	/** Injectable clock for deterministic barrier-expiry tests. */
	now?: () => number;
	/** Coalescing delay for event-derived fleet snapshot emissions. */
	fleetSnapshotDebounceMs?: number;
}

interface DashboardBarrier {
	seq: number;
	recordedAt: number;
}

export class RuntimePool {
	private readonly runtimes = new Map<string, RuntimeHandle>();
	private readonly listeners: RuntimeEventListener[] = [];
	private readonly fleetSnapshotListeners: FleetSnapshotListener[] = [];
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
	/** Snapshot ordering records observed synchronously from RpcClient stdout. */
	private readonly dashboardBarriers = new Map<string, DashboardBarrier>();
	private readonly dashboardBarrierTtlMs: number;
	private readonly dashboardBarrierLimit: number;
	private readonly now: () => number;
	private readonly fleetSnapshotDebounceMs: number;
	private dashboardBarrierPruneTimer: ReturnType<typeof setTimeout> | undefined;
	private fleetSnapshotTimer: ReturnType<typeof setTimeout> | undefined;
	private closing = false;

	constructor(options: RuntimePoolOptions = {}) {
		this.cliPath = options.cliPath ?? resolveDrebCliPath();
		this.baseArgs = options.baseArgs ?? [];
		this.clientFactory =
			options.clientFactory ?? ((o) => new RpcClient({ cliPath: o.cliPath, cwd: o.cwd, args: o.args }));
		this.logger = options.logger ?? ((line) => console.warn(`[dashboard] ${line}`));
		this.dashboardBarrierTtlMs = options.dashboardBarrierTtlMs ?? DEFAULT_DASHBOARD_BARRIER_TTL_MS;
		this.dashboardBarrierLimit = options.dashboardBarrierLimit ?? DEFAULT_DASHBOARD_BARRIER_LIMIT;
		this.now = options.now ?? Date.now;
		this.fleetSnapshotDebounceMs = options.fleetSnapshotDebounceMs ?? DEFAULT_FLEET_SNAPSHOT_DEBOUNCE_MS;
	}

	/** Subscribe to events from every runtime, tagged with the runtime key. */
	onEvent(listener: RuntimeEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const i = this.listeners.indexOf(listener);
			if (i !== -1) this.listeners.splice(i, 1);
		};
	}

	/** Subscribe to debounced, in-memory fleet snapshots. */
	onFleetSnapshot(listener: FleetSnapshotListener): () => void {
		this.fleetSnapshotListeners.push(listener);
		return () => {
			const i = this.fleetSnapshotListeners.indexOf(listener);
			if (i !== -1) this.fleetSnapshotListeners.splice(i, 1);
		};
	}

	/**
	 * Build the fleet's live-runtime view without RPC or disk access. Map
	 * insertion order is retained intentionally; the UI owns presentation order.
	 */
	fleetSnapshot(): FleetRuntimeSnapshotDto[] {
		return [...this.runtimes.values()].map((handle) => this.describeFleetRuntime(handle));
	}

	list(): RuntimeHandle[] {
		return [...this.runtimes.values()];
	}

	get(key: string): RuntimeHandle | undefined {
		return this.runtimes.get(key);
	}

	/**
	 * Record the EventHub sequence synchronously when the RPC snapshot marker
	 * arrives. The marker line precedes its response on stdout, so this runs
	 * before the RpcClient response continuation even across separate chunks.
	 */
	recordDashboardBarrier(runtimeKey: string, snapshotId: string, seq: number): void {
		this.pruneDashboardBarriers();
		this.dashboardBarriers.set(this.dashboardBarrierKey(runtimeKey, snapshotId), { seq, recordedAt: this.now() });
		this.pruneDashboardBarriers();
	}

	/**
	 * Capture a parent-session recovery snapshot and pair it with the sequence
	 * captured at its RPC marker. This deliberately does not infer ordering from
	 * await: later EventHub publications naturally have higher sequence numbers.
	 */
	async snapshotDashboard(handle: RuntimeHandle): Promise<DashboardRuntimeSnapshot> {
		const snapshot = await (handle.client as DashboardSnapshotClient).getDashboardSnapshot();
		this.pruneDashboardBarriers();
		const barrierKey = this.dashboardBarrierKey(handle.key, snapshot.snapshotId);
		const barrier = this.dashboardBarriers.get(barrierKey);
		this.dashboardBarriers.delete(barrierKey);
		this.scheduleDashboardBarrierPrune();
		if (!barrier) {
			throw new Error(`Dashboard snapshot ${snapshot.snapshotId} arrived without its ordering barrier`);
		}
		// This is an authoritative RPC baseline, so it may legitimately lower the
		// count after a fork/rewind instead of retaining an event-derived maximum.
		handle.lastState = snapshot.state;
		this.scheduleFleetSnapshot();
		return { key: handle.key, barrierSeq: barrier.seq, snapshot };
	}

	private dashboardBarrierKey(runtimeKey: string, snapshotId: string): string {
		return `${runtimeKey}\0${snapshotId}`;
	}

	private pruneDashboardBarriers(): void {
		const oldestAllowed = this.now() - this.dashboardBarrierTtlMs;
		for (const [snapshotId, barrier] of this.dashboardBarriers) {
			if (barrier.recordedAt < oldestAllowed) this.dashboardBarriers.delete(snapshotId);
		}
		while (this.dashboardBarriers.size > this.dashboardBarrierLimit) {
			const oldest = this.dashboardBarriers.keys().next().value;
			if (oldest === undefined) break;
			this.dashboardBarriers.delete(oldest);
		}
		this.scheduleDashboardBarrierPrune();
	}

	private scheduleDashboardBarrierPrune(): void {
		if (this.dashboardBarrierPruneTimer) clearTimeout(this.dashboardBarrierPruneTimer);
		this.dashboardBarrierPruneTimer = undefined;
		let oldest: DashboardBarrier | undefined;
		for (const barrier of this.dashboardBarriers.values()) {
			if (!oldest || barrier.recordedAt < oldest.recordedAt) oldest = barrier;
		}
		if (!oldest) return;
		const delay = Math.max(1, oldest.recordedAt + this.dashboardBarrierTtlMs - this.now() + 1);
		this.dashboardBarrierPruneTimer = setTimeout(() => {
			this.dashboardBarrierPruneTimer = undefined;
			this.pruneDashboardBarriers();
		}, delay);
		this.dashboardBarrierPruneTimer.unref?.();
	}

	private scheduleFleetSnapshot(): void {
		if (this.closing) return;
		if (this.fleetSnapshotTimer) clearTimeout(this.fleetSnapshotTimer);
		this.fleetSnapshotTimer = setTimeout(() => {
			this.fleetSnapshotTimer = undefined;
			if (this.closing) return;
			const event: FleetSnapshotEventDto = { type: "fleet_snapshot", runtimes: this.fleetSnapshot() };
			for (const listener of this.fleetSnapshotListeners) {
				try {
					listener(event);
				} catch {
					// An SSE bridge subscriber must not break the pool's event loop.
				}
			}
		}, this.fleetSnapshotDebounceMs);
		this.fleetSnapshotTimer.unref?.();
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
			createdAt: this.now(),
			lastActivity: this.now(),
			attention: new Map(),
			sessionFileFallback: sessionPath,
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
			this.scheduleFleetSnapshot();
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
		this.scheduleFleetSnapshot();
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
				createdAt: this.now(),
				lastActivity: this.now(),
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
		if (this.dashboardBarrierPruneTimer) clearTimeout(this.dashboardBarrierPruneTimer);
		this.dashboardBarrierPruneTimer = undefined;
		if (this.fleetSnapshotTimer) clearTimeout(this.fleetSnapshotTimer);
		this.fleetSnapshotTimer = undefined;
		this.fleetSnapshotListeners.length = 0;
		this.dashboardBarriers.clear();
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
		const type = event.type as string;
		if (type !== "dashboard_snapshot_barrier") {
			handle.lastActivity = this.now();
			this.updateStateFromEvent(handle, event, type);
		}

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
			if (event.errorMessage) this.recordRuntimeError(handle, String(event.errorMessage));
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
		if (this.runtimes.get(handle.key) === handle && FLEET_SNAPSHOT_EVENT_TYPES.has(type)) {
			this.scheduleFleetSnapshot();
		}
	}

	/**
	 * Events intentionally patch only fields they can prove. Session identity,
	 * session file, configuration, and context usage remain from the last RPC
	 * baseline (or the stable creation fallback) until a later reconciliation.
	 */
	private updateStateFromEvent(handle: RuntimeHandle, event: Record<string, unknown>, type: string): void {
		const state = this.fallbackState(handle);
		switch (type) {
			case "agent_start": {
				const model = event.model;
				if (
					model &&
					typeof model === "object" &&
					typeof (model as Record<string, unknown>).provider === "string" &&
					typeof (model as Record<string, unknown>).id === "string"
				) {
					const nextModel = model as { provider: string; id: string };
					state.model =
						state.model?.provider === nextModel.provider && state.model.id === nextModel.id
							? { ...state.model, ...nextModel }
							: nextModel;
				}
				state.isStreaming = true;
				break;
			}
			case "agent_end":
				state.isStreaming = false;
				break;
			case "auto_compaction_start":
				state.isCompacting = true;
				break;
			case "auto_compaction_end":
				state.isCompacting = false;
				break;
			case "tasks_update":
				if (Array.isArray(event.tasks)) state.tasks = [...event.tasks] as SessionStateDto["tasks"];
				break;
			case "session_name_changed":
				if (typeof event.name === "string") state.sessionName = event.name;
				break;
			case "message_start":
				state.messageCount += 1;
				break;
		}
		handle.lastState = state;
	}

	private recordRuntimeError(handle: RuntimeHandle, message: string): void {
		handle.error = message;
		handle.attention.set("error", message);
		if (this.runtimes.get(handle.key) === handle) this.scheduleFleetSnapshot();
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
		const previous = handle.lastState;
		return {
			...previous,
			sessionId: previous?.sessionId ?? handle.key,
			tasks: previous?.tasks ? [...previous.tasks] : [],
			thinkingLevel: previous?.thinkingLevel ?? "off",
			isStreaming: previous?.isStreaming ?? false,
			isCompacting: previous?.isCompacting ?? false,
			steeringMode: previous?.steeringMode ?? "all",
			followUpMode: previous?.followUpMode ?? "all",
			sessionFile: previous?.sessionFile ?? handle.sessionFileFallback,
			autoCompactionEnabled: previous?.autoCompactionEnabled ?? false,
			messageCount: previous?.messageCount ?? 0,
			pendingMessageCount: previous?.pendingMessageCount ?? 0,
		};
	}

	private describeFleetRuntime(handle: RuntimeHandle): FleetRuntimeSnapshotDto {
		const state = this.fallbackState(handle);
		return {
			key: handle.key,
			cwd: handle.cwd,
			state,
			backgroundAgents: [...handle.backgroundAgents.values()].map((agent) => ({ ...agent })),
			needsAttention: handle.attention.size > 0,
			error: handle.error,
			createdAt: new Date(handle.createdAt).toISOString(),
			lastActivity: new Date(handle.lastActivity).toISOString(),
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
			const authoritative = (await handle.client.getState()) as unknown as SessionStateDto;
			const fallback = this.fallbackState(handle);
			state = {
				...fallback,
				...authoritative,
				sessionId: authoritative.sessionId ?? fallback.sessionId,
				sessionFile: authoritative.sessionFile ?? fallback.sessionFile,
				tasks: authoritative.tasks ?? fallback.tasks,
			};
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
			if (sessionStats.contextUsage) {
				handle.lastState = { ...this.fallbackState(handle), contextUsage: sessionStats.contextUsage };
			}
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
