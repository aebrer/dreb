/**
 * App store — Solid reactive wrapper around the pure reducer. The reducer
 * mutates plain objects; this store uses the Solid store as the source of
 * truth and applies reducer mutations through produce for fine-grained updates.
 */

import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { ActiveRuntimeSnapshotDto, AuthStatusDto, EventEnvelope, FleetDto } from "../../shared/protocol.js";
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
	taskRevision: number;
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
	const [resyncError, setResyncError] = createSignal<string>();
	const [resyncing, setResyncing] = createSignal(false);
	const [auth, setAuth] = createSignal<(AuthStatusDto & { needsPairing?: boolean; error?: string }) | undefined>();
	const [connection, setConnection] = createSignal<EventConnectionStatus>({ state: "disconnected", attempt: 0 });
	const connected = () => connection().state === "connected";
	const [notices, setNotices] = createSignal<Toast[]>([]);
	const hydrationGenerations = new Map<string, number>();
	const taskRevisions = new Map<string, number>();
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
			taskRevision: currentTaskRevision(key),
		};
	}

	function hydrationIdentityMatches(key: string, guard: HydrationGuardToken): boolean {
		return currentHydrationGeneration(key) === guard.generation && hydrationEpoch === guard.epoch;
	}

	function hydrationGuardMatches(key: string, guard: HydrationGuardToken): boolean {
		return currentRevision(key) === guard.revision && hydrationIdentityMatches(key, guard);
	}

	function taskHydrationGuardMatches(key: string, guard: HydrationGuardToken): boolean {
		return currentTaskRevision(key) === guard.taskRevision && hydrationIdentityMatches(key, guard);
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

	async function refreshFleet(): Promise<void> {
		try {
			setFleet(await api.fleet());
			setFleetError(undefined);
		} catch (err) {
			setFleetError(err instanceof Error ? err.message : String(err));
			throw err;
		}
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
		if (type === "runtime_removed") {
			if (envelope.key) {
				const wasViewingRemovedRuntime = routedSessionKey() === envelope.key;
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
		if (
			type === "agent_start" ||
			type === "agent_end" ||
			type === "background_agent_start" ||
			type === "background_agent_end" ||
			type === "runtime_removed"
		) {
			refreshFleet().catch(() => {});
		}
	}

	function hydrateSnapshot(active: ActiveRuntimeSnapshotDto): void {
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
			if (active.subagent) {
				// The parent registry is captured after the subagent transcript, so it
				// is authoritative when it contains this agent.
				const agent =
					active.backgroundAgents.find((parentAgent) => parentAgent.agentId === active.subagent.agentId) ??
					active.subagent.agent;
				session.backgroundAgents[active.subagent.agentId] = agent;
				session.subagents[active.subagent.agentId] = {
					agentId: active.subagent.agentId,
					entries: messagesToEntries(active.subagent.messages as any[]),
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
		setFleet(snapshot.fleet);
		setFleetError(undefined);
		if (snapshot.active) hydrateSnapshot(snapshot.active);
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
				if (retryAfterCurrentResync) {
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
		const pending = pendingResync;
		pendingResync = undefined;
		if (pending) clearPendingQueue(pending);
		pending?.controller.abort("Dashboard stopped");
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
	 * Hydrate a session from the server (on drill-in): transcript from
	 * get_messages + background-agent registry from list_background_agents.
	 * The registry seed is what makes subagent drill-ins reachable again
	 * after a browser reload (reducer state is per-page, but the runtime
	 * keeps running server-side).
	 */
	async function hydrateSession(key: string, signal?: AbortSignal): Promise<void> {
		const hydrationGuard = captureHydrationGuard(key);
		const [messagesResult, agentsResult, runtimeResult] = await Promise.allSettled([
			api.messages(key, signal),
			api.backgroundAgents(key, signal),
			api.runtime(key, signal),
		] as const);
		// An aborted hydration (screen unmounted) must not create or touch
		// session state — without this guard the all-rejected mutation below
		// would still create a stub session and bump its revision.
		if (!signal?.aborted && hydrationIdentityMatches(key, hydrationGuard)) {
			const fullSnapshotSafe = hydrationGuardMatches(key, hydrationGuard);
			const tasksSnapshotSafe = taskHydrationGuardMatches(key, hydrationGuard);
			let appliedTasks = false;
			mutateSession(key, (session) => {
				if (fullSnapshotSafe && messagesResult.status === "fulfilled") {
					session.entries = messagesToEntries(messagesResult.value.messages as any[]);
				}
				if (fullSnapshotSafe && agentsResult.status === "fulfilled") {
					for (const agent of agentsResult.value.agents) {
						session.backgroundAgents[agent.agentId] = agent;
					}
					capBackgroundAgents(session);
				}
				// Seed live turn state from the runtime so a mid-turn browser refresh
				// still shows stop/working UI. Without this, `streaming` only becomes
				// true via a future agent_start SSE event — after a refresh that event
				// is in the past, leaving the stop button and status line missing while
				// the agent is visibly running. If unrelated live events raced this REST
				// hydrate, keep their transcript/streaming state while still restoring the
				// task snapshot unless a newer tasks_update event has already arrived.
				if (runtimeResult.status === "fulfilled" && runtimeResult.value?.state) {
					const state = runtimeResult.value.state;
					if (tasksSnapshotSafe) {
						session.tasks = (state.tasks ?? []).map((task) => ({ ...task }));
						appliedTasks = true;
					}
					if (fullSnapshotSafe) {
						session.streaming = state.isStreaming;
						session.compacting = state.isCompacting;
						if (state.isStreaming && !session.workingSince) {
							session.workingSince = Date.now();
							session.workingText = session.workingText ?? "working";
						} else if (!state.isStreaming) {
							session.workingSince = undefined;
						}
					}
				}
			});
			if (appliedTasks) bumpTaskRevision(key);
		}
		// Loud failure: apply what succeeded above, then surface the error.
		const failed = [messagesResult, agentsResult, runtimeResult].find((result) => result.status === "rejected");
		if (failed?.status === "rejected") {
			throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
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
		refreshFleet,
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
