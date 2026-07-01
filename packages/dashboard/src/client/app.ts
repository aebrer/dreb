import {
	applyDashboardEvent,
	clearSuggestion,
	createInitialDashboardState,
	type DashboardClientState,
	type DashboardMessage,
	type DashboardRuntimeState,
	hydrateMessages,
	hydrateRuntimeState,
	type JsonRecord,
} from "./state.js";

interface FileRoot {
	id: string;
	label: string;
	path: string;
}

interface DirectoryEntry {
	name: string;
	path: string;
	type: "directory" | "file" | "symlink" | "other";
	size: number;
	modified: string;
}

interface BrowseResult {
	root: FileRoot;
	path: string;
	entries: DirectoryEntry[];
}

interface SessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage?: string;
}

interface RuntimeContext {
	id: string;
	cwd: string;
	sessionPath?: string;
}

interface ModelInfo {
	provider?: string;
	id?: string;
	name?: string;
}

const authPanel = byId("auth-panel");
const appShell = byId("app-shell");
const statusLine = byId("status-line");
const runtimeBadge = byId("runtime-badge");
const rootSelect = byId<HTMLSelectElement>("root-select");
const pathInput = byId<HTMLInputElement>("path-input");
const cwdInput = byId<HTMLInputElement>("cwd-input");
const entriesList = byId("entries-list");
const sessionSelect = byId<HTMLSelectElement>("session-select");
const allSessionsList = byId("all-sessions-list");
const projectSessionsList = byId("project-sessions-list");
const transcript = byId("transcript");
const eventLog = byId("event-log");
const taskList = byId("task-list");
const suggestions = byId("suggestions");
const subagentList = byId("subagent-list");
const messageInput = byId<HTMLTextAreaElement>("message-input");
const commandSelect = byId<HTMLSelectElement>("command-select");
const modelSelect = byId<HTMLSelectElement>("model-select");
const thinkingSelect = byId<HTMLSelectElement>("thinking-select");
const steeringModeSelect = byId<HTMLSelectElement>("steering-mode-select");
const followUpModeSelect = byId<HTMLSelectElement>("follow-up-mode-select");

let roots: FileRoot[] = [];
let currentBrowse: BrowseResult | undefined;
let allSessions: SessionInfo[] = [];
let projectSessions: SessionInfo[] = [];
let runtime: RuntimeContext | undefined;
let eventSource: EventSource | undefined;
let dashboardState: DashboardClientState = createInitialDashboardState();

void initialize();

async function initialize(): Promise<void> {
	bindUi();
	showStatus("Checking authentication…");
	try {
		await fetchJson("/api/auth/status");
		showAuthenticated();
		await loadWorkspace();
	} catch (error) {
		showAuth(errorMessage(error));
	}
}

function bindUi(): void {
	byId<HTMLFormElement>("pair-form").addEventListener("submit", (event) => {
		event.preventDefault();
		void pair();
	});
	byId<HTMLFormElement>("browse-form").addEventListener("submit", (event) => {
		event.preventDefault();
		void browseSelected(pathInput.value || ".");
	});
	byId("up-button").addEventListener("click", () => void browseSelected(parentPath(currentBrowse?.path ?? ".")));
	byId("use-project-button").addEventListener("click", () => void useCurrentFolderAsProject());
	rootSelect.addEventListener("change", () => void selectRoot(rootSelect.value));
	byId<HTMLFormElement>("upload-form").addEventListener("submit", (event) => {
		event.preventDefault();
		void uploadFile();
	});
	byId("refresh-sessions-button").addEventListener("click", () => void loadSessions());
	byId("new-runtime-button").addEventListener("click", () => void openRuntime(false));
	byId("open-session-button").addEventListener("click", () => void openRuntime(true));
	byId("refresh-runtime-button").addEventListener("click", () => void refreshRuntime());
	byId<HTMLFormElement>("message-form").addEventListener("submit", (event) => {
		event.preventDefault();
		void sendMessage();
	});
	byId("abort-button").addEventListener("click", () => void abortRuntime());
	byId("apply-model-button").addEventListener("click", () => void applyModel());
	byId("apply-settings-button").addEventListener("click", () => void applyModes());

	for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
		button.addEventListener("click", () => activateTab(button.dataset.tab ?? "chat"));
	}
}

async function pair(): Promise<void> {
	const pin = byId<HTMLInputElement>("pin-input").value.trim();
	try {
		await fetchJson("/api/auth/pair", { method: "POST", body: JSON.stringify({ pin }) });
		showAuthenticated();
		await loadWorkspace();
	} catch (error) {
		showAuth(errorMessage(error));
	}
}

function showAuth(message: string): void {
	authPanel.hidden = false;
	appShell.hidden = true;
	showStatus(message || "Pair this browser with the local dashboard PIN.");
}

function showAuthenticated(): void {
	authPanel.hidden = true;
	appShell.hidden = false;
	showStatus("Connected");
}

async function loadWorkspace(): Promise<void> {
	await loadRoots();
	await loadSessions();
}

async function loadRoots(): Promise<void> {
	const response = await fetchJson<{ roots: FileRoot[] }>("/api/roots");
	roots = response.roots;
	rootSelect.replaceChildren(...roots.map((root) => option(root.id, `${root.label} — ${root.path}`)));
	if (roots[0]) await selectRoot(roots[0].id);
}

async function selectRoot(rootId: string): Promise<void> {
	const root = roots.find((candidate) => candidate.id === rootId);
	if (!root) return;
	rootSelect.value = root.id;
	cwdInput.value = root.path;
	await browseSelected(".");
	await loadSessions();
}

async function browseSelected(path: string): Promise<void> {
	if (!rootSelect.value) return;
	const params = new URLSearchParams({ root: rootSelect.value, path });
	currentBrowse = await fetchJson<BrowseResult>(`/api/files/browse?${params}`);
	pathInput.value = currentBrowse.path;
	renderFiles();
}

function renderFiles(): void {
	entriesList.replaceChildren();
	if (!currentBrowse) return;
	for (const entry of currentBrowse.entries) {
		const row = document.createElement("li");
		row.className = `file-row is-${entry.type}`;
		const open = document.createElement("button");
		open.type = "button";
		open.className = "link-button file-name";
		open.textContent = `${entry.type === "directory" ? "▸" : "•"} ${entry.name}`;
		open.addEventListener("click", () => {
			if (entry.type === "directory") void browseSelected(entry.path);
		});
		row.append(open, meta(`${entry.type} · ${formatBytes(entry.size)} · ${formatDate(entry.modified)}`));
		if (entry.type === "file") {
			const download = document.createElement("a");
			download.className = "small-button";
			download.href = `/api/files/download?${new URLSearchParams({ root: rootSelect.value, path: entry.path })}`;
			download.textContent = "download";
			row.append(download);
		}
		entriesList.append(row);
	}
}

async function useCurrentFolderAsProject(): Promise<void> {
	if (!currentBrowse) return;
	cwdInput.value = projectPath(currentBrowse.root.path, currentBrowse.path);
	await loadSessions();
	activateTab("runtime");
	showStatus(`Selected project ${cwdInput.value}`);
}

async function uploadFile(): Promise<void> {
	const fileInput = byId<HTMLInputElement>("upload-input");
	const file = fileInput.files?.[0];
	if (!file || !currentBrowse) return;
	const params = new URLSearchParams({ root: rootSelect.value, path: currentBrowse.path, name: file.name });
	await fetchJson(`/api/files/upload?${params}`, { method: "POST", body: await file.arrayBuffer() });
	fileInput.value = "";
	await browseSelected(currentBrowse.path);
	showStatus(`Uploaded ${file.name}`);
}

async function loadSessions(): Promise<void> {
	const all = fetchJson<{ sessions: SessionInfo[] }>("/api/sessions");
	const cwd = cwdInput.value || roots.find((root) => root.id === rootSelect.value)?.path || ".";
	const project = fetchJson<{ sessions: SessionInfo[] }>(`/api/sessions/project?${new URLSearchParams({ cwd })}`);
	const [allResult, projectResult] = await Promise.all([all, project]);
	allSessions = allResult.sessions;
	projectSessions = projectResult.sessions;
	renderSessions();
}

function renderSessions(): void {
	sessionSelect.replaceChildren(option("", "New session"));
	for (const session of projectSessions) {
		sessionSelect.append(option(session.path, sessionLabel(session)));
	}
	allSessionsList.replaceChildren(...allSessions.slice(0, 30).map((session) => sessionItem(session)));
	projectSessionsList.replaceChildren(...projectSessions.map((session) => sessionItem(session)));
}

function sessionItem(session: SessionInfo): HTMLElement {
	const item = document.createElement("li");
	item.className = "session-item";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "link-button";
	button.textContent = sessionLabel(session);
	button.addEventListener("click", () => {
		cwdInput.value = session.cwd;
		void openRuntimeFor(session.cwd, session.path);
	});
	item.append(button, meta(`${session.messageCount} messages · ${formatDate(session.modified)}`));
	if (session.firstMessage) item.append(meta(session.firstMessage));
	return item;
}

async function openRuntime(useSelectedSession: boolean): Promise<void> {
	const cwd = cwdInput.value.trim();
	if (!cwd) throw new Error("Choose a project path before opening a runtime");
	const sessionPath = useSelectedSession ? sessionSelect.value || undefined : undefined;
	await openRuntimeFor(cwd, sessionPath);
}

async function openRuntimeFor(cwd: string, sessionPath: string | undefined): Promise<void> {
	const body = { cwd, sessionPath };
	const response = await fetchJson<{ id: string; state: DashboardRuntimeState }>("/api/runtime", {
		method: "POST",
		body: JSON.stringify(body),
	});
	runtime = { id: response.id, cwd, sessionPath };
	dashboardState = hydrateRuntimeState(createInitialDashboardState(), response.state);
	renderState();
	connectEvents();
	await Promise.all([loadRuntimeMessages(), loadModels()]);
	showStatus("Runtime ready");
}

async function refreshRuntime(): Promise<void> {
	if (!runtime) return;
	const params = runtimeParams();
	const [state, messages] = await Promise.all([
		fetchJson<{ state: DashboardRuntimeState }>(`/api/runtime/${encodeURIComponent(runtime.id)}/state?${params}`),
		fetchJson<{ messages: DashboardMessage[] }>(`/api/runtime/${encodeURIComponent(runtime.id)}/messages?${params}`),
	]);
	dashboardState = hydrateMessages(hydrateRuntimeState(dashboardState, state.state), messages.messages);
	renderState();
}

async function loadRuntimeMessages(): Promise<void> {
	if (!runtime) return;
	const response = await fetchJson<{ messages: DashboardMessage[] }>(
		`/api/runtime/${encodeURIComponent(runtime.id)}/messages?${runtimeParams()}`,
	);
	dashboardState = hydrateMessages(dashboardState, response.messages);
	renderState();
}

async function loadModels(): Promise<void> {
	if (!runtime) return;
	const response = await fetchJson<{ models: ModelInfo[] }>(
		`/api/runtime/${encodeURIComponent(runtime.id)}/models?${runtimeParams()}`,
	);
	modelSelect.replaceChildren(option("", "Select model"));
	for (const model of response.models) {
		if (!model.provider || !model.id) continue;
		modelSelect.append(option(JSON.stringify([model.provider, model.id]), `${model.provider}/${model.id}`));
	}
	const active = dashboardState.runtime?.model;
	if (active?.provider && active.id) modelSelect.value = JSON.stringify([active.provider, active.id]);
}

function connectEvents(): void {
	eventSource?.close();
	if (!runtime) return;
	eventSource = new EventSource(`/api/runtime/${encodeURIComponent(runtime.id)}/events?${runtimeParams()}`, {
		withCredentials: true,
	});
	eventSource.addEventListener("ready", () => showStatus("Live events connected"));
	eventSource.addEventListener("agent", (message) => {
		const event = JSON.parse((message as MessageEvent<string>).data) as JsonRecord;
		dashboardState = applyDashboardEvent(dashboardState, event);
		renderState();
	});
	eventSource.onerror = () => showStatus("Live events disconnected; refresh or reopen the runtime to reconnect.");
}

async function sendMessage(): Promise<void> {
	if (!runtime) throw new Error("Open a runtime before sending a message");
	const message = messageInput.value.trim();
	if (!message) return;
	const command = commandSelect.value;
	await fetchJson(`/api/runtime/${encodeURIComponent(runtime.id)}/${command}`, {
		method: "POST",
		body: JSON.stringify({ ...runtimeBody(), message }),
	});
	messageInput.value = "";
	showStatus(`${command.replace("_", " ")} sent`);
}

async function abortRuntime(): Promise<void> {
	if (!runtime) return;
	await fetchJson(`/api/runtime/${encodeURIComponent(runtime.id)}/abort`, {
		method: "POST",
		body: JSON.stringify(runtimeBody()),
	});
	showStatus("Abort requested");
}

async function applyModel(): Promise<void> {
	if (!runtime || !modelSelect.value) return;
	const [provider, modelId] = JSON.parse(modelSelect.value) as [string, string];
	await fetchJson(`/api/runtime/${encodeURIComponent(runtime.id)}/model`, {
		method: "POST",
		body: JSON.stringify({ ...runtimeBody(), provider, modelId }),
	});
	await refreshRuntime();
	showStatus(`Model set to ${provider}/${modelId}`);
}

async function applyModes(): Promise<void> {
	if (!runtime) return;
	await fetchJson(`/api/runtime/${encodeURIComponent(runtime.id)}/thinking`, {
		method: "POST",
		body: JSON.stringify({ ...runtimeBody(), level: thinkingSelect.value }),
	});
	await fetchJson(`/api/runtime/${encodeURIComponent(runtime.id)}/modes`, {
		method: "POST",
		body: JSON.stringify({
			...runtimeBody(),
			steeringMode: steeringModeSelect.value,
			followUpMode: followUpModeSelect.value,
		}),
	});
	await refreshRuntime();
	showStatus("Runtime settings updated");
}

function renderState(): void {
	runtimeBadge.textContent = runtime
		? `${shortId(runtime.id)} · ${dashboardState.runtime?.model?.provider ?? "model"}/${dashboardState.runtime?.model?.id ?? "unset"}`
		: "no runtime";
	if (dashboardState.runtime?.thinkingLevel) thinkingSelect.value = dashboardState.runtime.thinkingLevel;
	if (dashboardState.runtime?.steeringMode) steeringModeSelect.value = dashboardState.runtime.steeringMode;
	if (dashboardState.runtime?.followUpMode) followUpModeSelect.value = dashboardState.runtime.followUpMode;
	renderTranscript();
	renderTasks();
	renderSuggestions();
	renderSubagents();
	renderEvents();
}

function renderTranscript(): void {
	const messages = dashboardState.streamMessage
		? [...dashboardState.messages, dashboardState.streamMessage]
		: dashboardState.messages;
	transcript.replaceChildren(...messages.map(messageElement));
	if (messages.length === 0) transcript.append(empty("No messages loaded."));
	transcript.scrollTop = transcript.scrollHeight;
}

function messageElement(message: DashboardMessage): HTMLElement {
	const item = document.createElement("article");
	item.className = `message role-${typeof message.role === "string" ? message.role : "custom"}`;
	const heading = document.createElement("header");
	heading.textContent = `${message.role ?? "message"}${message.timestamp ? ` · ${formatDate(message.timestamp)}` : ""}`;
	const body = document.createElement("pre");
	body.textContent = messageText(message);
	item.append(heading, body);
	return item;
}

function renderTasks(): void {
	taskList.replaceChildren();
	if (dashboardState.tasks.length === 0) {
		taskList.append(empty("No task list."));
		return;
	}
	for (const task of dashboardState.tasks) {
		const item = document.createElement("li");
		item.className = `task status-${task.status ?? "pending"}`;
		item.textContent = `${task.status ?? "pending"} — ${task.title ?? task.id ?? "task"}`;
		taskList.append(item);
	}
}

function renderSuggestions(): void {
	suggestions.replaceChildren();
	for (const command of dashboardState.suggestions) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "chip";
		button.textContent = command;
		button.addEventListener("click", () => {
			messageInput.value = command;
			dashboardState = clearSuggestion(dashboardState, command);
			renderSuggestions();
		});
		suggestions.append(button);
	}
}

function renderSubagents(): void {
	subagentList.replaceChildren();
	if (dashboardState.parentPause) {
		const pause = document.createElement("li");
		pause.className = "subagent pause";
		pause.textContent = `Parent paused: ${dashboardState.parentPause.runningAgentCount} running · turn ${dashboardState.parentPause.turnsUsed}/${dashboardState.parentPause.turnLimit}`;
		subagentList.append(pause);
	}
	for (const subagent of dashboardState.subagents) {
		const item = document.createElement("li");
		item.className = `subagent status-${subagent.status}`;
		item.textContent = `${subagent.status} · ${subagent.agentType} · ${subagent.taskSummary}`;
		subagentList.append(item);
	}
	if (subagentList.childElementCount === 0) subagentList.append(empty("No background agents."));
}

function renderEvents(): void {
	eventLog.replaceChildren(
		...dashboardState.events
			.slice(-50)
			.reverse()
			.map((entry) => {
				const item = document.createElement("li");
				item.className = `event category-${entry.category}`;
				item.textContent = `${formatDate(entry.timestamp)} · ${entry.category} · ${entry.type}`;
				return item;
			}),
	);
	if (dashboardState.events.length === 0) eventLog.append(empty("No live events yet."));
}

function runtimeParams(): URLSearchParams {
	return new URLSearchParams(runtimeBody());
}

function runtimeBody(): { cwd: string; sessionPath?: string } {
	if (!runtime) throw new Error("Runtime is not open");
	return runtime.sessionPath ? { cwd: runtime.cwd, sessionPath: runtime.sessionPath } : { cwd: runtime.cwd };
}

function activateTab(name: string): void {
	for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
		button.classList.toggle("active", button.dataset.tab === name);
	}
	for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) {
		panel.hidden = panel.dataset.panel !== name;
	}
}

async function fetchJson<T = JsonRecord>(url: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	if (init.body && !(init.body instanceof ArrayBuffer) && !headers.has("content-type")) {
		headers.set("content-type", "application/json");
	}
	const response = await fetch(url, { ...init, headers });
	if (!response.ok) {
		const text = await response.text();
		throw new Error(parseError(text) || `${response.status} ${response.statusText}`);
	}
	return (await response.json()) as T;
}

function parseError(text: string): string | undefined {
	try {
		const parsed = JSON.parse(text) as { error?: string };
		return parsed.error;
	} catch {
		return text.trim() || undefined;
	}
}

function messageText(message: DashboardMessage): string {
	return contentText(message.content) || JSON.stringify(message, null, 2);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!isRecord(block)) return "";
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "thinking" && typeof block.thinking === "string") return `[thinking]\n${block.thinking}`;
			if (block.type === "toolCall" && typeof block.name === "string") {
				return `[tool call] ${block.name}\n${JSON.stringify(block.arguments ?? {}, null, 2)}`;
			}
			if (block.type === "image") return "[image]";
			return JSON.stringify(block);
		})
		.filter(Boolean)
		.join("\n\n");
}

function parentPath(path: string): string {
	if (path === "." || path === "") return ".";
	const parts = path.split("/").filter(Boolean);
	parts.pop();
	return parts.length ? parts.join("/") : ".";
}

function projectPath(rootPath: string, relativePath: string): string {
	if (relativePath === "." || relativePath === "") return rootPath;
	const separator = rootPath.includes("\\") ? "\\" : "/";
	return `${rootPath.replace(/[\\/]+$/, "")}${separator}${relativePath}`;
}

function sessionLabel(session: SessionInfo): string {
	return session.name || session.firstMessage || session.id || session.path;
}

function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string | number): string {
	const date = new Date(value);
	return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
}

function shortId(id: string): string {
	return id.length > 14 ? `${id.slice(0, 14)}…` : id;
}

function option(value: string, label: string): HTMLOptionElement {
	const element = document.createElement("option");
	element.value = value;
	element.textContent = label;
	return element;
}

function meta(text: string): HTMLElement {
	const element = document.createElement("span");
	element.className = "muted";
	element.textContent = text;
	return element;
}

function empty(text: string): HTMLElement {
	const element = document.createElement("li");
	element.className = "empty";
	element.textContent = text;
	return element;
}

function showStatus(message: string): void {
	statusLine.textContent = message;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
	const element = document.getElementById(id);
	if (!element) throw new Error(`Missing element #${id}`);
	return element as T;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
