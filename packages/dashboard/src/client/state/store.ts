/**
 * App store — Solid reactive wrapper around the pure reducer. The reducer
 * mutates plain objects; this store clones the touched session into a signal
 * map so components re-render per-session, not per-token-globally.
 */

import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { AuthStatusDto, EventEnvelope, FleetDto } from "../../shared/protocol.js";
import { api, connectEvents } from "../api.js";
import {
	applyEnvelope,
	createDashboardState,
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
	const reducerState = createDashboardState();

	// sessions: reactive mirror of reducer session states (cloned on change)
	const [sessions, setSessions] = createStore<Record<string, SessionViewState>>({});
	// Per-session monotonic revision — bumped on EVERY synced envelope, including
	// in-place streaming mutations that don't change entries.length. Autoscroll
	// effects subscribe to this (entries.length alone misses text deltas).
	const [revisions, setRevisions] = createStore<Record<string, number>>({});
	const [route, setRouteSignal] = createSignal<Route>(parseHash());
	const [fleet, setFleet] = createSignal<FleetDto>({ runtimes: [], diskSessions: [] });
	const [auth, setAuth] = createSignal<(AuthStatusDto & { needsPairing?: boolean; error?: string }) | undefined>();
	const [connected, setConnected] = createSignal(false);

	window.addEventListener("hashchange", () => setRouteSignal(parseHash()));

	function navigate(next: Route): void {
		window.location.hash = routeToHash(next);
	}

	function syncSession(key: string): void {
		const session = reducerState.sessions.get(key);
		if (session) {
			// Clone: reconcile diffs the plain tree into the store so Solid updates
			// only the changed paths.
			setSessions(key, reconcile(structuredClone(session)));
			setRevisions(key, (revisions[key] ?? 0) + 1);
		}
	}

	async function refreshFleet(): Promise<void> {
		setFleet(await api.fleet());
	}

	function handleEnvelope(envelope: EventEnvelope): void {
		const session = applyEnvelope(reducerState, envelope);
		if (envelope.event?.type === "dashboard_resync") {
			setSessions(reconcile({}));
			setRevisions(reconcile({}));
		}
		if (session) syncSession(session.key);
		// Fleet-affecting events refresh the overview lazily.
		const type = envelope.event?.type as string | undefined;
		if (
			type === "agent_start" ||
			type === "agent_end" ||
			type === "background_agent_start" ||
			type === "background_agent_end"
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
			if (err?.body?.needsPairing) {
				navigate({ screen: "pairing" });
				return;
			}
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
		for (const [key, session] of reducerState.sessions) {
			if (!session.toasts.some((toast) => toast.id === id)) continue;
			dismissReducerToast(session, id);
			syncSession(key);
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
	async function hydrateSession(key: string): Promise<void> {
		const [messagesResult, agentsResult, runtimeResult] = await Promise.allSettled([
			api.messages(key),
			api.backgroundAgents(key),
			api.runtime(key),
		] as const);
		let session = reducerState.sessions.get(key);
		if (!session) {
			session = createSessionViewState(key);
			reducerState.sessions.set(key, session);
		}
		if (messagesResult.status === "fulfilled") {
			session.entries = messagesToEntries(messagesResult.value.messages as any[]);
		}
		if (agentsResult.status === "fulfilled") {
			for (const agent of agentsResult.value.agents) {
				session.backgroundAgents[agent.agentId] = agent;
			}
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
		syncSession(key);
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
	async function hydrateSubagent(key: string, agentId: string): Promise<void> {
		const { agent, messages } = await api.subagentMessages(key, agentId);
		let session = reducerState.sessions.get(key);
		if (!session) {
			session = createSessionViewState(key);
			reducerState.sessions.set(key, session);
		}
		session.backgroundAgents[agentId] = agent;
		let sub = session.subagents[agentId];
		if (!sub) {
			sub = { agentId, entries: [], streaming: agent.status === "running" };
			session.subagents[agentId] = sub;
		}
		// Never clobber richer live state with an empty disk snapshot.
		if (messages.length > 0) sub.entries = messagesToEntries(messages as any[]);
		sub.streaming = agent.status === "running";
		syncSession(key);
	}

	return {
		sessions,
		/** Per-session revision counters — bump on every applied envelope (autoscroll dependency). */
		revisions,
		route,
		navigate,
		fleet,
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
