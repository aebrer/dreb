/**
 * Shared UI primitives: status chips, topbar, modal, toasts. Chip variants
 * come from tokens.css — every status pairs a glyph with its color (status is
 * never color alone).
 */

import { For, type JSX, Show } from "solid-js";
import type { Toast } from "../state/reducer.js";
import type { AppStore } from "../state/store.js";

export function StatusChip(props: { status: "running" | "attention" | "idle" | "error"; label?: string }): JSX.Element {
	const glyphs = { running: "●", attention: "◆", idle: "○", error: "✕" } as const;
	const labels = { running: "running", attention: "needs attention", idle: "idle", error: "error" } as const;
	return (
		<span class={`chip chip-${props.status}`}>
			<span class="dot">{glyphs[props.status]}</span> {props.label ?? labels[props.status]}
		</span>
	);
}

export function ModeBadge(props: { store: AppStore }): JSX.Element {
	const auth = () => props.store.auth();
	return (
		<Show when={auth()} fallback={<span class="chip chip-plain">…</span>}>
			{(a) => (
				<span class="chip chip-plain">
					<span class="dot">{a().mode === "local" ? "⌂" : "⇄"}</span>{" "}
					{a().mode === "local"
						? "local · 127.0.0.1"
						: `remote · ${a().device ?? a().identity ?? "device"} via tailscale`}
				</span>
			)}
		</Show>
	);
}

export function Topbar(props: { store: AppStore; active: "fleet" | "files" | "settings" }): JSX.Element {
	const attentionCount = () =>
		Object.values(props.store.sessions).filter((s) => s.needsAttention).length +
		props.store.fleet().runtimes.filter((r) => r.needsAttention).length;
	return (
		<header class="topbar">
			<div class="topbar-inner">
				<a class="wordmark" href="#/">
					dreb
				</a>
				<nav>
					<a href="#/" aria-current={props.active === "fleet" ? "page" : undefined}>
						fleet{attentionCount() > 0 ? " ◆" : ""}
					</a>
					<a href="#/files" aria-current={props.active === "files" ? "page" : undefined}>
						files
					</a>
					<a href="#/settings" aria-current={props.active === "settings" ? "page" : undefined}>
						settings
					</a>
				</nav>
				<span class="topbar-spacer" />
				<Show when={!props.store.connected()}>
					<span class="chip chip-error">
						<span class="dot">✕</span> disconnected
					</span>
				</Show>
				<ModeBadge store={props.store} />
			</div>
		</header>
	);
}

export function Modal(props: {
	title: string;
	onDismiss: () => void;
	children: JSX.Element;
	actions?: JSX.Element;
	class?: string;
}): JSX.Element {
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss is supplementary — the modal itself provides Escape handling and dismiss buttons
		<div
			class="modal-backdrop"
			role="presentation"
			onClick={(e) => {
				if (e.target === e.currentTarget) props.onDismiss();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") props.onDismiss();
			}}
		>
			<div class={`modal ${props.class ?? ""}`} role="dialog" aria-label={props.title}>
				<div class="modal-title">{props.title}</div>
				<div class="modal-body">{props.children}</div>
				<Show when={props.actions}>
					<div class="modal-actions">{props.actions}</div>
				</Show>
			</div>
		</div>
	);
}

export function ToastRegion(props: { toasts: Toast[]; onDismiss: (id: number) => void }): JSX.Element {
	return (
		<div class="toast-region">
			<For each={props.toasts}>
				{(toast) => (
					<div class={`toast ${toast.tone}`}>
						<span>{toast.text}</span>
						<button
							type="button"
							class="btn btn-small"
							style={{ "margin-left": "auto" }}
							onClick={() => props.onDismiss(toast.id)}
						>
							✕
						</button>
					</div>
				)}
			</For>
		</div>
	);
}

/** Relative time: "2m ago", "6d ago". */
export function relativeTime(iso: string | number | undefined): string {
	if (!iso) return "";
	const then = typeof iso === "number" ? iso : Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const seconds = Math.floor((Date.now() - then) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return `${Math.floor(days / 30)}mo ago`;
}

export function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
