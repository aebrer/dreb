// @vitest-environment jsdom
/**
 * Screen smoke tests — every shipped screen renders without throwing, with
 * both empty state and populated state where meaningful.
 */

import { marked } from "marked";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { render } from "solid-js/web/dist/web.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the API module: screens fetch on mount; smoke tests must not hit a server.
vi.mock("../../src/client/api.js", () => ({
	api: {
		auth: vi.fn(async () => ({ mode: "local", needsPairing: false })),
		fleet: vi.fn(async () => ({ runtimes: [], diskSessions: [] })),
		resync: vi.fn(async () => ({ fleet: { runtimes: [], diskSessions: [] }, barrierSeq: 0 })),
		connectionDiagnostic: vi.fn(async () => ({ ok: true })),
		messages: vi.fn(async () => ({ messages: [] })),
		backgroundAgents: vi.fn(async () => ({ agents: [] })),
		subagentMessages: vi.fn(async () => ({
			agent: {
				agentId: "bg1",
				agentType: "Explore",
				taskSummary: "scan things",
				startedAt: new Date().toISOString(),
				status: "completed",
			},
			messages: [],
		})),
		models: vi.fn(async () => ({ models: [] })),
		settingsModels: vi.fn(async () => ({ models: [] })),
		agentTypes: vi.fn(async () => ({ agentTypes: [] })),
		stats: vi.fn(async () => ({
			sessionId: "s1",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 2,
			tokens: { input: 1200, output: 45000, cacheRead: 0, cacheWrite: 12, total: 46212 },
			cost: 0.42,
		})),
		performance: vi.fn(async () => ({ models: [] })),
		resources: vi.fn(async () => ({
			contextFiles: [],
			skills: [],
			extensions: [],
			promptTemplates: [],
			systemPromptPresent: false,
		})),
		commands: vi.fn(async () => ({ commands: [] })),
		branch: vi.fn(async () => ({ branch: null })),
		forkMessages: vi.fn(async () => ({ messages: [] })),
		fork: vi.fn(async () => ({ text: "", cancelled: false })),
		dailyCost: vi.fn(async () => ({ cost: 0.42 })),
		settings: vi.fn(async () => ({ defaultProvider: "anthropic", defaultModel: "m1" })),
		devices: vi.fn(async () => ({ devices: [] })),
		unpair: vi.fn(async () => ({ ok: true })),
		pairingCode: vi.fn(async () => ({ enabled: false })),
		version: vi.fn(async () => ({ version: "0.0.0-test" })),
		serverInfo: vi.fn(async () => ({
			version: "0.0.0-test",
			startedAt: new Date().toISOString(),
			supervised: false,
			restartable: true,
		})),
		restartServer: vi.fn(async () => ({ ok: true, restarting: true })),
		runtime: vi.fn(async (key: string) => ({
			key,
			cwd: "/home/test/project",
			state: {
				sessionId: key,
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				autoCompactionEnabled: true,
				messageCount: 0,
				pendingMessageCount: 0,
			},
			backgroundAgents: [],
			needsAttention: false,
			createdAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
		})),
		places: vi.fn(async () => ({ places: [{ label: "home", path: "/home/test" }] })),
		upload: vi.fn(async (_dir: string, file: File) => ({
			path: `/home/test/project/.dreb-dashboard-uploads/${file.name}`,
		})),
		mkdir: vi.fn(async (dir: string, name: string) => ({ path: `${dir}/${name}` })),
		trustContextFolder: vi.fn(async (path: string) => ({
			evaluation: { canonicalTarget: path, state: "trusted-root", grantingRoot: path },
			settings: {},
			addedRoot: path,
		})),
		untrustContextFolder: vi.fn(async (path: string) => ({
			evaluation: { canonicalTarget: path, state: "untrusted" },
			settings: {},
			removedRoot: path,
		})),
		removeTrustedContextFolder: vi.fn(async (path: string) => ({
			settings: {},
			removedFolder: path,
		})),
		listFiles: vi.fn(async () => ({
			path: "/home/test",
			contextTrust: { canonicalTarget: "/home/test", state: "untrusted" },
			entries: [
				{ name: "src", type: "dir", size: 0, modified: new Date().toISOString() },
				{ name: "readme.md", type: "file", size: 1200, modified: new Date().toISOString() },
			],
		})),
		exportHtmlUrl: (key: string) => `/api/runtimes/${key}/export-html`,
		downloadUrl: (path: string) => `/api/files/download?path=${path}`,
		pair: vi.fn(async () => ({ device: { id: "d1" } })),
		pending: vi.fn(async () => ({ steering: [], followUp: [] })),
		dequeue: vi.fn(async () => ({ steering: [], followUp: [] })),
		prompt: vi.fn(async () => ({})),
		abort: vi.fn(async () => ({})),
		abortCompaction: vi.fn(async () => ({})),
		abortRetry: vi.fn(async () => ({})),
		setModel: vi.fn(async () => ({ provider: "test", id: "m1" })),
		setThinking: vi.fn(async () => ({})),
		saveSettings: vi.fn(async (settings) => settings),
		deleteSession: vi.fn(async () => ({ ok: true })),
		createRuntime: vi.fn(async (cwd: string) => ({
			key: "new-key",
			cwd,
			state: {
				sessionId: "new",
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				autoCompactionEnabled: true,
				messageCount: 0,
				pendingMessageCount: 0,
			},
			backgroundAgents: [],
			needsAttention: false,
			createdAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
		})),
	},
	connectEvents: vi.fn(() => () => {}),
}));

import { api, connectEvents, type EventStreamHandlers } from "../../src/client/api.js";
import { ConnectionIndicator, Topbar } from "../../src/client/components/common.js";
import {
	TRANSCRIPT_WINDOW_SIZE,
	Transcript,
	type TranscriptRenderItem,
	transcriptRenderItems,
} from "../../src/client/components/transcript.js";
import { FilesScreen } from "../../src/client/screens/files.js";
import { FleetScreen, fleetGroupKey } from "../../src/client/screens/fleet.js";
import { PairingScreen } from "../../src/client/screens/pairing.js";
import { formatTokens, SessionScreen } from "../../src/client/screens/session.js";
import { SettingsScreen } from "../../src/client/screens/settings.js";
import { SubagentScreen } from "../../src/client/screens/subagent.js";
import {
	__resetAppearanceForTests,
	COLOR_MODE_STORAGE_KEY,
	reloadAppearance,
	THEME_STORAGE_KEY,
} from "../../src/client/state/appearance.js";
import { setExpandThinking } from "../../src/client/state/preferences.js";
import {
	applySessionEvent,
	createSessionViewState,
	type SessionViewState,
	type ToolEntry,
	type TranscriptEntry,
} from "../../src/client/state/reducer.js";
import { createAppStore } from "../../src/client/state/store.js";
import { MAX_TOTAL_IMAGE_BYTES } from "../../src/shared/protocol.js";

const disposers: Array<() => void> = [];

// jsdom lacks ResizeObserver; real browsers always have it. Install a no-op so
// the stick-to-bottom controller's observeContent() attaches quietly instead of
// logging its (correct) "ResizeObserver unavailable" warning on every screen
// mount. Tests that exercise the observer path override this with a capturing
// fake and restore it afterward.
if (!(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver) {
	class NoopResizeObserver {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	}
	(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
		NoopResizeObserver as unknown as typeof ResizeObserver;
}

beforeEach(() => {
	// Always install a Map-backed localStorage shim. jsdom's own localStorage can
	// be present-but-broken in some environments (e.g. when node is launched with
	// a bad `--localstorage-file`, its methods aren't functions), so a plain
	// `if (window.localStorage) return;` guard would leave those broken methods in
	// place. Redefining unconditionally (the property is configurable) is
	// deterministic and functionally identical where jsdom's storage works.
	const values = new Map<string, string>();
	Object.defineProperty(window, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, String(value)),
			removeItem: (key: string) => values.delete(key),
			clear: () => values.clear(),
			key: (index: number) => [...values.keys()][index] ?? null,
			get length() {
				return values.size;
			},
		},
	});
});

afterEach(() => {
	vi.useRealTimers();
	for (const dispose of disposers.splice(0)) dispose();
	document.body.innerHTML = "";
	window.location.hash = "#/";
	setExpandThinking(false);
	window.localStorage.clear();
	vi.mocked(connectEvents).mockImplementation(() => () => {});
	vi.mocked(api.auth).mockResolvedValue({ mode: "local", needsPairing: false });
	vi.mocked(api.fleet).mockResolvedValue({ runtimes: [], diskSessions: [] });
	vi.mocked(api.messages).mockResolvedValue({ messages: [] });
	vi.mocked(api.backgroundAgents).mockResolvedValue({ agents: [] });
	vi.mocked(api.runtime).mockImplementation(async (key: string) => ({
		key,
		cwd: "/home/test/project",
		state: {
			sessionId: key,
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		},
		backgroundAgents: [],
		needsAttention: false,
		createdAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
	}));
	vi.mocked(api.subagentMessages).mockResolvedValue({
		agent: {
			agentId: "bg1",
			agentType: "Explore",
			taskSummary: "scan things",
			startedAt: new Date().toISOString(),
			status: "completed",
		},
		messages: [],
	});
	vi.mocked(api.models).mockResolvedValue({ models: [] });
	vi.mocked(api.settingsModels).mockResolvedValue({ models: [] });
	vi.mocked(api.agentTypes).mockResolvedValue({ agentTypes: [] });
	vi.mocked(api.settings).mockResolvedValue({ defaultProvider: "anthropic", defaultModel: "m1" });
	vi.mocked(api.saveSettings).mockImplementation(async (settings) => settings);
	vi.mocked(api.deleteSession).mockResolvedValue({ ok: true });
	vi.mocked(api.createRuntime).mockImplementation(async (cwd: string) => ({
		key: "new-key",
		cwd,
		state: {
			sessionId: "new",
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		},
		backgroundAgents: [],
		needsAttention: false,
		createdAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
	}));
	vi.mocked(api.devices).mockResolvedValue({ devices: [] });
	vi.mocked(api.unpair).mockResolvedValue({ ok: true });
	vi.mocked(api.version).mockResolvedValue({ version: "0.0.0-test" });
	vi.mocked(api.stats).mockResolvedValue({
		sessionId: "s1",
		userMessages: 1,
		assistantMessages: 1,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 2,
		tokens: { input: 1200, output: 45000, cacheRead: 0, cacheWrite: 12, total: 46212 },
		cost: 0.42,
	});
	vi.mocked(api.performance).mockResolvedValue({ models: [] });
	vi.mocked(api.resources).mockResolvedValue({
		contextFiles: [],
		skills: [],
		extensions: [],
		promptTemplates: [],
		systemPromptPresent: false,
	});
	vi.mocked(api.commands).mockResolvedValue({ commands: [] });
	vi.mocked(api.branch).mockResolvedValue({ branch: null });
	vi.mocked(api.pair).mockResolvedValue({
		device: {
			id: "d1",
			identity: "alice@example.com",
			createdAt: new Date().toISOString(),
			expiresAt: new Date().toISOString(),
		},
	});
	vi.mocked(api.pending).mockResolvedValue({ steering: [], followUp: [] });
	vi.mocked(api.dequeue).mockResolvedValue({ steering: [], followUp: [] });
	vi.mocked(api.forkMessages).mockResolvedValue({ messages: [] });
	vi.mocked(api.fork).mockResolvedValue({ text: "", cancelled: false });
	vi.mocked(api.dailyCost).mockResolvedValue({ cost: 0.42 });
	vi.unstubAllGlobals();
	Reflect.deleteProperty(window, "matchMedia");
	vi.mocked(api.places).mockResolvedValue({ places: [{ label: "home", path: "/home/test" }] });
	vi.mocked(api.upload).mockImplementation(async (_dir: string, file: File) => ({
		path: `/home/test/project/.dreb-dashboard-uploads/${file.name}`,
	}));
	vi.mocked(api.mkdir).mockImplementation(async (dir: string, name: string) => ({ path: `${dir}/${name}` }));
	vi.mocked(api.trustContextFolder).mockImplementation(async (path: string) => ({
		evaluation: { canonicalTarget: path, state: "trusted-root", grantingRoot: path },
		settings: {},
		addedRoot: path,
	}));
	vi.mocked(api.untrustContextFolder).mockImplementation(async (path: string) => ({
		evaluation: { canonicalTarget: path, state: "untrusted" },
		settings: {},
		removedRoot: path,
	}));
	vi.mocked(api.removeTrustedContextFolder).mockImplementation(async (path: string) => ({
		settings: {},
		removedFolder: path,
	}));
	vi.mocked(api.listFiles).mockResolvedValue({
		path: "/home/test",
		contextTrust: { canonicalTarget: "/home/test", state: "untrusted" },
		entries: [
			{ name: "src", type: "dir", size: 0, modified: new Date().toISOString() },
			{ name: "readme.md", type: "file", size: 1200, modified: new Date().toISOString() },
		],
	});
});

function mount(element: () => any): HTMLElement {
	const { container, dispose } = mountDisposable(element);
	disposers.push(dispose);
	return container;
}

function mountDisposable(element: () => any): { container: HTMLElement; dispose: () => void } {
	const container = document.createElement("div");
	document.body.appendChild(container);
	return { container, dispose: render(element, container) };
}

function makeStore() {
	// createAppStore touches window.location.hash — jsdom provides it.
	return createAppStore();
}

function stubMobile(matches = true) {
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: vi.fn((query: string) => ({
			matches,
			media: query,
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		})),
	});
}

function stubObjectUrls() {
	let nextUrl = 0;
	const createObjectURL = vi.fn(() => `blob:mock-${++nextUrl}`);
	const revokeObjectURL = vi.fn();
	Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
	Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
	return { createObjectURL, revokeObjectURL };
}

function sizedImage(name: string, size: number): File {
	const file = new File(["x"], name, { type: "image/png" });
	Object.defineProperty(file, "size", { configurable: true, value: size });
	return file;
}

function maxTotalImageBytesLabel(): string {
	return `${(MAX_TOTAL_IMAGE_BYTES / (1024 * 1024)).toFixed(1)} MB`;
}

function rejectOnAbort<T>(signal: AbortSignal | undefined): Promise<T> {
	return new Promise<T>((_, reject) => {
		if (!signal) throw new Error("expected AbortSignal");
		signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
	});
}

/** Build a populated session state to exercise entry rendering. */
function populatedSession(key: string): SessionViewState {
	const state = createSessionViewState(key);
	applySessionEvent(state, { type: "agent_start" });
	applySessionEvent(state, {
		type: "message_end",
		message: {
			role: "assistant",
			model: "test-model",
			content: [
				{ type: "thinking", thinking: "pondering" },
				{ type: "text", text: "hello world" },
			],
		},
	});
	applySessionEvent(state, {
		type: "tool_execution_start",
		toolCallId: "t1",
		toolName: "edit",
		args: { path: "/x.ts" },
	});
	applySessionEvent(state, {
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "edit",
		result: { content: [{ type: "text", text: "- old\n+ new" }] },
		isError: false,
	});
	applySessionEvent(state, { type: "tasks_update", tasks: [{ title: "task one", status: "in_progress" }] });
	applySessionEvent(state, { type: "suggest_next", command: "/skill:test" });
	applySessionEvent(state, {
		type: "background_agent_start",
		agentId: "bg1",
		agentType: "Explore",
		taskSummary: "scan things",
		sessionDir: "/dir",
	});
	return state;
}

function setDetailsOpen(details: HTMLDetailsElement, open: boolean): void {
	details.open = open;
	details.dispatchEvent(new Event("toggle"));
}

function toolEntryFromEvents(params: {
	toolName: string;
	args?: Record<string, unknown>;
	resultText?: string;
	details?: unknown;
	isError?: boolean;
}): ToolEntry {
	const state = createSessionViewState(`tool-${params.toolName}`);
	const toolCallId = `t-${params.toolName}-${state.entries.length}`;
	applySessionEvent(state, {
		type: "tool_execution_start",
		toolCallId,
		toolName: params.toolName,
		args: params.args ?? {},
	});
	applySessionEvent(state, {
		type: "tool_execution_end",
		toolCallId,
		toolName: params.toolName,
		result: {
			content: [{ type: "text", text: params.resultText ?? "" }],
			details: params.details,
		},
		isError: params.isError ?? false,
	});
	const entry = state.entries.find(
		(item): item is ToolEntry => item.kind === "tool" && item.toolCallId === toolCallId,
	);
	if (!entry) throw new Error(`missing tool entry for ${params.toolName}`);
	return entry;
}

describe("app store integration", () => {
	it("topbar announces retrying live state with text, not color alone", async () => {
		let captured: EventStreamHandlers | undefined;
		vi.mocked(connectEvents).mockImplementation((handlers) => {
			captured = handlers;
			return () => {};
		});
		const store = makeStore();
		await store.start();
		if (!captured?.onStatusChange) throw new Error("connection status handler missing");
		captured.onStatusChange({ state: "retrying", attempt: 2, retryDelayMs: 1500, retryAt: Date.now() + 1500 });
		const el = mount(() => <Topbar store={store} active="fleet" />);
		expect(el.textContent).toContain("retrying in 2s");
		expect(el.querySelector("output")).not.toBeNull();
	});

	it("session view anchors live connection status in the persistent session header", async () => {
		stubMobile(true);
		let captured: EventStreamHandlers | undefined;
		vi.mocked(connectEvents).mockImplementation((handlers) => {
			captured = handlers;
			return () => {};
		});
		const store = makeStore();
		await store.start();
		const el = mount(() => <SessionScreen store={store} sessionKey="k-live-status" />);
		const headerStatus = () =>
			el.querySelector("header.session-bar .session-bar-main .session-connection-indicator") as HTMLElement | null;
		const footerStatus = () => el.querySelector("footer.dock .connection-indicator") as HTMLElement | null;
		expect(headerStatus()?.querySelector("output")).not.toBeNull();
		expect(footerStatus()).toBeNull();
		if (!captured?.onStatusChange) throw new Error("connection status handler missing");

		captured.onStatusChange({ state: "retrying", attempt: 2, retryDelayMs: 1500, retryAt: Date.now() + 1500 });
		expect(headerStatus()?.textContent).toContain("retrying in 2s");
		expect(footerStatus()).toBeNull();

		captured.onStatusChange({ state: "resyncing", attempt: 2 });
		expect(headerStatus()?.textContent).toContain("recovering live state");

		captured.onStatusChange({ state: "auth_failed", attempt: 2 });
		expect(headerStatus()?.textContent).toContain("live connection unauthorized");

		const collapseTopChrome = [...el.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("details ▴"),
		);
		if (!collapseTopChrome) throw new Error("top chrome collapse control missing");
		collapseTopChrome.click();
		expect(el.querySelector("header.session-bar.collapsed .session-connection-indicator")?.textContent).toContain(
			"live connection unauthorized",
		);

		const collapseComposer = [...el.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("compose ▾"),
		);
		if (!collapseComposer) throw new Error("composer collapse control missing");
		collapseComposer.click();
		expect(el.textContent).toContain("composer hidden for transcript reading");
		expect(headerStatus()?.textContent).toContain("live connection unauthorized");
		expect(footerStatus()).toBeNull();
	});

	it("dismissToast removes reducer toast and does not resurrect after later sync", async () => {
		let captured: EventStreamHandlers | undefined;
		vi.mocked(connectEvents).mockImplementation((handlers) => {
			captured = handlers;
			return () => {};
		});
		const store = makeStore();

		await store.start();
		if (!captured) throw new Error("connectEvents was not called");

		captured.onEnvelope({ seq: 1, key: "k1", event: { type: "extension_error", error: "boom" } });
		expect(store.sessions.k1?.toasts).toHaveLength(1);
		const toast = store.sessions.k1?.toasts[0];
		expect(toast).toMatchObject({ text: "extension error: boom", tone: "error" });
		if (!toast) throw new Error("toast was not created");

		store.dismissToast(toast.id);
		expect(store.sessions.k1?.toasts).toHaveLength(0);

		captured.onEnvelope({ seq: 2, key: "k1", event: { type: "agent_start" } });
		expect(store.sessions.k1?.toasts).toHaveLength(0);
		expect(store.sessions.k1?.toasts.some((item) => item.id === toast.id)).toBe(false);
	});

	it("dashboard_resync rehydrates the active session route", async () => {
		let captured: EventStreamHandlers | undefined;
		vi.mocked(connectEvents).mockImplementation((handlers) => {
			captured = handlers;
			return () => {};
		});
		vi.mocked(api.resync).mockResolvedValue({
			fleet: { runtimes: [], diskSessions: [] },
			active: {
				key: "k-resync",
				state: {
					sessionId: "k-resync",
					tasks: [],
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "all",
					autoCompactionEnabled: true,
					messageCount: 1,
					pendingMessageCount: 0,
				},
				messages: [{ role: "assistant", content: [{ type: "text", text: "fresh transcript" }] }],
				backgroundAgents: [],
				barrierSeq: 3,
			},
			barrierSeq: 3,
		});
		window.location.hash = "#/session/k-resync";
		const store = makeStore();

		await store.start();
		if (!captured) throw new Error("connectEvents was not called");
		captured.onEnvelope({ seq: 1, key: "k-resync", event: { type: "agent_start" } });
		expect(store.sessions["k-resync"]?.streaming).toBe(true);

		captured.onEnvelope({ seq: 2, key: "", event: { type: "dashboard_resync", reason: "buffer_gap" } });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(api.resync).toHaveBeenCalledWith("k-resync", undefined, expect.any(AbortSignal));
		expect(store.sessions["k-resync"]?.entries[0]?.kind).toBe("assistant");
	});

	it("touch scrolling the transcript suspends stick-to-bottom while streaming", async () => {
		let captured: EventStreamHandlers | undefined;
		vi.mocked(connectEvents).mockImplementation((handlers) => {
			captured = handlers;
			return () => {};
		});
		const store = makeStore();
		await store.start();
		if (!captured) throw new Error("connectEvents was not called");
		const el = mount(() => <SessionScreen store={store} sessionKey="k-scroll" />);
		captured.onEnvelope({ seq: 1, key: "k-scroll", event: { type: "agent_start" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const chat = el.querySelector(".chat") as HTMLElement;
		let scrollHeight = 500;
		Object.defineProperty(chat, "clientHeight", { configurable: true, value: 100 });
		Object.defineProperty(chat, "scrollHeight", { configurable: true, get: () => scrollHeight });
		chat.scrollTop = 400;
		chat.dispatchEvent(new Event("scroll", { bubbles: true }));

		const touchEvent = (type: string, clientY: number) => {
			const event = new Event(type, { bubbles: true }) as Event & { touches: Array<{ clientY: number }> };
			event.touches = [{ clientY }];
			return event;
		};
		chat.dispatchEvent(touchEvent("touchstart", 300));
		scrollHeight = 900;
		captured.onEnvelope({
			seq: 2,
			key: "k-scroll",
			event: { type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "yes" } },
		});
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		expect(chat.scrollTop).toBe(400);

		// The finger drags DOWN the screen (clientY increases) — an up-scroll.
		chat.dispatchEvent(touchEvent("touchmove", 360));
		chat.scrollTop = 200;
		chat.dispatchEvent(new Event("scroll", { bubbles: true }));
		chat.dispatchEvent(new Event("touchend", { bubbles: true }));
		scrollHeight = 1200;
		captured.onEnvelope({
			seq: 3,
			key: "k-scroll",
			event: { type: "tool_execution_update", toolCallId: "b1", content: "new output" },
		});
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		expect(chat.scrollTop).toBe(200);
	});

	it("keeps following when content grows without a user scroll (no silent drop-out)", async () => {
		let captured: EventStreamHandlers | undefined;
		vi.mocked(connectEvents).mockImplementation((handlers) => {
			captured = handlers;
			return () => {};
		});
		const store = makeStore();
		await store.start();
		if (!captured) throw new Error("connectEvents was not called");
		const el = mount(() => <SessionScreen store={store} sessionKey="k-grow" />);
		captured.onEnvelope({ seq: 1, key: "k-grow", event: { type: "agent_start" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const chat = el.querySelector(".chat") as HTMLElement;
		let scrollHeight = 500;
		Object.defineProperty(chat, "clientHeight", { configurable: true, value: 100 });
		Object.defineProperty(chat, "scrollHeight", { configurable: true, get: () => scrollHeight });

		// User is parked at the bottom.
		chat.scrollTop = 400;
		chat.dispatchEvent(new Event("scroll", { bubbles: true }));

		// Content grows below (e.g. a long tool output) and a spurious scroll event
		// fires while the viewport now measures "not at bottom" — the old absolute
		// at-bottom check would latch follow off here.
		scrollHeight = 900;
		chat.dispatchEvent(new Event("scroll", { bubbles: true }));

		// A subsequent envelope must still pin to the new bottom.
		scrollHeight = 1000;
		captured.onEnvelope({
			seq: 2,
			key: "k-grow",
			event: { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "yes" } },
		});
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		expect(chat.scrollTop).toBe(1000);
	});

	it("keeps following when an assistant→tool reflow lowers scrollTop with no user input", async () => {
		// The residual drop-out: at a tool boundary the transcript reflows (streamed
		// message replaced by full markdown, assistant-turn DOM recreated) and the
		// browser LOWERS scrollTop while a tool card is appended below. No wheel /
		// touch / pointer / key input precedes the resulting scroll event, so it must
		// not be misread as a user up-scroll.
		let captured: EventStreamHandlers | undefined;
		vi.mocked(connectEvents).mockImplementation((handlers) => {
			captured = handlers;
			return () => {};
		});
		const store = makeStore();
		await store.start();
		if (!captured) throw new Error("connectEvents was not called");
		const el = mount(() => <SessionScreen store={store} sessionKey="k-reflow" />);
		captured.onEnvelope({ seq: 1, key: "k-reflow", event: { type: "agent_start" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const chat = el.querySelector(".chat") as HTMLElement;
		let scrollHeight = 900;
		Object.defineProperty(chat, "clientHeight", { configurable: true, value: 100 });
		Object.defineProperty(chat, "scrollHeight", { configurable: true, get: () => scrollHeight });

		// Parked at the resting bottom.
		chat.scrollTop = 800;
		chat.dispatchEvent(new Event("scroll", { bubbles: true }));

		// Reflow: assistant completion lowers scrollTop by 300, a tool card grows the
		// content far below, and the browser emits a scroll event — WITHOUT any input.
		scrollHeight = 1500;
		chat.scrollTop = 500;
		chat.dispatchEvent(new Event("scroll", { bubbles: true }));

		// The next envelope must still pin to the new bottom (follow survived).
		scrollHeight = 1600;
		captured.onEnvelope({
			seq: 2,
			key: "k-reflow",
			event: { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "yes" } },
		});
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		expect(chat.scrollTop).toBe(1600);
	});

	it("releases follow when the user wheels up before a scroll (deliberate up-scroll)", async () => {
		let captured: EventStreamHandlers | undefined;
		vi.mocked(connectEvents).mockImplementation((handlers) => {
			captured = handlers;
			return () => {};
		});
		const store = makeStore();
		await store.start();
		if (!captured) throw new Error("connectEvents was not called");
		const el = mount(() => <SessionScreen store={store} sessionKey="k-wheelup" />);
		captured.onEnvelope({ seq: 1, key: "k-wheelup", event: { type: "agent_start" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const chat = el.querySelector(".chat") as HTMLElement;
		let scrollHeight = 900;
		Object.defineProperty(chat, "clientHeight", { configurable: true, value: 100 });
		Object.defineProperty(chat, "scrollHeight", { configurable: true, get: () => scrollHeight });

		chat.scrollTop = 800;
		chat.dispatchEvent(new Event("scroll", { bubbles: true }));

		// A genuine wheel-up followed by the resulting decreased scrollTop releases.
		chat.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
		chat.scrollTop = 300;
		chat.dispatchEvent(new Event("scroll", { bubbles: true }));

		// Later growth must NOT yank the released view back to the bottom.
		scrollHeight = 1600;
		captured.onEnvelope({
			seq: 2,
			key: "k-wheelup",
			event: { type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "yes" } },
		});
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		expect(chat.scrollTop).toBe(300);
	});

	it("re-pins the transcript when observed content or viewport changes without a new envelope", async () => {
		// Record each registration: the screen must attach two independent
		// observers, one to .chat-inner content and one to the .chat viewport.
		const observers: Array<{ callback: ResizeObserverCallback; observed?: Element }> = [];
		class FakeRO {
			private readonly registration: { callback: ResizeObserverCallback; observed?: Element };
			constructor(callback: ResizeObserverCallback) {
				this.registration = { callback };
				observers.push(this.registration);
			}
			observe(element: Element): void {
				this.registration.observed = element;
			}
			unobserve(): void {}
			disconnect(): void {}
		}
		const priorRO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
		(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
			FakeRO as unknown as typeof ResizeObserver;
		try {
			let captured: EventStreamHandlers | undefined;
			vi.mocked(connectEvents).mockImplementation((handlers) => {
				captured = handlers;
				return () => {};
			});
			const store = makeStore();
			await store.start();
			if (!captured) throw new Error("connectEvents was not called");
			const el = mount(() => <SessionScreen store={store} sessionKey="k-ro" />);
			captured.onEnvelope({ seq: 1, key: "k-ro", event: { type: "agent_start" } });
			await new Promise((resolve) => setTimeout(resolve, 0));
			const chat = el.querySelector(".chat") as HTMLElement;
			const chatInner = el.querySelector(".chat-inner") as HTMLElement;
			let scrollHeight = 500;
			let clientHeight = 100;
			let scrollTop = 0;
			let scrollWrites = 0;
			Object.defineProperty(chat, "clientHeight", { configurable: true, get: () => clientHeight });
			Object.defineProperty(chat, "scrollHeight", { configurable: true, get: () => scrollHeight });
			Object.defineProperty(chat, "scrollTop", {
				configurable: true,
				get: () => scrollTop,
				set: (value: number) => {
					scrollTop = value;
					scrollWrites++;
				},
			});
			expect(observers.map((observer) => observer.observed)).toEqual([chatInner, chat]);

			// Flush any pending mount/revision pin FIRST, so the assertion below can
			// only be satisfied by the ResizeObserver-driven re-pin — not by a
			// leftover coalesced pin that would reach the new bottom regardless of
			// whether observeViewport/observeContent actually attached.
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

			// Parked at the bottom.
			chat.scrollTop = 400;
			chat.dispatchEvent(new Event("scroll", { bubbles: true }));
			scrollWrites = 0;

			// Content grows asynchronously (e.g. late syntax highlighting) with NO
			// new envelope — only the content observer fires. The transcript must
			// re-pin to the new bottom.
			const contentObserver = observers.find((observer) => observer.observed === chatInner);
			expect(contentObserver).toBeDefined();
			scrollHeight = 1000;
			contentObserver?.callback([], {} as ResizeObserver);
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			expect(chat.scrollTop).toBe(1000);

			// A dock/composer resize changes only the viewport geometry. Its separate
			// observer must independently request the pin.
			const viewportObserver = observers.find((observer) => observer.observed === chat);
			expect(viewportObserver).toBeDefined();
			scrollWrites = 0;
			clientHeight = 200;
			viewportObserver?.callback([], {} as ResizeObserver);
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			expect(scrollWrites).toBe(1);
			expect(chat.scrollTop).toBe(1000);
		} finally {
			(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = priorRO;
		}
	});
});

describe("screen smoke tests", () => {
	it("fleet renders (empty state)", () => {
		const store = makeStore();
		const el = mount(() => <FleetScreen store={store} />);
		expect(el.textContent).toContain("fleet");
		expect(el.textContent).toContain("No sessions yet");
	});

	it("session view renders with a populated transcript and session info bar", async () => {
		vi.mocked(api.branch).mockResolvedValue({ branch: "feature/info" });
		vi.mocked(api.dailyCost).mockResolvedValue({ cost: 1.25 });
		vi.mocked(api.performance).mockResolvedValue({
			models: [{ provider: "test", modelId: "test-model", median: 41.8, mean: 43, count: 4 }],
		});
		const store = makeStore() as any;
		// Inject session state directly (store internals sync from the reducer).
		const session = populatedSession("k1");
		// Render with the raw state injected through a wrapper store object.
		const fakeStore = {
			...store,
			sessions: { k1: session },
			fleet: () => ({
				runtimes: [
					{
						key: "k1",
						cwd: "/home/test/software/dreb",
						state: {
							sessionId: "s1",
							sessionName: "test session",
							thinkingLevel: "medium",
							isStreaming: true,
							isCompacting: false,
							steeringMode: "all",
							followUpMode: "all",
							autoCompactionEnabled: true,
							messageCount: 3,
							pendingMessageCount: 0,
							model: { provider: "test", id: "test-model" },
							usingSubscription: true,
							contextUsage: { tokens: 50000, contextWindow: 200000, percent: 25 },
						},
						backgroundAgents: [],
						needsAttention: false,
						createdAt: new Date().toISOString(),
						lastActivity: new Date().toISOString(),
					},
				],
				diskSessions: [],
			}),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k1" />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(el.textContent).toContain("hello world");
		expect(el.textContent).toContain("edit");
		expect(el.textContent).toContain("task one");
		expect(el.textContent).toContain("steer");
		expect(el.textContent).toContain("follow-up");
		expect(el.textContent).toContain("■ stop");
		expect(el.textContent).toContain("ctx");
		expect(el.textContent).toContain("~/software/dreb (feature/info) • test session");
		expect(el.textContent).toContain("↑1.2k ↓45k W12");
		expect(el.textContent).toContain("$0.420 (sub), today: $1.25");
		expect(el.textContent).toContain("42 tok/s");
		expect(el.textContent).toContain("test/test-model");
		expect(el.textContent).toContain("scan things");
		// Suggest-next chip
		expect(el.textContent).toContain("/skill:test");
	});

	it("session view without streaming hides stop and mode toggle", () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k2");
		const fakeStore = {
			...store,
			sessions: { k2: session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k2" />);
		expect(el.textContent).not.toContain("■ stop");
		expect(el.textContent).not.toContain("follow-up");
	});

	it("session header prefers live session_name_changed state", () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-live");
		session.sessionName = "live rename";
		const fakeStore = {
			...store,
			sessions: { "k-live": session },
			fleet: () => ({
				runtimes: [
					{
						key: "k-live",
						cwd: "/repo",
						state: {
							sessionId: "s1",
							sessionName: "stale name",
							thinkingLevel: "off",
							isStreaming: false,
							isCompacting: false,
							steeringMode: "all",
							followUpMode: "all",
							autoCompactionEnabled: true,
							messageCount: 0,
							pendingMessageCount: 0,
						},
						backgroundAgents: [],
						needsAttention: false,
						createdAt: new Date().toISOString(),
						lastActivity: new Date().toISOString(),
					},
				],
				diskSessions: [],
			}),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-live" />);
		expect(el.querySelector(".session-bar .title")?.textContent).toBe("live rename");
	});

	it("session top and bottom chrome collapse with visible reopen hints", () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-collapse");
		const fakeStore = {
			...store,
			sessions: { "k-collapse": session },
			fleet: () => ({
				runtimes: [
					{
						key: "k-collapse",
						cwd: "/repo",
						state: {
							sessionId: "s1",
							thinkingLevel: "off",
							isStreaming: false,
							isCompacting: false,
							steeringMode: "all",
							followUpMode: "all",
							autoCompactionEnabled: true,
							messageCount: 0,
							pendingMessageCount: 0,
							model: { provider: "test", id: "long-model" },
						},
						backgroundAgents: [],
						needsAttention: false,
						createdAt: new Date().toISOString(),
						lastActivity: new Date().toISOString(),
					},
				],
				diskSessions: [],
			}),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-collapse" />);
		expect(el.querySelector("textarea")).not.toBeNull();
		expect(el.querySelector(".model-switcher")).not.toBeNull();

		[...el.querySelectorAll("button")].find((button) => button.textContent?.includes("details ▴"))?.click();
		expect(el.querySelector(".model-switcher")).toBeNull();
		expect(el.textContent).toContain("details ▾");

		[...el.querySelectorAll("button")].find((button) => button.textContent?.includes("compose ▾"))?.click();
		expect(el.querySelector("textarea")).toBeNull();
		expect(el.textContent).toContain("composer hidden for transcript reading");
		expect(el.textContent).toContain("compose ▴");
	});

	it("in-session subagent panel collapses without hiding the count", () => {
		const store = makeStore() as any;
		const session = populatedSession("k-subpanel");
		const fakeStore = {
			...store,
			sessions: { "k-subpanel": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-subpanel" />);
		expect(el.textContent).toContain("scan things");
		const toggle = [...el.querySelectorAll("button")].find((button) => button.textContent?.includes("subagents ▾"));
		expect(toggle).toBeDefined();
		(toggle as HTMLButtonElement).click();

		expect(el.textContent).toContain("subagents ▴");
		expect(el.textContent).toContain("1 running · 0 done");
		expect(el.textContent).toContain("subagent panel hidden");
		expect(el.textContent).not.toContain("scan things");
	});

	it("subagent drill-in renders read-only with the fixed note and no composer", () => {
		const store = makeStore() as any;
		const session = populatedSession("k1");
		applySessionEvent(session, {
			type: "background_agent_event",
			agentId: "bg1",
			event: {
				type: "message_end",
				message: { role: "assistant", model: "haiku", content: [{ type: "text", text: "subagent says hi" }] },
			},
		});
		const fakeStore = {
			...store,
			sessions: { k1: session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
		};
		const el = mount(() => <SubagentScreen store={fakeStore} sessionKey="k1" agentId="bg1" />);
		expect(el.textContent).toContain("subagent says hi");
		expect(el.textContent).toContain("subagents can't be steered yet");
		expect(el.querySelector("textarea")).toBeNull(); // no composer
	});

	it("session hydration aborts on unmount without surfacing an error", async () => {
		let capturedSignal: AbortSignal | undefined;
		vi.mocked(api.messages).mockImplementation((_key: string, signal?: AbortSignal) => {
			capturedSignal = signal;
			return rejectOnAbort(signal);
		});
		vi.mocked(api.backgroundAgents).mockImplementation((_key: string, signal?: AbortSignal) => rejectOnAbort(signal));
		vi.mocked(api.runtime).mockImplementation((_key: string, signal?: AbortSignal) => rejectOnAbort(signal));
		const store = makeStore();
		const { container, dispose } = mountDisposable(() => <SessionScreen store={store} sessionKey="abort-session" />);

		dispose();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(capturedSignal?.aborted).toBe(true);
		expect(container.textContent).not.toContain("Abort");
		expect(container.querySelector(".error")).toBeNull();
	});

	it("subagent hydration aborts on unmount without surfacing an error", async () => {
		let capturedSignal: AbortSignal | undefined;
		vi.mocked(api.subagentMessages).mockImplementation((_key: string, _agentId: string, signal?: AbortSignal) => {
			capturedSignal = signal;
			return rejectOnAbort(signal);
		});
		const store = makeStore();
		const { container, dispose } = mountDisposable(() => (
			<SubagentScreen store={store} sessionKey="abort-session" agentId="bg1" />
		));

		dispose();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(capturedSignal?.aborted).toBe(true);
		expect(container.textContent).not.toContain("Abort");
		expect(container.querySelector(".pair-error")).toBeNull();
	});

	it("genuine session hydration failures still surface as action errors", async () => {
		vi.mocked(api.messages).mockRejectedValueOnce(new Error("hydrate exploded"));
		const store = makeStore();
		const el = mount(() => <SessionScreen store={store} sessionKey="bad-hydrate" />);

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain("hydrate exploded");
	});

	it("files renders places, table, and the fixed warning copy", async () => {
		const store = makeStore();
		const el = mount(() => <FilesScreen store={store} />);
		// createResource resolves async — flush microtasks.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(el.textContent).toContain("whole host filesystem");
		expect(el.textContent).toContain("never overwritten silently");
		expect(el.textContent).toContain("readme.md");
		expect(el.textContent).toContain("new session here");
	});

	it("files trusts an untrusted folder and updates its scope immediately", async () => {
		vi.mocked(api.listFiles).mockResolvedValue({
			path: "/workspace",
			entries: [],
			contextTrust: { canonicalTarget: "/workspace", state: "untrusted" },
		});
		const store = makeStore();
		const el = mount(() => <FilesScreen store={store} initialPath="/workspace" />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain("Nested context is untrusted");
		const callsBeforeMutation = vi.mocked(api.listFiles).mock.calls.length;
		const trust = [...el.querySelectorAll("button")].find(
			(button) => button.textContent === "trust this folder and descendants",
		)!;
		trust.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.trustContextFolder).toHaveBeenCalledWith("/workspace");
		expect(el.textContent).toContain("Nested context trusted for this folder");
		expect(el.textContent).toContain("/workspace and all descendants are trusted");
		expect(api.listFiles).toHaveBeenCalledTimes(callsBeforeMutation);
	});

	it("files ignores a completed trust mutation after navigation", async () => {
		vi.mocked(api.listFiles).mockImplementation(async (currentPath: string) => ({
			path: currentPath,
			entries:
				currentPath === "/workspace"
					? [{ name: "child", type: "dir", size: 0, modified: new Date().toISOString() }]
					: [{ name: "b-file", type: "file", size: 1, modified: new Date().toISOString() }],
			contextTrust: { canonicalTarget: currentPath, state: "untrusted" as const },
		}));
		let resolveTrust!: (value: Awaited<ReturnType<typeof api.trustContextFolder>>) => void;
		const trustResult = new Promise<Awaited<ReturnType<typeof api.trustContextFolder>>>((resolve) => {
			resolveTrust = resolve;
		});
		vi.mocked(api.trustContextFolder).mockImplementationOnce(() => trustResult);

		const store = makeStore();
		const el = mount(() => <FilesScreen store={store} initialPath="/workspace" />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		[...el.querySelectorAll("button")]
			.find((button) => button.textContent === "trust this folder and descendants")!
			.click();
		[...el.querySelectorAll("button")].find((button) => button.textContent?.includes("child/"))!.click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(el.textContent).toContain("b-file");

		resolveTrust({
			evaluation: { canonicalTarget: "/workspace", state: "trusted-root", grantingRoot: "/workspace" },
			settings: {},
			addedRoot: "/workspace",
		});
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain("b-file");
		expect(el.textContent).toContain("Nested context is untrusted");
	});

	it("files explains and removes an exact or inherited granting root", async () => {
		vi.mocked(api.listFiles).mockResolvedValue({
			path: "/workspace/child",
			entries: [],
			contextTrust: {
				canonicalTarget: "/workspace/child",
				state: "trusted-root",
				grantingRoot: "/workspace",
			},
		});
		const store = makeStore();
		const el = mount(() => <FilesScreen store={store} initialPath="/workspace/child" />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain("Nested context inherited from a trusted root");
		expect(el.textContent).toContain("covered by /workspace and its descendants");
		expect(el.textContent).toContain("This removes trust from /workspace and all of its descendants");
		const untrust = [...el.querySelectorAll("button")].find((button) => button.textContent === "untrust /workspace")!;
		untrust.click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.untrustContextFolder).toHaveBeenCalledWith("/workspace/child");
		expect(el.textContent).toContain("Nested context is untrusted");
	});

	it("files explains exact-root untrust scope", async () => {
		vi.mocked(api.listFiles).mockResolvedValue({
			path: "/workspace",
			entries: [],
			contextTrust: { canonicalTarget: "/workspace", state: "trusted-root", grantingRoot: "/workspace" },
		});
		const store = makeStore();
		const el = mount(() => <FilesScreen store={store} initialPath="/workspace" />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain("Nested context trusted for this folder");
		expect(el.textContent).toContain("/workspace and all descendants are trusted");
		expect(el.textContent).toContain("This removes trust from /workspace and all of its descendants");
	});

	it("files never offers a false untrust under global expert trust", async () => {
		vi.mocked(api.listFiles).mockResolvedValue({
			path: "/workspace",
			entries: [],
			contextTrust: { canonicalTarget: "/workspace", state: "unrestricted" },
		});
		const store = makeStore();
		const el = mount(() => <FilesScreen store={store} initialPath="/workspace" />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain("Global expert trust is ON");
		expect(el.textContent).toContain("prompt-injection content");
		expect(el.textContent).toContain("Disable global expert trust in Settings");
		expect([...el.querySelectorAll("button")].some((button) => button.textContent?.startsWith("untrust"))).toBe(
			false,
		);
	});

	it("files refetches trust on navigation and surfaces trust mutation errors", async () => {
		vi.mocked(api.listFiles).mockImplementation(async (path: string) => ({
			path,
			entries:
				path === "/workspace" ? [{ name: "child", type: "dir", size: 0, modified: new Date().toISOString() }] : [],
			contextTrust:
				path === "/workspace"
					? { canonicalTarget: path, state: "untrusted" as const }
					: { canonicalTarget: path, state: "trusted-root" as const, grantingRoot: path },
		}));
		const store = makeStore();
		const el = mount(() => <FilesScreen store={store} initialPath="/workspace" />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const child = [...el.querySelectorAll("button")].find((button) => button.textContent?.includes("child/"))!;
		child.click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.listFiles).toHaveBeenLastCalledWith("/workspace/child");
		expect(el.textContent).toContain("Nested context trusted for this folder");

		vi.mocked(api.untrustContextFolder).mockRejectedValueOnce(new Error("trust write failed"));
		const untrust = [...el.querySelectorAll("button")].find(
			(button) => button.textContent === "untrust /workspace/child",
		)!;
		untrust.click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(el.textContent).toContain("trust write failed");
	});

	it("settings explains defaults and live-session context trust", async () => {
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(el.textContent).toContain("Ordinary defaults apply only to new sessions");
		expect(el.textContent).toContain("Context trust changes apply to subsequent lazy loads in live sessions");
		expect(el.textContent).toContain("already injected content cannot be retracted");
		expect(el.textContent).toContain("default model");
		expect(el.textContent).toContain("devices");
	});

	it("settings reports an initial durable-load failure", async () => {
		vi.mocked(api.settings).mockRejectedValueOnce(new Error("settings file contains malformed JSON"));
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.querySelector(".settings-error")?.textContent).toContain("settings file contains malformed JSON");
		expect(el.textContent).toContain("Settings could not be loaded — see the error above.");
	});

	it("settings defaults global expert context trust to off and warns about prompt injection", async () => {
		vi.mocked(api.settings).mockResolvedValue({});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		const row = [...el.querySelectorAll(".setting-row")].find((candidate) =>
			candidate.textContent?.includes("global expert nested-context trust"),
		)!;
		expect((row.querySelector("select") as HTMLSelectElement).value).toBe("off");
		expect(el.textContent).toContain("Expert global override");
		expect(el.textContent).toContain(".dreb/settings.json cannot enable, disable, or extend nested-context trust");
		expect(el.textContent).toContain("cloned repository cannot grant itself trust");
		expect(el.textContent).toContain("untrusted prompt-injection content");
	});

	it("settings lists trusted context folders and revokes a selected configured root", async () => {
		vi.mocked(api.removeTrustedContextFolder).mockClear();
		vi.mocked(api.untrustContextFolder).mockClear();
		vi.mocked(api.settings).mockResolvedValue({
			trustedContextFolders: ["/workspace/controlled", "/workspace/other"],
		});
		vi.mocked(api.removeTrustedContextFolder).mockResolvedValueOnce({
			settings: { trustedContextFolders: ["/workspace/other"] },
			removedFolder: "/workspace/controlled",
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain("/workspace/controlled");
		expect(el.textContent).toContain("/workspace/other");
		const revoke = [...el.querySelectorAll("button")].find((button) => button.textContent === "revoke trust")!;
		revoke.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.removeTrustedContextFolder).toHaveBeenCalledWith("/workspace/controlled");
		expect(api.untrustContextFolder).not.toHaveBeenCalled();
		expect(el.textContent).not.toContain("/workspace/controlled");
		expect(el.textContent).toContain("/workspace/other");
	});

	it("settings revokes stale configured trusted folders without resolving them", async () => {
		vi.mocked(api.removeTrustedContextFolder).mockClear();
		vi.mocked(api.untrustContextFolder).mockClear();
		vi.mocked(api.settings).mockResolvedValue({ trustedContextFolders: ["relative/legacy", "/workspace/other"] });
		vi.mocked(api.removeTrustedContextFolder).mockResolvedValueOnce({
			settings: { trustedContextFolders: ["/workspace/other"] },
			removedFolder: "relative/legacy",
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain("relative/legacy");
		const staleRow = [...el.querySelectorAll(".trusted-context-folder-row")].find((row) =>
			row.textContent?.includes("relative/legacy"),
		)!;
		(staleRow.querySelector("button") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.removeTrustedContextFolder).toHaveBeenCalledWith("relative/legacy");
		expect(api.untrustContextFolder).not.toHaveBeenCalled();
		expect(el.textContent).not.toContain("relative/legacy");
		expect(el.textContent).toContain("/workspace/other");
	});

	it("settings revokes configured roots while global expert context trust is on", async () => {
		vi.mocked(api.removeTrustedContextFolder).mockClear();
		vi.mocked(api.untrustContextFolder).mockClear();
		vi.mocked(api.settings).mockResolvedValue({
			autoLoadNestedContext: true,
			trustedContextFolders: ["/workspace/controlled"],
		});
		vi.mocked(api.removeTrustedContextFolder).mockResolvedValueOnce({
			settings: { autoLoadNestedContext: true, trustedContextFolders: [] },
			removedFolder: "/workspace/controlled",
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		[...el.querySelectorAll("button")].find((button) => button.textContent === "revoke trust")!.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.removeTrustedContextFolder).toHaveBeenCalledWith("/workspace/controlled");
		expect(api.untrustContextFolder).not.toHaveBeenCalled();
		expect(el.textContent).not.toContain("/workspace/controlled");
	});

	it("settings shows the trusted-context empty state", async () => {
		vi.mocked(api.settings).mockResolvedValue({ trustedContextFolders: [] });
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain(
			"No trusted folders. Use the Files view to trust a project folder and its descendants.",
		);
	});

	it("settings surfaces a trusted-context revoke error without mutating the list", async () => {
		vi.mocked(api.settings).mockResolvedValue({ trustedContextFolders: ["/workspace/controlled"] });
		vi.mocked(api.removeTrustedContextFolder).mockRejectedValueOnce(new Error("trust write failed"));
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		[...el.querySelectorAll("button")].find((button) => button.textContent === "revoke trust")!.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain("trust write failed");
		expect(el.textContent).toContain("/workspace/controlled");
		expect(el.textContent).not.toContain(
			"No trusted folders. Use the Files view to trust a project folder and its descendants.",
		);
		const revoke = [...el.querySelectorAll("button")].find((button) => button.textContent === "revoke trust")!;
		expect(revoke.disabled).toBe(false);
	});

	it("settings trusts a folder added by path", async () => {
		vi.mocked(api.trustContextFolder).mockResolvedValueOnce({
			evaluation: {
				canonicalTarget: "/workspace/controlled",
				state: "trusted-root",
				grantingRoot: "/workspace/controlled",
			},
			settings: { trustedContextFolders: ["/workspace/controlled"] },
			addedRoot: "/workspace/controlled",
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		const input = el.querySelector("#trusted-context-folder-path") as HTMLInputElement;
		input.value = "/workspace/controlled";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		(input.closest("form") as HTMLFormElement).dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.trustContextFolder).toHaveBeenCalledWith("/workspace/controlled");
		expect(el.textContent).toContain("/workspace/controlled");
	});

	it("settings keeps the add-by-path form stable when trusting a folder fails", async () => {
		vi.mocked(api.settings).mockResolvedValue({ trustedContextFolders: [] });
		vi.mocked(api.trustContextFolder).mockRejectedValueOnce(new Error("path must be an existing directory"));
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		const input = el.querySelector("#trusted-context-folder-path") as HTMLInputElement;
		input.value = "/workspace/missing";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		(input.closest("form") as HTMLFormElement).dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain("path must be an existing directory");
		expect(el.textContent).toContain(
			"No trusted folders. Use the Files view to trust a project folder and its descendants.",
		);
		expect(input.value).toBe("/workspace/missing");
		const submit = [...el.querySelectorAll("button")].find((button) => button.textContent === "trust folder")!;
		expect(submit.disabled).toBe(false);
	});

	it("settings shows the trusted-context empty state after revoking the final root", async () => {
		vi.mocked(api.settings).mockResolvedValue({ trustedContextFolders: ["/workspace/controlled"] });
		vi.mocked(api.removeTrustedContextFolder).mockResolvedValueOnce({
			settings: { trustedContextFolders: [] },
			removedFolder: "/workspace/controlled",
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		[...el.querySelectorAll("button")].find((button) => button.textContent === "revoke trust")!.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).not.toContain("/workspace/controlled");
		expect(el.textContent).toContain(
			"No trusted folders. Use the Files view to trust a project folder and its descendants.",
		);
	});

	it("settings renders expanded default rows and agent model defaults", async () => {
		vi.mocked(api.agentTypes).mockResolvedValue({
			agentTypes: [{ name: "Explore", description: "Explore the codebase" }],
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain("auto-resize images");
		expect(el.textContent).toContain("block images");
		expect(el.textContent).toContain("skill slash commands");
		expect(el.textContent).toContain("global expert nested-context trust");
		expect(el.textContent).toContain("hide thinking blocks");
		expect(el.textContent).toContain("transport");
		expect(el.textContent).toContain("agent models");
		expect(el.textContent).toContain("Explore");
		expect(el.textContent).toContain("default");
		expect(el.textContent).toContain("TUI-only settings");
	});

	const runtimeAt = (key: string, cwd: string) => ({
		key,
		cwd,
		state: {
			sessionId: key,
			thinkingLevel: "off" as const,
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all" as const,
			followUpMode: "all" as const,
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		},
		backgroundAgents: [],
		needsAttention: false,
		createdAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
	});

	const agentContextOptionTexts = async (cwds: string[]): Promise<string[]> => {
		vi.mocked(api.fleet).mockResolvedValue({
			runtimes: cwds.map((cwd, index) => runtimeAt(`k${index}`, cwd)),
			diskSessions: [],
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await store.refreshFleet();
		await new Promise((resolve) => setTimeout(resolve, 10));
		return [...el.querySelectorAll(".agent-context-row select option")].map((option) => option.textContent ?? "");
	};

	// Order-free multi-root assertion: localeCompare collation of mixed-case
	// prefixes is ICU-dependent, so only membership (plus exact count) is pinned.
	const expectAgentContextOptions = async (cwds: string[], expected: string[]) => {
		const options = await agentContextOptionTexts(cwds);
		expect(options).toHaveLength(expected.length + 1);
		expect(options[0]).toBe("global/home only");
		expect(options.slice(1)).toEqual(expect.arrayContaining(expected));
	};

	it("settings agent context select renders home-relative options with full-path values and tooltip", async () => {
		vi.mocked(api.fleet).mockResolvedValue({
			runtimes: [
				runtimeAt("a", "/home/test/project-beta"),
				runtimeAt("b", "/home/test/project-alpha"),
				runtimeAt("c", "/opt/shared"),
			],
			diskSessions: [],
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await store.refreshFleet();
		await new Promise((resolve) => setTimeout(resolve, 10));

		const select = el.querySelector<HTMLSelectElement>(".agent-context-row select")!;
		expect(select).toBeTruthy();
		const options = [...select.querySelectorAll("option")];
		// Sorted by full cwd; display text is home-relative, values stay absolute.
		expect(options.map((option) => option.textContent)).toEqual([
			"global/home only",
			"~/project-alpha",
			"~/project-beta",
			"/opt/shared",
		]);
		expect(options.map((option) => option.value)).toEqual([
			"",
			"/home/test/project-alpha",
			"/home/test/project-beta",
			"/opt/shared",
		]);
		// Tooltip exposes the full path of the current selection.
		expect(select.getAttribute("title")).toBe("global/home only");
		select.value = "/home/test/project-alpha";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(select.getAttribute("title")).toBe("/home/test/project-alpha");
	});

	it("settings agent context select disambiguates multiple home prefixes as ~user", async () => {
		expect(await agentContextOptionTexts(["/home/alice/x", "/home/bob/y"])).toEqual([
			"global/home only",
			"~alice/x",
			"~bob/y",
		]);
	});

	it("settings agent context select collapses /root and /Users home prefixes", async () => {
		// Single-home cases collapse to ~/… exactly like /home does.
		expect(await agentContextOptionTexts(["/root/project"])).toEqual(["global/home only", "~/project"]);
		expect(await agentContextOptionTexts(["/root"])).toEqual(["global/home only", "~"]);
		expect(await agentContextOptionTexts(["/Users/alice/tools"])).toEqual(["global/home only", "~/tools"]);
		// Mixed home roots disambiguate every root as ~user/… (order assertion-free:
		// localeCompare collation of mixed-case prefixes is ICU-dependent).
		const mixed = await agentContextOptionTexts(["/root/a", "/home/bob/b", "/Users/carol/c"]);
		expect(mixed).toHaveLength(4);
		expect(mixed[0]).toBe("global/home only");
		expect(mixed.slice(1)).toEqual(expect.arrayContaining(["~root/a", "~bob/b", "~carol/c"]));
	});

	it("settings agent context select namespace-qualifies colliding home labels", async () => {
		// Same-OS collision: /root and /home/root share the alias "root".
		await expectAgentContextOptions(["/root/project", "/home/root/project"], ["~root/project", "~home/root/project"]);

		// Cross-namespace same-username collision: /home/alice vs /Users/alice.
		await expectAgentContextOptions(["/home/alice/x", "/Users/alice/x"], ["~home/alice/x", "~Users/alice/x"]);

		// Distinct usernames across namespaces stay short — no qualification.
		await expectAgentContextOptions(["/home/alice/x", "/Users/bob/y"], ["~alice/x", "~bob/y"]);

		// The special root alias against the generic Users path.
		await expectAgentContextOptions(["/root/x", "/Users/root/x"], ["~root/x", "~Users/root/x"]);

		// Three-way collision: every label stays unique.
		await expectAgentContextOptions(
			["/root/p", "/home/root/p", "/Users/root/p"],
			["~root/p", "~home/root/p", "~Users/root/p"],
		);

		// Selective qualification: only colliding aliases qualify; non-colliders stay short.
		await expectAgentContextOptions(
			["/home/alice/x", "/Users/alice/x", "/home/bob/y"],
			["~home/alice/x", "~Users/alice/x", "~bob/y"],
		);
	});

	it("settings agent context selection resets to global when its cwd leaves the fleet", async () => {
		vi.mocked(api.fleet).mockResolvedValue({
			runtimes: [runtimeAt("a", "/home/test/project-alpha"), runtimeAt("b", "/home/test/project-beta")],
			diskSessions: [],
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await store.refreshFleet();
		await new Promise((resolve) => setTimeout(resolve, 10));

		const select = el.querySelector<HTMLSelectElement>(".agent-context-row select")!;
		select.value = "/home/test/project-alpha";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(select.getAttribute("title")).toBe("/home/test/project-alpha");
		expect(vi.mocked(api.agentTypes).mock.lastCall?.[0]).toBe("/home/test/project-alpha");

		// The selected project disappears from the fleet: the select, tooltip,
		// and agentTypes context must all fall back to global rather than go stale.
		vi.mocked(api.fleet).mockResolvedValue({
			runtimes: [runtimeAt("b", "/home/test/project-beta")],
			diskSessions: [],
		});
		await store.refreshFleet();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(select.value).toBe("");
		expect(select.getAttribute("title")).toBe("global/home only");
		expect(vi.mocked(api.agentTypes).mock.lastCall?.[0]).toBeUndefined();
	});

	it("settings rows keep the structure the browser layout harness mirrors", async () => {
		// settings-layout.browser.test.ts measures a static fixture of this markup.
		// If any selector asserted here drifts in production, update that harness too.
		vi.mocked(api.fleet).mockResolvedValue({
			runtimes: [runtimeAt("a", "/home/test/project")],
			diskSessions: [],
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await store.refreshFleet();
		await new Promise((resolve) => setTimeout(resolve, 10));

		const row = el.querySelector(".setting-row.agent-context-row")!;
		expect(row.querySelector(".setting-label .name")).toBeTruthy();
		expect(row.querySelector(".setting-label .hint")).toBeTruthy();
		expect(row.querySelector(".setting-control select[title]")).toBeTruthy();
		// Short-control rows (other selects) and checkbox rows share the same
		// .setting-row/.setting-control structure the harness exercises.
		expect(el.querySelectorAll(".setting-row .setting-control select").length).toBeGreaterThan(1);
		expect(el.querySelector(".setting-control .checkbox-control input[type=checkbox]")).toBeTruthy();
	});

	it("pairing renders the PIN flow with both security copy blocks", () => {
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			auth: () => ({ mode: "remote", needsPairing: true, identity: "alice@example.com" }),
		};
		const el = mount(() => <PairingScreen store={fakeStore} />);
		expect(el.textContent).toContain("pair this device");
		expect(el.textContent).toContain("Why a PIN?");
		expect(el.textContent).toContain("What pairing grants");
		expect(el.textContent).toContain("alice@example.com");
	});

	it("pairing submits a 6-digit PIN and returns to fleet", async () => {
		vi.mocked(api.pair).mockClear();
		const store = makeStore() as any;
		const start = vi.fn(async () => {});
		const navigate = vi.fn();
		const fakeStore = {
			...store,
			start,
			navigate,
			auth: () => ({ mode: "remote", needsPairing: true, identity: "alice@example.com" }),
		};
		const el = mount(() => <PairingScreen store={fakeStore} />);
		const input = el.querySelector("#pairing-pin") as HTMLInputElement;
		input.value = "123456";
		input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		(el.querySelector(".pair-actions .btn") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.pair).toHaveBeenCalledWith("123456");
		expect(start).toHaveBeenCalled();
		expect(navigate).toHaveBeenCalledWith({ screen: "fleet" });
	});

	it("pairing shows an error when the PIN is rejected", async () => {
		vi.mocked(api.pair).mockRejectedValueOnce(new Error("Incorrect pairing code"));
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			start: vi.fn(async () => {}),
			navigate: vi.fn(),
			auth: () => ({ mode: "remote", needsPairing: true, identity: "alice@example.com" }),
		};
		const el = mount(() => <PairingScreen store={fakeStore} />);
		const input = el.querySelector("#pairing-pin") as HTMLInputElement;
		input.value = "000000";
		input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		(el.querySelector(".pair-actions .btn") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.querySelector(".pair-error")?.textContent).toContain("Incorrect pairing code");
		expect(fakeStore.start).not.toHaveBeenCalled();
	});

	it("pairing does not submit from the mobile Enter key", () => {
		stubMobile(true);
		vi.mocked(api.pair).mockClear();
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			auth: () => ({ mode: "remote", needsPairing: true, identity: "alice@example.com" }),
		};
		const el = mount(() => <PairingScreen store={fakeStore} />);
		const input = el.querySelector("#pairing-pin") as HTMLInputElement;
		input.value = "123456";
		input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(api.pair).not.toHaveBeenCalled();
	});
});

describe("dashboard client regressions", () => {
	it("renders every connection state and exposes the failed recovery retry", async () => {
		let handlers: EventStreamHandlers | undefined;
		vi.mocked(connectEvents).mockImplementation((next) => {
			handlers = next;
			return () => {};
		});
		const store = makeStore();
		const el = mount(() => <ConnectionIndicator store={store} />);
		await store.start();
		if (!handlers) throw new Error("event handlers were not registered");

		const states = [
			["connected", "live"],
			["connecting", "connecting"],
			["retrying", "retrying in 2s"],
			["resyncing", "recovering live state"],
			["auth_failed", "live connection unauthorized"],
			["disconnected", "live connection disconnected"],
		] as const;
		for (const [state, text] of states) {
			handlers.onStatusChange?.({ state, attempt: 1, retryDelayMs: state === "retrying" ? 1_500 : undefined });
			expect(el.textContent).toContain(text);
		}

		vi.mocked(api.resync).mockRejectedValueOnce(new Error("snapshot unavailable"));
		handlers.onEnvelope({ seq: 1, key: "", event: { type: "dashboard_resync", reason: "buffer_gap" } });
		await Promise.resolve();
		await Promise.resolve();
		expect(el.textContent).toContain("retrying in 1s");
		expect(el.textContent).not.toContain("recovering live state");
		const retry = [...el.querySelectorAll("button")].find((button) => button.textContent?.includes("retry"));
		expect(retry?.textContent).toContain("recovery failed — retry");
		vi.mocked(api.resync).mockResolvedValueOnce({ fleet: { runtimes: [], diskSessions: [] }, barrierSeq: 1 });
		const callsBeforeRetry = vi.mocked(api.resync).mock.calls.length;
		retry?.click();
		await Promise.resolve();
		expect(api.resync).toHaveBeenCalledTimes(callsBeforeRetry + 1);
	});

	it("routes denied identities to the pairing denial screen without starting fleet or SSE", async () => {
		vi.mocked(api.auth).mockRejectedValueOnce(
			Object.assign(new Error('Tailscale identity "mallory@example.com" is not on the dashboard allowlist'), {
				status: 403,
				body: { needsPairing: false, identity: "mallory@example.com" },
			}),
		);
		vi.mocked(api.fleet).mockClear();
		vi.mocked(connectEvents).mockClear();
		const store = makeStore();

		await store.start();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(window.location.hash).toBe("#/pairing");
		expect(store.auth()).toMatchObject({
			needsPairing: false,
			identity: "mallory@example.com",
			error: expect.stringContaining("mallory@example.com"),
		});
		expect(api.fleet).not.toHaveBeenCalled();
		expect(connectEvents).not.toHaveBeenCalled();
	});

	it("formats token counts like the TUI footer", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1200)).toBe("1.2k");
		expect(formatTokens(45000)).toBe("45k");
		expect(formatTokens(1_200_000)).toBe("1.2M");
		expect(formatTokens(12_000_000)).toBe("12M");
	});

	it("transcript render item wrappers stay stable for unchanged rows", () => {
		const entries: Parameters<typeof transcriptRenderItems>[0] = [
			{ kind: "user", text: "first prompt" },
			{ kind: "assistant", blocks: [{ kind: "text", text: "I'll inspect" }], streaming: true },
			{
				kind: "tool",
				toolCallId: "t1",
				toolName: "read",
				args: { path: "/x" },
				status: "done",
				resultText: "body",
				startedAt: Date.now(),
			},
			{ kind: "user", text: "second prompt" },
			{ kind: "assistant", blocks: [{ kind: "text", text: "working" }], streaming: true },
		];
		const firstItems = transcriptRenderItems(entries);

		entries.push({
			kind: "tool",
			toolCallId: "t2",
			toolName: "bash",
			args: { command: "pwd" },
			status: "running",
			resultText: "",
			startedAt: Date.now(),
		});
		const nextItems = transcriptRenderItems(entries, firstItems);

		expect(nextItems).toHaveLength(firstItems.length);
		expect(nextItems[0]).toBe(firstItems[0]);
		expect(nextItems[1]).toBe(firstItems[1]);
		expect(nextItems[2]).toBe(firstItems[2]);
		// Appending a tool to the ACTIVE assistant turn must keep the turn item —
		// and therefore its rendered wrapper DOM — stable. Recreating the wrapper
		// tears down and re-renders the assistant markdown, a reflow that lowers
		// scrollTop at the assistant→tool boundary.
		expect(nextItems[3]).toBe(firstItems[3]);
		const turn = nextItems[3] as Extract<TranscriptRenderItem, { kind: "assistant-turn" }>;
		expect(turn.kind).toBe("assistant-turn");
		expect(turn.entries()).toEqual([entries[4], entries[5]]);
	});

	it("appending a tool keeps the rendered assistant-turn DOM node stable (no destroy/recreate reflow)", async () => {
		const assistant = {
			kind: "assistant" as const,
			blocks: [{ kind: "text" as const, text: "long analysis" }],
			streaming: false,
		};
		const [entries, setEntries] = createSignal<Parameters<typeof transcriptRenderItems>[0]>([assistant]);
		const el = mount(() => <Transcript entries={entries()} />);
		const turnBefore = el.querySelector('[data-testid="assistant-turn"]');
		expect(turnBefore).not.toBeNull();
		const markdownBefore = turnBefore?.querySelector(".entry-body");

		setEntries([
			assistant,
			{
				kind: "tool",
				toolCallId: "t-append",
				toolName: "bash",
				args: { command: "pwd" },
				status: "running",
				resultText: "",
				startedAt: Date.now(),
			},
		]);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const turnAfter = el.querySelector('[data-testid="assistant-turn"]');
		// SAME DOM nodes — the wrapper and the already-rendered assistant markdown
		// were not torn down when the tool card was appended.
		expect(turnAfter).toBe(turnBefore);
		expect(turnAfter?.querySelector(".entry-body")).toBe(markdownBefore);
		// …and the tool card actually rendered inside the same wrapper.
		expect(turnAfter?.querySelector(".tool")).not.toBeNull();
	});

	it("tool card bodies mount lazily and running tools stay mounted", () => {
		const doneTool: ToolEntry = {
			kind: "tool",
			toolCallId: "search-done",
			toolName: "web_search",
			args: { query: "solid details lazy body" },
			status: "done",
			resultText: "finished result body",
			startedAt: Date.now(),
		};
		const runningTool: ToolEntry = {
			kind: "tool",
			toolCallId: "search-running",
			toolName: "web_search",
			args: { query: "streaming" },
			status: "running",
			resultText: "partial result body",
			startedAt: Date.now(),
		};
		const el = mount(() => <Transcript entries={[doneTool, runningTool]} />);
		const tools = el.querySelectorAll("details.tool") as NodeListOf<HTMLDetailsElement>;

		expect(tools[0]?.open).toBe(false);
		expect(tools[0]?.querySelector(".tool-result")).toBeNull();
		expect(tools[1]?.open).toBe(true);
		expect(tools[1]?.querySelector(".tool-result")?.textContent).toContain("partial result body");

		setDetailsOpen(tools[0]!, true);
		expect(tools[0]?.querySelector(".tool-result")?.textContent).toContain("finished result body");

		setDetailsOpen(tools[0]!, false);
		expect(tools[0]?.querySelector(".tool-result")).toBeNull();
	});

	it("keeps running non-auto-open tool cards open when the user tries to close them", () => {
		const runningTool: ToolEntry = {
			kind: "tool",
			toolCallId: "search-running-lock",
			toolName: "web_search",
			args: { query: "streaming" },
			status: "running",
			resultText: "partial result body",
			startedAt: Date.now(),
		};
		const el = mount(() => <Transcript entries={[runningTool]} />);
		const tool = el.querySelector("details.tool") as HTMLDetailsElement;

		expect(tool.open).toBe(true);
		setDetailsOpen(tool, false);

		expect(tool.open).toBe(true);
		expect(tool.querySelector(".tool-result")?.textContent).toContain("partial result body");
	});

	it("collapses a running non-auto-open tool back to its completed default", async () => {
		const [entries, setEntries] = createStore<ToolEntry[]>([
			{
				kind: "tool",
				toolCallId: "search-running-done",
				toolName: "web_search",
				args: { query: "streaming" },
				status: "running",
				resultText: "partial result body",
				startedAt: Date.now(),
			},
		]);
		const el = mount(() => <Transcript entries={entries} />);
		const tool = el.querySelector("details.tool") as HTMLDetailsElement;
		expect(tool.open).toBe(true);

		setEntries(0, "status", "done");
		setEntries(0, "resultText", "finished result body");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(tool.open).toBe(false);
		expect(tool.querySelector(".tool-result")).toBeNull();
	});

	it("preserves a user's open choice for a completed non-auto-open tool across entry updates", async () => {
		const [entries, setEntries] = createStore<ToolEntry[]>([
			{
				kind: "tool",
				toolCallId: "search-user-open",
				toolName: "web_search",
				args: { query: "done" },
				status: "done",
				resultText: "initial result body",
				startedAt: Date.now(),
			},
		]);
		const el = mount(() => <Transcript entries={entries} />);
		const tool = el.querySelector("details.tool") as HTMLDetailsElement;
		expect(tool.open).toBe(false);

		setDetailsOpen(tool, true);
		expect(tool.open).toBe(true);
		setEntries(0, "resultText", "updated result body");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(tool.open).toBe(true);
		expect(tool.querySelector(".tool-result")?.textContent).toContain("updated result body");
	});

	it("transcript windows long histories with a show-earlier affordance", () => {
		const longEntries: TranscriptEntry[] = Array.from({ length: TRANSCRIPT_WINDOW_SIZE + 1 }, (_, index) => ({
			kind: "user",
			text: `entry-${index.toString().padStart(3, "0")}`,
		}));
		const longEl = mount(() => <Transcript entries={longEntries} />);

		expect(longEl.querySelectorAll(".entry.user")).toHaveLength(TRANSCRIPT_WINDOW_SIZE);
		expect(longEl.textContent).not.toContain("entry-000");
		expect(longEl.textContent).toContain(`entry-${TRANSCRIPT_WINDOW_SIZE.toString().padStart(3, "0")}`);
		const showEarlier = longEl.querySelector(".transcript-window-control button") as HTMLButtonElement;
		expect(showEarlier?.textContent).toContain("show earlier");

		showEarlier.click();
		expect(longEl.querySelectorAll(".entry.user")).toHaveLength(TRANSCRIPT_WINDOW_SIZE + 1);
		expect(longEl.textContent).toContain("entry-000");
		expect(longEl.querySelector(".transcript-window-control button")).toBeNull();

		const shortEntries: TranscriptEntry[] = Array.from({ length: TRANSCRIPT_WINDOW_SIZE }, (_, index) => ({
			kind: "user",
			text: `short-${index.toString().padStart(3, "0")}`,
		}));
		const shortEl = mount(() => <Transcript entries={shortEntries} />);
		expect(shortEl.querySelectorAll(".entry.user")).toHaveLength(TRANSCRIPT_WINDOW_SIZE);
		expect(shortEl.querySelector(".transcript-window-control button")).toBeNull();
	});

	it("throttles streaming assistant markdown and flushes the final complete text", async () => {
		vi.useFakeTimers();
		const parseSpy = vi.spyOn(marked, "parse");
		const [entries, setEntries] = createStore<TranscriptEntry[]>([
			{ kind: "assistant", blocks: [{ kind: "text", text: "start" }], streaming: true },
		]);
		const el = mount(() => <Transcript entries={entries} />);
		const afterMountCalls = parseSpy.mock.calls.length;

		setEntries(0, "blocks", 0, "text", "start **one**");
		setEntries(0, "blocks", 0, "text", "start **two**");
		setEntries(0, "blocks", 0, "text", "start **three**");
		expect(parseSpy.mock.calls.length).toBe(afterMountCalls);

		await vi.advanceTimersByTimeAsync(149);
		expect(parseSpy.mock.calls.length).toBe(afterMountCalls);
		await vi.advanceTimersByTimeAsync(1);
		expect(parseSpy.mock.calls.length).toBe(afterMountCalls + 1);
		expect(el.querySelector("strong")?.textContent).toBe("three");

		setEntries(0, "blocks", 0, "text", "final **complete** text");
		setEntries(0, "streaming", false);
		expect(parseSpy.mock.calls.length).toBe(afterMountCalls + 2);
		expect(el.querySelector("strong")?.textContent).toBe("complete");
		expect(el.textContent).toContain("final complete text");
	});

	it("truncates oversized tool results until the user opts into full output", () => {
		const fullText = `START-${"x".repeat(205 * 1024)}-TAIL`;
		const read: ToolEntry = {
			kind: "tool",
			toolCallId: "read-big",
			toolName: "read",
			args: { path: "/tmp/big.txt" },
			status: "done",
			resultText: fullText,
			startedAt: Date.now(),
		};
		const el = mount(() => <Transcript entries={[read]} />);

		expect(el.querySelector(".tool-output-truncated")?.textContent).toContain("output truncated");
		expect(el.textContent).toContain("-TAIL");
		expect(el.textContent).not.toContain("START-");

		(el.querySelector(".tool-output-truncated button") as HTMLButtonElement).click();
		expect(el.textContent).toContain("START-");
		expect(el.querySelector(".tool-output-truncated")).toBeNull();
	});

	it("transcript groups assistant turns with following tool cards", () => {
		const el = mount(() => (
			<Transcript
				entries={[
					{ kind: "assistant", blocks: [{ kind: "text", text: "I'll inspect" }], streaming: false },
					{
						kind: "tool",
						toolCallId: "t1",
						toolName: "read",
						args: { path: "/x" },
						status: "done",
						resultText: "body",
						startedAt: Date.now(),
					},
					{ kind: "user", text: "thanks" },
				]}
			/>
		));

		const turns = el.querySelectorAll(".assistant-turn");
		expect(turns).toHaveLength(1);
		expect(turns[0]?.querySelector(".entry.assistant")?.textContent).toContain("I'll inspect");
		expect(turns[0]?.querySelector("details.tool")?.textContent).toContain("read");
		expect(turns[0]?.textContent).not.toContain("thanks");
	});

	it("renders assistant markdown and strips unsafe HTML", () => {
		const htmlComment = ["<", "!--", "provider separator", "--", ">"].join("");
		const el = mount(() => (
			<Transcript
				entries={[
					{
						kind: "assistant",
						blocks: [
							{
								kind: "text",
								text: `**bold**\n\n${htmlComment}\n\nvisible after comment\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n<script>window.evil = true</script>`,
							},
						],
						streaming: false,
					},
				]}
			/>
		));

		expect(el.querySelector("strong")?.textContent).toBe("bold");
		expect(el.textContent).toContain("visible after comment");
		expect(el.querySelector("pre code")?.textContent).toContain("const x = 1");
		expect(el.querySelector("script")).toBeNull();
		expect(el.textContent).not.toContain(htmlComment);
	});

	it("renders background-agent results as collapsed markdown cards, not user messages", () => {
		const el = mount(() => (
			<Transcript
				entries={[
					{
						kind: "agent-result",
						header: "Background agent bg1 (Explore) completed.",
						text: "**complete**",
						raw: "raw",
					},
				]}
			/>
		));

		const card = el.querySelector(".agent-result-card");
		const details = card?.querySelector("details") as HTMLDetailsElement | null;
		expect(card?.textContent).toContain("background agent result");
		expect(card?.textContent).toContain("Background agent bg1 (Explore) completed.");
		expect(card?.querySelector("strong")?.textContent).toBe("complete");
		expect(details?.open).toBe(false);
		expect(card?.textContent).not.toContain("you");
	});

	it("transcript honors the always-expand-thinking browser preference", () => {
		setExpandThinking(true);
		const el = mount(() => (
			<Transcript
				entries={[{ kind: "assistant", blocks: [{ kind: "thinking", text: "ponder" }], streaming: false }]}
			/>
		));

		expect((el.querySelector("details.thinking") as HTMLDetailsElement | null)?.open).toBe(true);
	});

	it("transcript renders thinking markdown and hides HTML-comment separators", () => {
		const htmlComment = ["<", "!--", "provider separator", "--", ">"].join("");
		const el = mount(() => (
			<Transcript
				entries={[
					{
						kind: "assistant",
						blocks: [{ kind: "thinking", text: `**Before**\n\n${htmlComment}\n\nafter` }],
						streaming: false,
					},
				]}
			/>
		));

		const body = el.querySelector(".thinking-body");
		expect(body?.querySelector("strong")?.textContent).toBe("Before");
		expect(body?.textContent?.replace(/\n{2,}/g, "\n\n")).toBe("Before\n\nafter\n");
		expect(body?.textContent).not.toContain(htmlComment);
	});

	it("settings toggles the browser-local expand-thinking preference", async () => {
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const checkbox = el.querySelector("#pref-expand-thinking") as HTMLInputElement | null;
		expect(checkbox).not.toBeNull();
		expect(window.localStorage.getItem("dreb.dashboard.expandThinking")).toBeNull();

		checkbox!.click();

		expect(window.localStorage.getItem("dreb.dashboard.expandThinking")).toBe("true");
		expect(checkbox!.checked).toBe(true);
	});

	describe("settings appearance (theme gallery)", () => {
		// The appearance state is a module-level singleton driven by localStorage,
		// so reset both storage and the signals/DOM between cases.
		function resetAppearance() {
			window.localStorage.removeItem(THEME_STORAGE_KEY);
			window.localStorage.removeItem(COLOR_MODE_STORAGE_KEY);
			__resetAppearanceForTests();
			reloadAppearance(); // re-reads (now-empty) storage → removes the <html> attrs
		}

		beforeEach(resetAppearance);
		afterEach(resetAppearance);

		it("renders the mode selector and theme cards even when settings fails to load", async () => {
			// The appearance controls live in the dashboard section, OUTSIDE the
			// server-settings <Show> boundary — so a rejected api.settings() must not
			// hide them.
			vi.mocked(api.settings).mockRejectedValue(new Error("settings unavailable"));
			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(el.querySelector("#pref-color-mode")).not.toBeNull();
			expect(el.querySelectorAll("[data-theme-card]").length).toBe(8);
			expect(el.querySelector('[data-theme-card="default"]')).not.toBeNull();
			expect(el.querySelector('[data-theme-card="gruvbox"]')).not.toBeNull();
			expect(el.querySelector('[data-theme-card="qud"]')).not.toBeNull();
			expect(el.querySelector('[data-theme-card="vangogh"]')).not.toBeNull();
			expect(el.querySelector('[data-theme-card="okabe"]')).not.toBeNull();
			expect(el.querySelector('[data-theme-card="tol"]')).not.toBeNull();
		});

		it("every rendered card carries a data-theme matching its catalog id", async () => {
			// The gallery's scoped-preview contract requires data-theme on each card
			// so themes.css resolves that theme's palette locally, independent of :root.
			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const cards = Array.from(el.querySelectorAll("[data-theme-card]"));
			expect(cards.length).toBe(8);
			for (const card of cards) {
				const cardId = card.getAttribute("data-theme-card");
				expect(card.getAttribute("data-theme"), `card ${cardId} must have data-theme`).toBe(cardId);
			}
		});

		it("marks the restored theme card active and selects the restored color mode", async () => {
			window.localStorage.setItem(THEME_STORAGE_KEY, "solarized");
			window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, "dark");
			reloadAppearance();
			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const card = el.querySelector('[data-theme-card="solarized"]') as HTMLButtonElement;
			expect(card.classList.contains("active")).toBe(true);
			expect(card.getAttribute("aria-pressed")).toBe("true");
			const select = el.querySelector("#pref-color-mode") as HTMLSelectElement;
			expect(select.value).toBe("dark");
		});

		it("clicking a non-default card sets the documentElement theme attribute and persists it", async () => {
			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(document.documentElement.getAttribute("data-theme")).toBeNull();

			const card = el.querySelector('[data-theme-card="gruvbox"]') as HTMLButtonElement;
			card.click();

			expect(document.documentElement.getAttribute("data-theme")).toBe("gruvbox");
			expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("gruvbox");
			expect(card.classList.contains("active")).toBe(true);
		});

		it("selecting the default theme clears the attribute and storage key", async () => {
			window.localStorage.setItem(THEME_STORAGE_KEY, "dim");
			reloadAppearance();
			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(document.documentElement.getAttribute("data-theme")).toBe("dim");

			const defaultCard = el.querySelector('[data-theme-card="default"]') as HTMLButtonElement;
			defaultCard.click();

			expect(document.documentElement.getAttribute("data-theme")).toBeNull();
			expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
		});

		it("selecting system color mode clears the color-mode attribute and key", async () => {
			window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, "dark");
			reloadAppearance();
			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(document.documentElement.getAttribute("data-color-mode")).toBe("dark");

			const select = el.querySelector("#pref-color-mode") as HTMLSelectElement;
			select.value = "system";
			select.dispatchEvent(new Event("change", { bubbles: true }));

			expect(document.documentElement.getAttribute("data-color-mode")).toBeNull();
			expect(window.localStorage.getItem(COLOR_MODE_STORAGE_KEY)).toBeNull();
		});

		it("reflects a forced color mode onto every preview card's data-color-mode", async () => {
			// Each card carries data-color-mode so its scoped preview renders the
			// SELECTED variant (via themes.css), independent of the active :root.
			window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, "dark");
			reloadAppearance();
			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const cards = Array.from(el.querySelectorAll("[data-theme-card]"));
			expect(cards.length).toBe(8);
			for (const card of cards) {
				expect(card.getAttribute("data-color-mode")).toBe("dark");
			}
		});

		it("omits data-color-mode on preview cards in system mode", async () => {
			// system is the default (no stored key), so previews follow the OS and
			// must NOT carry data-color-mode.
			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const cards = Array.from(el.querySelectorAll("[data-theme-card]"));
			expect(cards.length).toBe(8);
			for (const card of cards) {
				expect(card.hasAttribute("data-color-mode")).toBe(false);
			}
		});

		it("updates preview cards' data-color-mode reactively when the mode changes", async () => {
			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const select = el.querySelector("#pref-color-mode") as HTMLSelectElement;
			select.value = "light";
			select.dispatchEvent(new Event("change", { bubbles: true }));
			for (const card of Array.from(el.querySelectorAll("[data-theme-card]"))) {
				expect(card.getAttribute("data-color-mode")).toBe("light");
			}

			select.value = "system";
			select.dispatchEvent(new Event("change", { bubbles: true }));
			for (const card of Array.from(el.querySelectorAll("[data-theme-card]"))) {
				expect(card.hasAttribute("data-color-mode")).toBe(false);
			}
		});

		it("documents that the dashboard appearance is independent of the TUI theme", async () => {
			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(el.textContent).toContain("independent of the TUI");
		});
	});

	it("settings requests browser notification permission from the dashboard toggle", async () => {
		const fakeNotification = Object.assign(function Notification() {}, {
			permission: "default" as NotificationPermission,
			requestPermission: vi.fn(async () => {
				fakeNotification.permission = "granted";
				return "granted" as NotificationPermission;
			}),
		});
		vi.stubGlobal("Notification", fakeNotification);
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const notifications = el.querySelector("#pref-notifications") as HTMLInputElement;

		notifications.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(fakeNotification.requestPermission).toHaveBeenCalled();
		expect(notifications.checked).toBe(true);
	});

	describe("settings iOS notification permission detection (#pref-notifications)", () => {
		// Restore the navigator/matchMedia mocks between cases — jsdom defines
		// userAgent as a prototype getter, so we shadow it with an own data
		// property (configurable so afterEach can delete it). The shared file
		// afterEach already unstubAllGlobals()s Notification and deletes
		// window.matchMedia, but our own navigator props need restoring here.
		const restore: Array<() => void> = [];

		afterEach(() => {
			for (const fn of restore.splice(0)) fn();
		});

		function stubAgent(value: string) {
			const nav = window.navigator;
			Object.defineProperty(nav, "userAgent", { configurable: true, value });
			restore.push(() => {
				delete (nav as { userAgent?: string }).userAgent;
			});
		}

		function stubStandalone(value: boolean) {
			const nav = window.navigator as { standalone?: boolean };
			Object.defineProperty(nav, "standalone", { configurable: true, value });
			restore.push(() => {
				delete nav.standalone;
			});
		}

		function stubMatchMedia(matches: boolean) {
			Object.defineProperty(window, "matchMedia", {
				configurable: true,
				value: vi.fn((query: string) => ({
					matches,
					media: query,
					onchange: null,
					addListener: vi.fn(),
					removeListener: vi.fn(),
					addEventListener: vi.fn(),
					removeEventListener: vi.fn(),
					dispatchEvent: vi.fn(),
				})),
			});
			restore.push(() => {
				Reflect.deleteProperty(window, "matchMedia");
			});
		}

		it("shows the install-prerequisite hint and disables the toggle on un-installed iOS Safari (no Notification API)", async () => {
			vi.stubGlobal("Notification", undefined);
			stubAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X)");
			stubStandalone(false);
			stubMatchMedia(false);

			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const checkbox = el.querySelector("#pref-notifications") as HTMLInputElement;
			expect(checkbox.disabled).toBe(true);
			expect(el.textContent).toContain("iOS notifications need the installed PWA");
			expect(el.textContent).not.toContain("browser notifications are unavailable in this environment");
		});

		it("treats an installed iOS PWA with the Notification API as normal (not ios-install)", async () => {
			const fakeNotification = Object.assign(function Notification() {}, {
				permission: "default" as NotificationPermission,
				requestPermission: vi.fn(async () => "default" as NotificationPermission),
			});
			vi.stubGlobal("Notification", fakeNotification);
			stubAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X)");
			stubStandalone(true);
			// display-mode: standalone also matches for an installed PWA; either
			// signal is sufficient — exercise the standalone===true branch here.

			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const checkbox = el.querySelector("#pref-notifications") as HTMLInputElement;
			expect(checkbox.disabled).toBe(false);
			expect(el.textContent).not.toContain("iOS notifications need the installed PWA");
			expect(el.textContent).not.toContain("browser notifications are unavailable in this environment");
			// default permission → the normal grant hint shows the enable copy.
			expect(el.textContent).toContain("show a notification when the tab needs input");
		});

		it("disables the toggle and shows the blocked hint when permission is denied", async () => {
			const fakeNotification = Object.assign(function Notification() {}, {
				permission: "denied" as NotificationPermission,
				requestPermission: vi.fn(async () => "denied" as NotificationPermission),
			});
			vi.stubGlobal("Notification", fakeNotification);
			stubAgent("Mozilla/5.0 (X11; Linux x86_64)");

			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const checkbox = el.querySelector("#pref-notifications") as HTMLInputElement;
			expect(checkbox.disabled).toBe(true);
			expect(el.textContent).toContain("blocked by browser settings");
		});

		it("shows the unsupported hint and disables the toggle on a non-iOS browser with no Notification API", async () => {
			// A non-iOS browser/WebView exposing no Notification API (e.g. an
			// embedded WebView, or a privacy mode that strips it) lands in the
			// "unsupported" branch — distinct from "ios-install" (the user can't
			// fix it by installing). The toggle must be disabled and the hint must
			// explain notifications are unavailable, not offer the install path.
			vi.stubGlobal("Notification", undefined);
			stubAgent("Mozilla/5.0 (X11; Linux x86_64)");
			stubStandalone(false);
			stubMatchMedia(false);

			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const checkbox = el.querySelector("#pref-notifications") as HTMLInputElement;
			expect(checkbox.disabled).toBe(true);
			expect(el.textContent).toContain("browser notifications are unavailable in this environment");
			expect(el.textContent).not.toContain("iOS notifications need the installed PWA");
		});

		it("shows the HTTPS hint (not the install hint) on an insecure context with no Notification API", async () => {
			// `--remote` without `--https` serves plain HTTP over the tailnet — an
			// insecure context where the Notification API is absent entirely.
			// Installing the PWA cannot fix an insecure origin, so the hint must
			// point at HTTPS, not at Add to Home Screen — even on iOS.
			vi.stubGlobal("Notification", undefined);
			stubAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X)");
			stubStandalone(false);
			stubMatchMedia(false);
			Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
			restore.push(() => {
				Reflect.deleteProperty(window, "isSecureContext");
			});

			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const checkbox = el.querySelector("#pref-notifications") as HTMLInputElement;
			expect(checkbox.disabled).toBe(true);
			expect(el.textContent).toContain("not a secure context");
			expect(el.textContent).not.toContain("iOS notifications need the installed PWA");
		});

		it("does not crash when window.matchMedia is undefined (optional chaining guards .matches)", async () => {
			// The display-mode probe is `window.matchMedia?.("…")?.matches`. If
			// matchMedia is absent (old/embedded browsers) the access must
			// short-circuit to undefined, not throw TypeError. Mount SettingsScreen
			// with no matchMedia and a Notification API absent on a non-iOS UA so
			// the standalone probe runs; the screen must render the unsupported
			// hint rather than crashing to a blank view.
			vi.stubGlobal("Notification", undefined);
			stubAgent("Mozilla/5.0 (X11; Linux x86_64)");
			// Ensure matchMedia is truly absent (some jsdom configs stub it).
			Reflect.deleteProperty(window, "matchMedia");

			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const checkbox = el.querySelector("#pref-notifications") as HTMLInputElement;
			expect(checkbox).not.toBeNull();
			expect(checkbox.disabled).toBe(true);
			expect(el.textContent).toContain("browser notifications are unavailable in this environment");
		});
	});

	it("settings refreshes pairing code and unpairs devices", async () => {
		vi.mocked(api.pairingCode).mockResolvedValue({ enabled: true, code: "123456", expiresInMs: 30_000 });
		vi.mocked(api.devices).mockClear();
		vi.mocked(api.devices).mockResolvedValue({
			devices: [
				{
					id: "device-1",
					identity: "alice@example.com",
					device: "phone",
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
				},
			],
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.pairingCode).toHaveBeenCalled();
		expect(el.textContent).toContain("123456");
		const unpair = [...el.querySelectorAll(".device-row .btn-danger")].find(
			(button) => button.textContent === "unpair",
		) as HTMLButtonElement;
		unpair.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.unpair).toHaveBeenCalledWith("device-1");
		expect(api.devices).toHaveBeenCalledTimes(2);
	});

	it("settings restart control confirms before calling the API", async () => {
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const restart = [...el.querySelectorAll("button")].find(
			(button) => button.textContent === "restart",
		) as HTMLButtonElement;
		restart.click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.restartServer).not.toHaveBeenCalled();
		const confirm = [...el.querySelectorAll(".modal .btn-danger")].at(-1) as HTMLButtonElement;
		confirm.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.restartServer).toHaveBeenCalled();
	});

	it("settings default-model picker saves provider and model", async () => {
		vi.mocked(api.settingsModels).mockResolvedValue({
			models: [
				{ provider: "anthropic", id: "claude-test", name: "Claude Test", contextWindow: 200000, reasoning: true },
			],
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		(el.querySelector(".model-picker-button") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(el.querySelector(".modal")?.classList.contains("model-picker-modal")).toBe(true);
		expect(el.querySelector(".model-provider-heading")?.textContent).toBe("anthropic");

		(el.querySelector(".model-row") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.saveSettings).toHaveBeenCalledWith({ defaultProvider: "anthropic", defaultModel: "claude-test" });
	});

	it("settings agent-model editor adds a model override", async () => {
		vi.mocked(api.agentTypes).mockResolvedValue({
			agentTypes: [{ name: "Explore", description: "Explore the codebase" }],
		});
		vi.mocked(api.settingsModels).mockResolvedValue({
			models: [
				{ provider: "github-copilot", id: "gpt-test", name: "GPT Test", contextWindow: 128000, reasoning: false },
			],
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		(el.querySelector(".agent-model-edit") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		const add = [...el.querySelectorAll("button")].find((button) => button.textContent?.includes("add model"));
		(add as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		(el.querySelector(".model-row") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.saveSettings).toHaveBeenCalledWith({
			agentModels: { Explore: ["github-copilot/gpt-test"] },
		});
	});

	it("settings loads agent definitions for an explicit project context", async () => {
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			fleet: () => ({
				runtimes: [],
				diskSessions: [
					{
						path: "/sessions/project.jsonl",
						id: "project",
						cwd: "/repo/project",
						name: "project",
						created: new Date().toISOString(),
						modified: new Date().toISOString(),
						messageCount: 1,
						firstMessage: "hello",
					},
				],
			}),
		};
		const el = mount(() => <SettingsScreen store={fakeStore} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const context = el.querySelector(".agent-context-row select") as HTMLSelectElement;
		context.value = "/repo/project";
		context.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.agentTypes).toHaveBeenCalledWith("/repo/project");
	});

	it("settings renders warnings returned from saveSettings", async () => {
		vi.mocked(api.settingsModels).mockResolvedValue({
			models: [{ provider: "test", id: "m2", name: "Model Two", contextWindow: 32000, reasoning: false }],
		});
		vi.mocked(api.saveSettings).mockResolvedValue({
			defaultProvider: "test",
			defaultModel: "m2",
			warnings: ["Project settings shadow a global agentModels entry"],
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		(el.querySelector(".model-picker-button") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		(el.querySelector(".model-row") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.querySelector(".settings-warning")?.textContent).toContain(
			"Project settings shadow a global agentModels entry",
		);
	});

	it("composer textarea auto-grows on input", () => {
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { k1: createSessionViewState("k1") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k1" />);
		const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
		Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 144 });

		textarea.value = "line 1\nline 2\nline 3";
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));

		expect(textarea.style.height).toBe("144px");
		expect(textarea.style.overflowY).toBe("hidden");
	});

	it("slash command autocomplete filters and accepts without sending", async () => {
		vi.mocked(api.commands).mockResolvedValue({
			commands: [
				{ name: "skill:review", description: "Review code", source: "skill" },
				{ name: "plan", description: "Plan work", source: "prompt" },
				{ name: "skill:write", description: "Write code", source: "skill" },
			],
		});
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { k1: createSessionViewState("k1") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k1" />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const textarea = el.querySelector("textarea") as HTMLTextAreaElement;

		textarea.value = "/";
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
		expect(el.querySelector('[role="listbox"]')?.textContent).toContain("/skill:review");
		expect(el.querySelector('[role="listbox"]')?.textContent).toContain("/plan");

		textarea.value = "/rev";
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
		expect(el.querySelector('[role="listbox"]')?.textContent).toContain("/skill:review");
		expect(el.querySelector('[role="listbox"]')?.textContent).not.toContain("/plan");

		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(el.querySelector('[role="listbox"]')).toBeNull();
		textarea.value = "/rev";
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(api.prompt).not.toHaveBeenCalled();
		expect(textarea.value).toBe("/skill:review ");
		expect(el.querySelector('[role="listbox"]')).toBeNull();
	});

	it("slash command composer sends raw slash text after arguments are entered", async () => {
		vi.mocked(api.commands).mockResolvedValue({
			commands: [{ name: "skill:review", description: "Review code", source: "skill" }],
		});
		vi.mocked(api.prompt).mockClear();
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { k1: createSessionViewState("k1") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k1" />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const textarea = el.querySelector("textarea") as HTMLTextAreaElement;

		textarea.value = "/skill:review args";
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

		expect(api.prompt).toHaveBeenCalledWith("k1", "/skill:review args");
	});

	it("composer Enter does not submit on mobile", async () => {
		stubMobile(true);
		vi.mocked(api.prompt).mockClear();
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { k1: createSessionViewState("k1") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k1" />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const textarea = el.querySelector("textarea") as HTMLTextAreaElement;

		textarea.value = "line one";
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

		expect(api.prompt).not.toHaveBeenCalled();
	});

	it("loaded context modal renders resources and empty sections", async () => {
		vi.mocked(api.resources).mockResolvedValueOnce({
			contextFiles: [{ path: "/home/test/project/AGENTS.md" }],
			skills: [{ name: "review", description: "Review code" }],
			extensions: [{ name: "demo", path: "/tmp/ext.ts" }],
			promptTemplates: [{ name: "plan", description: "Plan work" }],
			systemPromptPresent: true,
		});
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { k1: createSessionViewState("k1") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k1" />);
		(el.querySelector(".session-bar .right .switcher:last-child") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		[...el.querySelectorAll("button")].find((button) => button.textContent?.includes("loaded context"))?.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain("loaded context");
		expect(el.textContent).toContain("~/project/AGENTS.md");
		expect(el.textContent).toContain("review");
		expect(el.textContent).toContain("Review code");
		expect(el.textContent).toContain("demo");
		expect(el.textContent).toContain("system prompt: custom");

		vi.mocked(api.resources).mockResolvedValueOnce({
			contextFiles: [],
			skills: [],
			extensions: [],
			promptTemplates: [],
			systemPromptPresent: false,
		});
		[...el.querySelectorAll("button")].find((button) => button.textContent?.includes("loaded context"))?.click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(el.textContent).toContain("none");
	});

	it("files lists the home place first even when places resolves asynchronously", async () => {
		vi.mocked(api.places).mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			return { places: [{ label: "home", path: "/home/slow" }] };
		});
		vi.mocked(api.listFiles).mockResolvedValue({
			path: "/home/slow",
			entries: [],
			contextTrust: { canonicalTarget: "/home/slow", state: "untrusted" },
		});

		const store = makeStore();
		mount(() => <FilesScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(api.listFiles).toHaveBeenCalledWith("/home/slow");
		expect(vi.mocked(api.listFiles).mock.calls.some(([target]) => target === "/")).toBe(false);
	});

	it("groups /tmp sessions under a single fleet project", () => {
		expect(fleetGroupKey("/tmp")).toBe("/tmp");
		expect(fleetGroupKey("/tmp/x")).toBe("/tmp");
		expect(fleetGroupKey("/tmp/x/y")).toBe("/tmp");
		expect(fleetGroupKey("/home/u/proj")).toBe("/home/u/proj");

		const store = makeStore() as any;
		const liveSession = createSessionViewState("a");
		liveSession.sessionName = "live fleet name";
		const runtime = (key: string, cwd: string) => ({
			key,
			cwd,
			state: {
				sessionId: key,
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				autoCompactionEnabled: true,
				messageCount: 1,
				pendingMessageCount: 0,
				model: { provider: "github-copilot", id: "claude-fable-5" },
			},
			stats: { tokensTotal: 1545, cost: 0.42 },
			backgroundAgents: [],
			needsAttention: false,
			createdAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
		});
		const diskSession = (id: string, cwd: string) => ({
			path: `/sessions/${id}.jsonl`,
			id,
			cwd,
			name: `disk ${id}`,
			created: new Date().toISOString(),
			modified: new Date().toISOString(),
			messageCount: 3,
			firstMessage: "hello",
		});
		const fakeStore = {
			...store,
			sessions: { a: liveSession },
			fleet: () => ({
				runtimes: [runtime("a", "/tmp/a"), runtime("b", "/tmp/b")],
				diskSessions: [diskSession("d1", "/tmp/x"), diskSession("d2", "/tmp/y")],
			}),
		};
		const el = mount(() => <FleetScreen store={fakeStore} />);

		// Live cards are one flat grid (no project group headers); each card
		// carries its own real cwd.
		expect(el.querySelectorAll(".session-card")).toHaveLength(2);
		const cardProjects = [...el.querySelectorAll(".session-card .session-project")].map((node) => node.textContent);
		expect(cardProjects).toEqual(["/tmp/a", "/tmp/b"]);
		// Past sessions bundle /tmp/* into a single group.
		const headers = [...el.querySelectorAll(".group-head h3")].map((node) => node.textContent);
		expect(headers).toEqual(["/tmp"]);
		expect(el.textContent).toContain("github-copilot/claude-fable-5");
		expect(el.textContent).toContain("$0.42");
		expect(el.textContent).toContain("live fleet name");
	});

	it("fleet resumes disk sessions with their session path", async () => {
		const store = makeStore() as any;
		const refreshFleet = vi.fn(async () => {});
		const navigate = vi.fn();
		const fakeStore = {
			...store,
			refreshFleet,
			navigate,
			fleet: () => ({
				runtimes: [],
				diskSessions: [
					{
						path: "/sessions/resume.jsonl",
						id: "resume",
						cwd: "/repo",
						name: "resume me",
						created: new Date().toISOString(),
						modified: new Date().toISOString(),
						messageCount: 3,
						firstMessage: "hello",
					},
				],
			}),
		};
		const el = mount(() => <FleetScreen store={fakeStore} />);
		(el.querySelector(".disk-row .actions .btn") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.createRuntime).toHaveBeenCalledWith("/repo", { sessionPath: "/sessions/resume.jsonl" });
		expect(refreshFleet).toHaveBeenCalled();
		expect(navigate).toHaveBeenCalledWith({ screen: "session", key: "new-key" });
	});

	it("fleet deletes disk sessions and refreshes", async () => {
		const store = makeStore() as any;
		const refreshFleet = vi.fn(async () => {});
		const fakeStore = {
			...store,
			refreshFleet,
			fleet: () => ({
				runtimes: [],
				diskSessions: [
					{
						path: "/sessions/delete.jsonl",
						id: "delete",
						cwd: "/repo",
						name: "delete me",
						created: new Date().toISOString(),
						modified: new Date().toISOString(),
						messageCount: 3,
						firstMessage: "hello",
					},
				],
			}),
		};
		const el = mount(() => <FleetScreen store={fakeStore} />);
		const rowButtons = [...el.querySelectorAll(".disk-row .actions .btn")] as HTMLButtonElement[];
		rowButtons.find((button) => button.textContent === "delete")?.click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		const modalButtons = [...el.querySelectorAll(".modal .btn-danger")] as HTMLButtonElement[];
		modalButtons.at(-1)?.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.deleteSession).toHaveBeenCalledWith("/sessions/delete.jsonl");
		expect(refreshFleet).toHaveBeenCalled();
	});

	it("fleet shows load errors instead of the empty state", () => {
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			fleetError: () => "server down",
		};
		const el = mount(() => <FleetScreen store={fakeStore} />);
		expect(el.textContent).toContain("Fleet could not be loaded: server down");
		expect(el.textContent).not.toContain("No sessions yet");
	});

	it("fleet shows live sessions first and collapses past sessions to three rows with an expand toggle", () => {
		const store = makeStore() as any;
		const diskSession = (id: string, modified: string) => ({
			path: `/sessions/${id}.jsonl`,
			id,
			cwd: "/repo",
			name: `disk ${id}`,
			created: modified,
			modified,
			messageCount: 3,
			firstMessage: "hello",
		});
		const fakeStore = {
			...store,
			sessions: {},
			fleet: () => ({
				runtimes: [
					{
						key: "live1",
						cwd: "/repo",
						state: {
							sessionId: "live1",
							thinkingLevel: "off",
							isStreaming: true,
							isCompacting: false,
							steeringMode: "all",
							followUpMode: "all",
							autoCompactionEnabled: true,
							messageCount: 1,
							pendingMessageCount: 0,
						},
						backgroundAgents: [],
						needsAttention: false,
						createdAt: new Date().toISOString(),
						lastActivity: new Date().toISOString(),
					},
				],
				diskSessions: [
					diskSession("d1", "2026-01-04T00:00:00Z"),
					diskSession("d2", "2026-01-03T00:00:00Z"),
					diskSession("d3", "2026-01-02T00:00:00Z"),
					diskSession("d4", "2026-01-01T00:00:00Z"),
				],
			}),
		};
		const el = mount(() => <FleetScreen store={fakeStore} />);

		// Live grid renders before the past-sessions section.
		const live = el.querySelector(".live-sessions");
		const past = el.querySelector(".past-sessions");
		expect(live).not.toBeNull();
		expect(past).not.toBeNull();
		expect(live!.compareDocumentPosition(past!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		// Only 3 disk rows visible; the rest behind the expand toggle.
		expect(el.querySelectorAll(".disk-row")).toHaveLength(3);
		const toggle = el.querySelector(".disk-more") as HTMLButtonElement;
		expect(toggle.textContent).toContain("all 4 on disk");

		toggle.click();
		expect(el.querySelectorAll(".disk-row")).toHaveLength(4);
		expect((el.querySelector(".disk-more") as HTMLButtonElement).textContent).toContain("show fewer");
	});

	it("model selector groups by provider and marks the current same-id model", async () => {
		vi.mocked(api.models).mockResolvedValue({
			models: [
				{
					provider: "anthropic",
					id: "claude-fable-5",
					name: "Claude Fable",
					contextWindow: 200000,
					reasoning: true,
				},
				{
					provider: "github-copilot",
					id: "claude-fable-5",
					name: "Claude Fable",
					contextWindow: 200000,
					reasoning: true,
				},
			],
		});
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { k1: createSessionViewState("k1") },
			fleet: () => ({
				runtimes: [
					{
						key: "k1",
						cwd: "/repo",
						state: {
							sessionId: "s1",
							thinkingLevel: "off",
							isStreaming: false,
							isCompacting: false,
							steeringMode: "all",
							followUpMode: "all",
							autoCompactionEnabled: true,
							messageCount: 0,
							pendingMessageCount: 0,
							model: { provider: "github-copilot", id: "claude-fable-5" },
						},
						backgroundAgents: [],
						needsAttention: false,
						createdAt: new Date().toISOString(),
						lastActivity: new Date().toISOString(),
					},
				],
				diskSessions: [],
			}),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k1" />);

		(el.querySelector(".model-switcher") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.querySelector(".modal")?.classList.contains("model-picker-modal")).toBe(true);
		const headers = [...el.querySelectorAll(".model-provider-heading")].map((node) => node.textContent);
		expect(headers).toEqual(["anthropic", "github-copilot"]);
		expect(el.querySelectorAll(".model-row")).toHaveLength(2);
		expect(el.querySelector(".model-row.current")?.textContent).toContain("github-copilot");
		expect(el.querySelector(".model-row.current")?.textContent).toContain("✓");
	});

	it("queued messages render as chips and restore text plus inline images to the composer", async () => {
		const urls = stubObjectUrls();
		vi.mocked(api.pending).mockResolvedValue({
			steering: ["steer one"],
			followUp: ["follow one"],
			steeringMessages: [{ text: "steer one", images: [{ data: "aGVsbG8=", mimeType: "image/png" }] }],
			followUpMessages: [{ text: "follow one" }],
		});
		vi.mocked(api.dequeue).mockResolvedValue({
			steering: ["steer one"],
			followUp: ["follow one"],
			steeringMessages: [{ text: "steer one", images: [{ data: "aGVsbG8=", mimeType: "image/png" }] }],
			followUpMessages: [{ text: "follow one" }],
		});
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { queued: createSessionViewState("queued") },
			fleet: () => ({
				runtimes: [
					{
						key: "queued",
						cwd: "/repo",
						state: {
							sessionId: "s1",
							thinkingLevel: "off",
							isStreaming: false,
							isCompacting: false,
							steeringMode: "all",
							followUpMode: "all",
							autoCompactionEnabled: true,
							messageCount: 0,
							pendingMessageCount: 2,
						},
						backgroundAgents: [],
						needsAttention: false,
						createdAt: new Date().toISOString(),
						lastActivity: new Date().toISOString(),
					},
				],
				diskSessions: [],
			}),
			hydrateSession: async () => {},
			refreshFleet: vi.fn(async () => {}),
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="queued" />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(el.textContent).toContain("steer one");
		expect(el.textContent).toContain("follow one");
		vi.mocked(api.pending).mockClear();
		vi.mocked(api.dequeue).mockClear();

		[...el.querySelectorAll("button")].find((button) => button.textContent?.includes("restore"))?.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.pending).toHaveBeenCalledWith("queued");
		expect(api.dequeue).toHaveBeenCalledWith("queued");
		expect(vi.mocked(api.pending).mock.invocationCallOrder[0]!).toBeLessThan(
			vi.mocked(api.dequeue).mock.invocationCallOrder[0]!,
		);
		expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe("steer one\n\nfollow one");
		expect(el.querySelector(".attachment-thumb img")?.getAttribute("src")).toBe("blob:mock-2");
		expect(urls.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
		expect((urls.createObjectURL.mock.calls[0]?.[0] as Blob).size).toBe(5);
		expect((urls.createObjectURL.mock.calls[1]?.[0] as Blob).size).toBe(5);
		expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:mock-1");
	});

	it("restore rejects queued images over the aggregate cap without dequeuing", async () => {
		const urls = stubObjectUrls();
		const overBudgetQueuedImage = { data: "A".repeat(13 * 1024 * 1024), mimeType: "image/png" };
		vi.mocked(api.pending).mockResolvedValue({
			steering: ["oversized queued images"],
			followUp: [],
			steeringMessages: [
				{ text: "oversized queued images", images: [overBudgetQueuedImage, overBudgetQueuedImage] },
			],
			followUpMessages: [],
		});
		vi.mocked(api.dequeue).mockResolvedValue({ steering: [], followUp: [] });
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { queued: createSessionViewState("queued") },
			fleet: () => ({
				runtimes: [
					{
						key: "queued",
						cwd: "/repo",
						state: {
							sessionId: "s1",
							thinkingLevel: "off",
							isStreaming: false,
							isCompacting: false,
							steeringMode: "all",
							followUpMode: "all",
							autoCompactionEnabled: true,
							messageCount: 0,
							pendingMessageCount: 1,
						},
						backgroundAgents: [],
						needsAttention: false,
						createdAt: new Date().toISOString(),
						lastActivity: new Date().toISOString(),
					},
				],
				diskSessions: [],
			}),
			hydrateSession: async () => {},
			refreshFleet: vi.fn(async () => {}),
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="queued" />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		vi.mocked(api.pending).mockClear();
		vi.mocked(api.dequeue).mockClear();

		[...el.querySelectorAll("button")].find((button) => button.textContent?.includes("restore"))?.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain(`total inline images exceed ${maxTotalImageBytesLabel()}`);
		expect(el.querySelector(".attachment-thumb")).toBeNull();
		expect(urls.createObjectURL).toHaveBeenCalledTimes(2);
		expect(urls.revokeObjectURL).toHaveBeenCalledTimes(2);
		expect(urls.revokeObjectURL).toHaveBeenNthCalledWith(1, "blob:mock-1");
		expect(urls.revokeObjectURL).toHaveBeenNthCalledWith(2, "blob:mock-2");
		expect(api.dequeue).not.toHaveBeenCalled();
	});

	it("composer history recalls sent prompts with arrow keys", async () => {
		vi.mocked(api.prompt).mockClear();
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { hist: createSessionViewState("hist") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="hist" />);
		const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
		textarea.value = "first prompt";
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.prompt).toHaveBeenCalledWith("hist", "first prompt");
		expect(textarea.value).toBe("");

		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
		expect(textarea.value).toBe("first prompt");
		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(textarea.value).toBe("");
	});

	it("status compaction and retry entries expose abort buttons", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("abort-status");
		session.statusEntries = [
			{ key: "compaction", text: "compacting context…", tone: "info" },
			{ key: "retry", text: "retrying", tone: "warning" },
		];
		const fakeStore = {
			...store,
			sessions: { "abort-status": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="abort-status" />);
		const buttons = [...el.querySelectorAll(".status-line button")];
		buttons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		buttons[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.abortCompaction).toHaveBeenCalledWith("abort-status");
		expect(api.abortRetry).toHaveBeenCalledWith("abort-status");
	});

	it("transcript shows skill badges and copies raw user/assistant text", async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const el = mount(() => (
			<Transcript
				entries={[
					{ kind: "user", text: "/skill:review please" },
					{
						kind: "assistant",
						blocks: [
							{ kind: "thinking", text: "hidden" },
							{ kind: "text", text: "visible answer" },
						],
						streaming: false,
					},
				]}
			/>
		));
		expect(el.textContent).toContain("skill: review");
		const buttons = [...el.querySelectorAll(".entry-action")];
		(buttons[0] as HTMLButtonElement).click();
		(buttons[1] as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(writeText).toHaveBeenNthCalledWith(1, "/skill:review please");
		expect(writeText).toHaveBeenNthCalledWith(2, "visible answer");
	});

	it("bespoke tool cards render bash command lines and write bodies", () => {
		const el = mount(() => (
			<Transcript
				entries={[
					{
						kind: "tool",
						toolCallId: "b1",
						toolName: "bash",
						args: { command: "npm test" },
						status: "done",
						resultText: "passed",
						startedAt: Date.now(),
					},
					{
						kind: "tool",
						toolCallId: "w1",
						toolName: "write",
						args: { path: "/tmp/a.txt", content: "written body" },
						status: "done",
						resultText: "",
						startedAt: Date.now(),
					},
				]}
			/>
		));
		expect(el.querySelector(".tool-command")?.textContent).toContain("npm test");
		expect(el.textContent).toContain("passed");
		expect(el.textContent).toContain("written body");
	});

	it("bash tool output sticks to the bottom while streaming unless the user scrolls up", async () => {
		let scrollHeight = 300;
		const bashEntry = (resultText: string) => ({
			kind: "tool" as const,
			toolCallId: "b-stream",
			toolName: "bash",
			args: { command: "for i in {1..100}; do echo $i; done" },
			status: "running" as const,
			resultText,
			startedAt: Date.now(),
		});
		const entry = bashEntry("line 1");
		const [entries, setEntries] = createSignal([entry]);
		const el = mount(() => <Transcript entries={entries()} />);
		let pre = el.querySelector(".tool-result pre") as HTMLPreElement;
		const refreshPre = () => {
			pre = el.querySelector(".tool-result pre") as HTMLPreElement;
			Object.defineProperty(pre, "clientHeight", { configurable: true, value: 100 });
			Object.defineProperty(pre, "scrollHeight", { configurable: true, get: () => scrollHeight });
		};
		refreshPre();

		pre.scrollTop = 200;
		pre.dispatchEvent(new Event("scroll"));
		scrollHeight = 600;
		entry.resultText = "line 1\n".repeat(80);
		setEntries([entry]);
		refreshPre();
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		expect(pre.scrollTop).toBe(600);

		pre.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
		pre.scrollTop = 100;
		pre.dispatchEvent(new Event("scroll"));
		scrollHeight = 900;
		entry.resultText = "line 1\n".repeat(120);
		setEntries([entry]);
		refreshPre();
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		expect(pre.scrollTop).toBe(100);
	});

	it("bash tool output keeps following when output grows without a user scroll", async () => {
		let scrollHeight = 300;
		const bashEntry = (resultText: string) => ({
			kind: "tool" as const,
			toolCallId: "b-grow",
			toolName: "bash",
			args: { command: "for i in {1..100}; do echo $i; done" },
			status: "running" as const,
			resultText,
			startedAt: Date.now(),
		});
		const entry = bashEntry("line 1");
		const [entries, setEntries] = createSignal([entry]);
		const el = mount(() => <Transcript entries={entries()} />);
		let pre = el.querySelector(".tool-result pre") as HTMLPreElement;
		const refreshPre = () => {
			pre = el.querySelector(".tool-result pre") as HTMLPreElement;
			Object.defineProperty(pre, "clientHeight", { configurable: true, value: 100 });
			Object.defineProperty(pre, "scrollHeight", { configurable: true, get: () => scrollHeight });
		};
		refreshPre();

		// Parked at the bottom.
		pre.scrollTop = 200;
		pre.dispatchEvent(new Event("scroll"));

		// Output grows and a spurious scroll fires while not-at-bottom — must not
		// latch follow off.
		scrollHeight = 600;
		pre.dispatchEvent(new Event("scroll"));

		// Further streamed output pins back to the new bottom.
		scrollHeight = 900;
		entry.resultText = "line 1\n".repeat(120);
		setEntries([entry]);
		refreshPre();
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		expect(pre.scrollTop).toBe(900);
	});

	it("fork modal rewinds to a selected user message and prefills the composer", async () => {
		vi.mocked(api.forkMessages).mockResolvedValue({ messages: [{ entryId: "u1", text: "original prompt" }] });
		vi.mocked(api.fork).mockResolvedValue({ text: "original prompt", cancelled: false });
		const store = makeStore() as any;
		const hydrateSession = vi.fn(async () => {});
		const fakeStore = {
			...store,
			sessions: { fork: createSessionViewState("fork") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession,
			refreshFleet: vi.fn(async () => {}),
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="fork" />);
		(el.querySelector(".session-bar .right .switcher:last-child") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		[...el.querySelectorAll("button")].find((button) => button.textContent?.includes("fork"))?.click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(el.textContent).toContain("original prompt");
		(el.querySelector(".fork-message") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.fork).toHaveBeenCalledWith("fork", "u1");
		expect(hydrateSession).toHaveBeenCalledWith("fork");
		expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe("original prompt");
	});

	it("session stats popover shows the detailed stats breakdown", async () => {
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { stats: createSessionViewState("stats") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="stats" />);
		(el.querySelector(".stats-trigger") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.stats).toHaveBeenCalledWith("stats");
		expect(el.textContent).toContain("user messages");
		expect(el.textContent).toContain("total tokens");
		expect(el.textContent).toContain("$0.4200");
	});

	it("rejects image batches over the aggregate cap without adding previews", async () => {
		const urls = stubObjectUrls();
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { image: createSessionViewState("image") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="image" />);
		const input = el.querySelector('input[accept="image/*"]') as HTMLInputElement;
		Object.defineProperty(input, "files", {
			configurable: true,
			value: [
				sizedImage("one.png", 9 * 1024 * 1024),
				sizedImage("two.png", 9 * 1024 * 1024),
				sizedImage("three.png", 9 * 1024 * 1024),
			],
		});

		input.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain(`total inline images exceed ${maxTotalImageBytesLabel()}`);
		expect(el.querySelector(".attachment-thumb")).toBeNull();
		expect(urls.createObjectURL).not.toHaveBeenCalled();
	});

	it("removing an image attachment revokes its preview URL", async () => {
		const urls = stubObjectUrls();
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { image: createSessionViewState("image") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="image" />);
		const input = el.querySelector('input[accept="image/*"]') as HTMLInputElement;
		Object.defineProperty(input, "files", {
			configurable: true,
			value: [new File(["img"], "tiny.png", { type: "image/png" })],
		});
		input.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.querySelector(".attachment-thumb img")?.getAttribute("src")).toBe("blob:mock-1");
		(el.querySelector('button[aria-label="remove image"]') as HTMLButtonElement).click();

		expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:mock-1");
		expect(el.querySelector(".attachment-thumb")).toBeNull();
	});

	it("image file attachments are sent with the prompt, then revoked and cleared", async () => {
		const urls = stubObjectUrls();
		vi.mocked(api.prompt).mockClear();
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { image: createSessionViewState("image") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="image" />);
		const input = el.querySelector('input[accept="image/*"]') as HTMLInputElement;
		const file = new File(["img"], "tiny.png", { type: "image/png" });
		Object.defineProperty(input, "files", { configurable: true, value: [file] });
		input.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(el.querySelector(".attachment-thumb img")?.getAttribute("src")).toBe("blob:mock-1");
		const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
		textarea.value = "describe this";
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.prompt).toHaveBeenCalledWith(
			"image",
			expect.stringContaining("Attached images included inline with this turn"),
			undefined,
			[{ mimeType: "image/png", data: "aW1n" }],
		);
		expect(vi.mocked(api.prompt).mock.calls[0]?.[1]).toContain("tiny.png");
		expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:mock-1");
		expect(el.querySelector(".attachment-thumb")).toBeNull();
	});

	it("generic file attachments upload to the workspace and send paths, not inline file contents", async () => {
		vi.mocked(api.prompt).mockClear();
		vi.mocked(api.upload).mockClear();
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { files: createSessionViewState("files") },
			fleet: () => ({
				runtimes: [
					{
						key: "files",
						cwd: "/home/test/project",
						state: {
							sessionId: "files",
							thinkingLevel: "off",
							isStreaming: false,
							isCompacting: false,
							steeringMode: "all",
							followUpMode: "all",
							autoCompactionEnabled: true,
							messageCount: 0,
							pendingMessageCount: 0,
						},
						backgroundAgents: [],
						needsAttention: false,
						createdAt: new Date().toISOString(),
						lastActivity: new Date().toISOString(),
					},
				],
				diskSessions: [],
			}),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="files" />);
		const input = el.querySelector('input[type="file"]:not([accept])') as HTMLInputElement;
		const file = new File(["binary-content-should-not-be-in-prompt"], "archive.zip", {
			type: "application/zip",
		});
		Object.defineProperty(input, "files", { configurable: true, value: [file] });
		input.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		(el.querySelector(".send") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.upload).toHaveBeenCalledWith(
			"/home/test/project/.dreb-dashboard-uploads",
			expect.objectContaining({ name: expect.stringContaining("archive.zip") }),
			false,
		);
		expect(api.prompt).toHaveBeenCalledWith("files", expect.stringContaining("Attached files uploaded to the host"));
		const promptText = vi.mocked(api.prompt).mock.calls[0]?.[1] as string;
		expect(promptText).toContain("archive.zip");
		expect(promptText).toContain("/home/test/project/.dreb-dashboard-uploads/");
		expect(promptText).not.toContain("binary-content-should-not-be-in-prompt");
	});

	it("fleet cards show task progress from runtime state when session is not hydrated", () => {
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: {},
			fleet: () => ({
				runtimes: [
					{
						key: "k1",
						cwd: "/repo",
						state: {
							sessionId: "s1",
							tasks: [
								{ id: "1", title: "Done task", status: "completed" },
								{ id: "2", title: "WIP task", status: "in_progress" },
							],
							thinkingLevel: "off",
							isStreaming: false,
							isCompacting: false,
							steeringMode: "all",
							followUpMode: "all",
							autoCompactionEnabled: true,
							messageCount: 1,
							pendingMessageCount: 0,
						},
						backgroundAgents: [],
						needsAttention: false,
						createdAt: new Date().toISOString(),
						lastActivity: new Date().toISOString(),
					},
				],
				diskSessions: [],
			}),
			hydrateSession: async () => {},
		};
		const el = mount(() => <FleetScreen store={fakeStore} />);
		expect(el.querySelector(".session-meta")?.textContent).toContain("tasks 1/2");
	});

	it("fleet cards use lastAssistantText as a muted activity preview", () => {
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: {},
			fleet: () => ({
				runtimes: [
					{
						key: "preview",
						cwd: "/repo",
						state: {
							sessionId: "preview-session",
							thinkingLevel: "off",
							isStreaming: false,
							isCompacting: false,
							steeringMode: "all",
							followUpMode: "all",
							autoCompactionEnabled: true,
							messageCount: 1,
							pendingMessageCount: 0,
						},
						stats: { tokensTotal: 1, cost: 0.01 },
						backgroundAgents: [],
						needsAttention: false,
						lastAssistantText: "last assistant preview text",
						createdAt: new Date().toISOString(),
						lastActivity: new Date().toISOString(),
					},
				],
				diskSessions: [],
			}),
		};
		const el = mount(() => <FleetScreen store={fakeStore} />);
		expect(el.querySelector(".activity")?.textContent).toContain("last assistant preview text");
	});

	it("model selector defaults to scoped models when scopedModels are present", async () => {
		vi.mocked(api.models).mockResolvedValue({
			models: [{ provider: "anthropic", id: "all-only", name: "All Only", contextWindow: 1000, reasoning: false }],
		});
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { k1: createSessionViewState("k1") },
			fleet: () => ({
				runtimes: [
					{
						key: "k1",
						cwd: "/repo",
						state: {
							sessionId: "s1",
							thinkingLevel: "off",
							isStreaming: false,
							isCompacting: false,
							steeringMode: "all",
							followUpMode: "all",
							autoCompactionEnabled: true,
							messageCount: 0,
							pendingMessageCount: 0,
							model: { provider: "github-copilot", id: "scoped-model" },
							scopedModels: [{ provider: "github-copilot", id: "scoped-model", name: "Scoped Model" }],
						},
						backgroundAgents: [],
						needsAttention: false,
						createdAt: new Date().toISOString(),
						lastActivity: new Date().toISOString(),
					},
				],
				diskSessions: [],
			}),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k1" />);

		(el.querySelector(".model-switcher") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("scoped");
		expect(el.textContent).toContain("scoped-model");
		expect(el.textContent).not.toContain("all-only");
	});

	it("expanded thinking is the default for fresh browsers (opt-out, not opt-in)", async () => {
		// afterEach forces the signal to false — reload from clean storage to
		// exercise the real default path.
		window.localStorage.clear();
		const { reloadExpandThinkingPreference, expandThinking } = await import("../../src/client/state/preferences.js");
		reloadExpandThinkingPreference();
		expect(expandThinking()).toBe(true);

		// An explicit opt-out is honored.
		window.localStorage.setItem("dreb.dashboard.expandThinking", "false");
		reloadExpandThinkingPreference();
		expect(expandThinking()).toBe(false);
	});

	it("subagent drill-in hydrates from the on-disk session log on mount", async () => {
		vi.mocked(api.subagentMessages).mockResolvedValue({
			agent: {
				agentId: "bg9",
				agentType: "Explore",
				taskSummary: "hydrated task",
				startedAt: new Date().toISOString(),
				status: "completed",
			},
			messages: [{ role: "assistant", content: [{ type: "text", text: "found the answer on disk" }] }],
		});
		// Real store: hydrateSubagent must create the session + subagent state
		// from nothing (browser reloaded — reducer state is empty).
		const store = makeStore();
		const el = mount(() => <SubagentScreen store={store} sessionKey="k-reload" agentId="bg9" />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.subagentMessages).toHaveBeenCalledWith("k-reload", "bg9", expect.any(AbortSignal));
		expect(el.textContent).toContain("found the answer on disk");
		expect(el.textContent).toContain("hydrated task");
	});

	it("subagent drill-in surfaces hydration errors loudly", async () => {
		vi.mocked(api.subagentMessages).mockRejectedValue(new Error("No session log found for this agent"));
		const store = makeStore();
		const el = mount(() => <SubagentScreen store={store} sessionKey="k-reload" agentId="bg-missing" />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain("No session log found for this agent");
	});

	it("subagent transcript independently observes content and viewport geometry", async () => {
		const observers: Array<{ callback: ResizeObserverCallback; observed?: Element }> = [];
		class FakeRO {
			private readonly registration: { callback: ResizeObserverCallback; observed?: Element };
			constructor(callback: ResizeObserverCallback) {
				this.registration = { callback };
				observers.push(this.registration);
			}
			observe(element: Element): void {
				this.registration.observed = element;
			}
			unobserve(): void {}
			disconnect(): void {}
		}
		const priorRO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
		(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
			FakeRO as unknown as typeof ResizeObserver;
		try {
			vi.mocked(api.subagentMessages).mockResolvedValue({
				agent: {
					agentId: "bg-ro",
					agentType: "Explore",
					taskSummary: "streaming task",
					startedAt: new Date().toISOString(),
					status: "running",
				},
				messages: [{ role: "assistant", content: [{ type: "text", text: "streaming output" }] }],
			});
			const store = makeStore();
			const el = mount(() => <SubagentScreen store={store} sessionKey="k-ro-sub" agentId="bg-ro" />);
			await new Promise((resolve) => setTimeout(resolve, 10));
			const chat = el.querySelector(".chat") as HTMLElement;
			const chatInner = el.querySelector(".chat-inner") as HTMLElement;
			let scrollHeight = 500;
			let clientHeight = 100;
			let scrollTop = 0;
			let scrollWrites = 0;
			Object.defineProperty(chat, "clientHeight", { configurable: true, get: () => clientHeight });
			Object.defineProperty(chat, "scrollHeight", { configurable: true, get: () => scrollHeight });
			Object.defineProperty(chat, "scrollTop", {
				configurable: true,
				get: () => scrollTop,
				set: (value: number) => {
					scrollTop = value;
					scrollWrites++;
				},
			});
			expect(observers.map((observer) => observer.observed)).toEqual([chatInner, chat]);

			// Parked at the bottom; async growth with no revision must re-pin. Flush
			// any pending mount pin first so only the observer-driven re-pin can
			// satisfy the assertion.
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			chat.scrollTop = 400;
			chat.dispatchEvent(new Event("scroll", { bubbles: true }));
			scrollWrites = 0;

			const contentObserver = observers.find((observer) => observer.observed === chatInner);
			expect(contentObserver).toBeDefined();
			scrollHeight = 1000;
			contentObserver?.callback([], {} as ResizeObserver);
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			expect(chat.scrollTop).toBe(1000);

			const viewportObserver = observers.find((observer) => observer.observed === chat);
			expect(viewportObserver).toBeDefined();
			scrollWrites = 0;
			clientHeight = 200;
			viewportObserver?.callback([], {} as ResizeObserver);
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			expect(scrollWrites).toBe(1);

			// A deliberate up-scroll (wheel-up) suspends follow; later observed growth
			// must not yank the view back down.
			chat.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }));
			chat.scrollTop = 200;
			chat.dispatchEvent(new Event("scroll", { bubbles: true }));
			scrollHeight = 1600;
			contentObserver?.callback([], {} as ResizeObserver);
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			expect(chat.scrollTop).toBe(200);
		} finally {
			(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = priorRO;
		}
	});

	it("hydrateSession re-seeds background agents from the runtime registry", async () => {
		vi.mocked(api.messages).mockResolvedValue({ messages: [] });
		vi.mocked(api.backgroundAgents).mockResolvedValue({
			agents: [
				{
					agentId: "bg7",
					agentType: "Explore",
					taskSummary: "registry-seeded task",
					startedAt: new Date().toISOString(),
					status: "running",
				},
			],
		});
		const store = makeStore();
		await store.hydrateSession("k-reload");

		expect(store.sessions["k-reload"]?.backgroundAgents.bg7?.taskSummary).toBe("registry-seeded task");
	});

	it("tool cards render full inputs expanded (subagent task markdown, generic long args)", () => {
		const longTask = `investigate the following:\n\n- ${"x".repeat(150)}\n- item two`;
		const el = mount(() => (
			<Transcript
				entries={[
					{
						kind: "tool",
						toolCallId: "t1",
						toolName: "subagent",
						args: { task: longTask },
						status: "done",
						resultText: "## Agent: Explore\n\ndone",
						startedAt: Date.now(),
					},
					{
						kind: "tool",
						toolCallId: "t2",
						toolName: "web_search",
						args: { query: `a long query ${"y".repeat(120)}` },
						status: "done",
						resultText: "results",
						startedAt: Date.now(),
					},
				]}
			/>
		));

		for (const details of el.querySelectorAll("details.tool") as NodeListOf<HTMLDetailsElement>) {
			setDetailsOpen(details, true);
		}
		const inputs = el.querySelectorAll(".tool-input");
		expect(inputs.length).toBe(2);
		// Subagent task renders as markdown (list), in full.
		expect(inputs[0]?.querySelector(".markdown-body li")?.textContent).toContain("x".repeat(150));
		// Generic long string arg gets a labeled full-text section.
		expect(inputs[1]?.textContent).toContain("query");
		expect(inputs[1]?.textContent).toContain("y".repeat(120));
	});

	it("markdown-contract tool results render as markdown; suggest_next uses details", () => {
		const el = mount(() => (
			<Transcript
				entries={[
					{
						kind: "tool",
						toolCallId: "t1",
						toolName: "subagent",
						args: { task: "short" },
						status: "done",
						resultText: "## Agent: Explore\n\n**bold finding**",
						startedAt: Date.now(),
					},
					{
						kind: "tool",
						toolCallId: "t2",
						toolName: "suggest_next",
						args: {
							command: "/skill:mach6-push",
							summary: `Fixed *all* the bugs. ${"Detail sentence repeated for length. ".repeat(3)}`,
						},
						status: "done",
						resultText: "Suggestion registered: /skill:mach6-push",
						details: {
							suggestion: "/skill:mach6-push",
							summary: `Fixed *all* the bugs. ${"Detail sentence repeated for length. ".repeat(3)}`,
						},
						startedAt: Date.now(),
					},
				]}
			/>
		));

		setDetailsOpen(el.querySelector("details.tool") as HTMLDetailsElement, true);
		const results = el.querySelectorAll(".tool-result");
		// Subagent completion report: markdown headers/bold, not <pre>.
		expect(results[0]?.querySelector(".markdown-body h2")?.textContent).toBe("Agent: Explore");
		expect(results[0]?.querySelector("pre")).toBeNull();
		// suggest_next renders the markdown summary + the command, not the raw ack.
		expect(results[1]?.querySelector(".markdown-body em")?.textContent).toBe("all");
		expect(results[1]?.textContent).toContain("/skill:mach6-push");
		expect(results[1]?.textContent).not.toContain("Suggestion registered");
		// The summary renders exactly once — no duplicate via the generic
		// long-string input-section fallback.
		const card = el.querySelectorAll("details.tool")[1]!;
		expect(card.querySelectorAll(".tool-input").length).toBe(0);
	});

	it("edit tool cards render details.diff instead of the acknowledgement", () => {
		const edit = toolEntryFromEvents({
			toolName: "edit",
			args: { path: "/tmp/file.ts" },
			resultText: "Successfully replaced text in /tmp/file.ts.",
			details: { diff: "+123 added line\n-45 removed line\n 12 context" },
		});
		const el = mount(() => <Transcript entries={[edit]} />);

		expect(el.querySelector(".diff-add")?.textContent).toBe("+123 added line");
		expect(el.querySelector(".diff-del")?.textContent).toBe("-45 removed line");
		expect(el.textContent).toContain(" 12 context");
		expect(el.textContent).not.toContain("Successfully replaced text");
	});

	it("edit tool cards fall back to resultText when no diff details are present", () => {
		const edit = toolEntryFromEvents({
			toolName: "edit",
			args: { path: "/tmp/file.ts" },
			resultText: "Successfully replaced text in /tmp/file.ts.",
		});
		const el = mount(() => <Transcript entries={[edit]} />);

		expect(el.querySelector(".diff-add")).toBeNull();
		expect(el.querySelector(".diff-del")).toBeNull();
		expect(el.querySelector(".tool-result pre")?.textContent).toBe("Successfully replaced text in /tmp/file.ts.");
	});

	it("read tool results are syntax-highlighted by file extension", () => {
		const read = toolEntryFromEvents({
			toolName: "read",
			args: { path: "/tmp/example.ts" },
			resultText: "export const answer = 42;\nfunction call() { return answer; }",
		});
		const el = mount(() => <Transcript entries={[read]} />);
		const code = el.querySelector(".tool-result code.hljs");

		expect(code).not.toBeNull();
		expect(code?.innerHTML).toContain("<span");
		expect(code?.textContent).toContain("export const answer = 42");
	});

	it("completed legible tool cards including bash are open by default", () => {
		const entries = [
			toolEntryFromEvents({ toolName: "read", args: { path: "/tmp/a.ts" }, resultText: "const a = 1;" }),
			toolEntryFromEvents({
				toolName: "edit",
				args: { path: "/tmp/a.ts" },
				resultText: "Successfully replaced text in /tmp/a.ts.",
				details: { diff: "+1 const a = 2;" },
			}),
			toolEntryFromEvents({
				toolName: "write",
				args: { path: "/tmp/b.ts", content: "export const b = 2;" },
				resultText: "Wrote /tmp/b.ts.",
			}),
			toolEntryFromEvents({
				toolName: "suggest_next",
				args: { command: "/skill:mach6-push" },
				resultText: "Suggestion registered: /skill:mach6-push",
				details: { suggestion: "/skill:mach6-push", summary: "Fixed **everything**" },
			}),
			toolEntryFromEvents({ toolName: "bash", args: { command: "echo done" }, resultText: "done" }),
		];
		const el = mount(() => <Transcript entries={entries} />);
		const tools = Array.from(el.querySelectorAll("details.tool")) as HTMLDetailsElement[];

		// read/edit/write/suggest_next AND bash are all legible-open by default.
		expect(tools.slice(0, 5).every((tool) => tool.open && tool.hasAttribute("open"))).toBe(true);
	});

	it("suggest_next completed card shows markdown summary and command without interaction", () => {
		const suggestNext = toolEntryFromEvents({
			toolName: "suggest_next",
			args: { command: "/skill:mach6-push" },
			resultText: "Suggestion registered: /skill:mach6-push",
			details: { suggestion: "/skill:mach6-push", summary: "Fixed *all* maintainer bugs" },
		});
		const el = mount(() => <Transcript entries={[suggestNext]} />);
		const tool = el.querySelector("details.tool") as HTMLDetailsElement | null;

		expect(tool?.open).toBe(true);
		expect(tool?.querySelector(".markdown-body em")?.textContent).toBe("all");
		expect(tool?.querySelector(".suggested-command code")?.textContent).toBe("/skill:mach6-push");
		expect(tool?.textContent).not.toContain("Suggestion registered");
	});
});
