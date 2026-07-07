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
		}
	}

	async function refreshFleet(): Promise<void> {
		setFleet(await api.fleet());
	}

	function handleEnvelope(envelope: EventEnvelope): void {
		const session = applyEnvelope(reducerState, envelope);
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

	let disconnect: (() => void) | undefined;

	async function start(): Promise<void> {
		try {
			const status = await api.auth();
			setAuth(status);
		} catch (err: any) {
			setAuth({ mode: "remote", needsPairing: err?.body?.needsPairing ?? false, error: err?.message });
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
				refreshFleet().catch(() => {});
			},
		});
	}

	function stop(): void {
		disconnect?.();
	}

	return {
		sessions,
		route,
		navigate,
		fleet,
		refreshFleet,
		auth,
		connected,
		start,
		stop,
		/** Hydrate a session transcript from get_messages (on drill-in). */
		async hydrateSession(key: string): Promise<void> {
			const { messages } = await api.messages(key);
			let session = reducerState.sessions.get(key);
			if (!session) {
				session = createSessionViewState(key);
				reducerState.sessions.set(key, session);
			}
			session.entries = messagesToEntries(messages as any[]);
			syncSession(key);
		},
	};
}

export type AppStore = ReturnType<typeof createAppStore>;
