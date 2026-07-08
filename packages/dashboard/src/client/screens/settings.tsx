/**
 * Settings tab — persistent defaults via get/set_settings (validation errors
 * shown verbatim) + paired-devices management + version footer.
 */

import { createResource, createSignal, For, type JSX, Show } from "solid-js";
import type { SettingsDto } from "../../shared/protocol.js";
import { api } from "../api.js";
import { relativeTime, Topbar } from "../components/common.js";
import { expandThinking, setExpandThinking } from "../state/preferences.js";
import type { AppStore } from "../state/store.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const QUEUE_MODES = ["all", "one-at-a-time"] as const;

export function SettingsScreen(props: { store: AppStore }): JSX.Element {
	const [error, setError] = createSignal<string>();
	const [saved, setSaved] = createSignal(false);
	const [notificationPermission, setNotificationPermission] = createSignal<NotificationPermission | "unsupported">(
		typeof Notification === "undefined" ? "unsupported" : Notification.permission,
	);

	const [settings, { mutate, refetch }] = createResource(async () => {
		setError(undefined);
		try {
			return await api.settings();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return undefined;
		}
	});

	const [devices, { refetch: refetchDevices }] = createResource(async () => {
		const { devices } = await api.devices();
		return devices;
	});

	const [version] = createResource(async () => {
		try {
			const { version } = await api.version();
			return version;
		} catch {
			return undefined; // no live runtime — version unavailable, footer shows dashboard only
		}
	});

	async function save(update: Partial<SettingsDto>) {
		setError(undefined);
		setSaved(false);
		try {
			const next = await api.saveSettings(update);
			mutate(next);
			setSaved(true);
			setTimeout(() => setSaved(false), 2000);
		} catch (err) {
			// RPC validation errors surface verbatim — no silent retry (SPEC §3).
			setError(err instanceof Error ? err.message : String(err));
			await refetch();
		}
	}

	async function requestNotifications() {
		if (typeof Notification === "undefined") return;
		setNotificationPermission(await Notification.requestPermission());
	}

	const auth = () => props.store.auth();

	return (
		<div class="screen-fill">
			<Topbar store={props.store} active="settings" />
			<main class="container settings-wrap">
				<h1>settings</h1>
				<p class="settings-intro">
					Defaults for new sessions. Live sessions keep their current values — change those from the session view.
					Writes go to the global settings file on the host.
				</p>

				<Show when={error()}>
					<div class="settings-error">{error()}</div>
				</Show>
				<Show when={saved()}>
					<p class="muted small" style={{ "margin-bottom": "16px" }}>
						✓ saved
					</p>
				</Show>

				<Show
					when={settings()}
					fallback={
						<p class="muted">Settings need a live runtime — start or resume a session first, then return here.</p>
					}
				>
					{(current) => (
						<>
							<section class="settings-section">
								<h2>model</h2>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">default model</span>
										<span class="hint">used by new sessions; validated against configured providers</span>
									</span>
									<span class="setting-control">
										<input
											type="text"
											value={
												current().defaultProvider && current().defaultModel
													? `${current().defaultProvider}/${current().defaultModel}`
													: ""
											}
											placeholder="provider/model-id"
											onChange={(e) => {
												const value = e.currentTarget.value.trim();
												const slash = value.indexOf("/");
												if (slash === -1) {
													setError(`"${value}" is not provider/model-id format`);
													return;
												}
												save({
													defaultProvider: value.slice(0, slash),
													defaultModel: value.slice(slash + 1),
												});
											}}
										/>
									</span>
								</div>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">default thinking level</span>
										<span class="hint">{THINKING_LEVELS.join(" · ")}</span>
									</span>
									<span class="setting-control">
										<select
											value={current().defaultThinkingLevel ?? "off"}
											onChange={(e) => save({ defaultThinkingLevel: e.currentTarget.value })}
										>
											<For each={THINKING_LEVELS}>{(level) => <option value={level}>{level}</option>}</For>
										</select>
									</span>
								</div>
							</section>

							<section class="settings-section">
								<h2>queueing</h2>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">steering delivery</span>
										<span class="hint">deliver queued steers all at once, or one per turn</span>
									</span>
									<span class="setting-control">
										<select
											value={current().steeringMode ?? "all"}
											onChange={(e) =>
												save({ steeringMode: e.currentTarget.value as "all" | "one-at-a-time" })
											}
										>
											<For each={[...QUEUE_MODES]}>{(mode) => <option value={mode}>{mode}</option>}</For>
										</select>
									</span>
								</div>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">follow-up delivery</span>
										<span class="hint">deliver queued follow-ups all at once, or one per turn</span>
									</span>
									<span class="setting-control">
										<select
											value={current().followUpMode ?? "all"}
											onChange={(e) =>
												save({ followUpMode: e.currentTarget.value as "all" | "one-at-a-time" })
											}
										>
											<For each={[...QUEUE_MODES]}>{(mode) => <option value={mode}>{mode}</option>}</For>
										</select>
									</span>
								</div>
							</section>

							<section class="settings-section">
								<h2>reliability</h2>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">auto-compaction</span>
										<span class="hint">summarize old context when the window fills</span>
									</span>
									<span class="setting-control">
										<select
											value={current().compactionEnabled === false ? "off" : "on"}
											onChange={(e) => save({ compactionEnabled: e.currentTarget.value === "on" })}
										>
											<option value="on">on</option>
											<option value="off">off</option>
										</select>
									</span>
								</div>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">auto-retry</span>
										<span class="hint">retry transient stream errors (rate limits, 5xx)</span>
									</span>
									<span class="setting-control">
										<select
											value={current().retryEnabled === false ? "off" : "on"}
											onChange={(e) => save({ retryEnabled: e.currentTarget.value === "on" })}
										>
											<option value="on">on</option>
											<option value="off">off</option>
										</select>
									</span>
								</div>
							</section>
						</>
					)}
				</Show>

				<section class="settings-section">
					<h2>dashboard</h2>
					<div class="setting-row">
						<span class="setting-label">
							<span class="name">always expand thinking</span>
							<span class="hint">this browser only — stored in localStorage, not the host settings file</span>
						</span>
						<span class="setting-control">
							<label class="checkbox-control">
								<input
									type="checkbox"
									checked={expandThinking()}
									onChange={(e) => setExpandThinking(e.currentTarget.checked)}
								/>
								<span>open by default</span>
							</label>
						</span>
					</div>
					<div class="setting-row">
						<span class="setting-label">
							<span class="name">needs-attention notifications</span>
							<span class="hint">
								{notificationPermission() === "denied"
									? "blocked by browser settings — re-enable notifications in site permissions"
									: notificationPermission() === "unsupported"
										? "browser notifications are unavailable in this environment"
										: "show a browser notification when a hidden tab needs input"}
							</span>
						</span>
						<span class="setting-control">
							<label class="checkbox-control">
								<input
									type="checkbox"
									checked={notificationPermission() === "granted"}
									disabled={
										notificationPermission() === "denied" || notificationPermission() === "unsupported"
									}
									onChange={(e) => {
										if (e.currentTarget.checked) void requestNotifications();
									}}
								/>
								<span>{notificationPermission() === "granted" ? "enabled" : "enable notifications"}</span>
							</label>
						</span>
					</div>
				</section>

				<section class="settings-section">
					<h2>devices</h2>
					<div class="device-row">
						<span>
							this machine <span class="this-device">{auth()?.mode === "local" ? "local" : "host"}</span>
						</span>
						<span class="meta">local · always allowed</span>
					</div>
					<For each={devices() ?? []}>
						{(device) => (
							<div class="device-row">
								<span>{device.device ?? device.id}</span>
								<span class="meta">
									{device.identity} · paired {relativeTime(device.createdAt)}
								</span>
								<span class="actions">
									<button
										type="button"
										class="btn btn-small btn-danger"
										onClick={async () => {
											await api.unpair(device.id);
											await refetchDevices();
										}}
									>
										unpair
									</button>
								</span>
							</div>
						)}
					</For>
					<Show when={(devices() ?? []).length === 0}>
						<p class="muted small" style={{ "padding-top": "8px" }}>
							No remote devices paired. Launch with <code>--remote --allow &lt;identity&gt;</code> to enable
							Tailscale access.
						</p>
					</Show>
				</section>

				<footer>dreb{version() ? ` v${version()}` : ""} · dashboard</footer>
			</main>
		</div>
	);
}
