/**
 * Settings tab — persistent defaults via get/set_settings (validation errors
 * shown verbatim) + paired-devices management + version footer.
 */

import {
	createEffect,
	createMemo,
	createResource,
	createSignal,
	For,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type {
	AgentTypeDto,
	ModelInfoDto,
	PairingCodeDto,
	SettingsDto,
	SettingsUpdateDto,
	SubagentArbiterSettingsDto,
	TabTitleSettingsDto,
	TabTitleSettingsUpdateDto,
} from "../../shared/protocol.js";
import { api } from "../api.js";
import { Modal, relativeTime, Topbar } from "../components/common.js";
import { ScopedModelsEditor } from "../components/scoped-models-editor.js";
import { ThemeGallery } from "../components/theme-gallery.js";
import {
	expandThinking,
	imageDisplayMode,
	isToolAutoOpen,
	setExpandThinking,
	setImageDisplayMode,
	setToolAutoExpand,
	TOOL_AUTO_EXPAND_TOOLS,
} from "../state/preferences.js";
import type { AppStore } from "../state/store.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const QUEUE_MODES = ["all", "one-at-a-time"] as const;
const TRANSPORTS = ["sse", "websocket", "auto"] as const;

type ModelChoice = Pick<ModelInfoDto, "provider" | "id"> & Partial<Pick<ModelInfoDto, "name" | "reasoning">>;
type ModelPickerTarget =
	| { kind: "default" }
	| { kind: "arbiter" }
	| { kind: "tabTitle" }
	| { kind: "agent"; agentName: string };

function modelKey(model: Pick<ModelInfoDto, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function modelTitle(model: Pick<ModelInfoDto, "provider" | "id"> & { name?: string }): string {
	const id = modelKey(model);
	return model.name ? `${id} — ${model.name}` : id;
}

function defaultModelLabel(settings: SettingsDto): string {
	return settings.defaultProvider && settings.defaultModel
		? `${settings.defaultProvider}/${settings.defaultModel}`
		: "choose model…";
}

function modelMatchesQuery(model: ModelChoice, query: string): boolean {
	return `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(query);
}

/**
 * Compute the initial notification-permission state for the settings screen.
 * NOTE: Solid's `createSignal` treats a function argument as the stored value,
 * not as a lazy initializer — so this must be called (not passed as `() => …`)
 * when constructing the signal, otherwise the signal holds the function object
 * and the disabled/hint bindings never see "ios-install" / "unsupported" /
 * "denied".
 */
function initialNotificationPermission(): NotificationPermission | "unsupported" | "ios-install" | "insecure" {
	if (typeof Notification === "undefined") {
		// Plain HTTP over a non-loopback host (e.g. `--remote` without `--https`)
		// is an insecure context: the browser exposes no Notification API and no
		// service workers at all. Installing the PWA cannot fix this — say so
		// instead of showing a misleading install hint or a bare "unsupported".
		if (window.isSecureContext === false) return "insecure";
		// iOS Safari exposes no Notification API in a browser tab — only the
		// installed PWA (Add to Home Screen) gets one (iOS 16.4+). Show the
		// install prerequisite instead of a bare "unsupported" so the user
		// knows what to do rather than thinking their device can't do it.
		const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
		const isStandalone =
			(navigator as { standalone?: boolean }).standalone === true ||
			window.matchMedia?.("(display-mode: standalone)")?.matches === true;
		if (isIOS && !isStandalone) return "ios-install";
		return "unsupported";
	}
	return Notification.permission;
}

function groupedModels(models: ModelChoice[]): Array<{ provider: string; models: ModelChoice[] }> {
	const groups = new Map<string, ModelChoice[]>();
	for (const model of models) {
		const group = groups.get(model.provider) ?? [];
		group.push(model);
		groups.set(model.provider, group);
	}
	return [...groups.entries()].map(([provider, group]) => ({ provider, models: group }));
}

function moveItem<T>(items: T[], index: number, delta: -1 | 1): T[] {
	const target = index + delta;
	if (target < 0 || target >= items.length) return items;
	const next = [...items];
	[next[index], next[target]] = [next[target]!, next[index]!];
	return next;
}

function OnOffSelect(props: { value: boolean; onChange: (value: boolean) => unknown }): JSX.Element {
	return (
		<select
			value={props.value ? "on" : "off"}
			onChange={(event) => {
				const accepted = props.onChange(event.currentTarget.value === "on");
				if (accepted === false) event.currentTarget.value = props.value ? "on" : "off";
			}}
		>
			<option value="on">on</option>
			<option value="off">off</option>
		</select>
	);
}

function ModelPickerModal(props: {
	title: string;
	models: ModelChoice[];
	selected?: string[];
	/** Label for an optional first row that clears the selection (e.g. restore the automatic route). */
	clearLabel?: string;
	onClear?: () => void;
	onClose: () => void;
	onPick: (model: ModelChoice) => void;
}): JSX.Element {
	const [filter, setFilter] = createSignal("");
	const selected = () => new Set(props.selected ?? []);
	const filteredGroups = createMemo(() => {
		const q = filter().toLowerCase();
		return groupedModels(props.models.filter((model) => !q || modelMatchesQuery(model, q)).slice(0, 100));
	});
	const isCurrent = (model: ModelChoice) => selected().has(modelKey(model));

	return (
		<Modal title={props.title} onDismiss={props.onClose} class="model-picker-modal">
			<div class="field" style={{ "margin-bottom": "8px" }}>
				<input
					type="text"
					placeholder="search models…"
					value={filter()}
					onInput={(e) => setFilter(e.currentTarget.value)}
				/>
			</div>
			<div class="model-list" style={{ "max-height": "320px" }}>
				<Show when={props.onClear && props.clearLabel}>
					<button
						type="button"
						class="model-row model-clear-row"
						classList={{ current: selected().size === 0 }}
						onClick={() => props.onClear?.()}
					>
						<span class="model-current">{selected().size === 0 ? "✓" : ""}</span>
						<span class="model-id">{props.clearLabel}</span>
					</button>
				</Show>
				<Show when={filteredGroups().length > 0} fallback={<p class="muted small">No matching models.</p>}>
					<For each={filteredGroups()}>
						{(group) => (
							<section class="model-provider-group">
								<div class="model-provider-heading">{group.provider}</div>
								<For each={group.models}>
									{(model) => (
										<button
											type="button"
											class="model-row"
											classList={{ current: isCurrent(model) }}
											title={modelTitle(model)}
											onClick={() => props.onPick(model)}
										>
											<span class="model-current">{isCurrent(model) ? "✓" : ""}</span>
											<span class="model-id">{model.id}</span>
											<Show when={model.name}>
												<span class="model-name">{model.name}</span>
											</Show>
											<span class="model-provider-badge">{model.provider}</span>
											<Show when={model.reasoning}>
												<span class="model-reasoning">think</span>
											</Show>
										</button>
									)}
								</For>
							</section>
						)}
					</For>
				</Show>
			</div>
		</Modal>
	);
}

export function SettingsScreen(props: {
	store: AppStore;
	target?: "scoped-models";
	routeScopedModelsCwd?: string;
}): JSX.Element {
	const [error, setError] = createSignal<string>();
	const [warnings, setWarnings] = createSignal<string[]>([]);
	const [saved, setSaved] = createSignal(false);
	const [modelPickerTarget, setModelPickerTarget] = createSignal<ModelPickerTarget>();
	const [editingAgent, setEditingAgent] = createSignal<string>();
	const [agentContextCwd, setAgentContextCwd] = createSignal<string>();
	const [scopedModelsCwd, setScopedModelsCwd] = createSignal<string | undefined>(
		props.target === "scoped-models" ? props.routeScopedModelsCwd : undefined,
	);
	createEffect(() => {
		setScopedModelsCwd(props.target === "scoped-models" ? props.routeScopedModelsCwd : undefined);
	});
	const [trustedContextFolderPath, setTrustedContextFolderPath] = createSignal("");
	const [contextTrustMutating, setContextTrustMutating] = createSignal(false);
	const [notificationPermission, setNotificationPermission] = createSignal<
		NotificationPermission | "unsupported" | "ios-install" | "insecure"
	>(initialNotificationPermission());

	const [settings, { mutate, refetch }] = createResource(async () => {
		setError(undefined);
		try {
			return await api.settings();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return undefined;
		}
	});

	const [availableModels] = createResource(settings, async () => {
		try {
			const { models } = await api.settingsModels();
			return models;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return [];
		}
	});

	const agentProjectRoots = createMemo(() => {
		const roots = new Set<string>();
		for (const runtime of props.store.fleet().runtimes) roots.add(runtime.cwd);
		for (const session of props.store.fleet().diskSessions) roots.add(session.cwd);
		return [...roots].sort((a, b) => a.localeCompare(b));
	});

	const [agentTypes] = createResource(
		() => ({ settings: settings(), cwd: agentContextCwd() }),
		async ({ cwd }) => {
			if (!settings()) return [];
			try {
				const { agentTypes } = await api.agentTypes(cwd);
				return agentTypes;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return [];
			}
		},
	);

	const [devices, { refetch: refetchDevices }] = createResource(async () => {
		const { devices } = await api.devices();
		return devices;
	});

	const [pairingSettingsError, setPairingSettingsError] = createSignal<string>();
	const [pairingSettingsSaved, setPairingSettingsSaved] = createSignal(false);
	const [pairingSettingsSaving, setPairingSettingsSaving] = createSignal(false);
	const [pairingTtlDays, setPairingTtlDays] = createSignal("");
	const [pairingSettings, { mutate: mutatePairingSettings }] = createResource(async () => {
		try {
			return await api.pairingSettings();
		} catch (err) {
			setPairingSettingsError(err instanceof Error ? err.message : String(err));
			return undefined;
		}
	});
	createEffect(() => {
		const loaded = pairingSettings();
		if (loaded) setPairingTtlDays(String(loaded.pairingTtlDays));
	});

	async function savePairingSettings(): Promise<void> {
		setPairingSettingsError(undefined);
		setPairingSettingsSaved(false);
		const days = Number(pairingTtlDays());
		if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
			setPairingSettingsError("pairing lifetime must be a whole number from 1 through 3650 days");
			return;
		}
		setPairingSettingsSaving(true);
		try {
			const result = await api.savePairingSettings(days);
			mutatePairingSettings(result);
			setPairingSettingsSaved(true);
		} catch (err) {
			setPairingSettingsError(err instanceof Error ? err.message : String(err));
		} finally {
			setPairingSettingsSaving(false);
		}
	}

	const [pairingCode, setPairingCode] = createSignal<PairingCodeDto>();
	let pairingCodeTimer: ReturnType<typeof setTimeout> | undefined;

	function clearPairingCodeTimer() {
		if (pairingCodeTimer) clearTimeout(pairingCodeTimer);
		pairingCodeTimer = undefined;
	}

	function schedulePairingCodeRefresh(expiresInMs: number | undefined) {
		clearPairingCodeTimer();
		const delay = Math.max(250, expiresInMs ?? 30_000) + 100;
		pairingCodeTimer = setTimeout(() => void refreshPairingCode(), delay);
	}

	async function refreshPairingCode() {
		try {
			const next = await api.pairingCode();
			if (!next.enabled || !next.code) {
				setPairingCode(undefined);
				clearPairingCodeTimer();
				return;
			}
			setPairingCode(next);
			schedulePairingCodeRefresh(next.expiresInMs);
		} catch (err) {
			console.warn("pairing code unavailable", err);
			setPairingCode(undefined);
			clearPairingCodeTimer();
		}
	}

	const [version] = createResource(async () => {
		try {
			const { version } = await api.version();
			return version;
		} catch {
			return undefined; // no live runtime — version unavailable, footer shows dashboard only
		}
	});

	const [serverInfo] = createResource(async () => {
		try {
			return await api.serverInfo();
		} catch {
			return undefined;
		}
	});
	const [showRestartConfirm, setShowRestartConfirm] = createSignal(false);
	const [restarting, setRestarting] = createSignal(false);
	const [restartError, setRestartError] = createSignal<string>();

	async function restartServer() {
		setRestartError(undefined);
		setRestarting(true);
		try {
			await api.restartServer();
			// The server exits and (under a supervisor) respawns; the SSE stream drops
			// and reconnects. Nothing more to do client-side.
		} catch (err) {
			setRestartError(err instanceof Error ? err.message : String(err));
			setRestarting(false);
		}
	}

	async function save(update: SettingsUpdateDto) {
		setError(undefined);
		setWarnings([]);
		setSaved(false);
		try {
			const next = await api.saveSettings(update);
			mutate(next);
			setWarnings(next.warnings ?? []);
			setSaved(true);
			setTimeout(() => setSaved(false), 2000);
		} catch (err) {
			// RPC validation errors surface verbatim — no silent retry.
			setError(err instanceof Error ? err.message : String(err));
			await refetch();
		}
	}

	let arbiterSaveQueue: Promise<void> = Promise.resolve();
	let pendingArbiterPolicy: SubagentArbiterSettingsDto | undefined;

	function currentArbiterPolicy(): SubagentArbiterSettingsDto {
		return pendingArbiterPolicy ?? settings()?.subagentArbiter ?? {};
	}

	function saveArbiterPolicy(update: Partial<SubagentArbiterSettingsDto>): void {
		const nextPolicy = { ...currentArbiterPolicy(), ...update };
		pendingArbiterPolicy = nextPolicy;

		const currentSettings = settings();
		if (currentSettings) mutate({ ...currentSettings, subagentArbiter: nextPolicy });

		arbiterSaveQueue = arbiterSaveQueue.then(async () => {
			setError(undefined);
			setWarnings([]);
			setSaved(false);
			try {
				const savedSettings = await api.saveSettings({ subagentArbiter: nextPolicy });
				setWarnings(savedSettings.warnings ?? []);
				setSaved(true);
				setTimeout(() => setSaved(false), 2000);

				if (pendingArbiterPolicy === nextPolicy) {
					pendingArbiterPolicy = savedSettings.subagentArbiter ?? undefined;
					mutate(savedSettings);
				} else {
					// A newer edit is queued. Keep that optimistic policy visible while this
					// authoritative response supplies every unrelated settings field.
					mutate({ ...savedSettings, subagentArbiter: pendingArbiterPolicy });
				}
			} catch (err) {
				// Refetch clears the shared error signal, so restore the authoritative
				// validation error after rollback instead of silently hiding it.
				const saveError = err instanceof Error ? err.message : String(err);
				const refreshed = await refetch();
				setError(saveError);
				if (pendingArbiterPolicy === nextPolicy) {
					pendingArbiterPolicy = refreshed?.subagentArbiter ?? undefined;
				} else if (refreshed) {
					// Do not let a failed older request erase a newer queued edit.
					mutate({ ...refreshed, subagentArbiter: pendingArbiterPolicy });
				}
			}
		});
	}

	let tabTitleSaveQueue: Promise<void> = Promise.resolve();
	let pendingTabTitleSettings: TabTitleSettingsDto | undefined;

	function currentTabTitleSettings(): TabTitleSettingsDto {
		return pendingTabTitleSettings ?? settings()?.tabTitle ?? {};
	}

	function saveTabTitleSettings(update: TabTitleSettingsUpdateDto): void {
		const merged = { ...currentTabTitleSettings(), ...update };
		// `model: null` clears the pinned model; the optimistic state drops it so the
		// picker immediately shows the automatic Explore route again.
		const nextSettings: TabTitleSettingsDto = { ...merged, model: merged.model ?? undefined };
		pendingTabTitleSettings = nextSettings;

		const currentSettings = settings();
		if (currentSettings) mutate({ ...currentSettings, tabTitle: nextSettings });

		tabTitleSaveQueue = tabTitleSaveQueue.then(async () => {
			setError(undefined);
			setWarnings([]);
			setSaved(false);
			try {
				const savedSettings = await api.saveSettings({ tabTitle: update });
				setWarnings(savedSettings.warnings ?? []);
				setSaved(true);
				setTimeout(() => setSaved(false), 2000);

				if (pendingTabTitleSettings === nextSettings) {
					pendingTabTitleSettings = savedSettings.tabTitle ?? undefined;
					mutate(savedSettings);
				} else {
					mutate({ ...savedSettings, tabTitle: pendingTabTitleSettings });
				}
			} catch (err) {
				const saveError = err instanceof Error ? err.message : String(err);
				const refreshed = await refetch();
				setError(saveError);
				if (pendingTabTitleSettings === nextSettings) {
					pendingTabTitleSettings = refreshed?.tabTitle ?? undefined;
				} else if (refreshed) {
					mutate({ ...refreshed, tabTitle: pendingTabTitleSettings });
				}
			}
		});
	}

	async function saveAgentModels(agentName: string, nextList: string[]) {
		await save({ agentModels: { [agentName]: nextList } });
	}

	async function addTrustedFolder(path: string) {
		setError(undefined);
		setContextTrustMutating(true);
		try {
			const result = await api.trustContextFolder(path);
			mutate(result.settings);
			setTrustedContextFolderPath("");
		} catch (err) {
			// RPC validation errors surface verbatim — no silent retry.
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setContextTrustMutating(false);
		}
	}

	async function removeTrustedFolder(path: string) {
		setError(undefined);
		setContextTrustMutating(true);
		try {
			const result = await api.removeTrustedContextFolder(path);
			mutate(result.settings);
		} catch (err) {
			// RPC validation errors surface verbatim — no silent retry.
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setContextTrustMutating(false);
		}
	}

	function currentAgentModels(agentName: string): string[] {
		return settings()?.agentModels?.[agentName] ?? [];
	}

	function arbiterReadiness(current: SettingsDto): { ready: boolean; message: string } {
		const arbiter = current.subagentArbiter;
		if (arbiter?.enabled !== true) return { ready: false, message: "disabled" };
		if (typeof arbiter.model !== "string" || !arbiter.model.trim()) {
			return { ready: false, message: "not ready — choose an arbiter model" };
		}
		if (arbiter.thinking !== undefined && !THINKING_LEVELS.some((level) => level === arbiter.thinking)) {
			return { ready: false, message: "not ready — arbiter thinking setting is invalid" };
		}
		if (arbiter.guidePath !== undefined && typeof arbiter.guidePath !== "string") {
			return { ready: false, message: "not ready — routing guide path is invalid" };
		}
		if (!arbiter.guidePath?.trim()) {
			return {
				ready: true,
				message: "enabled — using ~/.dreb/agent/model-routing-guide.md; live scope/guide checked at dispatch",
			};
		}
		return { ready: true, message: "enabled — live scope and guide are validated before every child spawn" };
	}

	async function requestNotifications() {
		if (typeof Notification === "undefined") return;
		setNotificationPermission(await Notification.requestPermission());
	}

	onMount(() => void refreshPairingCode());
	onCleanup(clearPairingCodeTimer);

	const auth = () => props.store.auth();

	return (
		<div class="screen-fill">
			<Topbar store={props.store} active="settings" />
			<main class="container settings-wrap">
				<h1>settings</h1>
				<p class="settings-intro">
					Ordinary defaults apply only to new sessions. Dispatch Arbiter changes apply to subsequent child spawns.
					Context trust changes apply to subsequent lazy loads in live sessions; already injected content cannot be
					retracted. Writes go to the global settings file on the host.
				</p>

				<Show when={error()}>
					<div class="settings-error">{error()}</div>
				</Show>
				<Show when={warnings().length > 0}>
					<div class="settings-warning">
						<For each={warnings()}>{(warning) => <div>{warning}</div>}</For>
					</div>
				</Show>
				<Show when={saved()}>
					<p class="muted small" style={{ "margin-bottom": "16px" }}>
						✓ saved
					</p>
				</Show>

				<Show
					when={settings()}
					fallback={
						<p class="muted">
							{error() ? "Settings could not be loaded — see the error above." : "Loading settings…"}
						</p>
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
										<button
											type="button"
											class="btn btn-small model-picker-button"
											onClick={() => setModelPickerTarget({ kind: "default" })}
										>
											{defaultModelLabel(current())}
										</button>
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
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">transport</span>
										<span class="hint">preferred model transport for new sessions</span>
									</span>
									<span class="setting-control">
										<select
											value={current().transport ?? "sse"}
											onChange={(e) =>
												save({ transport: e.currentTarget.value as "sse" | "websocket" | "auto" })
											}
										>
											<For each={[...TRANSPORTS]}>
												{(transport) => <option value={transport}>{transport}</option>}
											</For>
										</select>
									</span>
								</div>
							</section>

							<section class="settings-section tab-title-settings">
								<h2>tab title</h2>
								<p class="muted small" style={{ "margin-bottom": "8px" }}>
									Automatically names new, unnamed sessions after a few tool calls. Changes apply to new
									sessions.
								</p>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">enabled</span>
										<span class="hint">enabled by default; disabled sessions make no title model call</span>
									</span>
									<span class="setting-control">
										<OnOffSelect
											value={current().tabTitle?.enabled !== false}
											onChange={(enabled) => saveTabTitleSettings({ enabled })}
										/>
									</span>
								</div>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">title model</span>
										<span class="hint">
											exact authenticated provider/model; parent session model remains the retry
										</span>
									</span>
									<span class="setting-control">
										<button
											type="button"
											class="btn btn-small model-picker-button"
											onClick={() => setModelPickerTarget({ kind: "tabTitle" })}
										>
											{typeof current().tabTitle?.model === "string"
												? current().tabTitle?.model
												: "automatic (Explore route)"}
										</button>
									</span>
								</div>
							</section>

							<ScopedModelsEditor
								cwd={scopedModelsCwd()}
								projectRoots={agentProjectRoots()}
								focused={props.target === "scoped-models"}
								onCwdChange={(cwd) => {
									setScopedModelsCwd(cwd);
									props.store.navigate({
										screen: "settings",
										target: "scoped-models",
										...(cwd ? { cwd } : {}),
									});
								}}
							/>

							<section class="settings-section dispatch-arbiter-settings">
								<h2>dispatch arbiter</h2>
								<p class="muted small" style={{ "margin-bottom": "8px" }}>
									Global-only, fully headless pre-spawn routing. Project settings cannot change it. When
									enabled, invalid model, scope, guide, inference, or output prevents the affected child from
									spawning.
								</p>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">enabled</span>
										<span class="hint">disabled by default; fail closed when enabled</span>
									</span>
									<span class="setting-control">
										<OnOffSelect
											value={current().subagentArbiter?.enabled === true}
											onChange={(enabled) => {
												const arbiter = currentArbiterPolicy();
												if (enabled && (typeof arbiter.model !== "string" || !arbiter.model.trim())) {
													setError("Choose an exact Dispatch Arbiter model before enabling it.");
													setModelPickerTarget({ kind: "arbiter" });
													return false;
												}
												saveArbiterPolicy({ enabled });
												return true;
											}}
										/>
									</span>
								</div>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">arbiter model</span>
										<span class="hint">exact authenticated provider/model; no fallback</span>
									</span>
									<span class="setting-control">
										<button
											type="button"
											class="btn btn-small model-picker-button"
											onClick={() => setModelPickerTarget({ kind: "arbiter" })}
										>
											{typeof current().subagentArbiter?.model === "string"
												? current().subagentArbiter?.model
												: "choose model…"}
										</button>
									</span>
								</div>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">arbiter thinking</span>
										<span class="hint">validated against the selected arbiter model</span>
									</span>
									<span class="setting-control">
										<select
											value={
												typeof current().subagentArbiter?.thinking === "string" &&
												THINKING_LEVELS.some((level) => level === current().subagentArbiter?.thinking)
													? current().subagentArbiter?.thinking
													: "off"
											}
											onChange={(event) =>
												saveArbiterPolicy({
													thinking: event.currentTarget.value as
														| "off"
														| "minimal"
														| "low"
														| "medium"
														| "high"
														| "xhigh"
														| "max",
												})
											}
										>
											<For each={THINKING_LEVELS}>{(level) => <option value={level}>{level}</option>}</For>
										</select>
									</span>
								</div>
								<div class="setting-row">
									<label class="setting-label" for="dispatch-arbiter-guide-path">
										<span class="name">routing guide path</span>
										<span class="hint">blank uses ~/.dreb/agent/model-routing-guide.md</span>
									</label>
									<span class="setting-control">
										<input
											id="dispatch-arbiter-guide-path"
											type="text"
											value={
												typeof current().subagentArbiter?.guidePath === "string"
													? current().subagentArbiter?.guidePath
													: ""
											}
											placeholder="~/.dreb/agent/model-routing-guide.md"
											onChange={(event) => {
												const guidePath = event.currentTarget.value.trim();
												saveArbiterPolicy({ guidePath: guidePath || undefined });
											}}
										/>
									</span>
								</div>
								<div
									class={arbiterReadiness(current()).ready ? "settings-warning" : "muted small"}
									data-testid="dispatch-arbiter-readiness"
								>
									<strong>status:</strong> {arbiterReadiness(current()).message}
								</div>
							</section>

							<section class="settings-section">
								<h2>agent models</h2>
								<p class="muted small" style={{ "margin-bottom": "8px" }}>
									Per-agent fallback lists. First available model wins; empty lists revert to the default
									model. Agent definitions are loaded from an explicit project context so project-local agents
									do not depend on which runtime opened first.
								</p>
								<Show when={agentProjectRoots().length > 0}>
									<div class="setting-row agent-context-row">
										<span class="setting-label">
											<span class="name">agent definition context</span>
											<span class="hint">choose a project to include its .dreb/agents definitions</span>
										</span>
										<span class="setting-control">
											<select
												value={agentContextCwd() ?? ""}
												title={agentContextCwd() ?? "global/home only"}
												onChange={(e) => setAgentContextCwd(e.currentTarget.value || undefined)}
											>
												<option value="">global/home only</option>
												<For each={agentProjectRoots()}>{(cwd) => <option value={cwd}>{cwd}</option>}</For>
											</select>
										</span>
									</div>
								</Show>
								<Show
									when={(agentTypes() ?? []).length > 0}
									fallback={<p class="muted small">No agent definitions found.</p>}
								>
									<For each={agentTypes() ?? []}>
										{(agent: AgentTypeDto) => {
											const fallbackList = () => current().agentModels?.[agent.name] ?? [];
											return (
												<div class="agent-model-row">
													<div class="agent-model-summary">
														<span class="agent-model-name">{agent.name}</span>
														<span class="agent-model-description">{agent.description}</span>
													</div>
													<div class="agent-model-fallbacks">
														<Show
															when={fallbackList().length > 0}
															fallback={<span class="muted small">default</span>}
														>
															<For each={fallbackList()}>
																{(entry, index) => (
																	<span class="agent-model-chip">
																		{index() + 1}. {entry}
																	</span>
																)}
															</For>
														</Show>
													</div>
													<button
														type="button"
														class="btn btn-small agent-model-edit"
														onClick={() =>
															setEditingAgent(editingAgent() === agent.name ? undefined : agent.name)
														}
													>
														{editingAgent() === agent.name ? "done" : "edit"}
													</button>
													<Show when={editingAgent() === agent.name}>
														<div class="agent-model-editor">
															<Show
																when={fallbackList().length > 0}
																fallback={<p class="muted small">Using the default model.</p>}
															>
																<For each={fallbackList()}>
																	{(entry, index) => (
																		<div class="agent-model-entry">
																			<span>{entry}</span>
																			<div class="agent-model-entry-actions">
																				<button
																					type="button"
																					class="btn btn-small"
																					disabled={index() === 0}
																					onClick={() =>
																						void saveAgentModels(
																							agent.name,
																							moveItem(fallbackList(), index(), -1),
																						)
																					}
																				>
																					↑
																				</button>
																				<button
																					type="button"
																					class="btn btn-small"
																					disabled={index() === fallbackList().length - 1}
																					onClick={() =>
																						void saveAgentModels(
																							agent.name,
																							moveItem(fallbackList(), index(), 1),
																						)
																					}
																				>
																					↓
																				</button>
																				<button
																					type="button"
																					class="btn btn-small"
																					onClick={() =>
																						void saveAgentModels(
																							agent.name,
																							fallbackList().filter((_, i) => i !== index()),
																						)
																					}
																				>
																					×
																				</button>
																			</div>
																		</div>
																	)}
																</For>
															</Show>
															<button
																type="button"
																class="btn btn-small"
																onClick={() =>
																	setModelPickerTarget({ kind: "agent", agentName: agent.name })
																}
															>
																add model…
															</button>
														</div>
													</Show>
												</div>
											);
										}}
									</For>
								</Show>
							</section>

							<section class="settings-section">
								<h2>images</h2>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">auto-resize images</span>
										<span class="hint">resize image inputs before sending them to providers</span>
									</span>
									<span class="setting-control">
										<OnOffSelect
											value={current().imageAutoResize !== false}
											onChange={(value) => save({ imageAutoResize: value })}
										/>
									</span>
								</div>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">block images</span>
										<span class="hint">prevent image inputs from being sent to providers</span>
									</span>
									<span class="setting-control">
										<OnOffSelect
											value={current().blockImages === true}
											onChange={(value) => save({ blockImages: value })}
										/>
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
								<h2>behavior</h2>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">skill slash commands</span>
										<span class="hint">register skills as slash commands in new sessions</span>
									</span>
									<span class="setting-control">
										<OnOffSelect
											value={current().enableSkillCommands !== false}
											onChange={(value) => save({ enableSkillCommands: value })}
										/>
									</span>
								</div>
								<div class="setting-row">
									<label class="setting-label" for="max-concurrent-subagents">
										<span class="name">max concurrent subagents</span>
										<span class="hint">
											new parent sessions only; 0 removes the subagent tool (default 4)
										</span>
									</label>
									<span class="setting-control">
										<input
											id="max-concurrent-subagents"
											type="number"
											min="0"
											step="1"
											value={current().maxConcurrentSubagents ?? 4}
											onChange={(event) => {
												const rawValue = event.currentTarget.value.trim();
												const value = rawValue.length > 0 ? Number(rawValue) : Number.NaN;
												if (!Number.isSafeInteger(value) || value < 0) {
													setError("Max concurrent subagents must be a non-negative whole number");
													event.currentTarget.value = String(current().maxConcurrentSubagents ?? 4);
													return;
												}
												void save({ maxConcurrentSubagents: value });
											}}
										/>
									</span>
								</div>
								<div class="context-trust-subsection">
									<h3>trusted context folders</h3>
									<p class="muted small">
										Specific global roots that may lazy-load nested AGENTS.md/CLAUDE.md and all descendants.
									</p>
									<div class="settings-warning context-trust-global-warning">
										<strong>Global-only policy.</strong> Project <code>.dreb/settings.json</code> cannot
										enable, disable, or extend nested-context trust. Only these global settings and the Files
										view can; a cloned repository cannot grant itself trust.
									</div>
									<Show
										when={(current().trustedContextFolders ?? []).length > 0}
										fallback={
											<p class="muted small trusted-context-empty">
												No trusted folders. Use the Files view to trust a project folder and its
												descendants.
											</p>
										}
									>
										<For each={current().trustedContextFolders ?? []}>
											{(path) => (
												<div class="trusted-context-folder-row">
													<code>{path}</code>
													<span class="meta">and all descendants</span>
													<button
														type="button"
														class="btn btn-small btn-danger"
														disabled={contextTrustMutating()}
														onClick={() => void removeTrustedFolder(path)}
													>
														{contextTrustMutating() ? "revoking…" : "revoke trust"}
													</button>
												</div>
											)}
										</For>
									</Show>
									<form
										class="trusted-context-folder-add"
										onSubmit={(event) => {
											event.preventDefault();
											const path = trustedContextFolderPath().trim();
											if (path) void addTrustedFolder(path);
										}}
									>
										<label for="trusted-context-folder-path">add folder by path</label>
										<input
											id="trusted-context-folder-path"
											type="text"
											value={trustedContextFolderPath()}
											onInput={(event) => setTrustedContextFolderPath(event.currentTarget.value)}
											placeholder="/path/to/project"
										/>
										<button
											type="submit"
											class="btn btn-small"
											disabled={contextTrustMutating() || !trustedContextFolderPath().trim()}
										>
											{contextTrustMutating() ? "trusting…" : "trust folder"}
										</button>
									</form>
								</div>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">global expert nested-context trust</span>
										<span class="hint">allow nested AGENTS.md/CLAUDE.md from any resolvable directory</span>
									</span>
									<span class="setting-control">
										<OnOffSelect
											value={current().autoLoadNestedContext === true}
											onChange={(value) => save({ autoLoadNestedContext: value })}
										/>
									</span>
								</div>
								<div class="settings-warning context-expert-warning">
									<strong>Expert global override.</strong> Project <code>.dreb/settings.json</code> cannot
									enable, disable, or extend nested-context trust; a cloned repository cannot grant itself
									trust. When ON, nested instructions from any resolvable directory may load, including
									untrusted prompt-injection content. Leave this OFF and use trusted folders for projects you
									control.
								</div>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">hide thinking blocks</span>
										<span class="hint">hide raw thinking blocks in rendered transcripts</span>
									</span>
									<span class="setting-control">
										<OnOffSelect
											value={current().hideThinkingBlock === true}
											onChange={(value) => save({ hideThinkingBlock: value })}
										/>
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
										<OnOffSelect
											value={current().compactionEnabled !== false}
											onChange={(value) => save({ compactionEnabled: value })}
										/>
									</span>
								</div>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">continue after auto-compaction</span>
										<span class="hint">
											can run and incur cost indefinitely; manual compaction never continues
										</span>
									</span>
									<span class="setting-control">
										<OnOffSelect
											value={current().continueAfterAutoCompaction === true}
											onChange={(value) => save({ continueAfterAutoCompaction: value })}
										/>
									</span>
								</div>
								<div class="setting-row">
									<span class="setting-label">
										<span class="name">auto-retry</span>
										<span class="hint">retry transient stream errors (rate limits, 5xx)</span>
									</span>
									<span class="setting-control">
										<OnOffSelect
											value={current().retryEnabled !== false}
											onChange={(value) => save({ retryEnabled: value })}
										/>
									</span>
								</div>
							</section>

							<p class="muted small settings-footnote">
								TUI-only settings (cursor, editor) are managed in the terminal /settings menu. The dashboard
								appearance (theme + light/dark mode + font) is set here, per-browser, and is independent of the
								TUI theme.
							</p>
						</>
					)}
				</Show>

				<section class="settings-section">
					<h2>dashboard</h2>
					<div class="appearance-block">
						<div class="setting-row appearance-heading-row">
							<span class="setting-label">
								<span class="name">appearance</span>
								<span class="hint">
									this browser only — theme, light/dark mode, and font are stored in localStorage and are
									independent of the TUI theme. Okabe-Ito and Paul Tol are colorblind-safe palettes.
								</span>
							</span>
						</div>
						<ThemeGallery />
					</div>
					<div class="setting-row">
						<label class="setting-label" for="pref-image-display-mode">
							<span class="name">tool-result images</span>
							<span class="hint">
								this browser only — placeholders make no automatic request, previews are bounded to 1024 px and
								256 KiB, and originals automatically transfer full files. Choosing originals is the informed
								network-data opt-in.
							</span>
						</label>
						<span class="setting-control">
							<select
								id="pref-image-display-mode"
								value={imageDisplayMode()}
								onChange={(event) =>
									setImageDisplayMode(event.currentTarget.value as "placeholders" | "previews" | "originals")
								}
							>
								<option value="placeholders">placeholders</option>
								<option value="previews">bounded previews</option>
								<option value="originals">automatic originals</option>
							</select>
						</span>
					</div>
					<div class="setting-row">
						<span class="setting-label">
							<span class="name">always expand thinking</span>
							<span class="hint">this browser only — stored in localStorage, not the host settings file</span>
						</span>
						<span class="setting-control">
							<label class="checkbox-control">
								<input
									id="pref-expand-thinking"
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
							<span class="name">auto-expand tool cards</span>
							<span class="hint">this browser only — stored in localStorage, not the host settings file</span>
						</span>
						<span class="setting-control" style={{ display: "grid", gap: "6px" }}>
							<For each={TOOL_AUTO_EXPAND_TOOLS}>
								{(toolName) => (
									<label class="checkbox-control">
										<input
											id={`pref-tool-expand-${toolName}`}
											type="checkbox"
											checked={isToolAutoOpen(toolName)}
											onChange={(e) => setToolAutoExpand(toolName, e.currentTarget.checked)}
										/>
										<span>{toolName}</span>
									</label>
								)}
							</For>
						</span>
					</div>
					<div class="setting-row">
						<span class="setting-label">
							<span class="name">needs-attention notifications</span>
							<span class="hint">
								{notificationPermission() === "denied"
									? "blocked by browser settings — re-enable notifications in site permissions"
									: notificationPermission() === "insecure"
										? "this page is not a secure context — notifications need HTTPS. Run the server with --https (tailscale cert <host>.<tailnet>.ts.net) and open it via the https:// hostname"
										: notificationPermission() === "ios-install"
											? "iOS notifications need the installed PWA — tap Share → Add to Home Screen, then open dreb from the home screen icon"
											: notificationPermission() === "unsupported"
												? "browser notifications are unavailable in this environment"
												: "show a notification when the tab needs input (Android/desktop need the app installed on mobile; works over HTTPS or localhost)"}
							</span>
						</span>
						<span class="setting-control">
							<label class="checkbox-control">
								<input
									id="pref-notifications"
									type="checkbox"
									checked={notificationPermission() === "granted"}
									disabled={
										notificationPermission() === "denied" ||
										notificationPermission() === "unsupported" ||
										notificationPermission() === "ios-install" ||
										notificationPermission() === "insecure"
									}
									onChange={(e) => {
										if (e.currentTarget.checked) void requestNotifications();
									}}
								/>
								<span>{notificationPermission() === "granted" ? "enabled" : "enable notifications"}</span>
							</label>
						</span>
					</div>
					<div class="setting-row">
						<span class="setting-label">
							<span class="name">restart dashboard service</span>
							<span class="hint">
								{serverInfo()?.supervised
									? "restarts the server process (a supervisor respawns it with the latest build) — kills all running sessions"
									: "exits the server process — only auto-restarts if run under a supervisor (systemd, pm2, …); otherwise the dashboard goes down. kills all running sessions"}
							</span>
						</span>
						<span class="setting-control">
							<button
								type="button"
								class="btn btn-small btn-danger"
								disabled={restarting()}
								onClick={() => setShowRestartConfirm(true)}
							>
								{restarting() ? "restarting…" : "restart"}
							</button>
						</span>
					</div>
					<Show when={restartError()}>
						<div class="settings-error">{restartError()}</div>
					</Show>
				</section>

				<section class="settings-section">
					<h2>devices</h2>
					<div class="device-row">
						<span>
							this machine <span class="this-device">{auth()?.mode === "local" ? "local" : "host"}</span>
						</span>
						<span class="meta">local · always allowed</span>
					</div>
					<div class="setting-row">
						<label class="setting-label" for="pairing-ttl-days">
							<span class="name">new pairing lifetime</span>
							<span class="hint">
								applies only to devices paired after saving; existing expiry dates do not change
							</span>
						</label>
						<span class="setting-control">
							<input
								id="pairing-ttl-days"
								type="number"
								min="1"
								max="3650"
								step="1"
								value={pairingTtlDays()}
								onInput={(event) => {
									setPairingTtlDays(event.currentTarget.value);
									setPairingSettingsSaved(false);
								}}
							/>
							<span>days</span>
							<button
								type="button"
								class="btn btn-small"
								disabled={pairingSettingsSaving() || pairingSettings.loading}
								onClick={() => void savePairingSettings()}
							>
								{pairingSettingsSaving() ? "saving…" : "save"}
							</button>
						</span>
					</div>
					<Show when={pairingSettingsSaved()}>
						<div class="settings-success">new pairing lifetime saved</div>
					</Show>
					<Show when={pairingSettingsError()}>
						<div class="settings-error">{pairingSettingsError()}</div>
					</Show>
					<Show when={pairingCode()?.enabled && pairingCode()?.code}>
						<div class="setting-row">
							<span class="setting-label">
								<span class="name">pairing code</span>
								<span class="hint">new devices enter this in the pairing screen; it rotates every 30s</span>
							</span>
							<span class="setting-control">
								<code style={{ "font-size": "var(--fs-h2)", "letter-spacing": "0.08em" }}>
									{pairingCode()!.code}
								</code>
							</span>
						</div>
					</Show>
					<For each={devices() ?? []}>
						{(device) => (
							<div class="device-row">
								<span>{device.device ?? device.id}</span>
								<span class="meta">
									{device.identity} · paired {relativeTime(device.createdAt)} · expires{" "}
									{device.expiresAt.slice(0, 10)}
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

				<footer>
					dreb
					{serverInfo()?.version ? ` v${serverInfo()!.version}` : version() ? ` v${version()}` : ""} · dashboard
					<Show when={serverInfo()?.startedAt}> · server build, up {relativeTime(serverInfo()!.startedAt)}</Show>
				</footer>
			</main>
			<Show when={showRestartConfirm()}>
				<Modal
					title="restart dashboard service?"
					onDismiss={() => setShowRestartConfirm(false)}
					actions={
						<>
							<button type="button" class="btn btn-small" onClick={() => setShowRestartConfirm(false)}>
								cancel
							</button>
							<button
								type="button"
								class="btn btn-small btn-danger"
								onClick={() => {
									setShowRestartConfirm(false);
									void restartServer();
								}}
							>
								restart
							</button>
						</>
					}
				>
					<p>
						This exits the dashboard server process and terminates <strong>all running sessions</strong>.
						{serverInfo()?.supervised
							? " A supervisor is detected — the server should respawn automatically with the latest build."
							: " No supervisor was detected — the dashboard will NOT come back on its own; you'll need to relaunch it manually."}
					</p>
				</Modal>
			</Show>
			<Show when={modelPickerTarget()}>
				{(target) => {
					const pickerTitle = () => {
						const active = target();
						if (active.kind === "default") return "select default model";
						if (active.kind === "arbiter") return "select Dispatch Arbiter model";
						if (active.kind === "tabTitle") return "select tab title model";
						return `add model for ${active.agentName}`;
					};
					const selectedKeys = () => {
						const active = target();
						if (active.kind === "default") {
							return settings()?.defaultProvider && settings()?.defaultModel
								? [`${settings()!.defaultProvider}/${settings()!.defaultModel}`]
								: [];
						}
						if (active.kind === "arbiter") {
							return settings()?.subagentArbiter?.model ? [settings()!.subagentArbiter!.model!] : [];
						}
						if (active.kind === "tabTitle") {
							return settings()?.tabTitle?.model ? [settings()!.tabTitle!.model!] : [];
						}
						return currentAgentModels(active.agentName);
					};
					return (
						<ModelPickerModal
							title={pickerTitle()}
							models={availableModels() ?? []}
							selected={selectedKeys()}
							clearLabel={target().kind === "tabTitle" ? "automatic (Explore route)" : undefined}
							onClear={
								target().kind === "tabTitle"
									? () => {
											setModelPickerTarget(undefined);
											saveTabTitleSettings({ model: null });
										}
									: undefined
							}
							onClose={() => setModelPickerTarget(undefined)}
							onPick={(model) => {
								const active = target();
								setModelPickerTarget(undefined);
								if (active.kind === "default") {
									void save({ defaultProvider: model.provider, defaultModel: model.id });
									return;
								}
								if (active.kind === "arbiter") {
									saveArbiterPolicy({ model: modelKey(model) });
									return;
								}
								if (active.kind === "tabTitle") {
									saveTabTitleSettings({ model: modelKey(model) });
									return;
								}
								const entry = modelKey(model);
								const currentList = currentAgentModels(active.agentName);
								if (currentList.includes(entry)) return;
								void saveAgentModels(active.agentName, [...currentList, entry]);
							}}
						/>
					);
				}}
			</Show>
		</div>
	);
}
