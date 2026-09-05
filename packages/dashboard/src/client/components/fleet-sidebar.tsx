/**
 * Fleet sidebar for the session view and subagent drill-in — the other live
 * sessions, so a focused transcript never loses fleet visibility.
 *
 * Entries are deterministically ordered (cwd, then createdAt — the fleet
 * page's comparator); needs-attention/error entries get the filled chip +
 * border emphasis without moving position (AGENTS.md: highlight, never
 * re-sort).
 *
 * Desktop: a static column beside the transcript, collapsed through the
 * persisted `dreb.dashboard.sessionSidebarCollapsed` preference. Mobile
 * (≤700px): a fixed overlay drawer above the session with a scrim — hidden by
 * default regardless of the desktop preference, opened from the session-bar
 * toggle, closed by scrim tap or entry tap (which also navigates).
 */

import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { RuntimeInfoDto } from "../shared/protocol.js";
import { sessionSidebarCollapsed, setSessionSidebarCollapsed } from "../state/preferences.js";
import type { AppStore } from "../state/store.js";
import { relativeTime, runtimeStatus, StatusChip } from "./common.js";

/**
 * Deterministic fleet order: alphabetical by project path, then session start
 * time as tiebreak — the same comparator the fleet page uses, so entries
 * never jump around as attention flags flip or activity ticks.
 */
export function fleetSidebarOrder(runtimes: readonly RuntimeInfoDto[]): RuntimeInfoDto[] {
	const ordered = [...runtimes];
	ordered.sort((a, b) => {
		const byPath = a.cwd.localeCompare(b.cwd);
		if (byPath !== 0) return byPath;
		return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
	});
	return ordered;
}

/**
 * Session-bar toggle state for the fleet sidebar: one control, two modes —
 * desktop collapse (the persisted preference, so it survives reloads) and
 * mobile overlay open (transient per page load; mobile always starts closed).
 */
export function createFleetSidebarUi() {
	const [overlayOpen, setOverlayOpen] = createSignal(false);
	return {
		/** Mobile overlay visibility. */
		open: overlayOpen,
		/** Desktop collapsed state (persisted browser-locally; mobile ignores it). */
		collapsed: sessionSidebarCollapsed,
		/** Toggle: collapse/expand on desktop, open/close the drawer on mobile. */
		toggle: (mobile: boolean) => {
			if (mobile) setOverlayOpen((current) => !current);
			else setSessionSidebarCollapsed(!sessionSidebarCollapsed());
		},
		/** Close the mobile overlay (scrim tap or entry tap). */
		close: () => setOverlayOpen(false),
	};
}

export function FleetSidebar(props: {
	store: AppStore;
	/** The session to exclude: the viewed session (its parent, on drill-in). */
	sessionKey: string;
	/** Mobile layout mode (≤700px): overlay drawer instead of static column. */
	mobile: boolean;
	/** Mobile overlay visibility (desktop ignores it). */
	open: boolean;
	/** Desktop collapsed state (mobile ignores it). */
	collapsed: boolean;
	onNavigate: (key: string) => void;
	onClose: () => void;
}): JSX.Element {
	const entries = createMemo(() =>
		fleetSidebarOrder(props.store.fleet().runtimes.filter((runtime) => runtime.key !== props.sessionKey)),
	);

	// Escape closes the open mobile drawer from anywhere on the page (the scrim
	// itself is not focusable), mirroring the session stats-popover pattern.
	createEffect(() => {
		if (!props.mobile || !props.open) return;
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") props.onClose();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	});

	return (
		<Show when={entries().length > 0}>
			<aside
				class="fleet-sidebar"
				classList={{
					open: props.mobile && props.open,
					collapsed: !props.mobile && props.collapsed,
				}}
			>
				<For each={entries()}>
					{(runtime) => {
						const status = () => runtimeStatus(runtime);
						const runningAgents = () =>
							runtime.backgroundAgents.filter((agent) => agent.status === "running").length;
						return (
							<button
								type="button"
								class="fleet-sidebar-entry"
								classList={{ attention: status() === "attention", error: status() === "error" }}
								title={runtime.cwd}
								onClick={() => props.onNavigate(runtime.key)}
							>
								<div class="fleet-sidebar-entry-head">
									<span class="name">{runtime.state.sessionName ?? runtime.state.sessionId.slice(0, 8)}</span>
									<StatusChip status={status()} />
								</div>
								<div class="fleet-sidebar-entry-meta">
									<span>{relativeTime(runtime.lastActivity)}</span>
									<Show when={runningAgents() > 0}>
										<span>
											· ⚡ {runningAgents()} agent{runningAgents() === 1 ? "" : "s"}
										</span>
									</Show>
								</div>
							</button>
						);
					}}
				</For>
			</aside>
			<Show when={props.mobile && props.open}>
				{
					// biome-ignore lint/a11y/noStaticElementInteractions: scrim tap-to-close mirrors the modal backdrop pattern — the drawer entries remain keyboard-reachable
					<div
						class="fleet-sidebar-scrim"
						onClick={() => props.onClose()}
						onKeyDown={(event) => {
							if (event.key === "Escape") props.onClose();
						}}
					/>
				}
			</Show>
		</Show>
	);
}
