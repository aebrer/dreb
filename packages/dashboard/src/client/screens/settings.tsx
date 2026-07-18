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
import type { AgentTypeDto, ModelInfoDto, PairingCodeDto, SettingsDto } from "../../shared/protocol.js";
import { api } from "../api.js";
import { Modal, relativeTime, Topbar } from "../components/common.js";
import { ThemeGallery } from "../components/theme-gallery.js";
import {
	expandThinking,
	isToolAutoOpen,
	setExpandThinking,
	setToolAutoExpand,
	TOOL_AUTO_EXPAND_TOOLS,
} from "../state/preferences.js";
import type { AppStore } from "../state/store.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const QUEUE_MODES = ["all", "one-at-a-time"] as const;
const TRANSPORTS = ["sse", "websocket", "auto"] as const;

type ModelChoice = Pick<ModelInfoDto, "provider" | "id"> & Partial<Pick<ModelInfoDto, "name" | "reasoning">>;
type ModelPickerTarget = { kind: "default" } | { kind: "agent"; agentName: string };

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

function OnOffSelect(props: { value: boolean; onChange: (value: boolean) => void }): JSX.Element {
	return (
		<select value={props.value ? "on" : "off"} onChange={(e) => props.onChange(e.currentTarget.value === "on")}>
			<option value="on">on</option>
			<option value="off">off</option>
		</select>
	);
}

function ModelPickerModal(props: {
	title: string;
	models: ModelChoice[];
	selected?: string[];
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

export function SettingsScreen(props: { store: AppStore }): JSX.Element {
	const [error, setError] = createSignal<string>();
	const [warnings, setWarnings] = createSignal<string[]>([]);
	const [saved, setSaved] = createSignal(false);
	const [modelPickerTarget, setModelPickerTarget] = createSignal<ModelPickerTarget>();
	const [editingAgent, setEditingAgent] = createSignal<string>();
	const [agentContextCwd, setAgentContextCwd] = createSignal<string>();
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

	// Home-shaped prefixes collapse for display. Chromium's opened select popup
	// stays control-width and clips long absolute paths (issue 378), so options
	// render home-relative and the full cwd moves to the select's title tooltip.
	// With roots from multiple homes, disambiguate as ~user/path.
	const homePrefixOf = (cwd: string): string | undefined =>
		cwd.match(/^\/(?:home|Users)\/[^/]+/)?.[0] ?? (cwd === "/root" || cwd.startsWith("/root/") ? "/root" : undefined);

	const homeAliasOf = (home: string): string => (home === "/root" ? "root" : (home.split("/").pop() ?? ""));

	const distinctHomePrefixes = createMemo(() => {
		const homes = new Set<string>();
		for (const root of agentProjectRoots()) {
			const home = homePrefixOf(root);
			if (home) homes.add(home);
		}
		return homes;
	});

	// Aliases are not unique across home roots: /root vs /home/root and
	// /home/alice vs /Users/alice all share a final segment. Detect collisions
	// so displayCwd can namespace-qualify the affected labels.
	const collidingHomeAliases = createMemo(() => {
		const counts = new Map<string, number>();
		for (const home of distinctHomePrefixes()) {
			const alias = homeAliasOf(home);
			counts.set(alias, (counts.get(alias) ?? 0) + 1);
		}
		return new Set([...counts].filter(([, count]) => count > 1).map(([alias]) => alias));
	});

	const candidateLabel = (cwd: string): string => {
		const home = homePrefixOf(cwd);
		if (!home) return cwd;
		const rest = cwd.slice(home.length); // "" or "/…"
		if (distinctHomePrefixes().size <= 1) return `~${rest}`;
		const alias = homeAliasOf(home);
		if (home === "/root" || !collidingHomeAliases().has(alias)) return `~${alias}${rest}`;
		// Namespace-qualify colliding labels: ~home/root/…, ~Users/alice/….
		return `~${home.split("/")[1]}/${alias}${rest}`;
	};

	// Labels must be unique — distinct cwds with identical labels would be
	// indistinguishable in the native popup. Disambiguation covers home-alias
	// collisions, but crafted names can still duplicate a qualified label (a
	// user literally named "home": /home/home/alice vs qualified /home/alice).
	// Any remaining duplicate falls back to the unambiguous full cwd.
	const displayLabels = createMemo(() => {
		const labels = new Map<string, string>();
		for (const root of agentProjectRoots()) labels.set(root, candidateLabel(root));
		const counts = new Map<string, number>();
		for (const label of labels.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
		for (const [root, label] of labels) {
			if ((counts.get(label) ?? 0) > 1) labels.set(root, root);
		}
		return labels;
	});

	const displayCwd = (cwd: string): string => displayLabels().get(cwd) ?? cwd;

	// Keep the selection reconciled with the fleet: when the selected project
	// disappears, fall back to global so the select value, title tooltip, and
	// agentTypes context stay in sync instead of retaining a stale cwd. Empty
	// snapshots are tolerated — resync windows and out-of-order refreshes can
	// transiently report no roots, and the select is hidden while roots are
	// empty anyway, so a retained selection is neither visible nor harmful.
	// (General refreshFleet response ordering is tracked separately.)
	createEffect(() => {
		const selected = agentContextCwd();
		const roots = agentProjectRoots();
		if (selected && roots.length > 0 && !roots.includes(selected)) setAgentContextCwd(undefined);
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

	async function save(update: Partial<SettingsDto>) {
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
					Ordinary defaults apply only to new sessions. Context trust changes apply to subsequent lazy loads in
					live sessions; already injected content cannot be retracted. Writes go to the global settings file on the
					host.
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
												<For each={agentProjectRoots()}>
													{(cwd) => <option value={cwd}>{displayCwd(cwd)}</option>}
												</For>
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
								appearance (theme + light/dark mode) is set here, per-browser, and is independent of the TUI
								theme.
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
									this browser only — theme and light/dark mode are stored in localStorage and are independent
									of the TUI theme. Okabe-Ito and Paul Tol are colorblind-safe palettes.
								</span>
							</span>
						</div>
						<ThemeGallery />
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
						return active.kind === "default" ? "select default model" : `add model for ${active.agentName}`;
					};
					const selectedKeys = () => {
						const active = target();
						if (active.kind === "default") {
							return settings()?.defaultProvider && settings()?.defaultModel
								? [`${settings()!.defaultProvider}/${settings()!.defaultModel}`]
								: [];
						}
						return currentAgentModels(active.agentName);
					};
					return (
						<ModelPickerModal
							title={pickerTitle()}
							models={availableModels() ?? []}
							selected={selectedKeys()}
							onClose={() => setModelPickerTarget(undefined)}
							onPick={(model) => {
								const active = target();
								setModelPickerTarget(undefined);
								if (active.kind === "default") {
									void save({ defaultProvider: model.provider, defaultModel: model.id });
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
