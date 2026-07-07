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
	});
	onCleanup(() => store.stop());

	// Browser tab badge: needs-attention marker in the title.
	createEffect(() => {
		const attention =
			Object.values(store.sessions).some((s) => s.needsAttention) ||
			store.fleet().runtimes.some((r) => r.needsAttention);
		const base = "dreb";
		document.title = attention ? `◆ ${base}` : base;
	});

	// All toasts across sessions, newest last.
	const allToasts = () =>
		Object.values(store.sessions)
			.flatMap((s) => s.toasts.map((t) => ({ ...t, sessionKey: s.key })))
			.slice(-5);

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
			<ToastRegion
				toasts={allToasts()}
				onDismiss={(id) => {
					// Toasts live in reducer state; drop by mutating through the store's
					// session sync (dismissal is cosmetic — no server round-trip).
					for (const session of Object.values(store.sessions)) {
						const index = session.toasts.findIndex((t) => t.id === id);
						if (index !== -1) session.toasts.splice(index, 1);
					}
				}}
			/>
		</>
	);
}

export { resolveUiRequest };
