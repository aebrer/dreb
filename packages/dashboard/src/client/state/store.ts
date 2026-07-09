/**
 * App store — Solid reactive wrapper around the pure reducer. The reducer
 * mutates plain objects; this store uses the Solid store as the source of
 * truth and applies reducer mutations through produce for fine-grained updates.
 */

import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import type { AuthStatusDto, EventEnvelope, FleetDto } from "../../shared/protocol.js";
import { api, connectEvents } from "../api.js";
import { evictComposerMemory } from "./composer-memory.js";
import {
	applySessionEvent,
	capBackgroundAgents,
	createSessionViewState,
	dismissToast as dismissReducerToast,
	messagesToEntries,
	type SessionViewState,
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
	const [auth, setAuth] = createSignal<(AuthStatusDto & { needsPairing?: boolean; error?: string }) | undefined>();
	const [connected, setConnected] = createSignal(false);

	window.addEventListener("hashchange", () => setRouteSignal(parseHash()));

	function navigate(next: Route): void {
		window.location.hash = routeToHash(next);
	}

	function currentRevision(key: string): number {
		return revisions[key] ?? 0;
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
		setSessions(key, undefined!);
		setRevisions(key, undefined!);
		evictComposerMemory(key);
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

	function handleEnvelope(envelope: EventEnvelope): void {
		const type = envelope.event?.type as string | undefined;
		if (type === "dashboard_resync") {
			setSessions(reconcile({}));
			setRevisions(reconcile({}));
		} else if (type === "runtime_removed") {
			if (envelope.key) deleteSessionState(envelope.key);
		} else if (envelope.key) {
			mutateSession(envelope.key, (session) => applySessionEvent(session, envelope.event));
		}
		// Fleet-affecting events refresh the overview lazily.
		if (
			type === "agent_start" ||
			type === "agent_end" ||
			type === "background_agent_start" ||
			type === "background_agent_end" ||
			type === "runtime_removed"
		) {
			refreshFleet().catch(() => {
				// Fleet refresh failing is non-fatal; next event retries.
			});
		}
	}

	async function resyncFromServer(): Promise<void> {
		await refreshFleet().catch(() => {});
		const current = route();
		try {
			if (current.screen === "session") {
				await hydrateSession(current.key);
			} else if (current.screen === "subagent") {
				await hydrateSession(current.key);
				await hydrateSubagent(current.key, current.agentId);
			}
		} catch {
			// Hydration failures surface when the user opens the route; keep the
			// reconnect path from throwing out of the EventSource callback.
		}
	}

	let disconnect: (() => void) | undefined;

	async function start(): Promise<void> {
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
			onStatusChange: setConnected,
			onResync: () => {
				resyncFromServer().catch(() => {});
			},
		});
	}

	function stop(): void {
		disconnect?.();
	}

	function dismissToast(id: number): void {
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
		const hydrationRevision = currentRevision(key);
		const [messagesResult, agentsResult, runtimeResult] = await Promise.allSettled([
			api.messages(key, signal),
			api.backgroundAgents(key, signal),
			api.runtime(key, signal),
		] as const);
		// An aborted hydration (screen unmounted) must not create or touch
		// session state — without this guard the all-rejected mutation below
		// would still create a stub session and bump its revision.
		if (!signal?.aborted && currentRevision(key) === hydrationRevision) {
			mutateSession(key, (session) => {
				if (messagesResult.status === "fulfilled") {
					session.entries = messagesToEntries(messagesResult.value.messages as any[]);
				}
				if (agentsResult.status === "fulfilled") {
					for (const agent of agentsResult.value.agents) {
						session.backgroundAgents[agent.agentId] = agent;
					}
					capBackgroundAgents(session);
				}
				// Seed live turn state from the runtime so a mid-turn browser refresh
				// still shows stop/working UI. Without this, `streaming` only becomes
				// true via a future agent_start SSE event — after a refresh that event
				// is in the past, leaving the stop button and status line missing while
				// the agent is visibly running.
				if (runtimeResult.status === "fulfilled" && runtimeResult.value?.state) {
					const state = runtimeResult.value.state;
					session.streaming = state.isStreaming;
					session.compacting = state.isCompacting;
					if (state.isStreaming && !session.workingSince) {
						session.workingSince = Date.now();
						session.workingText = session.workingText ?? "working";
					} else if (!state.isStreaming) {
						session.workingSince = undefined;
					}
				}
			});
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
		const hydrationRevision = currentRevision(key);
		const { agent, messages } = await api.subagentMessages(key, agentId, signal);
		if (currentRevision(key) !== hydrationRevision) return;
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
		auth,
		connected,
		start,
		stop,
		dismissToast,
		hydrateSession,
		hydrateSubagent,
	};
}

export type AppStore = ReturnType<typeof createAppStore>;
