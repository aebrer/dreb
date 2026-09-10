/**
 * Fleet sidebar for the session view and subagent drill-in — the other live
 * sessions, so a focused transcript never loses fleet visibility.
 *
 * Entries are deterministically ordered (cwd, then createdAt — the fleet
 * page's comparator); attention uses a filled chip and errors an outlined chip,
 * both with entry-border emphasis without moving position (AGENTS.md:
 * highlight, never re-sort).
 *
 * Desktop: a static column beside the transcript, collapsed through the
 * persisted `dreb.dashboard.sessionSidebarCollapsed` preference. Mobile
 * (≤700px): a fixed overlay drawer above the session with a scrim — hidden by
 * default regardless of the desktop preference, opened from the session-bar
 * toggle, closed by scrim tap or entry tap (which also navigates).
 */

import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, onCleanup, Show } from "solid-js";
import type { RuntimeInfoDto } from "../../shared/protocol.js";
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
	const media = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 700px)") : undefined;
	const [mobile, setMobile] = createSignal(media?.matches ?? false);
	const onMediaChange = (event: MediaQueryListEvent) => {
		// A breakpoint crossing never resurrects a previously open drawer and
		// never overwrites the independently persisted desktop preference.
		setOverlayOpen(false);
		setMobile(event.matches);
	};
	media?.addEventListener("change", onMediaChange);
	onCleanup(() => media?.removeEventListener("change", onMediaChange));
	return {
		id: `fleet-sidebar-${createUniqueId()}`,
		mobile,
		/** Mobile overlay visibility. */
		open: overlayOpen,
		/** Desktop collapsed state (persisted browser-locally; mobile ignores it). */
		collapsed: sessionSidebarCollapsed,
		/** Toggle: collapse/expand on desktop, open/close the drawer on mobile. */
		toggle: () => {
			if (mobile()) setOverlayOpen((current) => !current);
			else setSessionSidebarCollapsed(!sessionSidebarCollapsed());
		},
		/** Close the mobile overlay (scrim tap or entry tap). */
		close: () => setOverlayOpen(false),
	};
}

export function FleetSidebar(props: {
	id: string;
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

	let drawer: HTMLElement | undefined;
	const overlayActive = createMemo(() => props.mobile && props.open && entries().length > 0);
	const hidden = () => (props.mobile ? !props.open : props.collapsed);

	createEffect(() => {
		if (!overlayActive()) return;
		const previousFocus = document.activeElement;
		// Focus the stable close button, not an entry replaced by fleet snapshots.
		drawer?.querySelector<HTMLButtonElement>(".fleet-sidebar-close")?.focus({ preventScroll: true });
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target instanceof Element ? event.target : undefined;
			// A higher modal (for example an extension UI request) owns its keys.
			if (target?.closest('[role="dialog"]') && !drawer?.contains(target)) return;
			if (event.defaultPrevented) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation(); // Do not reach AskWizard's window-level abort.
				props.onClose();
			} else if (event.key === "Tab") {
				event.stopPropagation(); // Nor its question-tab navigation shortcut.
				const buttons = drawer?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
				const first = buttons?.[0];
				const last = buttons?.[buttons.length - 1];
				if (event.shiftKey && (document.activeElement === first || !drawer?.contains(document.activeElement))) {
					event.preventDefault();
					last?.focus();
				} else if (
					!event.shiftKey &&
					(document.activeElement === last || !drawer?.contains(document.activeElement))
				) {
					event.preventDefault();
					first?.focus();
				}
			} else if (target && drawer?.contains(target)) {
				// Entry activation stays native; background wizard number/arrow/Enter
				// shortcuts must not respond while focus belongs to the drawer.
				event.stopPropagation();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		onCleanup(() => {
			document.removeEventListener("keydown", onKeyDown);
			if (
				drawer?.contains(document.activeElement) &&
				previousFocus instanceof HTMLElement &&
				previousFocus.isConnected
			) {
				previousFocus.focus({ preventScroll: true });
			}
		});
	});

	return (
		<Show when={entries().length > 0}>
			{/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: mobile sets role="dialog" together with aria-modal; desktop uses the aside landmark without aria-modal */}
			<aside
				ref={drawer}
				id={props.id}
				role={props.mobile ? "dialog" : "complementary"}
				aria-label="Other live sessions"
				aria-modal={overlayActive() ? true : undefined}
				aria-hidden={hidden()}
				inert={hidden()}
				class="fleet-sidebar"
				classList={{
					open: props.mobile && props.open,
					collapsed: !props.mobile && props.collapsed,
				}}
			>
				<Show when={props.mobile}>
					<button type="button" class="chrome-toggle fleet-sidebar-close" onClick={() => props.onClose()}>
						close fleet sidebar
					</button>
				</Show>
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
				{/* Pointer-only scrim: keyboard dismissal belongs to the drawer. */}
				<div class="fleet-sidebar-scrim" aria-hidden="true" onClick={() => props.onClose()} />
			</Show>
		</Show>
	);
}
