/**
 * Shared UI primitives: status chips, topbar, modal, toasts. Chip variants
 * come from tokens.css — every status pairs a glyph with its color (status is
 * never color alone).
 */

import { For, type JSX, Show } from "solid-js";
import type { RuntimeInfoDto } from "../shared/protocol.js";
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

/**
 * Live-session status derivation, shared by the fleet page and the session
 * fleet sidebar: a runtime-level error wins, then the needs-attention flag,
 * then any active work (stream/retry/compaction), else idle.
 */
export function runtimeStatus(runtime: RuntimeInfoDto): "running" | "attention" | "idle" | "error" {
	if (runtime.error) return "error";
	if (runtime.needsAttention) return "attention";
	if (runtime.state.isStreaming || runtime.state.isRetrying || runtime.state.isCompacting) return "running";
	return "idle";
}

export function ModeBadge(props: { store: AppStore }): JSX.Element {
	const auth = () => props.store.auth();
	return (
		<Show when={auth()} fallback={<span class="chip chip-plain">…</span>}>
			{(a) => {
				const label = () =>
					a().mode === "local"
						? "local · 127.0.0.1"
						: `remote · ${a().device ?? a().identity ?? "device"} via tailscale`;
				return (
					<span class="chip chip-plain mode-badge" title={label()}>
						<span class="dot">{a().mode === "local" ? "⌂" : "⇄"}</span>
						<span class="mode-badge-text">{label()}</span>
					</span>
				);
			}}
		</Show>
	);
}

export function Topbar(props: { store: AppStore; active: "fleet" | "files" | "memories" | "settings" }): JSX.Element {
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
					<a href="#/memories" aria-current={props.active === "memories" ? "page" : undefined}>
						memories
					</a>
					<a href="#/settings" aria-current={props.active === "settings" ? "page" : undefined}>
						settings
					</a>
				</nav>
				<span class="topbar-spacer" />
				<ConnectionIndicator store={props.store} />
				<ModeBadge store={props.store} />
			</div>
		</header>
	);
}

export function ConnectionIndicator(props: { store: AppStore; class?: string }): JSX.Element {
	const status = () => (props.store.resyncing() ? "resyncing" : props.store.connection().state);
	const presentation = () => {
		switch (status()) {
			case "connected":
				return { glyph: "●", text: "live", tone: "idle" };
			case "connecting":
				return { glyph: "…", text: "connecting", tone: "attention" };
			case "retrying": {
				const delay = props.store.connection().retryDelayMs;
				return {
					glyph: "↻",
					text: `retrying${delay === undefined ? "" : ` in ${Math.ceil(delay / 1000)}s`}`,
					tone: "attention",
				};
			}
			case "resyncing":
				return { glyph: "↻", text: "recovering live state", tone: "attention" };
			case "auth_failed":
				return { glyph: "✕", text: "live connection unauthorized", tone: "error" };
			default:
				return { glyph: "✕", text: "live connection disconnected", tone: "error" };
		}
	};
	return (
		<span class={`connection-indicator ${props.class ?? ""}`.trim()}>
			<output class={`chip chip-${presentation().tone}`} aria-live="polite">
				<span class="dot">{presentation().glyph}</span> {presentation().text}
			</output>
			<Show when={props.store.resyncError()}>
				<button
					type="button"
					class="btn btn-small"
					title={props.store.resyncError()}
					onClick={() => void props.store.retryResync()}
				>
					recovery failed — retry
				</button>
			</Show>
		</span>
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

export interface BannerAction {
	label: string;
	run: () => void | Promise<void>;
	disabled?: boolean;
}

export interface BannerItem {
	key: string;
	text: string;
	tone: "info" | "warning" | "error";
	onDismiss: () => void;
	actions?: BannerAction[];
}

export function BannerRegion(props: { banners: BannerItem[] }): JSX.Element {
	return (
		<Show when={props.banners.length > 0}>
			<div class="container banner-region" aria-live="polite">
				<For each={props.banners}>
					{(banner) => (
						<div class={`banner ${banner.tone}`} data-banner-key={banner.key}>
							<span class="banner-glyph" aria-hidden="true">
								◆
							</span>
							<span class="banner-text">{banner.text}</span>
							<Show when={(banner.actions?.length ?? 0) > 0}>
								<span class="banner-actions">
									<For each={banner.actions}>
										{(action) => (
											<button
												type="button"
												class="btn btn-small"
												disabled={action.disabled}
												onClick={() => void action.run()}
											>
												{action.label}
											</button>
										)}
									</For>
								</span>
							</Show>
							<button type="button" class="btn btn-small banner-dismiss" onClick={banner.onDismiss}>
								dismiss
							</button>
						</div>
					)}
				</For>
			</div>
		</Show>
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
