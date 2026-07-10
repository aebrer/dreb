/**
 * App root — routes between screens, owns the store lifecycle, renders the
 * global toast region and the browser tab attention badge.
 */

import { createEffect, type JSX, Match, onCleanup, onMount, Switch } from "solid-js";
import { ToastRegion } from "./components/common.js";
import { FilesScreen } from "./screens/files.js";
import { FleetScreen } from "./screens/fleet.js";
import { PairingScreen } from "./screens/pairing.js";
import { SessionScreen } from "./screens/session.js";
import { SettingsScreen } from "./screens/settings.js";
import { SubagentScreen } from "./screens/subagent.js";
import { resolveUiRequest } from "./state/reducer.js";
import { createAppStore } from "./state/store.js";

export function App(): JSX.Element {
	const store = createAppStore();

	onMount(() => {
		store.start();
		// The service worker's notificationclick handler focuses an open client
		// and posts a navigate-session message so the already-open dashboard jumps
		// to the session that needs attention. (When no client is open, the SW
		// opens ./#session/<key> and the store's hashchange routing handles it.)
		if ("serviceWorker" in navigator) {
			navigator.serviceWorker.addEventListener("message", (event) => {
				if (event.data?.type === "navigate-session" && typeof event.data.sessionKey === "string") {
					const key = event.data.sessionKey;
					// Validate the session still exists before routing to it. A
					// notification can be clicked after its session was deleted/stopped
					// (the SW carries the stale key in notification.data); navigating
					// blindly lands on a blank session view with no signal the session
					// is gone. Fall back to fleet for a stale key.
					const known = Boolean(store.sessions[key]) || store.fleet().runtimes.some((r) => r.key === key);
					store.navigate(known ? { screen: "session", key } : { screen: "fleet" });
				}
			});
			// Register the SW for notifications + installability. Stable root-relative
			// URL (never content-hashed) so browsers fetch the latest copy and compare
			// byte-for-byte. Only available in secure contexts (HTTPS or localhost).
			// Errors are logged, never fatal — the in-tab ◆ badge still works.
			navigator.serviceWorker.register("./sw.js").catch((err) => {
				console.warn("dashboard: service worker registration failed", err);
			});
		}
	});
	onCleanup(() => store.stop());

	// Browser tab badge: needs-attention marker in the title.
	const notifiedAttention = new Set<string>();
	createEffect(() => {
		const sessionAttention = new Map<string, { name: string; reason: string }>();
		for (const runtime of store.fleet().runtimes) {
			if (runtime.needsAttention) {
				sessionAttention.set(runtime.key, {
					name: runtime.state.sessionName ?? runtime.state.sessionId.slice(0, 8),
					reason: "needs attention",
				});
			}
		}
		for (const session of Object.values(store.sessions)) {
			if (session.needsAttention) {
				sessionAttention.set(session.key, {
					name: session.sessionName ?? session.title ?? session.key,
					reason: session.uiRequests[0]?.title
						? `waiting for input — ${session.uiRequests[0].title}`
						: (session.statusEntries.find((s) => s.tone === "error")?.text ?? "needs attention"),
				});
			}
		}
		const attention = sessionAttention.size > 0;
		const route = store.route();
		const currentSessionKey = route.screen === "session" || route.screen === "subagent" ? route.key : undefined;
		const currentSession = currentSessionKey ? store.sessions[currentSessionKey] : undefined;
		const currentRuntime = currentSessionKey
			? store.fleet().runtimes.find((runtime) => runtime.key === currentSessionKey)
			: undefined;
		const displayName = currentSession?.title ?? currentSession?.sessionName ?? currentRuntime?.state.sessionName;
		const base = displayName ? `${displayName} — dreb` : "dreb";
		document.title = attention ? `◆ ${base}` : base;

		for (const [key, item] of sessionAttention) {
			if (notifiedAttention.has(key)) continue;
			// Notifications through the service worker (registration.showNotification)
			// — the only path that works on Android Chrome (which removed the page
			// Notification constructor) and on iOS (installed PWA only). Gated exactly
			// as before: permission granted + page hidden. Click handling lives in the
			// SW (notificationclick): it focuses/open a client and posts a navigate
			// message (handled below). The in-tab ◆ badge above is the no-SW fallback.
			// Mark the key as notified ONLY after showNotification succeeds, so a
			// rejected notification (e.g. permission revoked mid-flight, SW unregistered)
			// can be retried on the next effect run instead of being silently dropped.
			if (
				typeof Notification !== "undefined" &&
				Notification.permission === "granted" &&
				document.visibilityState !== "visible" &&
				"serviceWorker" in navigator
			) {
				navigator.serviceWorker.ready
					.then((reg) =>
						reg.showNotification(`dreb — ${item.name}`, {
							body: item.reason,
							tag: key,
							data: { sessionKey: key },
						}),
					)
					.then(() => notifiedAttention.add(key))
					.catch((err) => console.warn("dashboard: showNotification failed", err));
			}
		}
		for (const key of [...notifiedAttention]) {
			if (!sessionAttention.has(key)) notifiedAttention.delete(key);
		}
	});

	// All toasts across sessions, newest last.
	const allToasts = () =>
		[
			...Object.values(store.sessions).flatMap((s) => s.toasts.map((t) => ({ ...t, sessionKey: s.key }))),
			...store.notices(),
		].slice(-5);

	return (
		<>
			<Switch fallback={<FleetScreen store={store} />}>
				<Match when={store.route().screen === "session"}>
					<SessionScreen store={store} sessionKey={(store.route() as { key: string }).key} />
				</Match>
				<Match when={store.route().screen === "subagent"}>
					<SubagentScreen
						store={store}
						sessionKey={(store.route() as { key: string }).key}
						agentId={(store.route() as { agentId: string }).agentId}
					/>
				</Match>
				<Match when={store.route().screen === "files"}>
					<FilesScreen store={store} initialPath={(store.route() as { path?: string }).path} />
				</Match>
				<Match when={store.route().screen === "settings"}>
					<SettingsScreen store={store} />
				</Match>
				<Match when={store.route().screen === "pairing"}>
					<PairingScreen store={store} />
				</Match>
			</Switch>
			<ToastRegion toasts={allToasts()} onDismiss={(id) => store.dismissToast(id)} />
		</>
	);
}

export { resolveUiRequest };
