/**
 * Session view — full-parity chat drill-in. Transcript, dock (tasks, subagent
 * strip, status line, composer with steer/follow-up modes + abort),
 * session bar with model/thinking switchers, extension-UI modals.
 */

import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type {
	CommandDto,
	ImageAttachmentDto,
	ModelInfoDto,
	PendingMessagesDto,
	PerformanceStatsDto,
	ResourcesDto,
	ScopedModelDto,
	SessionStateDto,
	SessionStatsDto,
} from "../../shared/protocol.js";
import { api } from "../api.js";
import { Modal } from "../components/common.js";
import { Transcript } from "../components/transcript.js";
import type { ExtensionUiRequest, SessionViewState } from "../state/reducer.js";
import type { AppStore } from "../state/store.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const UPLOAD_DIR_NAME = ".dreb-dashboard-uploads";
const composerHistory = new Map<string, string[]>();
// Per-session composer drafts — unsent text survives fleet→session navigation
// for as long as the tab lives (module scope). Keyed by runtime key.
const composerDrafts = new Map<string, string>();

type ModelChoice = Pick<ModelInfoDto, "provider" | "id"> & Partial<Pick<ModelInfoDto, "name" | "reasoning">>;
type ModelScope = "scoped" | "all";

interface PendingImageAttachment extends ImageAttachmentDto {
	fileName: string;
	size: number;
}

interface UploadedFileAttachment {
	fileName: string;
	size: number;
	mimeType: string;
	path: string;
}

function modelLabel(model: SessionStateDto["model"] | undefined): string {
	return model ? `${model.provider}/${model.id}` : "—";
}

function modelTitle(model: (Pick<ModelInfoDto, "provider" | "id"> & { name?: string }) | undefined): string {
	if (!model) return "—";
	const id = `${model.provider}/${model.id}`;
	return model.name ? `${id} — ${model.name}` : id;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function shortenPath(path: string): string {
	return path.replace(/^\/home\/[^/]+/, "~");
}

function joinPath(dir: string, name: string): string {
	return `${dir.replace(/\/+$/, "")}/${name}`;
}

function sanitizeUploadName(name: string): string {
	const trimmed = name.trim().replace(/[\\/\0]/g, "_");
	return trimmed && trimmed !== "." && trimmed !== ".." ? trimmed : "upload.bin";
}

function uniqueUploadName(file: File, index: number): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${stamp}-${index + 1}-${sanitizeUploadName(file.name || "upload.bin")}`;
}

function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
	return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function modelMatchesQuery(model: ModelChoice, query: string): boolean {
	return `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(query);
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

export function autoGrowTextarea(textarea: HTMLTextAreaElement): void {
	textarea.style.height = "auto";
	const maxHeight = Math.max(120, Math.floor((window.innerHeight || 800) * 0.4));
	const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
	if (nextHeight > 0) textarea.style.height = `${nextHeight}px`;
	textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

function ExtensionUiModal(props: {
	request: ExtensionUiRequest;
	onRespond: (response: Record<string, unknown>) => void;
}): JSX.Element {
	const [text, setText] = createSignal(props.request.prefill ?? "");
	const respond = (body: Record<string, unknown>) =>
		props.onRespond({ type: "extension_ui_response", id: props.request.id, ...body });

	return (
		<Modal
			title={props.request.title}
			onDismiss={() => respond({ cancelled: true })}
			actions={
				<Show when={props.request.method !== "select"}>
					<button type="button" class="btn btn-small" onClick={() => respond({ cancelled: true })}>
						cancel
					</button>
					<Show when={props.request.method === "confirm"}>
						<button type="button" class="btn btn-small btn-primary" onClick={() => respond({ confirmed: true })}>
							confirm
						</button>
					</Show>
					<Show when={props.request.method === "input" || props.request.method === "editor"}>
						<button type="button" class="btn btn-small btn-primary" onClick={() => respond({ value: text() })}>
							submit
						</button>
					</Show>
				</Show>
			}
		>
			<Show when={props.request.message}>
				<p style={{ "margin-bottom": "12px" }}>{props.request.message}</p>
			</Show>
			<Show when={props.request.method === "select"}>
				<div class="recent-projects">
					<For each={props.request.options ?? []}>
						{(option) => (
							<button type="button" onClick={() => respond({ value: option })}>
								{option}
							</button>
						)}
					</For>
				</div>
			</Show>
			<Show when={props.request.method === "input"}>
				<div class="field">
					<input
						type="text"
						value={text()}
						placeholder={props.request.placeholder}
						onInput={(e) => setText(e.currentTarget.value)}
					/>
				</div>
			</Show>
			<Show when={props.request.method === "editor"}>
				<div class="field">
					<textarea rows="8" value={text()} onInput={(e) => setText(e.currentTarget.value)} />
				</div>
			</Show>
		</Modal>
	);
}

function LoadedContextModal(props: { resources?: ResourcesDto; error?: string; onClose: () => void }): JSX.Element {
	const section = (title: string, items: JSX.Element[]) => (
		<section class="context-section">
			<h3>{title}</h3>
			<Show when={items.length > 0} fallback={<p class="muted small">none</p>}>
				<ul>{items}</ul>
			</Show>
		</section>
	);

	return (
		<Modal title="loaded context" onDismiss={props.onClose}>
			<Show when={props.error}>
				<p class="pair-error">{props.error}</p>
			</Show>
			<Show when={props.resources} fallback={<p class="muted small">loading…</p>}>
				{(resources) => (
					<div class="context-modal-body">
						{section(
							"context files",
							resources().contextFiles.map((file) => <li title={file.path}>{shortenPath(file.path)}</li>),
						)}
						{section(
							"skills",
							resources().skills.map((skill) => (
								<li>
									<span>{skill.name}</span>
									<Show when={skill.description}>
										<span class="muted"> — {skill.description}</span>
									</Show>
								</li>
							)),
						)}
						{section(
							"extensions",
							resources().extensions.map((extension) => (
								<li title={extension.path}>
									<span>{extension.name ?? "extension"}</span>
									<span class="muted"> — {shortenPath(extension.path)}</span>
								</li>
							)),
						)}
						{section(
							"prompt templates",
							resources().promptTemplates.map((template) => <li>{template.name}</li>),
						)}
						<Show when={resources().systemPromptPresent}>
							<p class="muted small">system prompt: custom</p>
						</Show>
					</div>
				)}
			</Show>
		</Modal>
	);
}

function ModelSelectorModal(props: {
	sessionKey: string;
	state?: SessionStateDto;
	onClose: () => void;
	onSelected: () => void;
}): JSX.Element {
	const [models, setModels] = createSignal<ModelInfoDto[]>([]);
	const [filter, setFilter] = createSignal("");
	const [scope, setScope] = createSignal<ModelScope>((props.state?.scopedModels?.length ?? 0) > 0 ? "scoped" : "all");
	const [error, setError] = createSignal<string>();

	onMount(async () => {
		try {
			const { models } = await api.models(props.sessionKey);
			setModels(models);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	});

	const scopedModels = createMemo<ModelChoice[]>(() =>
		(props.state?.scopedModels ?? []).map((model: ScopedModelDto) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
		})),
	);
	const hasScoped = () => scopedModels().length > 0;
	const activeModels = () => (scope() === "scoped" && hasScoped() ? scopedModels() : models());
	const filteredGroups = createMemo(() => {
		const q = filter().toLowerCase();
		return groupedModels(
			activeModels()
				.filter((model) => !q || modelMatchesQuery(model, q))
				.slice(0, 100),
		);
	});
	const isCurrent = (model: ModelChoice) =>
		props.state?.model?.provider === model.provider && props.state?.model?.id === model.id;

	async function selectModel(model: ModelChoice) {
		try {
			await api.setModel(props.sessionKey, model.provider, model.id);
			props.onSelected();
			props.onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<Modal title="select model" onDismiss={props.onClose} class="model-picker-modal">
			<Show when={hasScoped()}>
				<div class="model-scope-tabs" role="tablist" aria-label="model scope">
					<button
						type="button"
						role="tab"
						aria-selected={scope() === "scoped"}
						classList={{ selected: scope() === "scoped" }}
						onClick={() => setScope("scoped")}
					>
						scoped
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={scope() === "all"}
						classList={{ selected: scope() === "all" }}
						onClick={() => setScope("all")}
					>
						all
					</button>
				</div>
			</Show>
			<div class="field" style={{ "margin-bottom": "8px" }}>
				<input
					type="text"
					placeholder="search models…"
					value={filter()}
					onInput={(e) => setFilter(e.currentTarget.value)}
				/>
			</div>
			<Show when={error()}>
				<p class="pair-error">{error()}</p>
			</Show>
			<div class="model-list session-model-list" style={{ "max-height": "320px" }}>
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
											onClick={() => selectModel(model)}
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

export function SessionScreen(props: { store: AppStore; sessionKey: string }): JSX.Element {
	const session = (): SessionViewState | undefined => props.store.sessions[props.sessionKey];
	const runtime = createMemo(() => props.store.fleet().runtimes.find((r) => r.key === props.sessionKey));

	const [composerText, setComposerText] = createSignal(composerDrafts.get(props.sessionKey) ?? "");
	const [sendMode, setSendMode] = createSignal<"steer" | "follow_up">("steer");
	const [stopping, setStopping] = createSignal(false);
	const [stoppingRuntime, setStoppingRuntime] = createSignal(false);
	const [showModelSelector, setShowModelSelector] = createSignal(false);
	const [showOverflow, setShowOverflow] = createSignal(false);
	const [topChromeCollapsed, setTopChromeCollapsed] = createSignal(false);
	const [bottomDockCollapsed, setBottomDockCollapsed] = createSignal(false);
	const [subagentPanelCollapsed, setSubagentPanelCollapsed] = createSignal(false);
	const [showCompactModal, setShowCompactModal] = createSignal(false);
	const [showRenameModal, setShowRenameModal] = createSignal(false);
	const [showContextModal, setShowContextModal] = createSignal(false);
	const [fallbackDismissed, setFallbackDismissed] = createSignal(false);
	const [actionError, setActionError] = createSignal<string>();
	const [elapsed, setElapsed] = createSignal(0);
	const [stats, setStats] = createSignal<SessionStatsDto>();
	const [performance, setPerformance] = createSignal<PerformanceStatsDto>();
	const [branch, setBranch] = createSignal<string | null>();
	const [dailyCost, setDailyCost] = createSignal<number>();
	const [commands, setCommands] = createSignal<CommandDto[]>([]);
	const [commandMenuClosed, setCommandMenuClosed] = createSignal(false);
	const [commandSelection, setCommandSelection] = createSignal(0);
	const [resources, setResources] = createSignal<ResourcesDto>();
	const [resourcesError, setResourcesError] = createSignal<string>();
	const [pendingMessages, setPendingMessages] = createSignal<PendingMessagesDto>({ steering: [], followUp: [] });
	const [imageAttachments, setImageAttachments] = createSignal<PendingImageAttachment[]>([]);
	const [fileAttachments, setFileAttachments] = createSignal<UploadedFileAttachment[]>([]);
	const [historyIndex, setHistoryIndex] = createSignal<number>();
	const [showForkModal, setShowForkModal] = createSignal(false);
	const [forkMessages, setForkMessages] = createSignal<Array<{ entryId: string; text: string }>>([]);
	const [forkError, setForkError] = createSignal<string>();
	const [showStatsPopover, setShowStatsPopover] = createSignal(false);
	const [statsPopoverError, setStatsPopoverError] = createSignal<string>();

	let chatRef: HTMLDivElement | undefined;
	let composerRef: HTMLTextAreaElement | undefined;
	let genericFileInputRef: HTMLInputElement | undefined;
	let imageFileInputRef: HTMLInputElement | undefined;
	let statsPopoverRef: HTMLDivElement | undefined;
	let autoScroll = true;
	let userScrollingTranscript = false;
	let userScrollTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const streaming = () => session()?.streaming ?? false;
	const compacting = () => session()?.compacting ?? false;
	const parentPaused = () => (session()?.statusEntries ?? []).some((s) => s.key === "paused");
	const anyLiveAgent = () => Object.values(session()?.backgroundAgents ?? {}).some((a) => a.status === "running");
	// Show stop controls whenever anything is stoppable — streaming, compacting,
	// or the parent is paused waiting on still-running background agents. TUI ESC
	// halts all of these; the dashboard stop button must reach the same states
	// (a mid-turn refresh or a paused-on-subagents parent must not hide it).
	const showStopControls = () => streaming() || compacting() || parentPaused() || anyLiveAgent();
	const chatAtBottom = () => !chatRef || chatRef.scrollTop + chatRef.clientHeight >= chatRef.scrollHeight - 40;
	function releaseTranscriptScrollSoon(): void {
		if (userScrollTimer) clearTimeout(userScrollTimer);
		userScrollTimer = setTimeout(() => {
			userScrollingTranscript = false;
			autoScroll = chatAtBottom();
		}, 250);
	}
	function scrollChatToBottomAfterLayout(): void {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (autoScroll && !userScrollingTranscript && chatRef) chatRef.scrollTop = chatRef.scrollHeight;
			});
		});
	}

	async function refreshRuntimeDetails(includeDailyCost = false) {
		const [statsResult, performanceResult, branchResult] = await Promise.allSettled([
			api.stats(props.sessionKey),
			api.performance(props.sessionKey),
			api.branch(props.sessionKey),
		] as const);
		const dailyCostResult = includeDailyCost ? await Promise.allSettled([api.dailyCost()] as const) : undefined;
		if (disposed) return;
		if (statsResult.status === "fulfilled") setStats(statsResult.value);
		if (performanceResult.status === "fulfilled") setPerformance(performanceResult.value);
		if (branchResult.status === "fulfilled") setBranch(branchResult.value.branch);
		if (dailyCostResult?.[0]?.status === "fulfilled") setDailyCost(dailyCostResult[0].value.cost);
		const rejected = [statsResult, performanceResult, branchResult, ...(dailyCostResult ?? [])].find(
			(result) => result.status === "rejected",
		);
		if (rejected?.status === "rejected") {
			setActionError(rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason));
		}
	}

	async function fetchCommands() {
		try {
			const { commands } = await api.commands(props.sessionKey);
			if (!disposed) setCommands(commands);
		} catch (err) {
			if (!disposed) setActionError(err instanceof Error ? err.message : String(err));
		}
	}

	async function openContextModal() {
		setShowContextModal(true);
		setResourcesError(undefined);
		try {
			setResources(await api.resources(props.sessionKey));
		} catch (err) {
			setResourcesError(err instanceof Error ? err.message : String(err));
		}
	}

	async function refreshPendingMessages() {
		// Always ask the runtime — never gate on the fleet's pendingMessageCount.
		// The fleet snapshot only refreshes on agent start/end, so a steer/follow-up
		// submitted mid-turn would be invisible if we trusted the stale count.
		try {
			setPendingMessages(await api.pending(props.sessionKey));
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		}
	}

	async function restorePendingToComposer() {
		try {
			const cleared = await api.dequeue(props.sessionKey);
			const queuedText = [...cleared.steering, ...cleared.followUp].join("\n\n");
			setPendingMessages({ steering: [], followUp: [] });
			// TUI parity: prepend the dequeued messages to whatever is already typed
			// rather than clobbering the composer.
			const current = composerText();
			setComposerText([queuedText, current].filter((t) => t.trim()).join("\n\n"));
			await props.store.refreshFleet();
			queueMicrotask(() => composerRef?.focus());
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		}
	}

	function imageAttachmentFromFile(file: File): Promise<PendingImageAttachment> {
		if (!file.type.startsWith("image/")) throw new Error(`Not an image: ${file.name || file.type}`);
		if (file.size > MAX_IMAGE_BYTES) throw new Error(`Image too large: ${file.name || file.type} exceeds 10MB`);
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onerror = () => reject(new Error(`Failed to read image: ${file.name || file.type}`));
			reader.onload = () => {
				const result = String(reader.result ?? "");
				const comma = result.indexOf(",");
				resolve({
					data: comma >= 0 ? result.slice(comma + 1) : result,
					mimeType: file.type,
					fileName: file.name || "image",
					size: file.size,
				});
			};
			reader.readAsDataURL(file);
		});
	}

	async function addImageFiles(files: Iterable<File>) {
		try {
			const next = await Promise.all([...files].map((file) => imageAttachmentFromFile(file)));
			setImageAttachments((current) => [...current, ...next]);
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		}
	}

	async function ensureUploadDir(cwd: string): Promise<string> {
		const dir = joinPath(cwd, UPLOAD_DIR_NAME);
		try {
			await api.listFiles(dir);
			return dir;
		} catch {
			await api.mkdir(cwd, UPLOAD_DIR_NAME);
			return dir;
		}
	}

	async function addGenericFiles(files: Iterable<File>) {
		const selected = [...files];
		if (selected.length === 0) return;
		const cwd = runtime()?.cwd;
		if (!cwd) {
			setActionError("Cannot attach files until the runtime is loaded.");
			return;
		}
		setActionError(undefined);
		try {
			const uploadDir = await ensureUploadDir(cwd);
			const uploaded: UploadedFileAttachment[] = [];
			for (const [index, file] of selected.entries()) {
				const uploadName = uniqueUploadName(file, index);
				const result = await api.upload(uploadDir, new File([file], uploadName, { type: file.type }), false);
				uploaded.push({
					fileName: file.name || uploadName,
					size: file.size,
					mimeType: file.type || "application/octet-stream",
					path: result.path,
				});
			}
			setFileAttachments((current) => [...current, ...uploaded]);
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		}
	}

	async function openForkModal() {
		setShowForkModal(true);
		setForkError(undefined);
		setForkMessages([]);
		try {
			const { messages } = await api.forkMessages(props.sessionKey);
			setForkMessages(messages);
		} catch (err) {
			setForkError(err instanceof Error ? err.message : String(err));
		}
	}

	async function selectForkMessage(entryId: string) {
		setForkError(undefined);
		try {
			const result = await api.fork(props.sessionKey, entryId);
			if (!result.cancelled) setComposerText(result.text);
			await props.store.hydrateSession(props.sessionKey);
			await props.store.refreshFleet();
			setShowForkModal(false);
		} catch (err) {
			setForkError(err instanceof Error ? err.message : String(err));
		}
	}

	async function openStatsPopover() {
		setShowStatsPopover(true);
		setStatsPopoverError(undefined);
		try {
			setStats(await api.stats(props.sessionKey));
		} catch (err) {
			setStatsPopoverError(err instanceof Error ? err.message : String(err));
		}
	}

	onMount(() => {
		props.store.hydrateSession(props.sessionKey).catch((err) => {
			setActionError(err instanceof Error ? err.message : String(err));
		});
		void refreshRuntimeDetails(true);
		void fetchCommands();
		void refreshPendingMessages();
		const detailTimer = setInterval(() => void refreshRuntimeDetails(false), 5000);
		onCleanup(() => {
			disposed = true;
			clearInterval(detailTimer);
		});
	});

	const closeStatsPopover = (event: MouseEvent) => {
		if (!showStatsPopover()) return;
		const target = event.target as Node | null;
		if (target && statsPopoverRef?.contains(target)) return;
		setShowStatsPopover(false);
	};
	const closeStatsPopoverOnEscape = (event: KeyboardEvent) => {
		if (event.key === "Escape") setShowStatsPopover(false);
	};
	document.addEventListener("mousedown", closeStatsPopover);
	document.addEventListener("keydown", closeStatsPopoverOnEscape);
	onCleanup(() => {
		document.removeEventListener("mousedown", closeStatsPopover);
		document.removeEventListener("keydown", closeStatsPopoverOnEscape);
	});

	// Elapsed timer for the status line.
	const timer = setInterval(() => {
		const since = session()?.workingSince;
		setElapsed(since ? Math.floor((Date.now() - since) / 1000) : 0);
	}, 1000);
	onCleanup(() => {
		clearInterval(timer);
		if (userScrollTimer) clearTimeout(userScrollTimer);
	});

	// Composer prefill from set_editor_text / fork.
	createEffect(() => {
		const prefill = session()?.composerPrefill;
		if (prefill) setComposerText(prefill);
	});

	createEffect(() => {
		composerText();
		if (composerRef) queueMicrotask(() => composerRef && autoGrowTextarea(composerRef));
	});

	// Stick-to-bottom autoscroll: revisions bump on every applied envelope,
	// including in-place streaming text deltas (entries.length alone only
	// fires when a new entry appends — i.e. after completion).
	createEffect(() => {
		props.store.revisions[props.sessionKey];
		session()?.entries.length;
		if (autoScroll && !userScrollingTranscript) scrollChatToBottomAfterLayout();
	});

	let wasStreaming = false;
	createEffect(() => {
		const nowStreaming = streaming();
		if (wasStreaming && !nowStreaming) void refreshRuntimeDetails(true);
		if (wasStreaming !== nowStreaming) void refreshPendingMessages();
		wasStreaming = nowStreaming;
	});

	createEffect(() => {
		// Re-fetch pending whenever the fleet-driven count changes; refreshPendingMessages
		// is authoritative (returns empty when there are none) so this never clears
		// on a stale snapshot.
		runtime()?.state.pendingMessageCount;
		void refreshPendingMessages();
	});

	// Persist the composer draft per session so navigating away and back keeps it.
	createEffect(() => {
		composerDrafts.set(props.sessionKey, composerText());
	});

	function promptWithAttachmentList(text: string): string {
		const sections: string[] = [];
		if (fileAttachments().length > 0) {
			sections.push(
				[
					"Attached files uploaded to the host (paths only; inspect deliberately if needed):",
					...fileAttachments().map(
						(file) =>
							`- ${file.path} (${file.fileName}, ${formatBytes(file.size)}, ${file.mimeType || "unknown type"})`,
					),
				].join("\n"),
			);
		}
		if (imageAttachments().length > 0) {
			sections.push(
				[
					"Attached images included inline with this turn:",
					...imageAttachments().map(
						(image, index) =>
							`- image ${index + 1}: ${image.fileName} (${formatBytes(image.size)}, ${image.mimeType})`,
					),
				].join("\n"),
			);
		}
		return [text, ...sections].filter((part) => part.trim()).join("\n\n");
	}

	async function send() {
		const text = composerText().trim();
		if (!text && fileAttachments().length === 0 && imageAttachments().length === 0) return;
		const promptText = promptWithAttachmentList(text || "Please review the attached item(s). ");
		setActionError(undefined);
		try {
			const images =
				imageAttachments().length > 0
					? imageAttachments().map(({ data, mimeType }) => ({ data, mimeType }))
					: undefined;
			if (streaming()) {
				await api.prompt(props.sessionKey, promptText, sendMode(), images);
			} else if (images) {
				await api.prompt(props.sessionKey, promptText, undefined, images);
			} else {
				await api.prompt(props.sessionKey, promptText);
			}
			const history = composerHistory.get(props.sessionKey) ?? [];
			history.push(promptText);
			composerHistory.set(props.sessionKey, history.slice(-100));
			setHistoryIndex(undefined);
			setComposerText("");
			setImageAttachments([]);
			setFileAttachments([]);
			void refreshPendingMessages();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		}
	}

	async function abort() {
		setStopping(true);
		try {
			await api.abort(props.sessionKey);
			// TUI ESC parity: clear the queue and return queued messages to the
			// composer so they don't silently restart the agent after the abort.
			await restorePendingToComposer();
			await props.store.refreshFleet();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setStopping(false);
		}
	}

	async function stopRuntime() {
		if (stoppingRuntime()) return;
		setStoppingRuntime(true);
		setActionError(undefined);
		try {
			await api.stopRuntime(props.sessionKey);
			props.store.navigate({ screen: "fleet" });
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setStoppingRuntime(false);
		}
	}

	async function abortStatus(key: string) {
		try {
			if (key === "compaction") await api.abortCompaction(props.sessionKey);
			else if (key === "retry") await api.abortRetry(props.sessionKey);
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		}
	}

	function setAllToolDetails(open: boolean) {
		chatRef?.querySelectorAll<HTMLDetailsElement>("details.tool").forEach((detail) => {
			detail.open = open;
		});
	}

	const liveAgents = () => Object.values(session()?.backgroundAgents ?? {}).filter((a) => a.status === "running");
	const doneAgents = () => Object.values(session()?.backgroundAgents ?? {}).filter((a) => a.status !== "running");
	const tasks = () => session()?.tasks ?? [];
	const tasksDone = () => tasks().filter((t) => t.status === "completed").length;
	const ctx = () => runtime()?.state.contextUsage ?? stats()?.contextUsage;
	const isMobile = () => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 700px)").matches;
	const displaySessionName = () => session()?.sessionName ?? runtime()?.state.sessionName;
	const headerTitle = () => displaySessionName() ?? session()?.title ?? props.sessionKey;
	const cwdWithBranch = () => {
		const cwd = runtime()?.cwd;
		if (!cwd) return undefined;
		const currentBranch = branch();
		return `${shortenPath(cwd)}${currentBranch ? ` (${currentBranch})` : ""}`;
	};
	const infoLeft = () => {
		const cwd = cwdWithBranch();
		const name = displaySessionName();
		if (cwd && name) return `${cwd} • ${name}`;
		return cwd ?? name ?? "session";
	};
	const tokenSummary = () => {
		const tokens = stats()?.tokens;
		if (!tokens) return undefined;
		const parts: string[] = [];
		if (tokens.input) parts.push(`↑${formatTokens(tokens.input)}`);
		if (tokens.output) parts.push(`↓${formatTokens(tokens.output)}`);
		if (tokens.cacheRead) parts.push(`R${formatTokens(tokens.cacheRead)}`);
		if (tokens.cacheWrite) parts.push(`W${formatTokens(tokens.cacheWrite)}`);
		return parts.length > 0 ? parts.join(" ") : undefined;
	};
	const costSummary = () => {
		const sessionCost = stats()?.cost ?? 0;
		const usingSubscription = runtime()?.state.usingSubscription ?? false;
		if (!sessionCost && !usingSubscription) return undefined;
		let text = `$${sessionCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
		const today = dailyCost();
		if (today !== undefined && today > sessionCost) text += `, today: $${today.toFixed(2)}`;
		return text;
	};
	const contextSummary = () => {
		const usage = ctx();
		if (!usage) return undefined;
		const percent = usage.percent === null ? "?" : `${usage.percent.toFixed(0)}%`;
		return `ctx ${percent}/${formatTokens(usage.contextWindow)}`;
	};
	const tokPerSecond = () => {
		const model = runtime()?.state.model;
		if (!model) return undefined;
		const rolling = performance()?.models.find(
			(entry) => entry.provider === model.provider && entry.modelId === model.id,
		);
		if (!rolling || rolling.count < 3) return undefined;
		return `${Math.round(rolling.median)} tok/s`;
	};
	const infoStats = () =>
		[tokenSummary(), costSummary(), contextSummary(), tokPerSecond()].filter(Boolean) as string[];
	const pendingMessageItems = () => [
		...pendingMessages().steering.map((text) => ({ kind: "steer", text })),
		...pendingMessages().followUp.map((text) => ({ kind: "follow-up", text })),
	];
	const commandQuery = () => {
		const text = composerText();
		if (commandMenuClosed() || !text.startsWith("/")) return undefined;
		const query = text.slice(1);
		if (/\s/.test(query)) return undefined;
		return query.toLowerCase();
	};
	const commandMatches = createMemo(() => {
		const query = commandQuery();
		if (query === undefined) return [];
		return commands()
			.filter((command) => {
				const name = command.name.toLowerCase();
				return !query || name.startsWith(query) || name.includes(query);
			})
			.sort((a, b) => {
				const aq = a.name.toLowerCase().startsWith(query) ? 0 : 1;
				const bq = b.name.toLowerCase().startsWith(query) ? 0 : 1;
				return aq - bq || a.name.localeCompare(b.name);
			})
			.slice(0, 8);
	});
	const showCommandMenu = () => commandMatches().length > 0;
	const acceptCommand = (command: CommandDto) => {
		setComposerText(`/${command.name} `);
		setCommandMenuClosed(true);
		queueMicrotask(() => composerRef?.focus());
	};
	createEffect(() => {
		const length = commandMatches().length;
		if (commandSelection() >= length) setCommandSelection(Math.max(0, length - 1));
	});

	return (
		<div class="session-screen">
			<header class="session-bar" classList={{ collapsed: topChromeCollapsed() }}>
				<div class="session-bar-inner session-bar-main">
					<a class="back" href="#/">
						← fleet
					</a>
					<span class="title">{headerTitle()}</span>
					<Show when={!topChromeCollapsed()}>
						<span class="project">{runtime()?.cwd ? shortenPath(runtime()!.cwd) : undefined}</span>
					</Show>
					<Show when={!topChromeCollapsed()}>
						<span class="right">
							<button
								type="button"
								class="switcher optional model-switcher"
								title={modelTitle(runtime()?.state.model)}
								onClick={() => setShowModelSelector(true)}
							>
								<span class="label">model</span> <span class="value">{modelLabel(runtime()?.state.model)}</span>
							</button>
							<button
								type="button"
								class="switcher optional"
								onClick={async () => {
									const current = runtime()?.state.thinkingLevel ?? "off";
									const next =
										THINKING_LEVELS[(THINKING_LEVELS.indexOf(current) + 1) % THINKING_LEVELS.length];
									try {
										await api.setThinking(props.sessionKey, next);
										await props.store.refreshFleet();
									} catch (err) {
										setActionError(err instanceof Error ? err.message : String(err));
									}
								}}
							>
								<span class="label">think</span> {runtime()?.state.thinkingLevel ?? "—"}
							</button>
							<Show when={ctx()}>
								<output class="switcher">
									<span class="label">ctx</span>{" "}
									{ctx()!.percent === null ? "?" : `${ctx()!.percent!.toFixed(0)}%`}
								</output>
							</Show>
							<button type="button" class="switcher" onClick={() => setShowOverflow(!showOverflow())}>
								⋯
							</button>
						</span>
					</Show>
					<button
						type="button"
						class="chrome-toggle"
						title={topChromeCollapsed() ? "show session details" : "hide session details"}
						onClick={() => setTopChromeCollapsed(!topChromeCollapsed())}
					>
						{topChromeCollapsed() ? "details ▾" : "details ▴"}
					</button>
				</div>
				<Show when={!topChromeCollapsed()}>
					<div class="session-bar-inner session-info-bar">
						<span class="session-info-left">{infoLeft()}</span>
						<button type="button" class="session-info-right stats-trigger" onClick={openStatsPopover}>
							<For each={infoStats()}>{(item) => <span>{item}</span>}</For>
						</button>
						<Show when={showStatsPopover()}>
							<div class="stats-popover" ref={statsPopoverRef}>
								<Show when={statsPopoverError()}>
									<p class="pair-error">{statsPopoverError()}</p>
								</Show>
								<Show when={stats()} fallback={<p class="muted small">loading stats…</p>}>
									{(s) => (
										<div class="stats-grid">
											<span>user messages</span>
											<strong>{s().userMessages}</strong>
											<span>assistant messages</span>
											<strong>{s().assistantMessages}</strong>
											<span>tool calls/results</span>
											<strong>
												{s().toolCalls}/{s().toolResults}
											</strong>
											<span>input/output</span>
											<strong>
												{formatTokens(s().tokens.input)} / {formatTokens(s().tokens.output)}
											</strong>
											<span>cache read/write</span>
											<strong>
												{formatTokens(s().tokens.cacheRead)} / {formatTokens(s().tokens.cacheWrite)}
											</strong>
											<span>total tokens</span>
											<strong>{formatTokens(s().tokens.total)}</strong>
											<span>cost</span>
											<strong>${s().cost.toFixed(4)}</strong>
										</div>
									)}
								</Show>
							</div>
						</Show>
					</div>
					<Show when={showOverflow()}>
						<div class="session-bar-inner" style={{ "justify-content": "flex-end", gap: "8px" }}>
							<a class="btn btn-small" href={api.exportHtmlUrl(props.sessionKey)}>
								export HTML
							</a>
							<button type="button" class="btn btn-small" onClick={() => setShowCompactModal(true)}>
								compact now
							</button>
							<button type="button" class="btn btn-small" onClick={() => setAllToolDetails(true)}>
								expand tools
							</button>
							<button type="button" class="btn btn-small" onClick={() => setAllToolDetails(false)}>
								collapse tools
							</button>
							<button type="button" class="btn btn-small" onClick={() => setShowRenameModal(true)}>
								rename
							</button>
							<button type="button" class="btn btn-small" onClick={openForkModal}>
								fork
							</button>
							<button type="button" class="btn btn-small" onClick={openContextModal}>
								loaded context
							</button>
							<Show when={isMobile()}>
								<button type="button" class="btn btn-small" onClick={() => setShowModelSelector(true)}>
									model: {modelLabel(runtime()?.state.model)}
								</button>
								<button
									type="button"
									class="btn btn-small"
									onClick={async () => {
										const current = runtime()?.state.thinkingLevel ?? "off";
										const next =
											THINKING_LEVELS[(THINKING_LEVELS.indexOf(current) + 1) % THINKING_LEVELS.length];
										try {
											await api.setThinking(props.sessionKey, next);
											await props.store.refreshFleet();
										} catch (err) {
											setActionError(err instanceof Error ? err.message : String(err));
										}
									}}
								>
									think: {runtime()?.state.thinkingLevel ?? "—"}
								</button>
							</Show>
							<button
								type="button"
								class="btn btn-small btn-danger"
								disabled={stoppingRuntime()}
								onClick={stopRuntime}
							>
								{stoppingRuntime() ? "stopping runtime…" : "stop runtime"}
							</button>
						</div>
					</Show>
				</Show>
			</header>

			<Show when={!topChromeCollapsed() && runtime()?.state.modelFallbackMessage && !fallbackDismissed()}>
				<div class="container" style={{ "padding-top": "8px" }}>
					<div class="fallback-banner">
						<span>◆ {runtime()!.state.modelFallbackMessage}</span>
						<button type="button" class="btn btn-small dismiss" onClick={() => setFallbackDismissed(true)}>
							dismiss
						</button>
					</div>
				</div>
			</Show>

			<main
				class="chat"
				ref={chatRef}
				onWheel={() => {
					userScrollingTranscript = true;
					releaseTranscriptScrollSoon();
				}}
				onTouchStart={() => {
					userScrollingTranscript = true;
				}}
				onTouchEnd={() => {
					userScrollingTranscript = false;
					autoScroll = chatAtBottom();
				}}
				onScroll={() => {
					autoScroll = chatAtBottom();
				}}
			>
				<div class="chat-inner">
					<Show when={session()} fallback={<p class="muted">loading transcript…</p>}>
						<For each={session()!.widgets.above}>{(line) => <div class="widget-block">{line}</div>}</For>
						<Transcript entries={session()!.entries} />
						<For each={session()!.widgets.below}>{(line) => <div class="widget-block">{line}</div>}</For>
					</Show>
				</div>
			</main>

			<footer class="dock" classList={{ collapsed: bottomDockCollapsed() }}>
				<div class="dock-collapse-row">
					<button
						type="button"
						class="chrome-toggle"
						title={bottomDockCollapsed() ? "show composer and controls" : "hide composer and controls"}
						onClick={() => setBottomDockCollapsed(!bottomDockCollapsed())}
					>
						{bottomDockCollapsed() ? "compose ▴" : "compose ▾"}
					</button>
					<Show when={bottomDockCollapsed()}>
						<span class="dock-collapsed-hint">
							{showStopControls()
								? "agent working — open controls to stop or steer"
								: pendingMessageItems().length > 0
									? `${pendingMessageItems().length} queued message(s)`
									: "composer hidden for transcript reading"}
						</span>
					</Show>
				</div>
				<Show when={!bottomDockCollapsed()}>
					<div class="dock-inner">
						<Show when={tasks().length > 0}>
							<details class="tasks" open={!isMobile()}>
								<summary>
									tasks — {tasksDone()} of {tasks().length} done
								</summary>
								<ul>
									<For each={tasks()}>
										{(task) => (
											<li
												classList={{
													done: task.status === "completed",
													active: task.status === "in_progress",
												}}
											>
												{task.status === "completed" ? "☑" : task.status === "in_progress" ? "⧖" : "☐"}{" "}
												{task.title}
											</li>
										)}
									</For>
								</ul>
							</details>
						</Show>

						<Show when={liveAgents().length + doneAgents().length > 0}>
							<div class="subagent-strip" classList={{ collapsed: subagentPanelCollapsed() }}>
								<button
									type="button"
									class="subagent-toggle"
									title={subagentPanelCollapsed() ? "show subagents" : "hide subagents"}
									onClick={() => setSubagentPanelCollapsed(!subagentPanelCollapsed())}
								>
									{subagentPanelCollapsed() ? "subagents ▴" : "subagents ▾"}
								</button>
								<span class="count">
									⚡ {liveAgents().length} running · {doneAgents().length} done
								</span>
								<Show when={subagentPanelCollapsed()}>
									<span class="collapsed-hint">subagent panel hidden</span>
								</Show>
								<Show when={!subagentPanelCollapsed()}>
									<For each={[...liveAgents(), ...doneAgents()].slice(0, 4)}>
										{(agent) => (
											<button
												type="button"
												class="agent-chip"
												title="view this subagent's session"
												onClick={() =>
													props.store.navigate({
														screen: "subagent",
														key: props.sessionKey,
														agentId: agent.agentId,
													})
												}
											>
												<span class={agent.status === "running" ? "live" : "done"}>
													{agent.status === "running" ? "●" : agent.status === "completed" ? "✓" : "✕"}
												</span>
												<span class="task">
													{agent.agentType} — {agent.taskSummary}
												</span>
											</button>
										)}
									</For>
								</Show>
							</div>
						</Show>

						<Show when={showStopControls() || (session()?.statusEntries.length ?? 0) > 0 || actionError()}>
							<div class="status-line">
								<Show when={streaming()}>
									<span class="working">
										● working{session()?.workingText ? ` — ${session()!.workingText}` : ""}
										{elapsed() > 2 ? ` (${elapsed()}s)` : ""}
									</span>
								</Show>
								<For each={session()?.statusEntries ?? []}>
									{(status) => (
										<span class={status.tone === "info" ? "queued" : status.tone}>
											{status.text}
											<Show when={status.key === "compaction" || status.key === "retry"}>
												<button
													type="button"
													class="btn btn-small btn-danger inline-stop"
													onClick={() => abortStatus(status.key)}
												>
													stop
												</button>
											</Show>
										</span>
									)}
								</For>
								<Show when={actionError()}>
									<span class="error">{actionError()}</span>
								</Show>
								<Show when={showStopControls()}>
									<button type="button" class="btn btn-small btn-danger" disabled={stopping()} onClick={abort}>
										{stopping() ? "stopping…" : "■ stop"}
									</button>
								</Show>
							</div>
						</Show>

						<div class="composer">
							<Show when={pendingMessageItems().length > 0}>
								<div class="queued-message-row">
									<For each={pendingMessageItems()}>
										{(item) => (
											<span class="queued-chip" title={item.text}>
												<span class="queued-kind">{item.kind}</span>
												{item.text}
											</span>
										)}
									</For>
									<button type="button" class="btn btn-small" onClick={restorePendingToComposer}>
										restore to composer
									</button>
								</div>
							</Show>
							<Show when={fileAttachments().length > 0 || imageAttachments().length > 0}>
								<div class="attachment-strip">
									<For each={fileAttachments()}>
										{(file, index) => (
											<span class="attachment-file" title={file.path}>
												<span>📎 {file.fileName}</span>
												<span class="muted">{formatBytes(file.size)}</span>
												<button
													type="button"
													aria-label="remove file attachment"
													onClick={() =>
														setFileAttachments((current) => current.filter((_, i) => i !== index()))
													}
												>
													×
												</button>
											</span>
										)}
									</For>
									<For each={imageAttachments()}>
										{(image, index) => (
											<span
												class="attachment-thumb"
												title={`${image.fileName} (${formatBytes(image.size)})`}
											>
												<img src={`data:${image.mimeType};base64,${image.data}`} alt={image.fileName} />
												<button
													type="button"
													aria-label="remove image"
													onClick={() =>
														setImageAttachments((current) => current.filter((_, i) => i !== index()))
													}
												>
													×
												</button>
											</span>
										)}
									</For>
								</div>
							</Show>
							<Show when={showCommandMenu()}>
								<div class="command-popover" role="listbox" id="command-listbox" aria-label="slash commands">
									<For each={commandMatches()}>
										{(command, index) => (
											<button
												type="button"
												id={`command-option-${index()}`}
												role="option"
												aria-selected={commandSelection() === index()}
												class="command-option"
												classList={{ selected: commandSelection() === index() }}
												onMouseEnter={() => setCommandSelection(index())}
												onClick={() => acceptCommand(command)}
											>
												<span class="command-name">/{command.name}</span>
												<Show when={command.description}>
													<span class="command-description">{command.description}</span>
												</Show>
												<span class="command-source">{command.source}</span>
											</button>
										)}
									</For>
								</div>
							</Show>
							<textarea
								ref={composerRef}
								placeholder={streaming() ? "Message dreb — sends as steer while it works…" : "Message dreb…"}
								value={composerText()}
								aria-controls={showCommandMenu() ? "command-listbox" : undefined}
								aria-activedescendant={showCommandMenu() ? `command-option-${commandSelection()}` : undefined}
								onPaste={(e) => {
									const files = [...(e.clipboardData?.items ?? [])]
										.filter((item) => item.type.startsWith("image/"))
										.map((item) => item.getAsFile())
										.filter((file): file is File => !!file);
									if (files.length > 0) {
										e.preventDefault();
										void addImageFiles(files);
									}
								}}
								onInput={(e) => {
									setCommandMenuClosed(false);
									setCommandSelection(0);
									setHistoryIndex(undefined);
									setComposerText(e.currentTarget.value);
									autoGrowTextarea(e.currentTarget);
								}}
								onKeyDown={(e) => {
									if (showCommandMenu()) {
										if (e.key === "ArrowDown") {
											e.preventDefault();
											setCommandSelection((commandSelection() + 1) % commandMatches().length);
											return;
										}
										if (e.key === "ArrowUp") {
											e.preventDefault();
											setCommandSelection(
												(commandSelection() - 1 + commandMatches().length) % commandMatches().length,
											);
											return;
										}
										if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !isMobile())) {
											e.preventDefault();
											const command = commandMatches()[commandSelection()];
											if (command) acceptCommand(command);
											return;
										}
										if (e.key === "Escape") {
											e.preventDefault();
											setCommandMenuClosed(true);
											return;
										}
									}
									if (
										(e.key === "ArrowUp" || e.key === "ArrowDown") &&
										(composerText() === "" || historyIndex() !== undefined)
									) {
										const history = composerHistory.get(props.sessionKey) ?? [];
										if (history.length > 0) {
											e.preventDefault();
											if (e.key === "ArrowUp") {
												const next =
													historyIndex() === undefined
														? history.length - 1
														: Math.max(0, historyIndex()! - 1);
												setHistoryIndex(next);
												setComposerText(history[next] ?? "");
											} else if (historyIndex() !== undefined) {
												const next = historyIndex()! + 1;
												if (next >= history.length) {
													setHistoryIndex(undefined);
													setComposerText("");
												} else {
													setHistoryIndex(next);
													setComposerText(history[next] ?? "");
												}
											}
										}
										return;
									}
									if (e.key === "Enter" && !e.shiftKey && !isMobile()) {
										e.preventDefault();
										send();
									}
								}}
							/>
							<div class="composer-row">
								<input
									ref={genericFileInputRef}
									type="file"
									multiple
									class="hidden-file-input"
									onChange={(e) => {
										void addGenericFiles(e.currentTarget.files ?? []);
										e.currentTarget.value = "";
									}}
								/>
								<input
									ref={imageFileInputRef}
									type="file"
									accept="image/*"
									multiple
									class="hidden-file-input"
									onChange={(e) => {
										void addImageFiles(e.currentTarget.files ?? []);
										e.currentTarget.value = "";
									}}
								/>
								<button
									type="button"
									class="btn btn-small"
									title="attach file (uploads to workspace and sends path)"
									onClick={() => genericFileInputRef?.click()}
								>
									📎 file
								</button>
								<button
									type="button"
									class="btn btn-small"
									title="attach image inline"
									onClick={() => imageFileInputRef?.click()}
								>
									🖼 photo
								</button>
								<Show when={streaming()}>
									<span class="mode-toggle" role="radiogroup" aria-label="send mode">
										<button
											type="button"
											classList={{ selected: sendMode() === "steer" }}
											title="Deliver now — injected into the running turn"
											onClick={() => setSendMode("steer")}
										>
											steer
										</button>
										<button
											type="button"
											classList={{ selected: sendMode() === "follow_up" }}
											title="Queue — delivered after the agent finishes"
											onClick={() => setSendMode("follow_up")}
										>
											follow-up
										</button>
									</span>
								</Show>
								<Show when={session()?.suggestedCommand}>
									<button
										type="button"
										class="ghost-suggest"
										onClick={() => setComposerText(session()!.suggestedCommand!)}
									>
										suggested: <code>{session()!.suggestedCommand}</code> <span class="key">tap</span>
									</button>
								</Show>
								<button type="button" class="btn btn-primary btn-small send" onClick={send}>
									send ↵
								</button>
							</div>
						</div>
					</div>
				</Show>
			</footer>

			<Show when={session()?.uiRequests[0]}>
				{(request) => (
					<ExtensionUiModal
						request={request()}
						onRespond={async (response) => {
							try {
								await api.extensionUiResponse(props.sessionKey, response);
							} catch (err) {
								setActionError(err instanceof Error ? err.message : String(err));
							}
						}}
					/>
				)}
			</Show>

			<Show when={showModelSelector()}>
				<ModelSelectorModal
					sessionKey={props.sessionKey}
					state={runtime()?.state}
					onClose={() => setShowModelSelector(false)}
					onSelected={() => props.store.refreshFleet()}
				/>
			</Show>

			<Show when={showCompactModal()}>
				<Modal
					title="compact context"
					onDismiss={() => setShowCompactModal(false)}
					actions={
						<>
							<button type="button" class="btn btn-small" onClick={() => setShowCompactModal(false)}>
								cancel
							</button>
							<button
								type="button"
								class="btn btn-small btn-primary"
								onClick={async () => {
									setShowCompactModal(false);
									try {
										await api.compact(props.sessionKey);
									} catch (err) {
										setActionError(err instanceof Error ? err.message : String(err));
									}
								}}
							>
								compact
							</button>
						</>
					}
				>
					<p>Summarize older context to free window space. The transcript keeps a summary card.</p>
				</Modal>
			</Show>

			<Show when={showContextModal()}>
				<LoadedContextModal
					resources={resources()}
					error={resourcesError()}
					onClose={() => setShowContextModal(false)}
				/>
			</Show>

			<Show when={showForkModal()}>
				<Modal title="fork from message" onDismiss={() => setShowForkModal(false)}>
					<Show when={forkError()}>
						<p class="pair-error">{forkError()}</p>
					</Show>
					<Show when={forkMessages().length > 0} fallback={<p class="muted small">loading forkable messages…</p>}>
						<div class="fork-message-list">
							<For each={forkMessages()}>
								{(message) => (
									<button
										type="button"
										class="fork-message"
										onClick={() => selectForkMessage(message.entryId)}
									>
										<span class="fork-entry-id">{message.entryId}</span>
										<span>{message.text}</span>
									</button>
								)}
							</For>
						</div>
					</Show>
				</Modal>
			</Show>

			<Show when={showRenameModal()}>
				<RenameModal
					current={displaySessionName() ?? ""}
					onClose={() => setShowRenameModal(false)}
					onRename={async (name) => {
						try {
							await api.rename(props.sessionKey, name);
							await props.store.refreshFleet();
							setShowRenameModal(false);
						} catch (err) {
							setActionError(err instanceof Error ? err.message : String(err));
						}
					}}
				/>
			</Show>
		</div>
	);
}

function RenameModal(props: { current: string; onClose: () => void; onRename: (name: string) => void }): JSX.Element {
	const [name, setName] = createSignal(props.current);
	return (
		<Modal
			title="rename session"
			onDismiss={props.onClose}
			actions={
				<>
					<button type="button" class="btn btn-small" onClick={props.onClose}>
						cancel
					</button>
					<button
						type="button"
						class="btn btn-small btn-primary"
						disabled={!name().trim()}
						onClick={() => props.onRename(name().trim())}
					>
						rename
					</button>
				</>
			}
		>
			<div class="field">
				<input type="text" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
			</div>
		</Modal>
	);
}
