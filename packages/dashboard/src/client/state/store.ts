/**
 * App store — Solid reactive wrapper around the pure reducer. The reducer
 * mutates plain objects; this store uses the Solid store as the source of
 * truth and applies reducer mutations through produce for fine-grained updates.
 */

import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type {
	ActiveRuntimeSnapshotDto,
	AuthStatusDto,
	EventEnvelope,
	FleetDto,
	FleetRuntimeSnapshotDto,
	FleetSnapshotEventDto,
	RuntimeInfoDto,
	SessionStatsDto,
} from "../../shared/protocol.js";
import { api, connectEvents, type EventConnectionStatus } from "../api.js";
import { evictComposerMemory } from "./composer-memory.js";
import {
	applySessionEvent,
	capBackgroundAgents,
	createSessionViewState,
	dismissToast as dismissReducerToast,
	messagesToEntries,
	type SessionViewState,
	type Toast,
	updateAttention,
} from "./reducer.js";

export type Route =
	| { screen: "fleet" }
	| { screen: "session"; key: string }
	| { screen: "subagent"; key: string; agentId: string }
	| { screen: "files"; path?: string }
	| { screen: "settings" }
	| { screen: "pairing" };

function parseHash(): Route {
	const hash = window.location.hash.replace(/^#\/?/, "");
	const [head, ...rest] = hash.split("/");
	if (head === "session" && rest[0]) {
		if (rest[1] === "subagent" && rest[2]) return { screen: "subagent", key: rest[0], agentId: rest[2] };
		return { screen: "session", key: rest[0] };
	}
	if (head === "files") return { screen: "files", path: rest.length ? decodeURIComponent(rest.join("/")) : undefined };
	if (head === "settings") return { screen: "settings" };
	if (head === "pairing") return { screen: "pairing" };
	return { screen: "fleet" };
}

export function routeToHash(route: Route): string {
	switch (route.screen) {
		case "fleet":
			return "#/";
		case "session":
			return `#/session/${route.key}`;
		case "subagent":
			return `#/session/${route.key}/subagent/${route.agentId}`;
		case "files":
			return route.path ? `#/files/${encodeURIComponent(route.path)}` : "#/files";
		case "settings":
			return "#/settings";
		case "pairing":
			return "#/pairing";
	}
}

const MAX_NOTICES = 20;
const MAX_PENDING_RESYNC_ENVELOPES = 2_000;
/** Matches the server's replay budget and bounds projected frame retention in the browser. */
const MAX_PENDING_RESYNC_BYTES = 3 * 1024 * 1024;
/** A hydrate is also a snapshot/replay transaction, with the same bounded browser budget. */
const MAX_PENDING_HYDRATION_ENVELOPES = MAX_PENDING_RESYNC_ENVELOPES;
const MAX_PENDING_HYDRATION_BYTES = MAX_PENDING_RESYNC_BYTES;
const RESYNC_TIMEOUT_MS = 30_000;
const RESYNC_RETRY_BASE_MS = 1_000;
const RESYNC_RETRY_MAX_MS = 30_000;
const textEncoder = new TextEncoder();

interface PendingResync {
	queued: EventEnvelope[];
	queuedBytes: number;
	state: "active" | "failed";
	controller: AbortController;
	barrierSeq?: number;
}

interface HydrationGuardToken {
	revision: number;
	generation: number;
	epoch: number;
}

interface PendingHydration {
	guard: HydrationGuardToken;
	queued: EventEnvelope[];
	queuedBytes: number;
}

export function createAppStore() {
	// sessions: reactive source of truth; reducer mutations are applied through
	// Solid's produce so text deltas touch only the mutated leaf.
	const [sessions, setSessions] = createStore<Record<string, SessionViewState>>({});
	// Per-session monotonic revision — bumped on EVERY applied envelope, including
	// in-place streaming mutations that don't change entries.length. Autoscroll
	// effects subscribe to this (entries.length alone misses text deltas).
	const [revisions, setRevisions] = createStore<Record<string, number>>({});
	const [route, setRouteSignal] = createSignal<Route>(parseHash());
	const [fleet, setFleet] = createSignal<FleetDto>({ runtimes: [], diskSessions: [] });
	const [fleetError, setFleetError] = createSignal<string>();
	const [fleetStatsError, setFleetStatsError] = createSignal<string>();
	const [resyncError, setResyncError] = createSignal<string>();
	const [resyncing, setResyncing] = createSignal(false);
	const [auth, setAuth] = createSignal<(AuthStatusDto & { needsPairing?: boolean; error?: string }) | undefined>();
	const [connection, setConnection] = createSignal<EventConnectionStatus>({ state: "disconnected", attempt: 0 });
	const connected = () => connection().state === "connected";
	const [notices, setNotices] = createSignal<Toast[]>([]);
	const hydrationGenerations = new Map<string, number>();
	const taskRevisions = new Map<string, number>();
	/** Per-key HTTP snapshot/replay transactions. Live envelopes still render immediately. */
	const pendingHydrations = new Map<string, PendingHydration>();
	let hydrationEpoch = 0;
	let noticeCounter = 0;
	let resyncPromise: Promise<void> | undefined;
	let pendingResync: PendingResync | undefined;
	let resyncRetryTimer: ReturnType<typeof setTimeout> | undefined;
	let resyncRetryPreviousConnection: EventConnectionStatus | undefined;
	let resyncRetryOwnsConnectionStatus = false;
	let resyncRetryAttempt = 0;
	let retryAfterCurrentResync = false;
	let authoritativeBarrierSeq: number | undefined;
	/** Invalidates in-flight full fleet reads after any narrower authoritative mutation. */
	let fleetMutationGeneration = 0;
	let latestFleetRequestGeneration = 0;
	/** Latest inventory request wins, so a slow earlier response cannot regress disk rows. */
	let latestDiskSessionsRequestGeneration = 0;
	let fleetStatsPromise: Promise<void> | undefined;
	/** Runtime keys removed by lifecycle events cannot be revived by an older snapshot. */
	const removedRuntimeKeys = new Set<string>();
	let stopped = false;

	window.addEventListener("hashchange", () => setRouteSignal(parseHash()));

	function navigate(next: Route): void {
		window.location.hash = routeToHash(next);
	}

	function currentRevision(key: string): number {
		return revisions[key] ?? 0;
	}

	function currentHydrationGeneration(key: string): number {
		return hydrationGenerations.get(key) ?? 0;
	}

	function currentTaskRevision(key: string): number {
		return taskRevisions.get(key) ?? 0;
	}

	function bumpTaskRevision(key: string): void {
		taskRevisions.set(key, currentTaskRevision(key) + 1);
	}

	function bumpHydrationGeneration(key: string): void {
		hydrationGenerations.set(key, currentHydrationGeneration(key) + 1);
	}

	function captureHydrationGuard(key: string): HydrationGuardToken {
		return {
			revision: currentRevision(key),
			generation: currentHydrationGeneration(key),
			epoch: hydrationEpoch,
		};
	}

	function hydrationIdentityMatches(key: string, guard: HydrationGuardToken): boolean {
		return currentHydrationGeneration(key) === guard.generation && hydrationEpoch === guard.epoch;
	}

	function hydrationGuardMatches(key: string, guard: HydrationGuardToken): boolean {
		return currentRevision(key) === guard.revision && hydrationIdentityMatches(key, guard);
	}

	function clearHydrationTransaction(key: string, pending?: PendingHydration): void {
		if (pending && pendingHydrations.get(key) !== pending) return;
		pendingHydrations.delete(key);
		if (pending) {
			pending.queued = [];
			pending.queuedBytes = 0;
		}
	}

	function bumpRevision(key: string): void {
		setRevisions(key, currentRevision(key) + 1);
	}

	function ensureSession(key: string): void {
		if (!sessions[key]) setSessions(key, createSessionViewState(key));
	}

	function mutateSession(key: string, mutator: (session: SessionViewState) => void): void {
		ensureSession(key);
		setSessions(key, produce(mutator));
		bumpRevision(key);
	}

	function deleteSessionState(key: string): void {
		clearHydrationTransaction(key);
		bumpHydrationGeneration(key);
		taskRevisions.delete(key);
		setSessions(key, undefined!);
		setRevisions(key, undefined!);
		evictComposerMemory(key);
	}

	function routedSessionKey(): string | undefined {
		const current = parseHash();
		return current.screen === "session" || current.screen === "subagent" ? current.key : undefined;
	}

	function pushNotice(text: string, tone: Toast["tone"] = "info"): void {
		noticeCounter -= 1;
		setNotices((current) => [...current, { id: noticeCounter, text, tone }].slice(-MAX_NOTICES));
	}

	function mutateFleet(mutator: (current: FleetDto) => FleetDto): void {
		fleetMutationGeneration += 1;
		setFleet(mutator);
	}

	function replaceFleet(next: FleetDto): void {
		removedRuntimeKeys.clear();
		mutateFleet(() => next);
	}

	/**
	 * Fleet SSE frames intentionally omit REST-enriched card fields. Preserve
	 * those values, plus monotonic message/context data, while replacing the
	 * event-derived runtime membership as one Solid signal update.
	 */
	function applyFleetSnapshot(runtimes: FleetRuntimeSnapshotDto[]): void {
		const nextKeys = new Set(
			runtimes.filter((runtime) => !removedRuntimeKeys.has(runtime.key)).map((runtime) => runtime.key),
		);
		const membershipChanged =
			nextKeys.size !== fleet().runtimes.length || fleet().runtimes.some((runtime) => !nextKeys.has(runtime.key));
		mutateFleet((current) => {
			const existing = new Map(current.runtimes.map((runtime) => [runtime.key, runtime]));
			return {
				...current,
				runtimes: runtimes
					.filter((runtime) => !removedRuntimeKeys.has(runtime.key))
					.map((runtime): RuntimeInfoDto => {
						const previous = existing.get(runtime.key);
						return {
							...runtime,
							state: {
								...runtime.state,
								// Context usage is refreshed through the slower authoritative stats
								// path. Message count belongs to this sequenced snapshot and may
								// legitimately decrease after a fork/rewind.
								contextUsage: previous?.state.contextUsage ?? runtime.state.contextUsage,
							},
							...(previous?.stats === undefined ? {} : { stats: previous.stats }),
							...(previous?.lastAssistantText === undefined
								? {}
								: { lastAssistantText: previous.lastAssistantText }),
						};
					}),
			};
		});
		if (membershipChanged) void refreshDiskSessions().catch(() => {});
	}

	function removeFleetRuntime(key: string): void {
		removedRuntimeKeys.add(key);
		// Bump even when the card was not rendered: an older full response must
		// still be unable to resurrect a just-removed runtime.
		mutateFleet((current) => ({ ...current, runtimes: current.runtimes.filter((runtime) => runtime.key !== key) }));
		void refreshDiskSessions().catch(() => {});
	}

	function refreshFleet(): Promise<void> {
		const requestGeneration = ++latestFleetRequestGeneration;
		const mutationAtRequest = fleetMutationGeneration;
		return api.fleet().then(
			(next) => {
				if (requestGeneration !== latestFleetRequestGeneration || mutationAtRequest !== fleetMutationGeneration) {
					return;
				}
				replaceFleet(next);
				setFleetError(undefined);
			},
			(err) => {
				if (requestGeneration === latestFleetRequestGeneration && mutationAtRequest === fleetMutationGeneration) {
					setFleetError(err instanceof Error ? err.message : String(err));
				}
				throw err;
			},
		);
	}

	function refreshDiskSessions(): Promise<void> {
		const requestGeneration = ++latestDiskSessionsRequestGeneration;
		return api.sessions().then(
			(inventory) => {
				if (requestGeneration !== latestDiskSessionsRequestGeneration) return;
				mutateFleet((current) => ({ ...current, diskSessions: inventory.sessions }));
				setFleetError(undefined);
			},
			(err) => {
				if (requestGeneration === latestDiskSessionsRequestGeneration) {
					setFleetError(err instanceof Error ? err.message : String(err));
				}
				throw err;
			},
		);
	}

	/** Insert or replace one authoritative runtime without requiring a fleet read. */
	function upsertRuntime(runtime: RuntimeInfoDto): void {
		removedRuntimeKeys.delete(runtime.key);
		mutateFleet((current) => {
			const index = current.runtimes.findIndex((existing) => existing.key === runtime.key);
			if (index === -1) return { ...current, runtimes: [...current.runtimes, runtime] };
			const runtimes = [...current.runtimes];
			runtimes[index] = runtime;
			return { ...current, runtimes };
		});
	}

	/** Apply the runtime state from an atomic hydrate, including legitimate rewinds. */
	function setHydratedRuntimeState(key: string, state: RuntimeInfoDto["state"]): void {
		// SessionScreen can hydrate while start()'s initial fleet request is still
		// pending. A no-op patch must not invalidate that authoritative first load.
		if (!fleet().runtimes.some((runtime) => runtime.key === key)) return;
		mutateFleet((current) => ({
			...current,
			runtimes: current.runtimes.map((runtime) => (runtime.key === key ? { ...runtime, state } : runtime)),
		}));
	}

	/** Patch the card immediately from the authoritative set-model response. */
	function setRuntimeModel(key: string, model: { provider: string; id: string }): void {
		mutateFleet((current) => ({
			...current,
			runtimes: current.runtimes.map((runtime) =>
				runtime.key === key ? { ...runtime, state: { ...runtime.state, model } } : runtime,
			),
		}));
	}

	/** Patch thinking state after the direct RPC response; no session event carries it. */
	function setRuntimeThinkingLevel(key: string, thinkingLevel: string): void {
		mutateFleet((current) => ({
			...current,
			runtimes: current.runtimes.map((runtime) =>
				runtime.key === key ? { ...runtime, state: { ...runtime.state, thinkingLevel } } : runtime,
			),
		}));
	}

	function mergeRuntimeStats(
		runtime: RuntimeInfoDto,
		stats: SessionStatsDto,
		liveStateRaced: boolean,
	): RuntimeInfoDto {
		return {
			...runtime,
			state: {
				...runtime.state,
				...(stats.contextUsage === undefined ? {} : { contextUsage: stats.contextUsage }),
				// Stats is authoritative unless a newer fleet mutation landed while it
				// was in flight; then it must not rewind that newer live state.
				messageCount: liveStateRaced
					? Math.max(runtime.state.messageCount, stats.totalMessages)
					: stats.totalMessages,
			},
			stats: { tokensTotal: stats.tokens.total, cost: stats.cost },
		};
	}

	function refreshFleetStats(): Promise<void> {
		if (fleetStatsPromise) return fleetStatsPromise;
		const mutationAtRequest = fleetMutationGeneration;
		const keys = fleet().runtimes.map((runtime) => runtime.key);
		const requests = keys.map((key) => {
			try {
				return api.stats(key);
			} catch (error) {
				return Promise.reject(error);
			}
		});
		const promise = Promise.allSettled(requests)
			.then((results) => {
				const successful = new Map<string, SessionStatsDto>();
				const failures: string[] = [];
				for (const [index, result] of results.entries()) {
					if (result.status === "fulfilled") successful.set(keys[index], result.value);
					else failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
				}
				if (successful.size > 0) {
					// Re-read membership at application time. Results for removed runtimes
					// are discarded rather than creating a stale card.
					const liveStateRaced = fleetMutationGeneration !== mutationAtRequest;
					mutateFleet((current) => ({
						...current,
						runtimes: current.runtimes.map((runtime) => {
							const stats = successful.get(runtime.key);
							return stats ? mergeRuntimeStats(runtime, stats, liveStateRaced) : runtime;
						}),
					}));
				}
				setFleetStatsError(failures.length > 0 ? failures.join("; ") : undefined);
			})
			.finally(() => {
				if (fleetStatsPromise === promise) fleetStatsPromise = undefined;
			});
		fleetStatsPromise = promise;
		return promise;
	}

	function encodedEnvelopeBytes(envelope: EventEnvelope): number {
		return textEncoder.encode(JSON.stringify(envelope)).byteLength;
	}

	function clearPendingQueue(pending: PendingResync): void {
		pending.queued = [];
		pending.queuedBytes = 0;
	}

	function clearResyncRetry(): void {
		if (resyncRetryTimer !== undefined) clearTimeout(resyncRetryTimer);
		resyncRetryTimer = undefined;
	}

	function resyncRetryDelay(): number {
		return Math.min(RESYNC_RETRY_MAX_MS, RESYNC_RETRY_BASE_MS * 2 ** Math.max(0, resyncRetryAttempt - 1));
	}

	function scheduleResyncRetry(): void {
		if (stopped || resyncRetryTimer !== undefined) return;
		resyncRetryAttempt += 1;
		const delay = resyncRetryDelay();
		setResyncing(false);
		if (!resyncRetryPreviousConnection) resyncRetryPreviousConnection = connection();
		setConnection((current) => {
			if (current.state === "auth_failed") return current;
			resyncRetryOwnsConnectionStatus = true;
			return {
				...current,
				state: "retrying",
				attempt: Math.max(current.attempt, resyncRetryAttempt),
				retryDelayMs: delay,
				retryAt: Date.now() + delay,
			};
		});
		resyncRetryTimer = setTimeout(() => {
			resyncRetryTimer = undefined;
			void beginResync();
		}, delay);
	}

	function restoreConnectionAfterResyncRetry(): void {
		const previous = resyncRetryPreviousConnection;
		const ownsConnectionStatus = resyncRetryOwnsConnectionStatus;
		resyncRetryPreviousConnection = undefined;
		resyncRetryOwnsConnectionStatus = false;
		if (!ownsConnectionStatus || previous?.state !== "connected" || connection().state !== "retrying") return;
		setConnection({ state: "connected", attempt: previous.attempt, lastAppliedSeq: previous.lastAppliedSeq });
	}

	function applyEnvelope(envelope: EventEnvelope): void {
		const type = envelope.event?.type as string | undefined;
		if (type === "fleet_snapshot") {
			// This is a global event (key=""). It updates cards only and must never
			// create a synthetic session reducer entry under the empty key.
			applyFleetSnapshot((envelope.event as unknown as FleetSnapshotEventDto).runtimes);
		} else if (type === "disk_sessions_changed") {
			// A delete in another dashboard client should converge without bringing
			// back the expensive full fleet endpoint.
			void refreshDiskSessions().catch(() => {});
		} else if (type === "runtime_removed") {
			if (envelope.key) {
				const wasViewingRemovedRuntime = routedSessionKey() === envelope.key;
				removeFleetRuntime(envelope.key);
				deleteSessionState(envelope.key);
				if (wasViewingRemovedRuntime) {
					pushNotice(`session ${envelope.key} was stopped`, "warning");
					navigate({ screen: "fleet" });
				}
			}
		} else if (envelope.key) {
			mutateSession(envelope.key, (session) => applySessionEvent(session, envelope.event));
			if (type === "tasks_update") bumpTaskRevision(envelope.key);
		}
	}

	function hydrateSnapshot(active: ActiveRuntimeSnapshotDto): void {
		const subagent = active.subagent;
		mutateSession(active.key, (session) => {
			session.entries = messagesToEntries(active.messages as any[]);
			session.tasks = (active.state.tasks ?? []).map((task) => ({ ...task }));
			session.streaming = active.state.isStreaming;
			session.compacting = active.state.isCompacting;
			session.sessionName = active.state.sessionName;
			session.model = active.state.model?.id;
			session.contextUsage = active.state.contextUsage;
			// Authoritative recovery snapshots do not carry transient reducer UI
			// state. Clear pre-gap extension/status affordances so the restored
			// transcript/runtime state is the source of truth until replay applies
			// post-barrier events below.
			session.uiRequests = [];
			session.statusEntries = [];
			session.suggestedCommand = undefined;
			session.lastError = undefined;
			session.widgets = { above: [], below: [] };
			session.toasts = [];
			session.title = undefined;
			session.composerPrefill = undefined;
			updateAttention(session);
			if (session.streaming) {
				// The snapshot has no current-tool label or turn start time. Reset
				// both rather than preserving stale pre-gap working metadata.
				session.workingSince = Date.now();
				session.workingText = "working";
			} else {
				session.workingSince = undefined;
				session.workingText = undefined;
			}
			session.backgroundAgents = Object.fromEntries(active.backgroundAgents.map((agent) => [agent.agentId, agent]));
			capBackgroundAgents(session);
			if (subagent) {
				// The parent registry is captured after the subagent transcript, so it
				// is authoritative when it contains this agent.
				const agent =
					active.backgroundAgents.find((parentAgent) => parentAgent.agentId === subagent.agentId) ??
					subagent.agent;
				session.backgroundAgents[subagent.agentId] = agent;
				session.subagents[subagent.agentId] = {
					agentId: subagent.agentId,
					entries: messagesToEntries(subagent.messages as any[]),
					streaming: agent.status === "running",
				};
			}
		});
		bumpTaskRevision(active.key);
	}

	function finishResync(pending: PendingResync, snapshot: Awaited<ReturnType<typeof api.resync>>): void {
		if (pendingResync !== pending || pending.state !== "active" || pending.barrierSeq === undefined) return;
		clearResyncRetry();
		resyncRetryAttempt = 0;
		restoreConnectionAfterResyncRetry();
		const barrierSeq = pending.barrierSeq;
		authoritativeBarrierSeq = barrierSeq;
		replaceFleet(snapshot.fleet);
		setFleetError(undefined);
		if (snapshot.active) {
			hydrateSnapshot(snapshot.active);
		} else {
			const activeRouteKey = routedSessionKey();
			if (activeRouteKey) {
				deleteSessionState(activeRouteKey);
				pushNotice(`session ${activeRouteKey} was stopped`, "warning");
				navigate({ screen: "fleet" });
			}
		}
		// /api/resync's barrierSeq is the parent snapshot ordering point. The
		// subagent disk transcript is captured earlier, so relay its matching child
		// events between that boundary and the parent barrier before normal replay.
		const ordered = [...pending.queued].sort((a, b) => a.seq - b.seq);
		const subagent = snapshot.active?.subagent;
		if (subagent && snapshot.active) {
			for (const envelope of ordered) {
				if (
					envelope.seq > subagent.barrierSeq &&
					envelope.seq <= barrierSeq &&
					envelope.key === snapshot.active.key &&
					envelope.event.type === "background_agent_event" &&
					String(envelope.event.agentId) === subagent.agentId
				) {
					applyEnvelope(envelope);
				}
			}
		}
		for (const envelope of ordered) {
			if (envelope.seq > barrierSeq) applyEnvelope(envelope);
		}
		clearPendingQueue(pending);
		pendingResync = undefined;
		setResyncing(false);
		setResyncError(undefined);
	}

	function beginResync(queueAfterCurrent = false): Promise<void> {
		if (stopped) return Promise.resolve();
		if (resyncPromise) {
			if (queueAfterCurrent || pendingResync?.state === "failed") retryAfterCurrentResync = true;
			return resyncPromise;
		}
		clearResyncRetry();
		const current = route();
		const key = current.screen === "session" || current.screen === "subagent" ? current.key : undefined;
		const agentId = current.screen === "subagent" ? current.agentId : undefined;
		// A failed or overflowed transaction is intentionally discarded. Its queue
		// cannot safely be applied; this request obtains a newer authoritative view.
		const pending: PendingResync = { queued: [], queuedBytes: 0, state: "active", controller: new AbortController() };
		pendingResync = pending;
		// Invalidate pre-barrier REST hydrations without clearing the currently
		// rendered state; the ordered snapshot will replace it only once ready.
		hydrationEpoch += 1;
		for (const [hydrationKey, hydration] of pendingHydrations) {
			clearHydrationTransaction(hydrationKey, hydration);
		}
		setResyncing(true);
		setResyncError(undefined);
		const timeout = setTimeout(() => pending.controller.abort("Dashboard recovery timed out"), RESYNC_TIMEOUT_MS);
		const request = api
			.resync(key, agentId, pending.controller.signal)
			.then((snapshot) => {
				pending.barrierSeq = snapshot.barrierSeq;
				finishResync(pending, snapshot);
			})
			.catch((err) => {
				if (pendingResync !== pending) return;
				pending.state = "failed";
				clearPendingQueue(pending);
				const reason = pending.controller.signal.reason;
				setResyncError(typeof reason === "string" ? reason : err instanceof Error ? err.message : String(err));
				scheduleResyncRetry();
				if (resyncRetryTimer === undefined) setResyncing(false);
			})
			.finally(() => {
				clearTimeout(timeout);
				if (resyncPromise === request) resyncPromise = undefined;
				if (!stopped && retryAfterCurrentResync) {
					retryAfterCurrentResync = false;
					void beginResync();
				}
			});
		resyncPromise = request;
		return request;
	}

	function retryResync(): Promise<void> {
		return beginResync(true);
	}

	function handleEnvelope(envelope: EventEnvelope): void {
		const type = envelope.event?.type as string | undefined;
		if (type === "dashboard_resync") {
			// A later barrier may represent another gap beyond the in-flight snapshot.
			// Coalesce it into one sequential follow-up without overlapping requests.
			void beginResync(true);
			return;
		}
		if (pendingResync) {
			if (pendingResync.state === "failed") {
				scheduleResyncRetry();
				throw new Error(
					"Dashboard recovery is failed; refusing to acknowledge live envelope before resync succeeds",
				);
			}
			const envelopeBytes = encodedEnvelopeBytes(envelope);
			if (
				pendingResync.queued.length >= MAX_PENDING_RESYNC_ENVELOPES ||
				pendingResync.queuedBytes + envelopeBytes > MAX_PENDING_RESYNC_BYTES
			) {
				clearPendingQueue(pendingResync);
				pendingResync.state = "failed";
				const message = "Dashboard recovery queue overflowed; waiting for a newer authoritative snapshot";
				setResyncError(message);
				pendingResync.controller.abort(message);
				scheduleResyncRetry();
				if (resyncRetryTimer === undefined) setResyncing(false);
				throw new Error(message);
			}
			// Queue even a lower number while a restart transaction is active: its
			// replacement snapshot may establish a new sequence domain.
			pendingResync.queued.push(envelope);
			pendingResync.queuedBytes += envelopeBytes;
			return;
		}
		if (authoritativeBarrierSeq !== undefined && envelope.seq <= authoritativeBarrierSeq) return;
		const hydration = envelope.key ? pendingHydrations.get(envelope.key) : undefined;
		if (hydration) {
			const envelopeBytes = encodedEnvelopeBytes(envelope);
			if (
				hydration.queued.length >= MAX_PENDING_HYDRATION_ENVELOPES ||
				hydration.queuedBytes + envelopeBytes > MAX_PENDING_HYDRATION_BYTES
			) {
				clearHydrationTransaction(envelope.key, hydration);
				throw new Error(
					`Dashboard hydration queue overflowed for ${envelope.key}; refusing an incomplete snapshot replay`,
				);
			}
			// Render promptly while retaining every frame that may be newer than the
			// HTTP snapshot's explicit barrier for its later atomic replay.
			hydration.queued.push(envelope);
			hydration.queuedBytes += envelopeBytes;
		}
		applyEnvelope(envelope);
	}

	let disconnect: (() => void) | undefined;

	async function start(): Promise<void> {
		stopped = false;
		try {
			const status = await api.auth();
			setAuth(status);
		} catch (err: any) {
			setAuth({
				mode: "remote",
				needsPairing: err?.body?.needsPairing ?? false,
				identity: err?.body?.identity,
				error: err?.message,
			});
			navigate({ screen: "pairing" });
			return;
		}
		await refreshFleet().catch(() => {});
		disconnect = connectEvents({
			onEnvelope: handleEnvelope,
			onStatusChange: (status) => {
				resyncRetryOwnsConnectionStatus = false;
				resyncRetryPreviousConnection = status.state === "connected" ? status : undefined;
				setConnection(status);
			},
			onRecovery: () => {
				// connectEvents has already closed the stale source. The store owns the
				// authoritative snapshot transaction and dashboard_resync envelopes.
				void beginResync();
			},
		});
	}

	function stop(): void {
		stopped = true;
		disconnect?.();
		clearResyncRetry();
		resyncRetryPreviousConnection = undefined;
		resyncRetryOwnsConnectionStatus = false;
		retryAfterCurrentResync = false;
		const pending = pendingResync;
		pendingResync = undefined;
		if (pending) clearPendingQueue(pending);
		pending?.controller.abort("Dashboard stopped");
		for (const [key, hydration] of pendingHydrations) clearHydrationTransaction(key, hydration);
	}

	function dismissToast(id: number): void {
		if (notices().some((toast) => toast.id === id)) {
			setNotices((current) => current.filter((toast) => toast.id !== id));
			return;
		}
		for (const [key, session] of Object.entries(sessions)) {
			if (!session.toasts.some((toast) => toast.id === id)) continue;
			mutateSession(key, (draft) => dismissReducerToast(draft, id));
			return;
		}
	}

	/**
	 * Hydrate a session as an atomic snapshot/replay transaction. Live envelopes
	 * still update the screen immediately, then the snapshot replaces its baseline
	 * and only frames after its explicit barrier are replayed.
	 */
	async function hydrateSession(key: string, signal?: AbortSignal): Promise<void> {
		// A newer request supersedes an older one for this key even if both happen
		// to share the same generation.
		clearHydrationTransaction(key);
		const pending: PendingHydration = {
			guard: captureHydrationGuard(key),
			queued: [],
			queuedBytes: 0,
		};
		pendingHydrations.set(key, pending);
		const abortHydration = () => clearHydrationTransaction(key, pending);
		signal?.addEventListener("abort", abortHydration, { once: true });
		if (signal?.aborted) abortHydration();
		try {
			const snapshot = await api.hydrate(key, signal);
			// An aborted hydration (screen unmounted), removed runtime, started
			// resync, overflow, or superseding hydrate must not create phantom state.
			if (
				signal?.aborted ||
				pendingHydrations.get(key) !== pending ||
				!hydrationIdentityMatches(key, pending.guard)
			) {
				return;
			}
			mutateSession(key, (session) => {
				session.entries = messagesToEntries(snapshot.messages as any[]);
				session.backgroundAgents = Object.fromEntries(
					snapshot.backgroundAgents.map((agent) => [agent.agentId, agent]),
				);
				capBackgroundAgents(session);
				session.streaming = snapshot.state.isStreaming;
				session.compacting = snapshot.state.isCompacting;
				session.tasks = (snapshot.state.tasks ?? []).map((task) => ({ ...task }));
				if (snapshot.state.isStreaming) {
					session.workingSince = Date.now();
					session.workingText = "working";
				} else {
					session.workingSince = undefined;
					session.workingText = undefined;
				}
			});
			bumpTaskRevision(key);
			// The runtime snapshot is authoritative, including a lower count after a
			// fork or rewind. Preserve card-only enrichment on the surrounding card.
			setHydratedRuntimeState(key, snapshot.state);
			for (const envelope of [...pending.queued].sort((a, b) => a.seq - b.seq)) {
				if (envelope.seq > snapshot.barrierSeq) applyEnvelope(envelope);
			}
		} finally {
			signal?.removeEventListener("abort", abortHydration);
			clearHydrationTransaction(key, pending);
		}
	}

	/**
	 * Hydrate a subagent transcript from its on-disk session log. Live
	 * `background_agent_event` relays only exist for the page that was open
	 * when they streamed — after a reload this is the only data source.
	 */
	async function hydrateSubagent(key: string, agentId: string, signal?: AbortSignal): Promise<void> {
		const hydrationGuard = captureHydrationGuard(key);
		const { agent, messages } = await api.subagentMessages(key, agentId, signal);
		if (signal?.aborted || !hydrationGuardMatches(key, hydrationGuard)) return;
		mutateSession(key, (session) => {
			session.backgroundAgents[agentId] = agent;
			let sub = session.subagents[agentId];
			if (!sub) {
				sub = { agentId, entries: [], streaming: agent.status === "running" };
				session.subagents[agentId] = sub;
			}
			// Never clobber richer live state with an empty disk snapshot.
			if (messages.length > 0) sub.entries = messagesToEntries(messages as any[]);
			sub.streaming = agent.status === "running";
		});
	}

	return {
		sessions,
		/** Per-session revision counters — bump on every applied envelope (autoscroll dependency). */
		revisions,
		route,
		navigate,
		fleet,
		fleetError,
		fleetStatsError,
		refreshFleet,
		refreshDiskSessions,
		refreshFleetStats,
		upsertRuntime,
		setRuntimeModel,
		setRuntimeThinkingLevel,
		resyncing,
		resyncError,
		retryResync,
		auth,
		connected,
		connection,
		notices,
		start,
		stop,
		dismissToast,
		hydrateSession,
		hydrateSubagent,
	};
}

export type AppStore = ReturnType<typeof createAppStore>;
