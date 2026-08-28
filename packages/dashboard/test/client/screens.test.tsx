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
	dashboardImageUrl: (runtimeKey: string, id: string, variant: string, agentId?: string) => {
		if (!/^[0-9a-f]{64}$/.test(id) || !runtimeKey) return undefined;
		const base = agentId
			? `/api/runtimes/${encodeURIComponent(runtimeKey)}/subagents/${encodeURIComponent(agentId)}/images`
			: `/api/runtimes/${encodeURIComponent(runtimeKey)}/images`;
		return `${base}/${id}/${variant}`;
	},
	api: {
		auth: vi.fn(async () => ({ mode: "local", needsPairing: false })),
		extensionUiResponse: vi.fn(async () => ({ ok: true })),
		fleet: vi.fn(async () => ({ runtimes: [], diskSessions: [] })),
		sessions: vi.fn(async () => ({ sessions: [] })),
		resync: vi.fn(async () => ({ fleet: { runtimes: [], diskSessions: [] }, barrierSeq: 0 })),
		connectionDiagnostic: vi.fn(async () => ({ ok: true })),
		hydrate: vi.fn(async (key: string) => ({
			key,
			state: {
				sessionId: key,
				tasks: [],
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				autoCompactionEnabled: true,
				messageCount: 0,
				pendingMessageCount: 0,
			},
			messages: [],
			backgroundAgents: [],
			barrierSeq: 0,
		})),
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
		subagentPending: vi.fn(async () => ({
			steeringMode: "one-at-a-time",
			pending: { steering: [], followUp: [] },
		})),
		steerSubagent: vi.fn(async () => ({ ok: true })),
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
		pairingSettings: vi.fn(async () => ({ pairingTtlDays: 180 })),
		savePairingSettings: vi.fn(async (pairingTtlDays: number) => ({ pairingTtlDays })),
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
		memoryScopes: vi.fn(async () => ({
			scopes: [
				{ id: "global", kind: "global", label: "global", memoryDir: "/home/test/.dreb/memory", exists: true },
			],
		})),
		memoryListing: vi.fn(async () => ({
			scope: { id: "global", kind: "global", label: "global", memoryDir: "/home/test/.dreb/memory", exists: true },
			indexContent: "- [Entry](entry.md) — entry\n",
			indexRevision: "idx1",
			indexOverLimit: false,
			entries: [
				{
					file: "entry.md",
					metadata: { name: "Entry", description: "Test entry", type: "project" },
					modified: new Date().toISOString(),
					size: 64,
				},
			],
		})),
		memoryDocument: vi.fn(async (_scopeId: string, file: string) => ({
			kind: file === "MEMORY.md" ? "index" : "entry",
			file,
			content:
				file === "MEMORY.md"
					? "- [Entry](entry.md) — entry\n"
					: "---\nname: Entry\ndescription: Test entry\ntype: project\n---\n\nBody\n",
			revision: file === "MEMORY.md" ? "idx1" : "rev1",
			...(file === "MEMORY.md" ? {} : { metadata: { name: "Entry", description: "Test entry", type: "project" } }),
		})),
		saveMemoryDocument: vi.fn(async (_scopeId: string, file: string, content: string) => ({
			listing: {
				scope: {
					id: "global",
					kind: "global",
					label: "global",
					memoryDir: "/home/test/.dreb/memory",
					exists: true,
				},
				indexContent: file === "MEMORY.md" ? content : "- [Entry](entry.md) — entry\n",
				indexRevision: "idx2",
				indexOverLimit: false,
				entries: [],
			},
			document: { kind: file === "MEMORY.md" ? "index" : "entry", file, content, revision: "rev2" },
		})),
		deleteMemoryEntry: vi.fn(async () => ({
			listing: {
				scope: {
					id: "global",
					kind: "global",
					label: "global",
					memoryDir: "/home/test/.dreb/memory",
					exists: true,
				},
				indexContent: "",
				indexRevision: "idx3",
				indexOverLimit: false,
				entries: [],
			},
		})),
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
		setModel: vi.fn(async () => ({
			model: { provider: "test", id: "m1" },
			thinkingLevel: "off",
			availableThinkingLevels: ["off"],
			settingsRevision: 1,
		})),
		setThinking: vi.fn(async () => ({ ok: true, settingsRevision: 1 })),
		compact: vi.fn(async () => ({})),
		newSession: vi.fn(async () => ({ cancelled: false })),
		reload: vi.fn(async () => ({ ok: true })),
		dream: vi.fn(async () => ({ message: "Dream completed" })),
		importJsonl: vi.fn(async () => ({ cancelled: false })),
		rename: vi.fn(async () => ({ ok: true })),
		tree: vi.fn(async () => ({ roots: [], leafId: null })),
		navigateTree: vi.fn(async () => ({ cancelled: false })),
		runtimeSessions: vi.fn(async () => ({ sessions: [] })),
		resume: vi.fn(async () => ({ cancelled: false })),
		saveSettings: vi.fn(async (settings) => settings),
		deleteSession: vi.fn(async () => ({ ok: true })),
		stopRuntime: vi.fn(async () => ({ ok: true })),
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
import { App } from "../../src/client/app.js";
import { ConnectionIndicator, Topbar } from "../../src/client/components/common.js";
import {
	TRANSCRIPT_WINDOW_SIZE,
	Transcript,
	type TranscriptRenderItem,
	transcriptRenderItems,
} from "../../src/client/components/transcript.js";
import { FilesScreen } from "../../src/client/screens/files.js";
import { FleetScreen, fleetGroupKey } from "../../src/client/screens/fleet.js";
import { MemoriesScreen } from "../../src/client/screens/memories.js";
import { PairingScreen } from "../../src/client/screens/pairing.js";
import {
	formatPerformanceIndicator,
	formatTokens,
	performanceIndicatorForModel,
	SessionScreen,
} from "../../src/client/screens/session.js";
import { SettingsScreen } from "../../src/client/screens/settings.js";
import { SubagentScreen } from "../../src/client/screens/subagent.js";
import {
	__resetAppearanceForTests,
	COLOR_MODE_STORAGE_KEY,
	FONT_STORAGE_KEY,
	reloadAppearance,
	THEME_STORAGE_KEY,
} from "../../src/client/state/appearance.js";
import { setExpandThinking, setImageDisplayMode } from "../../src/client/state/preferences.js";
import {
	applySessionEvent,
	createSessionViewState,
	type SessionViewState,
	type ToolEntry,
	type TranscriptEntry,
	type UserEntry,
} from "../../src/client/state/reducer.js";
import { createAppStore } from "../../src/client/state/store.js";
import {
	type CommandDto,
	MAX_TOTAL_IMAGE_BYTES,
	type PerformanceModelSummaryDto,
	type PerformanceStatsDto,
	type RuntimeInfoDto,
	type SettingsDto,
} from "../../src/shared/protocol.js";

const disposers: Array<() => void> = [];

function performanceSummary(
	overrides: {
		provider?: string;
		modelId?: string;
		rolling?: Partial<PerformanceModelSummaryDto["rolling"]>;
		delta?: Partial<PerformanceModelSummaryDto["delta"]>;
	} = {},
): PerformanceModelSummaryDto {
	return {
		provider: overrides.provider ?? "test",
		modelId: overrides.modelId ?? "test-model",
		rolling: { median: 41.8, mean: 43, count: 100, ...overrides.rolling },
		delta: {
			baselineMedian: 38,
			recentMedian: 41.8,
			percentDelta: 10,
			direction: "above",
			baselineCount: 200,
			recentCount: 10,
			...overrides.delta,
		},
	};
}

// jsdom lacks ResizeObserver; real browsers always have it. Install a no-op so
// the stick-to-bottom controller's observeContent() attaches quietly instead of
// logging its (correct) "ResizeObserver unavailable" warning on every screen
// mount. Tests that exercise the observer path override this with a capturing
// fake and restore it afterward.
if (!HTMLElement.prototype.scrollIntoView) {
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
}

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
	setImageDisplayMode("previews");
	window.localStorage.clear();
	vi.mocked(connectEvents).mockImplementation(() => () => {});
	vi.mocked(api.auth).mockResolvedValue({ mode: "local", needsPairing: false });
	vi.mocked(api.fleet).mockResolvedValue({ runtimes: [], diskSessions: [] });
	vi.mocked(api.sessions).mockResolvedValue({ sessions: [] });
	vi.mocked(api.hydrate).mockImplementation(async (key: string) => ({
		key,
		state: {
			sessionId: key,
			tasks: [],
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		},
		messages: [],
		backgroundAgents: [],
		barrierSeq: 0,
	}));
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
	vi.mocked(api.stopRuntime).mockResolvedValue({ ok: true });
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

async function mountCommandComposer(commands: CommandDto[]) {
	vi.mocked(api.commands).mockResolvedValueOnce({ commands });
	const baseStore = makeStore() as any;
	const store = {
		...baseStore,
		sessions: { k1: createSessionViewState("k1") },
		fleet: () => ({
			runtimes: commands.some((command) => command.name === "scoped-models") ? [runtimeInfo("k1")] : [],
			diskSessions: [],
		}),
		hydrateSession: vi.fn(async () => {}),
		refreshDiskSessions: vi.fn(async () => {}),
		removeRuntime: vi.fn(async () => {}),
		stopRuntime: vi.fn(async () => {}),
		navigate: vi.fn(),
	};
	const element = mount(() => <SessionScreen store={store} sessionKey="k1" />);
	await new Promise((resolve) => setTimeout(resolve, 10));
	return { element, store, textarea: element.querySelector("textarea") as HTMLTextAreaElement };
}

async function submitComposer(textarea: HTMLTextAreaElement, text: string): Promise<void> {
	textarea.value = text;
	textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
	textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 10));
}

function runtimeInfo(key: string, cwd = "/home/test/project"): RuntimeInfoDto {
	return {
		key,
		cwd,
		state: {
			sessionId: key,
			tasks: [],
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
		createdAt: new Date(0).toISOString(),
		lastActivity: new Date(0).toISOString(),
	};
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

	it("constrains a long remote device label while preserving its full text", async () => {
		const device = "phone.a-very-long-tailnet-name.ts.net";
		vi.mocked(api.auth).mockResolvedValueOnce({
			mode: "remote",
			needsPairing: false,
			identity: "alice@example.com",
			device,
		});
		const store = makeStore();
		await store.start();
		const el = mount(() => <Topbar store={store} active="fleet" />);
		const badge = el.querySelector(".mode-badge");
		const label = `remote · ${device} via tailscale`;
		expect(badge?.getAttribute("title")).toBe(label);
		expect(badge?.querySelector(".mode-badge-text")?.textContent).toBe(label);
		store.stop();
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

	it("session banners collect fallback, status, and toast sources with independent dismissal", async () => {
		const runtime = runtimeInfo("banner-sources");
		runtime.state.modelFallbackMessage = "fallback model is active";
		vi.mocked(api.fleet).mockResolvedValueOnce({ runtimes: [runtime], diskSessions: [] });
		vi.mocked(api.hydrate).mockResolvedValueOnce({
			key: runtime.key,
			state: runtime.state,
			messages: [],
			backgroundAgents: [],
			barrierSeq: 0,
		});
		let captured: EventStreamHandlers | undefined;
		vi.mocked(connectEvents).mockImplementation((handlers) => {
			captured = handlers;
			return () => {};
		});
		window.location.hash = `#/session/${runtime.key}`;
		const store = makeStore();
		await store.start();
		const el = mount(() => <SessionScreen store={store} sessionKey={runtime.key} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		if (!captured) throw new Error("connectEvents was not called");

		captured.onEnvelope({
			seq: 1,
			key: runtime.key,
			event: {
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "provider failed terminally",
					content: [],
				},
			},
		});
		captured.onEnvelope({ seq: 2, key: runtime.key, event: { type: "extension_error", error: "plugin exploded" } });

		const banner = (key: string) => el.querySelector<HTMLElement>(`[data-banner-key="${key}"]`);
		const status = store.sessions[runtime.key]?.statusEntries.find(
			(entry) => entry.text === "provider failed terminally",
		);
		const toast = store.sessions[runtime.key]?.toasts.find(
			(entry) => entry.text === "extension error: plugin exploded",
		);
		if (!status || !toast) throw new Error("expected status and toast banner sources");
		expect(banner("fallback")?.textContent).toContain("fallback model is active");
		expect(banner(`status:${status.id}`)?.textContent).toContain("provider failed terminally");
		expect(banner(`toast:${toast.id}`)?.textContent).toContain("extension error: plugin exploded");

		banner("fallback")?.querySelector<HTMLButtonElement>(".banner-dismiss")?.click();
		expect(banner("fallback")).toBeNull();
		expect(banner(`status:${status.id}`)).not.toBeNull();
		expect(banner(`toast:${toast.id}`)).not.toBeNull();

		banner(`status:${status.id}`)?.querySelector<HTMLButtonElement>(".banner-dismiss")?.click();
		expect(store.sessions[runtime.key]?.statusEntries.find((entry) => entry.id === status.id)?.dismissed).toBe(true);
		expect(store.sessions[runtime.key]?.needsAttention).toBe(true);
		expect(banner(`status:${status.id}`)).toBeNull();
		expect(banner(`toast:${toast.id}`)).not.toBeNull();

		banner(`toast:${toast.id}`)?.querySelector<HTMLButtonElement>(".banner-dismiss")?.click();
		expect(store.sessions[runtime.key]?.toasts).toHaveLength(0);
		expect(banner(`toast:${toast.id}`)).toBeNull();
	});

	it("viewed session toasts render as banners instead of app-global toasts", async () => {
		const runtime = runtimeInfo("app-viewed-toast");
		vi.mocked(api.fleet).mockResolvedValueOnce({ runtimes: [runtime], diskSessions: [] });
		let captured: EventStreamHandlers | undefined;
		vi.mocked(connectEvents).mockImplementation((handlers) => {
			captured = handlers;
			return () => {};
		});
		window.location.hash = `#/session/${runtime.key}`;
		const el = mount(() => <App />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		if (!captured) throw new Error("connectEvents was not called");

		captured.onEnvelope({
			seq: 1,
			key: runtime.key,
			event: { type: "extension_error", error: "visible only in transcript chrome" },
		});

		expect(el.querySelector('[data-banner-key^="toast:"]')?.textContent).toContain(
			"extension error: visible only in transcript chrome",
		);
		expect(el.querySelector(".toast-region .toast")).toBeNull();
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
				backgroundAgents: [
					{
						agentId: "resynced-route",
						agentType: "feature-dev",
						taskSummary: "resynced routing",
						startedAt: new Date().toISOString(),
						status: "completed",
						arbitrations: [
							{
								status: "success",
								proposed: { agent: "Explore", model: "provider/frontier", thinking: "high" },
								final: { agent: "feature-dev", model: "provider/cheap", thinking: "low" },
								changed: ["agent", "model", "thinking"],
							},
						],
					},
				],
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
		expect(store.sessions["k-resync"]?.backgroundAgents["resynced-route"]).toMatchObject({
			agentType: "feature-dev",
			arbitrations: [{ final: { agent: "feature-dev", model: "provider/cheap", thinking: "low" } }],
		});
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

	it("fleet creates a new session without leaving the fleet", async () => {
		const store = makeStore() as any;
		const upsertRuntime = vi.fn();
		const refreshDiskSessions = vi.fn(async () => {});
		const navigate = vi.fn();
		const el = mount(() => <FleetScreen store={{ ...store, upsertRuntime, refreshDiskSessions, navigate }} />);

		[...el.querySelectorAll("button")].find((button) => button.textContent?.includes("new session"))?.click();
		const cwd = el.querySelector<HTMLInputElement>("#new-session-cwd");
		if (!cwd) throw new Error("new-session cwd input missing");
		cwd.value = "/workspace/new-project";
		cwd.dispatchEvent(new InputEvent("input", { bubbles: true }));
		[...el.querySelectorAll("button")].find((button) => button.textContent === "start session")?.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.createRuntime).toHaveBeenCalledWith("/workspace/new-project", { firstPrompt: undefined });
		expect(upsertRuntime).toHaveBeenCalledWith(expect.objectContaining({ key: "new-key" }));
		expect(refreshDiskSessions).toHaveBeenCalledOnce();
		expect(navigate).not.toHaveBeenCalled();
		expect(el.querySelector(".modal")).toBeNull();
	});

	it("fleet renders a terminal provider error chip and reason", () => {
		const store = makeStore() as any;
		const runtime = runtimeInfo("provider-error");
		runtime.error = "provider API unavailable";
		runtime.needsAttention = true;
		const fakeStore = {
			...store,
			sessions: {},
			fleet: () => ({ runtimes: [runtime], diskSessions: [] }),
		};

		const el = mount(() => <FleetScreen store={fakeStore} />);

		expect(el.querySelector(".session-card .chip-error")?.textContent).toContain("error");
		expect(el.querySelector(".error-reason")?.textContent).toBe("provider API unavailable");
	});

	it("fleet treats retry backoff as running work", () => {
		const store = makeStore() as any;
		const runtime = runtimeInfo("retrying");
		runtime.state.isRetrying = true;
		runtime.state.retryAttempt = 1;
		const fakeStore = {
			...store,
			sessions: {},
			fleet: () => ({ runtimes: [runtime], diskSessions: [] }),
		};

		const el = mount(() => <FleetScreen store={fakeStore} />);

		expect(el.querySelector(".session-card .chip-running")?.textContent).toContain("running");
	});

	it("session view renders with a populated transcript and session info bar", async () => {
		vi.mocked(api.branch).mockResolvedValue({ branch: "feature/info" });
		vi.mocked(api.dailyCost).mockResolvedValue({ cost: 1.25 });
		vi.mocked(api.performance).mockResolvedValue({
			models: [
				performanceSummary({ rolling: { count: 4 }, delta: { baselineCount: 4, recentCount: 4 } }),
				performanceSummary({ modelId: "other-model", rolling: { median: 99 } }),
			],
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
		expect(el.textContent).toContain("~42 tok/s [4] · 10% ↑ median [4]");
		expect(el.textContent).not.toContain("99 tok/s");
		expect(el.textContent).toContain("test/test-model");
		expect(el.textContent).toContain("scan things");
		// Suggest-next chip
		expect(el.textContent).toContain("/skill:test");
	});

	it("keeps mounted header details live and refreshes context when compaction ends", async () => {
		const baseStore = makeStore() as any;
		const session = createSessionViewState("live");
		session.compacting = true;
		const [sessions, setSessions] = createStore({ live: session });
		const runtime = runtimeInfo("live");
		runtime.state.model = { provider: "test", id: "old-model" };
		runtime.state.contextUsage = { tokens: null, contextWindow: 200_000, percent: null };
		const [fleet, setFleet] = createSignal({ runtimes: [runtime], diskSessions: [] });
		const detailStats = (tokens: number, percent: number) => ({
			sessionId: "live",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 2,
			tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
			cost: 0.1,
			contextUsage: { tokens, contextWindow: 200_000, percent },
		});
		const refreshRuntimeStats = vi
			.fn()
			.mockResolvedValueOnce(detailStats(50_000, 25))
			.mockResolvedValueOnce(detailStats(20_000, 10));
		const fakeStore = {
			...baseStore,
			sessions,
			fleet,
			hydrateSession: vi.fn(async () => {}),
			refreshRuntimeStats,
		};

		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="live" />);
		await vi.waitFor(() => expect(el.querySelector(".session-bar output.switcher")?.textContent).toContain("25%"));
		expect(el.textContent).not.toContain("ctx ?");

		setFleet((current) => ({
			...current,
			runtimes: current.runtimes.map((item) =>
				item.key === "live"
					? { ...item, state: { ...item.state, model: { provider: "test", id: "live-model" } } }
					: item,
			),
		}));
		await vi.waitFor(() => expect(el.textContent).toContain("test/live-model"));

		refreshRuntimeStats.mockClear();
		setSessions("live", "compacting", false);
		await vi.waitFor(() => expect(refreshRuntimeStats).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(el.querySelector(".session-bar output.switcher")?.textContent).toContain("10%"));

		refreshRuntimeStats.mockClear();
		refreshRuntimeStats.mockRejectedValueOnce(new Error("stats unavailable"));
		setSessions("live", "compacting", true);
		await Promise.resolve();
		setSessions("live", "compacting", false);
		await vi.waitFor(() => expect(refreshRuntimeStats).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(el.textContent).toContain("stats unavailable"));
		expect(el.querySelector(".session-bar output.switcher")?.textContent).toContain("10%");
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

	it("ask_user wizard: native checkboxes + free text combine into one answers[] entry", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask");
		session.uiRequests = [
			{
				id: "a1",
				method: "ask",
				title: "Choose validation",
				questions: [
					{
						question: "Which **checks**?\n\nUse `fast` validation.",
						options: ["unit", "browser"],
						multiSelect: true,
						allowFreeText: true,
					},
				],
			},
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const question = el.querySelector(".ask-question-body");
		expect(question?.querySelector("strong")?.textContent).toBe("checks");
		expect(question?.querySelector("code")?.textContent).toBe("fast");
		expect(question?.textContent).not.toContain("**");
		// ask_user renders inline in the transcript flow (scrollable), not as a
		// blocking modal overlay.
		expect(el.querySelector(".chat-inner .ask-wizard")).not.toBeNull();
		expect(el.querySelector(".modal-backdrop")).toBeNull();
		const checkboxes = el.querySelectorAll<HTMLInputElement>('.ask-option input[type="checkbox"]');
		expect(checkboxes.length).toBe(2);
		expect(el.querySelector('.ask-option input[type="radio"]')).toBeNull();

		checkboxes[0].click(); // check "unit"
		const custom = el.querySelector<HTMLInputElement>('input[id^="ask-custom-"]');
		if (!custom) throw new Error("free-text field missing");
		custom.value = "lint";
		custom.dispatchEvent(new Event("input", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		const submit = [...el.querySelectorAll("button")].find((b) => b.textContent === "submit");
		submit?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(vi.mocked(api.extensionUiResponse)).toHaveBeenCalledWith(
			"k-ask",
			expect.objectContaining({
				type: "extension_ui_response",
				id: "a1",
				answers: [expect.objectContaining({ selected: ["unit"], customText: "lint" })],
			}),
		);
	});

	it("ask_user wizard: N>=2 renders a tab strip with answered-state markers and a Submit tab", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-tabs");
		session.uiRequests = [
			{
				id: "multi",
				method: "ask",
				title: "Setup",
				questions: [
					{ question: "Q one?", title: "First question", options: ["A", "B"] },
					{ question: "Q two?", title: "Second question", options: ["C", "D"] },
					{ question: "Q three?", title: "Third question", options: ["E", "F"] },
				],
			},
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask-tabs": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-tabs" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		// A tab strip with one button per question plus a trailing Submit tab.
		const tabs = el.querySelectorAll<HTMLButtonElement>(".ask-tab-strip .ask-tab");
		expect(tabs.length).toBe(4);
		expect(tabs[0].textContent).toContain("First question");
		expect(tabs[2].textContent).toContain("Third question");
		expect(tabs[3].textContent).toContain("Submit");

		// Every question starts unanswered (no answered class, no check).
		const questionTabs = [...tabs].filter((t) => !t.classList.contains("ask-tab-submit"));
		expect(questionTabs.every((t) => !t.classList.contains("answered"))).toBe(true);
		expect(el.querySelectorAll(".ask-tab-check").length).toBe(0);

		// All question panels + the review panel are mounted (so their state
		// persists) but only the active question is visible.
		const panels = el.querySelectorAll(".ask-tab-panel");
		expect(panels.length).toBe(4);
		const visible = [...panels].filter((p) => !p.classList.contains("hidden"));
		expect(visible.length).toBe(1);

		// Answering the active question marks its tab answered (class + trailing check).
		el.querySelectorAll<HTMLInputElement>('.ask-option input[type="radio"]')[0].click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const answeredTabs = el.querySelectorAll<HTMLButtonElement>(".ask-tab-strip .ask-tab");
		expect(answeredTabs[0].classList.contains("answered")).toBe(true);
		expect(answeredTabs[0].querySelector(".ask-tab-check")).not.toBeNull();
	});

	it("ask_user wizard: clicking a tab switches the active question", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-switch");
		session.uiRequests = [
			{
				id: "switch",
				method: "ask",
				title: "Setup",
				questions: [
					{ question: "First body", title: "Alpha", options: ["A", "B"] },
					{ question: "Second body", title: "Beta", options: ["C", "D"] },
				],
			},
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask-switch": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-switch" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const tabs = el.querySelectorAll<HTMLButtonElement>(".ask-tab-strip .ask-tab");
		// First question active by default.
		expect(tabs[0].getAttribute("aria-selected")).toBe("true");
		let activePanel = [...el.querySelectorAll(".ask-tab-panel")].find((p) => !p.classList.contains("hidden"));
		expect(activePanel?.textContent).toContain("First body");

		tabs[1].click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(tabs[1].getAttribute("aria-selected")).toBe("true");
		activePanel = [...el.querySelectorAll(".ask-tab-panel")].find((p) => !p.classList.contains("hidden"));
		expect(activePanel?.textContent).toContain("Second body");
	});

	it("ask_user wizard: free-text drafts persist across tabs and submit in question order", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-text-tabs");
		session.uiRequests = [
			{
				id: "text-tabs",
				method: "ask",
				title: "Setup",
				questions: [
					{ question: "First details?", title: "First", allowFreeText: true },
					{ question: "Second details?", title: "Second", multiline: true },
				],
			},
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask-text-tabs": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		vi.mocked(api.extensionUiResponse).mockClear();
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-text-tabs" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const tabs = el.querySelectorAll<HTMLButtonElement>(".ask-tab-strip .ask-tab");
		const first = el.querySelector<HTMLInputElement>("#ask-custom-text-tabs-0");
		expect(first).not.toBeNull();
		first!.value = "first detail";
		first!.dispatchEvent(new Event("input", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		tabs[1].click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = el.querySelector<HTMLTextAreaElement>("#ask-custom-text-tabs-1");
		expect(second).not.toBeNull();
		second!.value = "second detail";
		second!.dispatchEvent(new Event("input", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		tabs[0].click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(first!.value).toBe("first detail");
		tabs[1].click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(second!.value).toBe("second detail");

		tabs[2].click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const submitAll = [...el.querySelectorAll("button")].find((button) => button.textContent === "Submit all");
		submitAll?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(vi.mocked(api.extensionUiResponse)).toHaveBeenCalledWith(
			"k-ask-text-tabs",
			expect.objectContaining({
				type: "extension_ui_response",
				id: "text-tabs",
				answers: [
					expect.objectContaining({ selected: [], customText: "first detail" }),
					expect.objectContaining({ selected: [], customText: "second detail" }),
				],
			}),
		);
	});

	it("ask_user wizard: ArrowRight/ArrowLeft/Tab navigate tabs with wrap-around", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-kbnav");
		session.uiRequests = [
			{
				id: "kbnav",
				method: "ask",
				title: "Setup",
				questions: [
					{ question: "First body", title: "Alpha", options: ["A", "B"] },
					{ question: "Second body", title: "Beta", options: ["C", "D"] },
				],
			},
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask-kbnav": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-kbnav" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Tabs: [question 0, question 1, Submit/review] → indices 0,1,2.
		const activeIndex = () =>
			[...el.querySelectorAll<HTMLButtonElement>(".ask-tab-strip .ask-tab")].findIndex(
				(t) => t.getAttribute("aria-selected") === "true",
			);
		const key = async (k: string) => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: k }));
			await new Promise((resolve) => setTimeout(resolve, 0));
		};

		expect(activeIndex()).toBe(0);
		await key("ArrowRight");
		expect(activeIndex()).toBe(1);
		await key("ArrowRight");
		expect(activeIndex()).toBe(2); // Submit/review tab
		await key("ArrowRight");
		expect(activeIndex()).toBe(0); // wraps forward past the review tab
		await key("ArrowLeft");
		expect(activeIndex()).toBe(2); // wraps backward to the review tab
		await key("Tab");
		expect(activeIndex()).toBe(0); // Tab advances and wraps
	});

	it("ask_user wizard: digit/Enter typed into a text field do not toggle options or submit", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-defer");
		session.uiRequests = [
			{
				id: "defer",
				method: "ask",
				title: "Setup",
				questions: [{ question: "Pick one", title: "Solo", options: ["A", "B"], multiline: true }],
			},
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask-defer": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		vi.mocked(api.extensionUiResponse).mockClear();
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-defer" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const textarea = el.querySelector<HTMLTextAreaElement>(".ask-custom-field textarea");
		expect(textarea).not.toBeNull();

		// A digit typed into the free-text field must NOT toggle option 2.
		textarea?.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const options = el.querySelectorAll<HTMLInputElement>(".ask-option input");
		expect([...options].some((o) => o.checked)).toBe(false);

		// Enter inside the textarea must NOT submit the single-question wizard.
		textarea?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(vi.mocked(api.extensionUiResponse)).not.toHaveBeenCalled();
	});

	it("ask_user wizard: single-question Enter submits only from its own field, not Stop or outside inputs", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-enter-scope");
		session.uiRequests = [
			{
				id: "enter-scope",
				method: "ask",
				title: "Solo",
				questions: [{ question: "Only one?", options: ["A", "B"], allowFreeText: true }],
			},
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask-enter-scope": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		vi.mocked(api.extensionUiResponse).mockClear();
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-enter-scope" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const fire = async (target: EventTarget, key: string) => {
			target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
			await new Promise((resolve) => setTimeout(resolve, 0));
		};

		// Enter on the wizard's own Stop button must NOT submit a skipped answer —
		// the button keeps its native Enter-to-click (abort) behavior instead.
		const stop = [...el.querySelectorAll("button")].find((b) => b.textContent === "■ stop agent");
		expect(stop).toBeTruthy();
		await fire(stop!, "Enter");
		expect(vi.mocked(api.extensionUiResponse)).not.toHaveBeenCalled();

		// Enter on an unrelated single-line input elsewhere on the page (e.g. the
		// model filter or rename field) must be left completely alone.
		const outside = document.createElement("input");
		outside.type = "text";
		document.body.appendChild(outside);
		await fire(outside, "Enter");
		expect(vi.mocked(api.extensionUiResponse)).not.toHaveBeenCalled();
		outside.remove();

		// Enter from the wizard's OWN single-line answer field does submit.
		const field = el.querySelector<HTMLInputElement>('input[id^="ask-custom-"]');
		expect(field).toBeTruthy();
		field!.value = "typed answer";
		field!.dispatchEvent(new Event("input", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await fire(field!, "Enter");
		expect(vi.mocked(api.extensionUiResponse)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(api.extensionUiResponse)).toHaveBeenCalledWith(
			"k-ask-enter-scope",
			expect.objectContaining({
				type: "extension_ui_response",
				id: "enter-scope",
				answers: [expect.objectContaining({ customText: "typed answer" })],
			}),
		);
	});

	it("ask_user wizard: arrow/Tab in a focused field do not switch tabs (N>=2)", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-kbnav-field");
		session.uiRequests = [
			{
				id: "kbnav-field",
				method: "ask",
				title: "Setup",
				questions: [
					{ question: "First body", title: "Alpha", options: ["A", "B"], allowFreeText: true },
					{ question: "Second body", title: "Beta", multiline: true },
				],
			},
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask-kbnav-field": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-kbnav-field" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const activeIndex = () =>
			[...el.querySelectorAll<HTMLButtonElement>(".ask-tab-strip .ask-tab")].findIndex(
				(t) => t.getAttribute("aria-selected") === "true",
			);
		const fireFrom = async (target: EventTarget, k: string) => {
			target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
			await new Promise((resolve) => setTimeout(resolve, 0));
		};

		// Start on the first question tab.
		expect(activeIndex()).toBe(0);

		// A focused single-line input on question 0: arrows move the caret and Tab
		// does its normal thing — none may switch the active wizard tab.
		const input = el.querySelector<HTMLInputElement>('input[id^="ask-custom-"]');
		expect(input).toBeTruthy();
		await fireFrom(input!, "ArrowLeft");
		expect(activeIndex()).toBe(0);
		await fireFrom(input!, "ArrowRight");
		expect(activeIndex()).toBe(0);
		await fireFrom(input!, "Tab");
		expect(activeIndex()).toBe(0);

		// Switch to question 1 (a multiline textarea) and repeat from the textarea.
		const tabs = el.querySelectorAll<HTMLButtonElement>(".ask-tab-strip .ask-tab");
		tabs[1].click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(activeIndex()).toBe(1);

		const textarea = el.querySelector<HTMLTextAreaElement>(".ask-custom-field textarea");
		expect(textarea).toBeTruthy();
		await fireFrom(textarea!, "ArrowLeft");
		expect(activeIndex()).toBe(1);
		await fireFrom(textarea!, "ArrowRight");
		expect(activeIndex()).toBe(1);
		await fireFrom(textarea!, "Tab");
		expect(activeIndex()).toBe(1);
	});

	it("ask_user wizard: digit keys toggle options and Submit all sends one answer per question", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-digits");
		session.uiRequests = [
			{
				id: "digits",
				method: "ask",
				title: "Setup",
				questions: [
					{ question: "First?", title: "One", options: ["A", "B"] },
					{ question: "Second?", title: "Two", options: ["C", "D"] },
				],
			},
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask-digits": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		vi.mocked(api.extensionUiResponse).mockClear();
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-digits" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Digit "2" selects the second option of the active (first) question.
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Switch to the second question and pick its first option.
		const tabs = el.querySelectorAll<HTMLButtonElement>(".ask-tab-strip .ask-tab");
		tabs[1].click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Move to the review tab and submit everything.
		tabs[2].click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const submitAll = [...el.querySelectorAll("button")].find((b) => b.textContent === "Submit all");
		submitAll?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(vi.mocked(api.extensionUiResponse)).toHaveBeenCalledWith(
			"k-ask-digits",
			expect.objectContaining({
				type: "extension_ui_response",
				id: "digits",
				answers: [expect.objectContaining({ selected: ["B"] }), expect.objectContaining({ selected: ["C"] })],
			}),
		);
	});

	it("ask_user wizard: review panel summarizes answers and marks unanswered questions", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-review");
		session.uiRequests = [
			{
				id: "review",
				method: "ask",
				title: "Setup",
				questions: [
					{ question: "First?", title: "One", options: ["A", "B"] },
					{ question: "Second?", title: "Two", options: ["C", "D"] },
				],
			},
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask-review": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		vi.mocked(api.extensionUiResponse).mockClear();
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-review" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Answer only the first question, then open the review tab.
		el.querySelectorAll<HTMLInputElement>('.ask-option input[type="radio"]')[0].click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const tabs = el.querySelectorAll<HTMLButtonElement>(".ask-tab-strip .ask-tab");
		tabs[2].click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		const items = el.querySelectorAll(".ask-review-item");
		expect(items.length).toBe(2);
		expect(items[0].querySelector(".ask-review-answer")?.textContent).toContain("A");
		expect(items[1].querySelector(".ask-review-answer.muted")?.textContent).toContain("(unanswered)");

		// Submitting marks the unanswered second question as skipped.
		const submitAll = [...el.querySelectorAll("button")].find((b) => b.textContent === "Submit all");
		submitAll?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(vi.mocked(api.extensionUiResponse)).toHaveBeenCalledWith(
			"k-ask-review",
			expect.objectContaining({
				id: "review",
				answers: [
					expect.objectContaining({ selected: ["A"] }),
					expect.objectContaining({ selected: [], skipped: true }),
				],
			}),
		);
	});

	it("ask_user wizard: a single-question request shows no tab strip", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-one");
		session.uiRequests = [
			{ id: "o1", method: "ask", title: "Solo", questions: [{ question: "Only one?", options: ["A", "B"] }] },
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask-one": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-one" />);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(el.querySelector(".ask-tab-strip")).toBeNull();
		expect(el.querySelector(".ask-wizard")).not.toBeNull();
		expect(el.querySelector(".ask-question")).not.toBeNull();
	});

	it("ask_user dialog: single-select keeps stop-agent accessible in the mobile question card", async () => {
		stubMobile(true);
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask2");
		session.uiRequests = [
			{ id: "a2", method: "ask", title: "Pick", questions: [{ question: "Which one?", options: ["A", "B"] }] },
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask2": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		vi.mocked(api.abort).mockClear();
		vi.mocked(api.extensionUiResponse).mockClear();
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask2" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const radios = el.querySelectorAll<HTMLInputElement>('.ask-option input[type="radio"]');
		expect(radios.length).toBe(2);

		const stop = [...el.querySelectorAll("button")].find((button) => button.textContent === "■ stop agent");
		stop?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(vi.mocked(api.abort)).toHaveBeenCalledWith("k-ask2");
		expect(vi.mocked(api.extensionUiResponse)).not.toHaveBeenCalled();
	});

	it("keeps the stop-agent action available when aborting fails", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-stop-retry");
		session.uiRequests = [
			{
				id: "a-stop-retry",
				method: "ask",
				title: "Retry",
				questions: [{ question: "Still there?", options: ["A", "B"] }],
			},
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask-stop-retry": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		vi.mocked(api.abort).mockClear();
		vi.mocked(api.abort).mockRejectedValueOnce(new Error("offline"));
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-stop-retry" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const stop = [...el.querySelectorAll("button")].find((button) => button.textContent === "■ stop agent");
		stop?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(el.querySelector(".ask-wizard")).not.toBeNull();
		expect(el.textContent).toContain("offline");
		expect(stop?.disabled).toBe(false);

		vi.mocked(api.abort).mockResolvedValueOnce({});
		stop?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(vi.mocked(api.abort)).toHaveBeenCalledTimes(2);
	});

	it("retains a selected + typed answer across a failed send and resends it on retry", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-state");
		session.uiRequests = [
			{
				id: "a-state",
				method: "ask",
				title: "Pick",
				questions: [{ question: "Which?", options: ["A", "B"], allowFreeText: true }],
			},
		];
		const resolveUiRequest = vi.fn();
		const fakeStore = {
			...store,
			sessions: { "k-ask-state": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
			resolveUiRequest,
		};
		vi.mocked(api.extensionUiResponse).mockClear();
		vi.mocked(api.extensionUiResponse).mockRejectedValueOnce(new Error("offline"));
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-state" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Choose an option and type free text, then fail the send.
		const radio = el.querySelector<HTMLInputElement>('.ask-option input[type="radio"]');
		if (!radio) throw new Error("radio missing");
		radio.click();
		const custom = el.querySelector<HTMLInputElement>('input[id^="ask-custom-"]');
		if (!custom) throw new Error("free-text field missing");
		custom.value = "extra";
		custom.dispatchEvent(new Event("input", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		const submitButton = () => [...el.querySelectorAll("button")].find((b) => b.textContent === "submit");
		submitButton()?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Failure keeps the question and preserves the entered answer state.
		expect(resolveUiRequest).not.toHaveBeenCalled();
		expect(el.querySelector(".ask-wizard")).not.toBeNull();
		expect(el.querySelector<HTMLInputElement>('.ask-option input[type="radio"]')?.checked).toBe(true);
		expect(el.querySelector<HTMLInputElement>('input[id^="ask-custom-"]')?.value).toBe("extra");

		// Retry succeeds and sends the same retained answer, not a stateless skip.
		vi.mocked(api.extensionUiResponse).mockResolvedValueOnce({ ok: true });
		submitButton()?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(vi.mocked(api.extensionUiResponse)).toHaveBeenLastCalledWith(
			"k-ask-state",
			expect.objectContaining({
				id: "a-state",
				answers: [expect.objectContaining({ selected: ["A"], customText: "extra" })],
			}),
		);
		expect(resolveUiRequest).toHaveBeenCalledWith("k-ask-state", "a-state");
	});

	it("suppresses duplicate sends while a response POST is still in flight", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-dedup");
		session.uiRequests = [
			{ id: "a-dedup", method: "ask", title: "Pick", questions: [{ question: "Which?", options: ["A", "B"] }] },
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask-dedup": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		vi.mocked(api.extensionUiResponse).mockClear();
		let release!: () => void;
		vi.mocked(api.extensionUiResponse).mockReturnValueOnce(
			new Promise((resolve) => {
				release = () => resolve({ ok: true });
			}),
		);
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-dedup" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const radio = el.querySelector<HTMLInputElement>('.ask-option input[type="radio"]');
		if (!radio) throw new Error("radio missing");
		radio.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		const submitButton = () => [...el.querySelectorAll("button")].find((b) => b.textContent === "submit");
		// Three rapid clicks while the first POST is still pending.
		submitButton()?.click();
		submitButton()?.click();
		submitButton()?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(vi.mocked(api.extensionUiResponse)).toHaveBeenCalledTimes(1);
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it("stops the agent when Escape is pressed and shows a timeout countdown", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-esc");
		session.uiRequests = [
			{
				id: "a-esc",
				method: "ask",
				title: "Pick",
				questions: [{ question: "Which?", options: ["A", "B"] }],
				timeout: 30_000,
			},
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask-esc": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		vi.mocked(api.abort).mockClear();
		vi.mocked(api.extensionUiResponse).mockClear();
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-esc" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		// A visible auto-stop countdown mirrors the TUI.
		expect(el.textContent).toContain("auto-stops in");

		// Escape stops the whole turn, matching the explicit card action.
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(vi.mocked(api.abort)).toHaveBeenCalledWith("k-ask-esc");
		expect(vi.mocked(api.extensionUiResponse)).not.toHaveBeenCalled();
	});

	it("auto-stops an ask request exactly once when the client-side countdown reaches zero", async () => {
		vi.useFakeTimers();
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-timeout");
		session.uiRequests = [
			{
				id: "a-timeout",
				method: "ask",
				title: "Pick",
				questions: [{ question: "Which?", options: ["A", "B"] }],
				timeout: 30_000,
			},
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask-timeout": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		vi.mocked(api.abort).mockClear();
		vi.mocked(api.extensionUiResponse).mockClear();
		mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-timeout" />);
		await vi.advanceTimersByTimeAsync(0);

		// Not yet fired one tick before the deadline.
		await vi.advanceTimersByTimeAsync(29_000);
		expect(vi.mocked(api.abort)).not.toHaveBeenCalled();

		// The countdown backstop stops the whole turn exactly once at zero.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(vi.mocked(api.abort)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(api.abort)).toHaveBeenCalledWith("k-ask-timeout");
		expect(vi.mocked(api.extensionUiResponse)).not.toHaveBeenCalled();

		// clearInterval on fire prevents any repeated stop request.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(vi.mocked(api.abort)).toHaveBeenCalledTimes(1);
	});

	it("uses the authoritative remaining deadline after a timed ask is recovered", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-30T18:00:00Z"));
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-recovered-timeout");
		session.uiRequests = [
			{
				id: "a-recovered-timeout",
				method: "ask",
				title: "Pick",
				questions: [{ question: "Which?", options: ["A", "B"] }],
				timeout: 30_000,
				// Twenty-five seconds elapsed before reload; only five remain.
				expiresAt: Date.now() + 5_000,
			},
		];
		const fakeStore = {
			...store,
			sessions: { "k-ask-recovered-timeout": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		vi.mocked(api.abort).mockClear();
		vi.mocked(api.extensionUiResponse).mockClear();
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-recovered-timeout" />);
		await vi.advanceTimersByTimeAsync(0);

		expect(el.textContent).toContain("auto-stops in 5s");
		await vi.advanceTimersByTimeAsync(4_000);
		expect(vi.mocked(api.abort)).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(vi.mocked(api.abort)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(api.abort)).toHaveBeenCalledWith("k-ask-recovered-timeout");
		expect(vi.mocked(api.extensionUiResponse)).not.toHaveBeenCalled();
	});

	it("ask_user tool card stays collapsed while running (unlike other running tools)", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-ask-collapse");
		session.entries = [
			{
				kind: "tool",
				toolCallId: "ask-tc",
				toolName: "ask_user",
				args: { title: "Favorite Composer", options: ["Bach", "Mozart"] },
				status: "running",
				resultText: "",
				startedAt: Date.now(),
			},
			{
				kind: "tool",
				toolCallId: "bash-tc",
				toolName: "bash",
				args: { command: "pwd" },
				status: "running",
				resultText: "",
				startedAt: Date.now(),
			},
		] as any;
		const fakeStore = {
			...store,
			sessions: { "k-ask-collapse": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-ask-collapse" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const cards = [...el.querySelectorAll<HTMLDetailsElement>("details.tool")];
		const askCard = cards.find((c) => c.querySelector(".tool-name")?.textContent === "ask_user");
		const bashCard = cards.find((c) => c.querySelector(".tool-name")?.textContent === "bash");
		if (!askCard || !bashCard) throw new Error("expected both tool cards to render");
		// The still-running ask_user card is collapsed; a normal running tool (bash) auto-opens.
		expect(askCard.open).toBe(false);
		expect(bashCard.open).toBe(true);
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

	it("keeps dock panels together and the composer outside their scroll wrapper", () => {
		const store = makeStore() as any;
		const session = populatedSession("k-dock-layout");
		const fakeStore = {
			...store,
			sessions: { "k-dock-layout": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-dock-layout" />);
		const dockInner = el.querySelector(".dock-inner");
		const dockPanels = dockInner?.querySelector(".dock-panels");
		const composer = dockInner?.querySelector(".composer");

		expect(dockPanels?.parentElement).toBe(dockInner);
		expect(dockPanels?.querySelector("details.tasks:not(.subagents)")).not.toBeNull();
		expect(dockPanels?.querySelector("details.subagents")).not.toBeNull();
		expect(dockPanels?.querySelector(".status-line")).not.toBeNull();
		expect(composer?.parentElement).toBe(dockInner);
		expect(dockPanels?.contains(composer ?? null)).toBe(false);
	});

	it("in-session subagent panel collapses with the task-tracker details pattern", () => {
		const store = makeStore() as any;
		const session = populatedSession("k-subpanel");
		const fakeStore = {
			...store,
			sessions: { "k-subpanel": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-subpanel" />);
		const panel = el.querySelector("details.subagents") as HTMLDetailsElement;
		expect(panel).not.toBeNull();
		expect(panel.open).toBe(true);
		expect(panel.querySelector("summary")?.textContent).toContain("subagents — 1 running · 0 done");
		expect(el.textContent).toContain("scan things");

		setDetailsOpen(panel, false);
		expect(panel.open).toBe(false);
		// The count stays visible in the summary while collapsed
		expect(panel.querySelector("summary")?.textContent).toContain("subagents — 1 running · 0 done");
	});

	it("starts the subagent panel collapsed on mobile while keeping the count visible", () => {
		stubMobile(true);
		const store = makeStore() as any;
		const session = populatedSession("k-subpanel-mobile");
		const fakeStore = {
			...store,
			sessions: { "k-subpanel-mobile": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-subpanel-mobile" />);
		const panel = el.querySelector("details.subagents") as HTMLDetailsElement;
		expect(panel).not.toBeNull();
		expect(panel.open).toBe(false);
		expect(panel.querySelector("summary")?.textContent).toContain("subagents — 1 running · 0 done");
	});

	it("lists every subagent beyond the old four-agent cap, newest spawn first, with drill-in navigation", () => {
		const store = makeStore() as any;
		const session = createSessionViewState("k-submany");
		applySessionEvent(session, { type: "agent_start" });
		for (let i = 1; i <= 6; i++) {
			applySessionEvent(session, {
				type: "background_agent_start",
				agentId: `bg${i}`,
				agentType: "Explore",
				taskSummary: `task ${i}`,
				sessionDir: "/dir",
			});
		}
		for (let i = 2; i <= 6; i++) {
			applySessionEvent(session, {
				type: "background_agent_end",
				agentId: `bg${i}`,
				agentType: "Explore",
				success: true,
			});
		}
		// Pin distinct spawn times so the newest-first ordering is deterministic
		for (let i = 1; i <= 6; i++) {
			session.backgroundAgents[`bg${i}`]!.startedAt = new Date(1_000_000 + i * 1000).toISOString();
		}
		const navigate = vi.fn();
		const fakeStore = {
			...store,
			sessions: { "k-submany": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
			navigate,
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k-submany" />);
		const chips = el.querySelectorAll(".subagent-list .agent-chip");
		expect(chips).toHaveLength(6);
		expect(el.textContent).toContain("subagents — 1 running · 5 done");

		// Newest spawned at the top, oldest at the bottom
		expect(chips[0]?.textContent).toContain("task 6");
		expect(chips[5]?.textContent).toContain("task 1");

		(chips[0] as HTMLButtonElement).click();
		expect(navigate).toHaveBeenCalledWith({ screen: "subagent", key: "k-submany", agentId: "bg6" });
	});

	it("subagent drill-in renders completed transcripts read-only", () => {
		const store = makeStore() as any;
		const session = populatedSession("k1");
		applySessionEvent(session, {
			type: "subagent_arbitration",
			agentId: "bg1",
			status: "success",
			proposed: { agent: "Explore", model: "provider/frontier", thinking: "high" },
			final: { agent: "feature-dev", model: "provider/cheap", thinking: "low" },
			changed: ["agent", "model", "thinking"],
		});
		applySessionEvent(session, {
			type: "background_agent_event",
			agentId: "bg1",
			event: {
				type: "message_end",
				message: { role: "assistant", model: "haiku", content: [{ type: "text", text: "subagent says hi" }] },
			},
		});
		applySessionEvent(session, {
			type: "background_agent_end",
			agentId: "bg1",
			agentType: "feature-dev",
			success: true,
		});
		const fakeStore = {
			...store,
			sessions: { k1: session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
		};
		const el = mount(() => <SubagentScreen store={fakeStore} sessionKey="k1" agentId="bg1" />);
		expect(el.textContent).toContain("subagent says hi");
		expect(el.textContent).toContain("agent, model, thinking changed");
		expect(el.textContent).toContain("feature-dev · provider/cheap · low");
		expect(el.textContent).toContain("no longer running");
		expect(el.querySelector("textarea")).toBeNull();
	});

	it("closed subagents retain their transcript and all steering controls become read-only", () => {
		const store = makeStore() as any;
		const session = populatedSession("closed-subagent");
		applySessionEvent(session, {
			type: "background_agent_event",
			agentId: "bg1",
			event: {
				type: "message_end",
				message: {
					role: "assistant",
					model: "test",
					content: [{ type: "text", text: "closed child transcript remains" }],
				},
			},
		});
		session.closed = { cwd: "/repo", sessionFile: "/sessions/closed.jsonl" };
		const fakeStore = {
			...store,
			sessions: { "closed-subagent": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
		};

		const el = mount(() => <SubagentScreen store={fakeStore} sessionKey="closed-subagent" agentId="bg1" />);

		expect(el.textContent).toContain("closed child transcript remains");
		expect(el.textContent).toContain("subagent transcript is read-only");
		expect(el.querySelector('[data-banner-key="closed"]')?.textContent).toContain("Resume session");
		expect(el.querySelector('[data-banner-key="closed"]')?.textContent).toContain("Return to fleet");
		expect(el.querySelector("textarea")).toBeNull();
		expect(el.querySelector(".composer")).toBeNull();
		expect(el.querySelector("button.send")).toBeNull();
	});

	it("subagent drill-in sends unchanged steering text and shows the child queue mode", async () => {
		const store = makeStore() as any;
		const session = populatedSession("k-live-steer");
		applySessionEvent(session, {
			type: "background_agent_start",
			agentId: "bg-live",
			agentType: "Explore",
			taskSummary: "scan things",
		});
		const fakeStore = {
			...store,
			sessions: { "k-live-steer": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
		};
		vi.mocked(api.subagentPending).mockResolvedValue({
			steeringMode: "one-at-a-time",
			pending: { steering: ["first"], followUp: [] },
		});
		const el = mount(() => <SubagentScreen store={fakeStore} sessionKey="k-live-steer" agentId="bg-live" />);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea).not.toBeNull();
		expect(el.textContent).toContain("steering delivery: one-at-a-time");
		expect(el.textContent).toContain("steer: first");
		textarea.value = "Whatever the user wants";
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
		(el.querySelector("button.send") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(api.steerSubagent).toHaveBeenCalledWith("k-live-steer", "bg-live", "Whatever the user wants");
	});

	it("subagent drill-in renders failed arbitration with safe host metadata", () => {
		const store = makeStore() as any;
		const session = populatedSession("k-failed-arbitration");
		applySessionEvent(session, {
			type: "subagent_arbitration",
			agentId: "bg1",
			status: "failure",
			proposed: { agent: "Explore", model: "provider/frontier", thinking: "high" },
			final: null,
			changed: [],
			errorCode: "invalid_guide",
			errorMessage: "Routing guide coverage is stale.",
			rawResponse: "RAW ARBITER MODEL OUTPUT",
		});
		const fakeStore = {
			...store,
			sessions: { "k-failed-arbitration": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
		};

		const el = mount(() => <SubagentScreen store={fakeStore} sessionKey="k-failed-arbitration" agentId="bg1" />);

		expect(el.textContent).toContain("arbiter: failed — Routing guide coverage is stale.");
		expect(el.textContent).not.toContain("RAW ARBITER MODEL OUTPUT");
	});

	it("session hydration aborts on unmount without surfacing an error", async () => {
		let capturedSignal: AbortSignal | undefined;
		vi.mocked(api.hydrate).mockImplementation((_key: string, signal?: AbortSignal) => {
			capturedSignal = signal;
			return rejectOnAbort(signal);
		});
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
		vi.mocked(api.hydrate).mockRejectedValueOnce(new Error("hydrate exploded"));
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

	it("files creates a new session in the selected directory without refetching the fleet", async () => {
		vi.mocked(api.listFiles).mockResolvedValue({
			path: "/workspace/selected",
			entries: [],
			contextTrust: { canonicalTarget: "/workspace/selected", state: "untrusted" },
		});
		const runtime: Awaited<ReturnType<typeof api.createRuntime>> = {
			key: "created-here",
			cwd: "/workspace/selected",
			state: {
				sessionId: "created-here",
				tasks: [],
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
		};
		vi.mocked(api.createRuntime).mockResolvedValueOnce(runtime);
		const store = makeStore() as any;
		const upsertRuntime = vi.fn();
		const refreshDiskSessions = vi.fn(async () => {});
		const navigate = vi.fn();
		const el = mount(() => (
			<FilesScreen
				store={{ ...store, upsertRuntime, refreshDiskSessions, navigate }}
				initialPath="/workspace/selected"
			/>
		));
		await new Promise((resolve) => setTimeout(resolve, 10));
		vi.mocked(api.fleet).mockClear();

		[...el.querySelectorAll("button")].find((button) => button.textContent?.includes("new session here"))!.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.createRuntime).toHaveBeenCalledWith("/workspace/selected");
		expect(upsertRuntime).toHaveBeenCalledWith(runtime);
		expect(refreshDiskSessions).toHaveBeenCalledOnce();
		expect(navigate).not.toHaveBeenCalled();
		expect(api.fleet).not.toHaveBeenCalled();
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

	it("memories renders scopes, index warning, editor, conflict, and delete flow", async () => {
		vi.mocked(api.memoryListing).mockResolvedValueOnce({
			scope: { id: "global", kind: "global", label: "global", memoryDir: "/home/test/.dreb/memory", exists: true },
			indexContent: Array.from({ length: 201 }, (_, i) => `line ${i}`).join("\n"),
			indexRevision: "idx1",
			indexOverLimit: true,
			entries: [
				{
					file: "entry.md",
					metadata: { name: "Entry", description: "Test entry", type: "project" },
					modified: new Date().toISOString(),
					size: 64,
				},
			],
		});
		vi.mocked(api.saveMemoryDocument).mockRejectedValueOnce(
			Object.assign(new Error("Memory document is stale"), { status: 409 }),
		);
		const store = makeStore();
		const el = mount(() => <MemoriesScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(el.textContent).toContain("Edit dreb memory only");
		expect(el.textContent).toContain("Complete index warning");
		const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
		textarea.value = `${textarea.value}\nextra`;
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "extra" }));
		[...el.querySelectorAll("button")].find((button) => button.textContent === "save")!.click();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(el.textContent).toContain("Your draft is still here");

		const entryButton = [...el.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("entry.md"),
		)!;
		entryButton.click();
		await new Promise((resolve) => setTimeout(resolve, 20));
		entryButton.click();
		expect([...el.querySelectorAll("button")].some((button) => button.textContent === "delete entry")).toBe(true);
		[...el.querySelectorAll("button")].find((button) => button.textContent === "delete entry")!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(el.textContent).toContain("Delete entry.md?");
		[...el.querySelectorAll("button")]
			.reverse()
			.find((button) => button.textContent === "delete entry")!
			.click();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(api.deleteMemoryEntry).toHaveBeenCalled();
	});

	it("opens rendered local index links in the current memory scope", async () => {
		const el = mount(() => <MemoriesScreen store={makeStore()} />);
		await new Promise((resolve) => setTimeout(resolve, 200));
		const link = el.querySelector('.memory-preview a[href="entry.md"]') as HTMLAnchorElement;

		link.click();
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(window.location.hash).toBe("#/");
		expect(api.memoryDocument).toHaveBeenLastCalledWith("global", "entry.md");
		expect(el.querySelector("textarea")?.value).toContain("name: Entry");
	});

	it("hides stale editor content and announces document loading", async () => {
		let resolveEntry!: (value: Awaited<ReturnType<typeof api.memoryDocument>>) => void;
		vi.mocked(api.memoryDocument).mockImplementationOnce(async (_scopeId, file) => ({
			kind: "index",
			file,
			content: "- [Entry](entry.md)\n",
			revision: "idx1",
		}));
		const pending = new Promise<Awaited<ReturnType<typeof api.memoryDocument>>>((resolve) => {
			resolveEntry = resolve;
		});
		vi.mocked(api.memoryDocument).mockImplementationOnce(() => pending);
		const el = mount(() => <MemoriesScreen store={makeStore()} />);
		await new Promise((resolve) => setTimeout(resolve, 20));

		const entryButton = [...el.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("entry.md"),
		)!;
		entryButton.click();
		await Promise.resolve();
		expect(el.querySelector(".memory-loading")?.textContent).toContain("loading selected memory");
		expect(el.querySelector("textarea")).toBeNull();

		resolveEntry({
			kind: "entry",
			file: "entry.md",
			content: "---\nname: Entry\ndescription: Test entry\ntype: project\n---\n",
			revision: "rev1",
			metadata: { name: "Entry", description: "Test entry", type: "project" },
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(el.querySelector("textarea")).not.toBeNull();
	});

	it("memories keeps repeated multi-scope navigation bounded and ignores stale loads", async () => {
		vi.mocked(api.memoryListing).mockClear();
		vi.mocked(api.memoryDocument).mockClear();
		type Listing = Awaited<ReturnType<typeof api.memoryListing>>;
		let resolveGlobal!: (value: Listing) => void;
		const staleGlobal = new Promise<Listing>((resolve) => {
			resolveGlobal = resolve;
		});
		const listingFor = (scopeId: string): Listing => ({
			scope: {
				id: scopeId,
				kind: scopeId === "global" ? "global" : "project",
				label: scopeId,
				memoryDir: `/memory/${scopeId}`,
				exists: true,
				...(scopeId === "global" ? {} : { projectRoot: `/projects/${scopeId}` }),
			},
			indexContent: `# ${scopeId}\n`,
			indexRevision: `index-${scopeId}`,
			indexOverLimit: false,
			entries: [],
		});
		vi.mocked(api.memoryScopes).mockResolvedValueOnce({
			scopes: [
				{ id: "global", kind: "global", label: "global", memoryDir: "/memory/global", exists: true },
				{
					id: "project-a",
					kind: "project",
					label: "project-a",
					projectRoot: "/projects/project-a",
					memoryDir: "/memory/project-a",
					exists: true,
				},
			],
		});
		let listingCalls = 0;
		vi.mocked(api.memoryListing).mockImplementation((scopeId) => {
			listingCalls += 1;
			return scopeId === "global" && listingCalls === 1 ? staleGlobal : Promise.resolve(listingFor(scopeId));
		});
		vi.mocked(api.memoryDocument).mockImplementation(async (scopeId, file) => ({
			kind: "index",
			file,
			content: `${scopeId}:${file}:${"x".repeat(256 * 1024)}`,
			revision: `revision-${scopeId}`,
		}));

		const el = mount(() => <MemoriesScreen store={makeStore()} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const project = [...el.querySelectorAll("button")].find((button) => button.textContent?.includes("project-a"))!;
		project.click();
		await new Promise((resolve) => setTimeout(resolve, 20));
		resolveGlobal(listingFor("global"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(el.querySelector("textarea")?.value.startsWith("project-a:MEMORY.md:")).toBe(true);

		const global = [...el.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("/memory/global"),
		)!;
		for (let i = 0; i < 6; i++) {
			(i % 2 === 0 ? global : project).click();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(api.memoryListing).toHaveBeenCalledTimes(8);
		expect(api.memoryDocument).toHaveBeenCalledTimes(7);
		expect(el.querySelectorAll(".memory-editor textarea")).toHaveLength(1);
		expect(el.querySelectorAll(".memory-preview .markdown-body")).toHaveLength(1);
		expect(el.querySelector("textarea")?.value.startsWith("project-a:MEMORY.md:")).toBe(true);
	});

	it("throttles live memory preview rendering while typing", async () => {
		vi.useFakeTimers();
		const parse = vi.spyOn(marked, "parse");
		const el = mount(() => <MemoriesScreen store={makeStore()} />);
		await vi.advanceTimersByTimeAsync(200);
		const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
		const baseline = parse.mock.calls.length;
		for (let i = 0; i < 20; i++) {
			textarea.value = `draft ${i}`;
			textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(i) }));
		}
		expect(parse.mock.calls.length).toBe(baseline);
		await vi.advanceTimersByTimeAsync(149);
		expect(parse.mock.calls.length).toBe(baseline);
		await vi.advanceTimersByTimeAsync(1);
		expect(parse.mock.calls.length).toBe(baseline + 1);
		expect(el.querySelector(".memory-preview")?.textContent).toContain("draft 19");
		parse.mockRestore();
	});

	it("memories shows missing and malformed empty states", async () => {
		vi.mocked(api.memoryListing).mockResolvedValueOnce({
			scope: { id: "global", kind: "global", label: "global", memoryDir: "/home/test/.dreb/memory", exists: false },
			indexContent: null,
			indexRevision: null,
			indexOverLimit: false,
			entries: [],
		});
		const store = makeStore();
		const el = mount(() => <MemoriesScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(el.textContent).toContain("Memory directory is missing");
	});

	it("memories surfaces scope-loading failures", async () => {
		vi.mocked(api.memoryScopes).mockRejectedValueOnce(new Error("memory inventory failed"));
		const store = makeStore();
		const el = mount(() => <MemoriesScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(el.textContent).toContain("memory inventory failed");
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

	it("settings exposes and saves continue-after-auto-compaction off by default", async () => {
		vi.mocked(api.settings).mockResolvedValue({});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		const row = [...el.querySelectorAll(".setting-row")].find((candidate) =>
			candidate.textContent?.includes("continue after auto-compaction"),
		) as HTMLElement;
		expect(row).not.toBeNull();
		expect(row.textContent).toContain("can run and incur cost indefinitely");
		const select = row.querySelector("select") as HTMLSelectElement;
		expect(select.value).toBe("off");

		select.value = "on";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.saveSettings).toHaveBeenCalledWith({ continueAfterAutoCompaction: true });
	});

	it("settings reflects an enabled continue-after-auto-compaction value", async () => {
		vi.mocked(api.settings).mockResolvedValue({ continueAfterAutoCompaction: true });
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		const row = [...el.querySelectorAll(".setting-row")].find((candidate) =>
			candidate.textContent?.includes("continue after auto-compaction"),
		) as HTMLElement;
		expect((row.querySelector("select") as HTMLSelectElement).value).toBe("on");
	});

	it("settings exposes and saves the maximum concurrent subagent count", async () => {
		vi.mocked(api.settings).mockResolvedValue({ maxConcurrentSubagents: 4 });
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		const input = el.querySelector("#max-concurrent-subagents") as HTMLInputElement;
		expect(input.value).toBe("4");
		expect(el.textContent).toContain("0 removes the subagent tool");
		input.value = "1";
		input.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.saveSettings).toHaveBeenCalledWith({ maxConcurrentSubagents: 1 });
		vi.mocked(api.saveSettings).mockClear();
	});

	it("settings rejects an invalid maximum concurrent subagent count before saving", async () => {
		vi.mocked(api.settings).mockResolvedValue({ maxConcurrentSubagents: 4 });
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		const input = el.querySelector("#max-concurrent-subagents") as HTMLInputElement;
		for (const invalid of ["-1", "1.5", ""]) {
			input.value = invalid;
			input.dispatchEvent(new Event("change", { bubbles: true }));
			expect(el.querySelector(".settings-error")?.textContent).toContain("non-negative whole number");
			expect(input.value).toBe("4");
		}
		expect(api.saveSettings).not.toHaveBeenCalled();
	});

	it("settings exposes default-enabled tab title controls and the automatic route", async () => {
		vi.mocked(api.settings).mockResolvedValue({});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		const section = el.querySelector(".tab-title-settings") as HTMLElement;
		expect(section).not.toBeNull();
		expect(section.textContent).toContain("title model");
		expect(section.textContent).toContain("automatic (Explore route)");
		const enabled = section.querySelector("select") as HTMLSelectElement;
		expect(enabled.value).toBe("on");
	});

	it("settings persists tab title model and enable edits as partial nested updates", async () => {
		let durable: SettingsDto = { tabTitle: { enabled: false, triggerAfter: 7, maxTitleLength: 90 } };
		vi.mocked(api.settings).mockImplementation(async () => durable);
		vi.mocked(api.settingsModels).mockResolvedValue({
			models: [
				{
					provider: "openrouter",
					id: "vendor/title-model",
					name: "Title Model",
					contextWindow: 128000,
					reasoning: false,
				},
			],
		});
		vi.mocked(api.saveSettings).mockImplementation(async (update) => {
			durable = { tabTitle: { ...durable.tabTitle, ...(update.tabTitle ?? {}) } };
			return durable;
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		let section = el.querySelector(".tab-title-settings") as HTMLElement;
		expect((section.querySelector("select") as HTMLSelectElement).value).toBe("off");
		(section.querySelector(".model-picker-button") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(el.textContent).toContain("select tab title model");
		const modelRow = [...el.querySelectorAll<HTMLButtonElement>(".model-row")].find((row) =>
			row.textContent?.includes("vendor/title-model"),
		)!;
		modelRow.click();
		await vi.waitFor(() =>
			expect(api.saveSettings).toHaveBeenCalledWith({
				tabTitle: { model: "openrouter/vendor/title-model" },
			}),
		);
		expect(durable.tabTitle).toEqual({
			enabled: false,
			model: "openrouter/vendor/title-model",
			triggerAfter: 7,
			maxTitleLength: 90,
		});

		section = el.querySelector(".tab-title-settings") as HTMLElement;
		const enabled = section.querySelector("select") as HTMLSelectElement;
		enabled.value = "on";
		enabled.dispatchEvent(new Event("change", { bubbles: true }));
		await vi.waitFor(() => expect(api.saveSettings).toHaveBeenLastCalledWith({ tabTitle: { enabled: true } }));
		expect(durable.tabTitle).toMatchObject({ enabled: true, model: "openrouter/vendor/title-model" });
		await vi.waitFor(() => {
			const currentSection = el.querySelector(".tab-title-settings") as HTMLElement;
			expect((currentSection.querySelector("select") as HTMLSelectElement).value).toBe("on");
			expect(currentSection.textContent).toContain("openrouter/vendor/title-model");
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		vi.mocked(api.saveSettings).mockClear();
	});

	it("settings rolls back a rejected tab title edit and shows the error", async () => {
		vi.mocked(api.settings).mockClear();
		vi.mocked(api.saveSettings).mockClear();
		const durable = { tabTitle: { enabled: false, model: "provider/title-model" } };
		vi.mocked(api.settings).mockResolvedValue(durable);
		vi.mocked(api.saveSettings).mockRejectedValueOnce(new Error("tab title setting rejected"));
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const enabled = el.querySelector(".tab-title-settings select") as HTMLSelectElement;

		enabled.value = "on";
		enabled.dispatchEvent(new Event("change", { bubbles: true }));
		expect(enabled.value).toBe("on");

		await vi.waitFor(() =>
			expect(el.querySelector(".settings-error")?.textContent).toContain("tab title setting rejected"),
		);
		expect(api.saveSettings).toHaveBeenCalledWith({ tabTitle: { enabled: true } });
		expect(enabled.value).toBe("off");
		vi.mocked(api.saveSettings).mockClear();
	});

	it("settings clears a pinned tab title model back to the automatic route", async () => {
		vi.mocked(api.settings).mockClear();
		vi.mocked(api.saveSettings).mockClear();
		let durable: SettingsDto = { tabTitle: { enabled: true, model: "provider/title-model" } };
		vi.mocked(api.settings).mockImplementation(async () => durable);
		vi.mocked(api.settingsModels).mockResolvedValue({
			models: [
				{
					provider: "provider",
					id: "title-model",
					name: "Title Model",
					contextWindow: 128000,
					reasoning: false,
				},
			],
		});
		vi.mocked(api.saveSettings).mockImplementation(async (update) => {
			const merged = { ...durable.tabTitle, ...(update.tabTitle ?? {}) };
			if (update.tabTitle?.model === null) delete merged.model;
			durable = { tabTitle: { ...merged, model: merged.model ?? undefined } };
			return durable;
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		const section = el.querySelector(".tab-title-settings") as HTMLElement;
		const pickerButton = section.querySelector(".model-picker-button") as HTMLButtonElement;
		expect(pickerButton.textContent).toContain("provider/title-model");
		pickerButton.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.textContent).toContain("select tab title model");
		const clearRow = el.querySelector(".model-clear-row") as HTMLButtonElement;
		expect(clearRow.textContent).toContain("automatic (Explore route)");
		clearRow.click();

		await vi.waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ tabTitle: { model: null } }));
		await vi.waitFor(() => {
			const button = el.querySelector(".tab-title-settings .model-picker-button") as HTMLButtonElement;
			expect(button.textContent).toContain("automatic (Explore route)");
		});
		expect(durable.tabTitle).toEqual({ enabled: true });
		vi.mocked(api.saveSettings).mockClear();
	});

	it("serializes overlapping tab title edits without restoring stale state", async () => {
		vi.mocked(api.settings).mockClear();
		vi.mocked(api.saveSettings).mockClear();
		vi.mocked(api.settings).mockResolvedValue({
			tabTitle: { enabled: true, model: "provider/title-model", triggerAfter: 9, maxTitleLength: 60 },
		});
		vi.mocked(api.settingsModels).mockResolvedValue({
			models: [
				{
					provider: "openrouter",
					id: "vendor/title-model",
					name: "Title Model",
					contextWindow: 128000,
					reasoning: false,
				},
			],
		});
		let resolveFirst!: (value: Awaited<ReturnType<typeof api.saveSettings>>) => void;
		let resolveSecond!: (value: Awaited<ReturnType<typeof api.saveSettings>>) => void;
		const firstSave = new Promise<Awaited<ReturnType<typeof api.saveSettings>>>((resolve) => {
			resolveFirst = resolve;
		});
		const secondSave = new Promise<Awaited<ReturnType<typeof api.saveSettings>>>((resolve) => {
			resolveSecond = resolve;
		});
		vi.mocked(api.saveSettings)
			.mockImplementationOnce(() => firstSave)
			.mockImplementationOnce(() => secondSave);

		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		// First edit: disable while nothing is in flight → save 1 starts.
		const section = el.querySelector(".tab-title-settings") as HTMLElement;
		const enabled = section.querySelector("select") as HTMLSelectElement;
		enabled.value = "off";
		enabled.dispatchEvent(new Event("change", { bubbles: true }));

		// Second edit before save 1 resolves: pin a different model via the picker.
		(section.querySelector(".model-picker-button") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		const modelRow = [...el.querySelectorAll<HTMLButtonElement>(".model-row")].find((row) =>
			row.textContent?.includes("vendor/title-model"),
		)!;
		modelRow.click();
		await Promise.resolve();

		expect(api.saveSettings).toHaveBeenCalledTimes(1);
		expect(api.saveSettings).toHaveBeenNthCalledWith(1, { tabTitle: { enabled: false } });

		// Save 1 resolves with a snapshot predating the model edit; the newer
		// optimistic model selection must survive instead of rolling back.
		resolveFirst({
			tabTitle: { enabled: false, model: "provider/title-model", triggerAfter: 9, maxTitleLength: 60 },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(api.saveSettings).toHaveBeenNthCalledWith(2, {
			tabTitle: { model: "openrouter/vendor/title-model" },
		});

		const pickerButton = () => el.querySelector(".tab-title-settings .model-picker-button") as HTMLButtonElement;
		expect(pickerButton().textContent).toContain("openrouter/vendor/title-model");
		expect((el.querySelector(".tab-title-settings select") as HTMLSelectElement).value).toBe("off");

		resolveSecond({
			tabTitle: { enabled: false, model: "openrouter/vendor/title-model", triggerAfter: 9, maxTitleLength: 60 },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(pickerButton().textContent).toContain("openrouter/vendor/title-model");
		vi.mocked(api.saveSettings).mockClear();
	});

	it("settings exposes complete global Dispatch Arbiter controls and readiness", async () => {
		vi.mocked(api.settings).mockResolvedValue({
			subagentArbiter: {
				enabled: true,
				model: "provider/router",
				thinking: "medium",
				guidePath: "~/routing.md",
			},
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		const section = el.querySelector(".dispatch-arbiter-settings") as HTMLElement;
		expect(section).not.toBeNull();
		expect(section.textContent).toContain("Global-only");
		expect(section.textContent).toContain("enabled");
		expect(section.textContent).toContain("arbiter model");
		expect(section.textContent).toContain("arbiter thinking");
		expect(section.textContent).toContain("routing guide path");
		expect(section.textContent).toContain("live scope and guide are validated before every child spawn");
		expect((section.querySelector("#dispatch-arbiter-guide-path") as HTMLInputElement).value).toBe("~/routing.md");
	});

	it("settings refuses to enable the Dispatch Arbiter until a model is selected", async () => {
		vi.mocked(api.settings).mockResolvedValue({ subagentArbiter: { enabled: false } });
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const section = el.querySelector(".dispatch-arbiter-settings") as HTMLElement;
		const enabledRow = [...section.querySelectorAll(".setting-row")].find((row) =>
			row.textContent?.includes("disabled by default"),
		)!;
		const select = enabledRow.querySelector("select") as HTMLSelectElement;
		select.value = "on";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(el.querySelector(".settings-error")?.textContent).toContain("Choose an exact Dispatch Arbiter model");
		expect(select.value).toBe("off");
		expect(api.saveSettings).not.toHaveBeenCalled();
		expect(el.textContent).toContain("select Dispatch Arbiter model");
	});

	it("settings explicitly disables even when retained fields are malformed", async () => {
		vi.mocked(api.settings).mockResolvedValue({
			subagentArbiter: {
				enabled: true,
				model: "malformed-model-id",
				thinking: "invalid-thinking",
				guidePath: "",
			} as never,
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const section = el.querySelector(".dispatch-arbiter-settings") as HTMLElement;
		const enabledRow = [...section.querySelectorAll(".setting-row")].find((row) =>
			row.textContent?.includes("disabled by default"),
		)!;
		const enabled = enabledRow.querySelector("select") as HTMLSelectElement;

		enabled.value = "off";
		enabled.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.saveSettings).toHaveBeenCalledWith({
			subagentArbiter: {
				enabled: false,
				model: "malformed-model-id",
				thinking: "invalid-thinking",
				guidePath: "",
			},
		});
		expect(enabled.value).toBe("off");
	});

	it("keeps the disable control reachable with a non-string retained guide path", async () => {
		vi.mocked(api.settings).mockResolvedValue({
			subagentArbiter: {
				enabled: true,
				model: "provider/router",
				thinking: "high",
				guidePath: 123,
			} as never,
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const section = el.querySelector(".dispatch-arbiter-settings") as HTMLElement;
		const enabledRow = [...section.querySelectorAll(".setting-row")].find((row) =>
			row.textContent?.includes("disabled by default"),
		)!;
		const enabled = enabledRow.querySelector("select") as HTMLSelectElement;

		expect((section.querySelector("#dispatch-arbiter-guide-path") as HTMLInputElement).value).toBe("");
		expect(section.querySelector("[data-testid='dispatch-arbiter-readiness']")?.textContent).toContain(
			"routing guide path is invalid",
		);
		enabled.value = "off";
		enabled.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.saveSettings).toHaveBeenCalledWith({
			subagentArbiter: { enabled: false, model: "provider/router", thinking: "high", guidePath: 123 },
		});
		expect(enabled.value).toBe("off");
	});

	it("settings model picker and toggle persist the exact global Dispatch Arbiter policy", async () => {
		vi.mocked(api.settings).mockResolvedValue({
			subagentArbiter: { enabled: false, thinking: "medium", guidePath: "~/routing.md" },
		});
		vi.mocked(api.settingsModels).mockResolvedValue({
			models: [{ provider: "provider", id: "router", name: "Router", contextWindow: 128000, reasoning: true }],
		});
		vi.mocked(api.saveSettings).mockImplementation(async (update) => ({
			subagentArbiter: {
				enabled: false,
				thinking: "medium",
				guidePath: "~/routing.md",
				...(update.subagentArbiter ?? {}),
			},
		}));
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const section = el.querySelector(".dispatch-arbiter-settings") as HTMLElement;
		(section.querySelector(".model-picker-button") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		(el.querySelector(".model-row") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.saveSettings).toHaveBeenCalledWith({
			subagentArbiter: {
				enabled: false,
				model: "provider/router",
				thinking: "medium",
				guidePath: "~/routing.md",
			},
		});

		const refreshedSection = el.querySelector(".dispatch-arbiter-settings") as HTMLElement;
		const enabledRow = [...refreshedSection.querySelectorAll(".setting-row")].find((row) =>
			row.textContent?.includes("disabled by default"),
		)!;
		const select = enabledRow.querySelector("select") as HTMLSelectElement;
		select.value = "on";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.saveSettings).toHaveBeenLastCalledWith({
			subagentArbiter: {
				enabled: true,
				model: "provider/router",
				thinking: "medium",
				guidePath: "~/routing.md",
			},
		});
	});

	it("serializes overlapping Dispatch Arbiter edits without restoring stale disabled state", async () => {
		vi.mocked(api.saveSettings).mockClear();
		vi.mocked(api.settings).mockResolvedValue({
			subagentArbiter: { enabled: false, model: "provider/router", thinking: "off" },
		});
		let resolveFirst!: (value: Awaited<ReturnType<typeof api.saveSettings>>) => void;
		let resolveSecond!: (value: Awaited<ReturnType<typeof api.saveSettings>>) => void;
		const firstSave = new Promise<Awaited<ReturnType<typeof api.saveSettings>>>((resolve) => {
			resolveFirst = resolve;
		});
		const secondSave = new Promise<Awaited<ReturnType<typeof api.saveSettings>>>((resolve) => {
			resolveSecond = resolve;
		});
		vi.mocked(api.saveSettings)
			.mockImplementationOnce(() => firstSave)
			.mockImplementationOnce(() => secondSave);

		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const section = el.querySelector(".dispatch-arbiter-settings") as HTMLElement;
		const enabledRow = [...section.querySelectorAll(".setting-row")].find((row) =>
			row.textContent?.includes("disabled by default"),
		)!;
		const enabled = enabledRow.querySelector("select") as HTMLSelectElement;
		enabled.value = "on";
		enabled.dispatchEvent(new Event("change", { bubbles: true }));

		const thinkingRow = [...section.querySelectorAll(".setting-row")].find((row) =>
			row.textContent?.includes("arbiter thinking"),
		)!;
		const thinking = thinkingRow.querySelector("select") as HTMLSelectElement;
		thinking.value = "high";
		thinking.dispatchEvent(new Event("change", { bubbles: true }));
		await Promise.resolve();

		expect(api.saveSettings).toHaveBeenCalledTimes(1);
		expect(api.saveSettings).toHaveBeenNthCalledWith(1, {
			subagentArbiter: { enabled: true, model: "provider/router", thinking: "off" },
		});
		resolveFirst({ subagentArbiter: { enabled: true, model: "provider/router", thinking: "off" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(api.saveSettings).toHaveBeenNthCalledWith(2, {
			subagentArbiter: { enabled: true, model: "provider/router", thinking: "high" },
		});

		resolveSecond({ subagentArbiter: { enabled: true, model: "provider/router", thinking: "high" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(el.querySelector("[data-testid='dispatch-arbiter-readiness']")?.textContent).toContain("status: enabled");
	});

	it("rolls back an optimistic Dispatch Arbiter edit when the durable save is rejected", async () => {
		vi.mocked(api.settings).mockClear();
		vi.mocked(api.saveSettings).mockClear();
		const durableSettings = {
			subagentArbiter: { enabled: false, model: "provider/router", thinking: "off" as const },
		};
		vi.mocked(api.settings).mockResolvedValue(durableSettings);
		vi.mocked(api.saveSettings).mockRejectedValueOnce(new Error("arbiter policy rejected by server"));
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const section = el.querySelector(".dispatch-arbiter-settings") as HTMLElement;
		const enabledRow = [...section.querySelectorAll(".setting-row")].find((row) =>
			row.textContent?.includes("disabled by default"),
		)!;
		const enabled = enabledRow.querySelector("select") as HTMLSelectElement;

		enabled.value = "on";
		enabled.dispatchEvent(new Event("change", { bubbles: true }));
		expect(enabled.value).toBe("on");

		await vi.waitFor(() =>
			expect(el.querySelector(".settings-error")?.textContent).toContain("arbiter policy rejected by server"),
		);
		expect(api.saveSettings).toHaveBeenCalledWith({
			subagentArbiter: { enabled: true, model: "provider/router", thinking: "off" },
		});
		expect(api.settings).toHaveBeenCalledTimes(3); // main + scoped editor reads, then main rollback refetch
		expect(enabled.value).toBe("off");
		expect(el.querySelector("[data-testid='dispatch-arbiter-readiness']")?.textContent).toContain("status: disabled");
	});

	it("settings persists Dispatch Arbiter thinking and guide-path controls", async () => {
		vi.mocked(api.settings).mockResolvedValue({
			subagentArbiter: { enabled: false, model: "provider/router", thinking: "off" },
		});
		vi.mocked(api.saveSettings).mockImplementation(async (update) => update);
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		let section = el.querySelector(".dispatch-arbiter-settings") as HTMLElement;
		const thinkingRow = [...section.querySelectorAll(".setting-row")].find((row) =>
			row.textContent?.includes("arbiter thinking"),
		)!;
		const thinking = thinkingRow.querySelector("select") as HTMLSelectElement;
		thinking.value = "high";
		thinking.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.saveSettings).toHaveBeenCalledWith({
			subagentArbiter: { enabled: false, model: "provider/router", thinking: "high" },
		});

		section = el.querySelector(".dispatch-arbiter-settings") as HTMLElement;
		const path = section.querySelector("#dispatch-arbiter-guide-path") as HTMLInputElement;
		path.value = "~/custom-guide.md";
		path.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.saveSettings).toHaveBeenLastCalledWith({
			subagentArbiter: {
				enabled: false,
				model: "provider/router",
				thinking: "high",
				guidePath: "~/custom-guide.md",
			},
		});
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

	it("settings agent context select carries full path values with a full-path tooltip", async () => {
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
		vi.mocked(api.fleet).mockResolvedValue({
			runtimes: [runtimeAt("a", "/home/test/project-beta"), runtimeAt("b", "/home/test/project-alpha")],
			diskSessions: [],
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await store.refreshFleet();
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Options display the full absolute cwd (no display transformation) and
		// the closed control exposes it on hover via the title tooltip.
		const select = el.querySelector<HTMLSelectElement>(".agent-context-row select")!;
		const options = [...select.querySelectorAll("option")];
		expect(options.map((option) => option.textContent)).toEqual([
			"global/home only",
			"/home/test/project-alpha",
			"/home/test/project-beta",
		]);
		expect(options.map((option) => option.value)).toEqual([
			"",
			"/home/test/project-alpha",
			"/home/test/project-beta",
		]);
		expect(select.getAttribute("title")).toBe("global/home only");
		select.value = "/home/test/project-alpha";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(select.getAttribute("title")).toBe("/home/test/project-alpha");
	});

	it("routes scoped-model context through App and reloads and saves after context selection", async () => {
		const available = [
			{ provider: "anthropic", id: "sonnet", name: "Sonnet", contextWindow: 1, reasoning: true },
			{ provider: "openai", id: "gpt", name: "GPT", contextWindow: 1, reasoning: false },
			{ provider: "google", id: "gemini", name: "Gemini", contextWindow: 1, reasoning: true },
		];
		const scopedSnapshot = (provider: string, id: string): SettingsDto => ({
			enabledModels: [`${provider}/${id}`],
			resolvedScopedModels: [{ provider, id }],
			scopeWarnings: [],
			hasProjectEnabledModelsOverride: true,
			enabledModelsSource: "project",
		});
		vi.mocked(api.settings).mockClear();
		vi.mocked(api.settingsModels).mockClear();
		vi.mocked(api.saveSettings).mockClear();
		vi.mocked(api.fleet).mockResolvedValue({
			runtimes: [{ cwd: "/project/b" } as RuntimeInfoDto],
			diskSessions: [],
		});
		vi.mocked(api.settings).mockImplementation(async (cwd?: string) =>
			cwd === "/project/b" ? scopedSnapshot("openai", "gpt") : scopedSnapshot("anthropic", "sonnet"),
		);
		vi.mocked(api.settingsModels).mockResolvedValue({ models: available });
		vi.mocked(api.saveSettings).mockImplementation(async (update, cwd) => ({
			...scopedSnapshot("openai", "gpt"),
			enabledModels: update.enabledModels ?? undefined,
			resolvedScopedModels: (update.enabledModels ?? []).map((key) => {
				const [provider, ...id] = key.split("/");
				return { provider: provider!, id: id.join("/") };
			}),
			warnings: cwd === "/project/b" ? ["project b shadow warning"] : [],
		}));
		window.location.hash = "#/settings/scoped-models?cwd=%2Fproject%2Fa";

		const el = mount(() => <App />);

		await vi.waitFor(() => {
			expect(api.settings).toHaveBeenCalledWith("/project/a");
			expect(api.settingsModels).toHaveBeenCalledWith("/project/a");
		});
		const context = el.querySelector<HTMLSelectElement>(".scoped-models-context select")!;
		expect(context.value).toBe("/project/a");
		await vi.waitFor(() => expect(context.querySelector('option[value="/project/b"]')).not.toBeNull());

		context.value = "/project/b";
		context.dispatchEvent(new Event("change", { bubbles: true }));
		await vi.waitFor(() => {
			expect(window.location.hash).toContain("cwd=%2Fproject%2Fb");
			expect(api.settings).toHaveBeenCalledWith("/project/b");
			expect(api.settingsModels).toHaveBeenCalledWith("/project/b");
			expect(context.value).toBe("/project/b");
		});

		await vi.waitFor(() =>
			expect(
				[...el.querySelectorAll<HTMLLabelElement>(".scoped-model-choice")].some((label) =>
					label.textContent?.includes("sonnet"),
				),
			).toBe(true),
		);
		const sonnet = [...el.querySelectorAll<HTMLLabelElement>(".scoped-model-choice")].find((label) =>
			label.textContent?.includes("sonnet"),
		)!;
		sonnet.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
		[...el.querySelectorAll<HTMLButtonElement>("button")]
			.find((candidate) => candidate.textContent?.trim() === "save")!
			.click();
		await vi.waitFor(() => {
			expect(api.saveSettings).toHaveBeenCalledWith(
				{ enabledModels: ["openai/gpt", "anthropic/sonnet"] },
				"/project/b",
			);
			expect(el.textContent).toContain("project b shadow warning");
		});

		const callsBeforeDirectRoute = vi.mocked(api.settingsModels).mock.calls.length;
		window.location.hash = "#/settings/scoped-models?cwd=%2Fproject%2Fa";
		window.dispatchEvent(new HashChangeEvent("hashchange"));
		await vi.waitFor(() => {
			expect(context.value).toBe("/project/a");
			expect(api.settingsModels).toHaveBeenCalledTimes(callsBeforeDirectRoute + 1);
			expect(api.settingsModels).toHaveBeenLastCalledWith("/project/a");
		});

		const callsBeforeGlobalRoute = vi.mocked(api.settingsModels).mock.calls.length;
		window.location.hash = "#/settings";
		window.dispatchEvent(new HashChangeEvent("hashchange"));
		await vi.waitFor(() => {
			expect(context.value).toBe("");
			expect(api.settingsModels).toHaveBeenCalledTimes(callsBeforeGlobalRoute + 1);
			expect(api.settingsModels).toHaveBeenLastCalledWith(undefined);
		});
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

	it("formats above, below, and stable TPS summaries like the TUI footer", () => {
		expect(formatPerformanceIndicator(performanceSummary())).toBe("~42 tok/s [100] · 10% ↑ median [200]");
		expect(
			formatPerformanceIndicator(performanceSummary({ delta: { direction: "below", percentDelta: -9.6 } })),
		).toBe("~42 tok/s [100] · 10% ↓ median [200]");
		expect(formatPerformanceIndicator(performanceSummary({ delta: { direction: "stable", percentDelta: 99 } }))).toBe(
			"~42 tok/s [100] · 0% → median [200]",
		);
	});

	it("applies the TUI sample gates to TPS summaries", () => {
		expect(formatPerformanceIndicator(performanceSummary({ rolling: { count: 2 } }))).toBeUndefined();
		expect(formatPerformanceIndicator(undefined)).toBeUndefined();
		expect(formatPerformanceIndicator(performanceSummary({ delta: { recentCount: 2 } }))).toBe("~42 tok/s [100]");
		expect(formatPerformanceIndicator(performanceSummary({ delta: { baselineCount: 2 } }))).toBe("~42 tok/s [100]");
	});

	it("selects only the active model's shared TPS summary", () => {
		const performance: PerformanceStatsDto = { models: [performanceSummary()] };
		expect(performanceIndicatorForModel(performance, { provider: "test", id: "test-model" })).toBe(
			"~42 tok/s [100] · 10% ↑ median [200]",
		);
		expect(performanceIndicatorForModel(performance, { provider: "test", id: "other-model" })).toBeUndefined();
		expect(performanceIndicatorForModel(undefined, { provider: "test", id: "test-model" })).toBeUndefined();
		expect(performanceIndicatorForModel(performance, undefined)).toBeUndefined();
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

	it("renders provider failures inline while omitting finalized whitespace-only thinking", () => {
		const el = mount(() => (
			<Transcript
				entries={[
					{
						kind: "assistant",
						blocks: [
							{ kind: "thinking", text: "  \n\t" },
							{ kind: "text", text: "partial answer" },
						],
						streaming: false,
						stopReason: "error",
						errorMessage: "provider rejected request",
					},
				]}
			/>
		));

		expect(el.textContent).toContain("partial answer");
		expect(el.querySelector(".assistant-error")?.textContent).toBe("Error: provider rejected request");
		expect(el.querySelector("details.thinking")).toBeNull();
	});

	it("keeps nonblank partial thinking alongside an inline provider failure", () => {
		const el = mount(() => (
			<Transcript
				entries={[
					{
						kind: "assistant",
						blocks: [{ kind: "thinking", text: "useful partial reasoning" }],
						streaming: false,
						stopReason: "error",
						errorMessage: "network error",
					},
				]}
			/>
		));

		expect(el.querySelector("details.thinking")?.textContent).toContain("useful partial reasoning");
		expect(el.querySelector(".assistant-error")?.textContent).toBe("Error: network error");
	});

	it("leaves active empty thinking placeholders visible while streaming", () => {
		const el = mount(() => (
			<Transcript
				entries={[
					{
						kind: "assistant",
						blocks: [{ kind: "thinking", text: "" }],
						streaming: true,
					},
				]}
			/>
		));

		expect(el.querySelector("details.thinking")).not.toBeNull();
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

	it("settings persists the browser-local image display mode separately from model-input settings", async () => {
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const select = el.querySelector("#pref-image-display-mode") as HTMLSelectElement;
		expect(select.value).toBe("previews");
		select.value = "originals";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		expect(window.localStorage.getItem("dreb.dashboard.imageDisplayMode")).toBe("originals");
		expect(el.textContent).toContain("informed network-data opt-in");
	});

	describe("settings appearance (theme gallery)", () => {
		// The appearance state is a module-level singleton driven by localStorage,
		// so reset both storage and the signals/DOM between cases.
		function resetAppearance() {
			window.localStorage.removeItem(THEME_STORAGE_KEY);
			window.localStorage.removeItem(COLOR_MODE_STORAGE_KEY);
			window.localStorage.removeItem(FONT_STORAGE_KEY);
			__resetAppearanceForTests();
			reloadAppearance(); // re-reads (now-empty) storage → removes the <html> attrs
		}

		beforeEach(resetAppearance);
		afterEach(resetAppearance);

		it("renders appearance selectors and theme cards even when settings fails to load", async () => {
			// The appearance controls live in the dashboard section, OUTSIDE the
			// server-settings <Show> boundary — so a rejected api.settings() must not
			// hide them.
			vi.mocked(api.settings).mockRejectedValue(new Error("settings unavailable"));
			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(el.querySelector("#pref-color-mode")).not.toBeNull();
			const fontSelect = el.querySelector("#pref-font") as HTMLSelectElement;
			expect(Array.from(fontSelect.options).map((option) => [option.value, option.textContent])).toEqual([
				["theme", "Theme default"],
				["ibm-plex-mono", "IBM Plex Mono"],
				["jetbrains-mono", "JetBrains Mono"],
				["fira-code", "Fira Code"],
				["iosevka", "Iosevka"],
				["opendyslexic", "OpenDyslexic"],
				["atkinson-hyperlegible", "Atkinson Hyperlegible"],
			]);
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

		it("restores the selected theme, color mode, and font", async () => {
			window.localStorage.setItem(THEME_STORAGE_KEY, "solarized");
			window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, "dark");
			window.localStorage.setItem(FONT_STORAGE_KEY, "opendyslexic");
			reloadAppearance();
			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const card = el.querySelector('[data-theme-card="solarized"]') as HTMLButtonElement;
			expect(card.classList.contains("active")).toBe(true);
			expect(card.getAttribute("aria-pressed")).toBe("true");
			const select = el.querySelector("#pref-color-mode") as HTMLSelectElement;
			expect(select.value).toBe("dark");
			const fontSelect = el.querySelector("#pref-font") as HTMLSelectElement;
			expect(fontSelect.value).toBe("opendyslexic");
			expect(document.documentElement.getAttribute("data-font")).toBe("opendyslexic");
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

		it("selects an explicit font independently and clears it with Theme default", async () => {
			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const fontSelect = el.querySelector("#pref-font") as HTMLSelectElement;
			fontSelect.value = "opendyslexic";
			fontSelect.dispatchEvent(new Event("change", { bubbles: true }));
			expect(document.documentElement.getAttribute("data-font")).toBe("opendyslexic");
			expect(window.localStorage.getItem(FONT_STORAGE_KEY)).toBe("opendyslexic");

			fontSelect.value = "jetbrains-mono";
			fontSelect.dispatchEvent(new Event("change", { bubbles: true }));
			expect(document.documentElement.getAttribute("data-font")).toBe("jetbrains-mono");
			expect(window.localStorage.getItem(FONT_STORAGE_KEY)).toBe("jetbrains-mono");

			const gruvbox = el.querySelector('[data-theme-card="gruvbox"]') as HTMLButtonElement;
			gruvbox.click();
			expect(document.documentElement.getAttribute("data-theme")).toBe("gruvbox");
			expect(document.documentElement.getAttribute("data-font")).toBe("jetbrains-mono");

			fontSelect.value = "theme";
			fontSelect.dispatchEvent(new Event("change", { bubbles: true }));
			expect(document.documentElement.getAttribute("data-font")).toBeNull();
			expect(window.localStorage.getItem(FONT_STORAGE_KEY)).toBeNull();
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

		it("uses IBM for theme-default previews and reflects explicit fonts reactively", async () => {
			const store = makeStore();
			const el = mount(() => <SettingsScreen store={store} />);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const cards = Array.from(el.querySelectorAll("[data-theme-card]"));
			for (const card of cards) expect(card.getAttribute("data-font")).toBe("ibm-plex-mono");

			const fontSelect = el.querySelector("#pref-font") as HTMLSelectElement;
			fontSelect.value = "jetbrains-mono";
			fontSelect.dispatchEvent(new Event("change", { bubbles: true }));
			for (const card of cards) expect(card.getAttribute("data-font")).toBe("jetbrains-mono");

			fontSelect.value = "opendyslexic";
			fontSelect.dispatchEvent(new Event("change", { bubbles: true }));
			for (const card of cards) expect(card.getAttribute("data-font")).toBe("opendyslexic");

			fontSelect.value = "ibm-plex-mono";
			fontSelect.dispatchEvent(new Event("change", { bubbles: true }));
			for (const card of cards) expect(card.getAttribute("data-font")).toBe("ibm-plex-mono");
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

	it("settings edits only the future-pairing lifetime and shows recorded device expiry", async () => {
		vi.mocked(api.pairingSettings).mockResolvedValueOnce({ pairingTtlDays: 180 });
		vi.mocked(api.savePairingSettings).mockClear();
		vi.mocked(api.devices).mockResolvedValueOnce({
			devices: [
				{
					id: "device-1",
					identity: "alice@example.com",
					device: "phone",
					createdAt: "2030-01-01T00:00:00.000Z",
					expiresAt: "2030-07-01T00:00:00.000Z",
				},
			],
		});
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));

		const input = el.querySelector("#pairing-ttl-days") as HTMLInputElement;
		expect(input.value).toBe("180");
		expect(el.textContent).toContain("applies only to devices paired after saving");
		expect(el.textContent).toContain("expires 2030-07-01");

		input.value = "90";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		const save = input.parentElement?.querySelector("button") as HTMLButtonElement;
		save.click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.savePairingSettings).toHaveBeenCalledWith(90);
		expect(el.textContent).toContain("new pairing lifetime saved");
	});

	it("settings disables the save control while the pairing lifetime is being persisted", async () => {
		let resolveSave!: (value: { pairingTtlDays: number }) => void;
		const pendingSave = new Promise<{ pairingTtlDays: number }>((resolve) => {
			resolveSave = resolve;
		});
		vi.mocked(api.savePairingSettings).mockReturnValueOnce(pendingSave);
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const input = el.querySelector("#pairing-ttl-days") as HTMLInputElement;
		input.value = "90";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		const save = input.parentElement?.querySelector("button") as HTMLButtonElement;

		save.click();
		await Promise.resolve();
		expect(save.disabled).toBe(true);
		expect(save.textContent).toBe("saving…");

		resolveSave({ pairingTtlDays: 90 });
		await pendingSave;
		await Promise.resolve();
		expect(save.disabled).toBe(false);
		expect(save.textContent).toBe("save");
	});

	it("settings rejects an invalid pairing lifetime before sending it", async () => {
		vi.mocked(api.savePairingSettings).mockClear();
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const input = el.querySelector("#pairing-ttl-days") as HTMLInputElement;
		input.value = "1.5";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		(input.parentElement?.querySelector("button") as HTMLButtonElement).click();
		await Promise.resolve();
		expect(api.savePairingSettings).not.toHaveBeenCalled();
		expect(el.textContent).toContain("whole number from 1 through 3650 days");
	});

	it("settings surfaces pairing lifetime save failures", async () => {
		vi.mocked(api.savePairingSettings).mockRejectedValueOnce(new Error("pairing settings write failed"));
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const input = el.querySelector("#pairing-ttl-days") as HTMLInputElement;
		input.value = "30";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		(input.parentElement?.querySelector("button") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(el.textContent).toContain("pairing settings write failed");
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

	it("session action notices and errors render as independently dismissible banners", async () => {
		const { element, textarea } = await mountCommandComposer([
			{ name: "dream", description: "dream", source: "builtin", dashboard: true },
		]);
		vi.mocked(api.dream).mockResolvedValueOnce({ message: "dream action completed" });

		await submitComposer(textarea, "/dream");
		const notice = element.querySelector<HTMLElement>('[data-banner-key="action-notice"]');
		expect(notice?.textContent).toContain("dream action completed");
		notice?.querySelector<HTMLButtonElement>(".banner-dismiss")?.click();
		expect(element.querySelector('[data-banner-key="action-notice"]')).toBeNull();

		vi.mocked(api.dream).mockRejectedValueOnce(new Error("dream action failed"));
		await submitComposer(textarea, "/dream");
		const error = element.querySelector<HTMLElement>('[data-banner-key="action-error"]');
		expect(error?.textContent).toContain("dream action failed");
		expect(element.querySelector('[data-banner-key="action-notice"]')).toBeNull();
		error?.querySelector<HTMLButtonElement>(".banner-dismiss")?.click();
		expect(element.querySelector('[data-banner-key="action-error"]')).toBeNull();
	});

	const mappedBuiltinCases = [
		{ command: "/settings", name: "settings", expected: "settings" },
		{ command: "/scoped-models", name: "scoped-models", expected: "scoped-models" },
		{ command: "/model claude", name: "model", expected: "model" },
		{ command: "/export", name: "export", expected: "export" },
		{ command: "/import /tmp/session.jsonl", name: "import", expected: "import" },
		{ command: "/name release", name: "name", expected: "name" },
		{ command: "/session", name: "session", expected: "session" },
		{ command: "/fork", name: "fork", expected: "fork" },
		{ command: "/tree", name: "tree", expected: "tree" },
		{ command: "/new", name: "new", expected: "new" },
		{ command: "/compact keep key details", name: "compact", expected: "compact" },
		{ command: "/dream backup /tmp/archive", name: "dream", expected: "dream" },
		{ command: "/resume", name: "resume", expected: "resume" },
		{ command: "/reload", name: "reload", expected: "reload" },
		{ command: "/quit", name: "quit", expected: "quit" },
	] as const;

	it.each(mappedBuiltinCases)("routes $command through its dashboard action without prompting", async (testCase) => {
		const { element, store, textarea } = await mountCommandComposer([
			{ name: testCase.name, description: testCase.name, source: "builtin", dashboard: true },
		]);
		const exportClick =
			testCase.expected === "export"
				? vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
				: undefined;
		for (const method of [
			api.prompt,
			api.models,
			api.stats,
			api.forkMessages,
			api.tree,
			api.newSession,
			api.compact,
			api.dream,
			api.runtimeSessions,
			api.reload,
			api.commands,
			api.stopRuntime,
			api.rename,
		]) {
			vi.mocked(method).mockClear();
		}
		store.navigate.mockClear();
		store.removeRuntime.mockClear();
		store.stopRuntime.mockClear();

		await submitComposer(textarea, testCase.command);

		expect(api.prompt).not.toHaveBeenCalled();
		expect(textarea.value).toBe("");
		switch (testCase.expected) {
			case "settings":
				expect(store.navigate).toHaveBeenCalledWith({ screen: "settings" });
				break;
			case "scoped-models":
				expect(store.navigate).toHaveBeenCalledWith({
					screen: "settings",
					target: "scoped-models",
					cwd: "/home/test/project",
				});
				break;
			case "model":
				expect((element.querySelector('input[placeholder="search models…"]') as HTMLInputElement).value).toBe(
					"claude",
				);
				break;
			case "export":
				expect(exportClick).toHaveBeenCalledOnce();
				break;
			case "import":
				expect(
					(element.querySelector('input[placeholder="/path/to/session.jsonl"]') as HTMLInputElement).value,
				).toBe("/tmp/session.jsonl");
				break;
			case "name":
				expect(api.rename).toHaveBeenCalledWith("k1", "release");
				break;
			case "session":
				expect(api.stats).toHaveBeenCalledWith("k1");
				expect(element.querySelector(".stats-popover")).not.toBeNull();
				break;
			case "fork":
				expect(api.forkMessages).toHaveBeenCalledWith("k1");
				expect(element.textContent).toContain("fork from message");
				break;
			case "tree":
				expect(api.tree).toHaveBeenCalledWith("k1");
				expect(element.textContent).toContain("session tree");
				break;
			case "new":
				expect(api.newSession).toHaveBeenCalledWith("k1");
				break;
			case "compact":
				expect(api.compact).toHaveBeenCalledWith("k1", "keep key details");
				break;
			case "dream":
				expect(api.dream).toHaveBeenCalledWith("k1", "backup /tmp/archive");
				break;
			case "resume":
				expect(api.runtimeSessions).toHaveBeenCalledWith("k1");
				expect(element.textContent).toContain("resume session");
				break;
			case "reload":
				expect(api.reload).toHaveBeenCalledWith("k1");
				expect(api.commands).toHaveBeenCalledWith("k1");
				break;
			case "quit":
				expect(api.stopRuntime).not.toHaveBeenCalled();
				expect(store.stopRuntime).toHaveBeenCalledWith("k1");
				expect(store.removeRuntime).not.toHaveBeenCalled();
				expect(store.navigate).not.toHaveBeenCalled();
				break;
		}
		exportClick?.mockRestore();
	});

	it.each([
		{ command: "/model", name: "model", title: "select model" },
		{ command: "/import", name: "import", title: "import session" },
		{ command: "/name", name: "name", title: "rename session" },
		{ command: "/compact", name: "compact", title: "compact context" },
	])("opens the expected modal for the no-argument $command form", async ({ command, name, title }) => {
		const { element, textarea } = await mountCommandComposer([
			{ name, description: name, source: "builtin", dashboard: true },
		]);
		vi.mocked(api.prompt).mockClear();

		await submitComposer(textarea, command);

		expect(api.prompt).not.toHaveBeenCalled();
		expect(element.querySelector(".modal")?.textContent).toContain(title);
	});

	it.each([
		{ command: "/dream", args: undefined },
		{ command: "/dream backup", args: "backup" },
		{ command: "/dream backup /tmp/archive", args: "backup /tmp/archive" },
	])("preserves the dashboard behavior for $command", async ({ command, args }) => {
		const { textarea } = await mountCommandComposer([
			{ name: "dream", description: "dream", source: "builtin", dashboard: true },
		]);
		vi.mocked(api.prompt).mockClear();
		vi.mocked(api.dream).mockClear();

		await submitComposer(textarea, command);

		expect(api.prompt).not.toHaveBeenCalled();
		expect(api.dream).toHaveBeenCalledWith("k1", args);
	});

	it.each(["settings", "scoped-models", "export", "session", "fork", "tree", "new", "resume", "reload", "quit"])(
		"rejects arguments for /%s with visible usage guidance",
		async (name) => {
			const { element, store, textarea } = await mountCommandComposer([
				{ name, description: name, source: "builtin", dashboard: true },
			]);
			const exportClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
			exportClick.mockClear();
			for (const method of [
				api.prompt,
				api.stats,
				api.forkMessages,
				api.tree,
				api.newSession,
				api.runtimeSessions,
				api.reload,
				api.commands,
				api.stopRuntime,
			]) {
				vi.mocked(method).mockClear();
			}
			store.navigate.mockClear();

			await submitComposer(textarea, `/${name} extra`);

			expect(api.prompt).not.toHaveBeenCalled();
			expect(element.textContent).toContain(`Usage: /${name}`);
			expect(api.stats).not.toHaveBeenCalled();
			expect(api.forkMessages).not.toHaveBeenCalled();
			expect(api.tree).not.toHaveBeenCalled();
			expect(api.newSession).not.toHaveBeenCalled();
			expect(api.runtimeSessions).not.toHaveBeenCalled();
			expect(api.reload).not.toHaveBeenCalled();
			expect(api.commands).not.toHaveBeenCalled();
			expect(api.stopRuntime).not.toHaveBeenCalled();
			expect(store.navigate).not.toHaveBeenCalled();
			expect(exportClick).not.toHaveBeenCalled();
			exportClick.mockRestore();
		},
	);

	it("excludes and intercepts every dashboard-invalid built-in", async () => {
		const invalid = ["copy", "hotkeys", "buddy"];
		const { element, textarea } = await mountCommandComposer(
			invalid.map((name) => ({ name, description: name, source: "builtin", dashboard: false })),
		);
		vi.mocked(api.prompt).mockClear();

		textarea.value = "/";
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
		expect(element.querySelector('[role="listbox"]')).toBeNull();
		for (const name of invalid) {
			await submitComposer(textarea, `/${name}`);
			expect(element.textContent).toContain(`/${name} is available only in the terminal UI`);
		}

		expect(api.prompt).not.toHaveBeenCalled();
	});

	it("surfaces the fail-closed RPC rejection when built-in discovery fails", async () => {
		vi.mocked(api.commands).mockRejectedValueOnce(new Error("command discovery failed"));
		vi.mocked(api.prompt).mockRejectedValueOnce(
			new Error("Built-in slash command /fork must be handled by the RPC client; it was not sent to the model."),
		);
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
		textarea.value = "/fork";
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.prompt).toHaveBeenCalledWith("k1", "/fork");
		expect(el.textContent).toContain("was not sent to the model");
		expect(textarea.value).toBe("/fork");
	});

	it("fails closed while built-in discovery is still pending, then dispatches after discovery", async () => {
		let resolveCommands: ((value: { commands: CommandDto[] }) => void) | undefined;
		vi.mocked(api.commands).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveCommands = resolve;
				}),
		);
		vi.mocked(api.prompt).mockRejectedValueOnce(
			new Error("Built-in slash command /fork must be handled by the RPC client; it was not sent to the model."),
		);
		const baseStore = makeStore() as any;
		const store = {
			...baseStore,
			sessions: { k1: createSessionViewState("k1") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: vi.fn(async () => {}),
		};
		const element = mount(() => <SessionScreen store={store} sessionKey="k1" />);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const textarea = element.querySelector("textarea") as HTMLTextAreaElement;
		vi.mocked(api.prompt).mockClear();

		await submitComposer(textarea, "/fork");

		expect(api.prompt).toHaveBeenCalledWith("k1", "/fork");
		expect(element.textContent).toContain("was not sent to the model");
		expect(textarea.value).toBe("/fork");

		resolveCommands?.({
			commands: [{ name: "fork", description: "Fork", source: "builtin", dashboard: true }],
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		await submitComposer(textarea, "/fork");

		expect(api.prompt).toHaveBeenCalledOnce();
		expect(api.forkMessages).toHaveBeenCalledWith("k1");
		expect(element.textContent).toContain("fork from message");
		expect(textarea.value).toBe("");
	});

	it.each(["/forklift", "/unknown with args"])(
		"sends unrecognized slash text %s to the model unchanged",
		async (text) => {
			const { textarea } = await mountCommandComposer([
				{ name: "fork", description: "Fork", source: "builtin", dashboard: true },
			]);
			vi.mocked(api.prompt).mockClear();

			await submitComposer(textarea, text);

			expect(api.prompt).toHaveBeenCalledWith("k1", text);
		},
	);

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

	it("fleet stop stays absent when its runtime_removed SSE echo arrives", async () => {
		const runtime = runtimeInfo("stop-from-fleet");
		vi.mocked(api.fleet).mockResolvedValueOnce({ runtimes: [runtime], diskSessions: [] });
		let handlers: EventStreamHandlers | undefined;
		vi.mocked(connectEvents).mockImplementation((next) => {
			handlers = next;
			return () => {};
		});
		const store = makeStore();
		await store.start();
		handlers?.onEnvelope({ seq: 1, key: runtime.key, event: { type: "agent_start" } });
		expect(store.sessions[runtime.key]).toBeDefined();
		const el = mount(() => <FleetScreen store={store} />);
		vi.mocked(api.stopRuntime).mockClear();
		vi.mocked(api.sessions).mockClear();
		vi.mocked(api.fleet).mockClear();

		(el.querySelector(".session-card .btn-danger") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.stopRuntime).toHaveBeenCalledOnce();
		expect(api.stopRuntime).toHaveBeenCalledWith(runtime.key);
		expect(store.fleet().runtimes).toEqual([]);
		expect(store.sessions[runtime.key]).toBeUndefined();
		expect(api.sessions).toHaveBeenCalledOnce();
		expect(api.fleet).not.toHaveBeenCalled();

		// The direct response wins first; its later SSE echo must take the
		// idempotent branch rather than scanning inventory again.
		handlers?.onEnvelope({ seq: 2, key: runtime.key, event: { type: "runtime_removed" } });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(store.fleet().runtimes).toEqual([]);
		expect(store.sessions[runtime.key]).toBeUndefined();
		expect(api.sessions).toHaveBeenCalledOnce();
		expect(api.fleet).not.toHaveBeenCalled();
	});

	it("session stop keeps a closed read-only transcript snapshot on the current route", async () => {
		const runtime = runtimeInfo("stop-from-session");
		runtime.state.sessionFile = "/sessions/stop-from-session.jsonl";
		vi.mocked(api.fleet).mockResolvedValueOnce({ runtimes: [runtime], diskSessions: [] });
		vi.mocked(api.hydrate).mockResolvedValueOnce({
			key: runtime.key,
			state: runtime.state,
			messages: [{ role: "assistant", content: [{ type: "text", text: "retained after stop" }] }],
			backgroundAgents: [],
			barrierSeq: 0,
		});
		const store = makeStore();
		await store.start();
		store.navigate({ screen: "session", key: runtime.key });
		const routeBeforeStop = window.location.hash;
		const el = mount(() => <SessionScreen store={store} sessionKey={runtime.key} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(el.textContent).toContain("retained after stop");
		vi.mocked(api.stopRuntime).mockClear();
		vi.mocked(api.sessions).mockClear();
		vi.mocked(api.fleet).mockClear();

		(el.querySelector(".session-bar .right .switcher:last-child") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const stop = [...el.querySelectorAll("button")].find((button) => button.textContent === "stop runtime");
		(stop as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.stopRuntime).toHaveBeenCalledWith(runtime.key);
		expect(store.fleet().runtimes).toEqual([]);
		expect(store.sessions[runtime.key]?.closed).toMatchObject({
			cwd: runtime.cwd,
			sessionFile: runtime.state.sessionFile,
		});
		expect(store.sessions[runtime.key]?.entries).not.toHaveLength(0);
		expect(api.sessions).toHaveBeenCalledOnce();
		expect(api.fleet).not.toHaveBeenCalled();
		expect(window.location.hash).toBe(routeBeforeStop);
		expect(el.textContent).toContain("retained after stop");
		expect(el.querySelector('[data-banner-key="closed"]')?.textContent).toContain("Resume session");
		expect(el.querySelector('[data-banner-key="closed"]')?.textContent).toContain("Return to fleet");
		expect(el.textContent).toContain("transcript is read-only");
		expect(el.querySelector(".composer")).toBeNull();
		expect(el.querySelector("textarea")).toBeNull();
		expect(el.querySelector(".session-bar .right")).toBeNull();
		expect(el.querySelector(".status-line")).toBeNull();
	});

	it("fleet resumes disk sessions with their session path", async () => {
		const store = makeStore() as any;
		const refreshDiskSessions = vi.fn(async () => {});
		const upsertRuntime = vi.fn();
		const navigate = vi.fn();
		const fakeStore = {
			...store,
			refreshDiskSessions,
			upsertRuntime,
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
		vi.mocked(api.fleet).mockClear();
		(el.querySelector(".disk-row .actions .btn") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.createRuntime).toHaveBeenCalledWith("/repo", { sessionPath: "/sessions/resume.jsonl" });
		expect(upsertRuntime).toHaveBeenCalledWith(expect.objectContaining({ key: "new-key" }));
		expect(refreshDiskSessions).toHaveBeenCalled();
		expect(vi.mocked(api.fleet)).not.toHaveBeenCalled();
		expect(navigate).toHaveBeenCalledWith({ screen: "session", key: "new-key" });
	});

	it("fleet deletes disk sessions and refreshes inventory", async () => {
		const store = makeStore() as any;
		const refreshDiskSessions = vi.fn(async () => {});
		const fakeStore = {
			...store,
			refreshDiskSessions,
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
		vi.mocked(api.fleet).mockClear();
		const rowButtons = [...el.querySelectorAll(".disk-row .actions .btn")] as HTMLButtonElement[];
		rowButtons.find((button) => button.textContent === "delete")?.click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		const modalButtons = [...el.querySelectorAll(".modal .btn-danger")] as HTMLButtonElement[];
		modalButtons.at(-1)?.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.deleteSession).toHaveBeenCalledWith("/sessions/delete.jsonl");
		expect(refreshDiskSessions).toHaveBeenCalled();
		expect(vi.mocked(api.fleet)).not.toHaveBeenCalled();
	});

	it("fleet polls stats every 30 seconds without an immediate round and cleans up on unmount", async () => {
		vi.useFakeTimers();
		const store = makeStore() as any;
		const refreshFleetStats = vi.fn(async () => {});
		const { dispose } = mountDisposable(() => <FleetScreen store={{ ...store, refreshFleetStats }} />);

		expect(refreshFleetStats).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(refreshFleetStats).toHaveBeenCalledOnce();
		// The screen delegates overlap control to the store's shared request.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(refreshFleetStats).toHaveBeenCalledTimes(2);
		dispose();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(refreshFleetStats).toHaveBeenCalledTimes(2);
	});

	it("fleet shows load and stats errors without clearing cards", () => {
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			fleet: () => ({
				runtimes: [
					{
						key: "live",
						cwd: "/repo",
						state: {
							sessionId: "live",
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
			fleetError: () => "server down",
			fleetStatsError: () => "stats down",
		};
		const el = mount(() => <FleetScreen store={fakeStore} />);
		expect(el.textContent).toContain("Fleet could not be loaded: server down");
		expect(el.textContent).toContain("Fleet stats could not be refreshed: stats down");
		expect(el.querySelectorAll(".session-card")).toHaveLength(1);
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

	it("status dock contains only the retry and compaction stop controls", async () => {
		const store = makeStore() as any;
		const session = createSessionViewState("abort-status");
		session.statusEntries = [
			{ id: 101, key: "compaction", text: "compacting context…", tone: "info" },
			{ id: 102, key: "retry", text: "retrying", tone: "warning" },
		];
		const fakeStore = {
			...store,
			sessions: { "abort-status": session },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="abort-status" />);
		const statusLine = el.querySelector("footer.dock .status-line");
		const buttons = [...(statusLine?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
		expect(buttons.map((button) => button.textContent)).toEqual(["stop compaction", "stop retry"]);
		expect(statusLine?.textContent).not.toContain("compacting context");
		expect(statusLine?.textContent).not.toContain("retrying");

		buttons.find((button) => button.textContent === "stop compaction")?.click();
		buttons.find((button) => button.textContent === "stop retry")?.click();
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
		vi.mocked(api.forkMessages).mockResolvedValue({
			messages: [{ entryId: "u1", text: "original prompt", role: "user" }],
		});
		vi.mocked(api.fork).mockResolvedValue({ text: "original prompt", cancelled: false });
		const store = makeStore() as any;
		const hydrateSession = vi.fn(async () => {});
		const refreshDiskSessions = vi.fn(async () => {});
		const fakeStore = {
			...store,
			sessions: { fork: createSessionViewState("fork") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession,
			refreshDiskSessions,
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="fork" />);
		(el.querySelector(".session-bar .right .switcher:last-child") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		[...el.querySelectorAll("button")].find((button) => button.textContent?.includes("fork"))?.click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(el.textContent).toContain("original prompt");
		vi.mocked(api.fleet).mockClear();
		(el.querySelector(".fork-message") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.fork).toHaveBeenCalledWith("fork", "u1");
		expect(hydrateSession).toHaveBeenCalledWith("fork");
		expect(refreshDiskSessions).toHaveBeenCalledOnce();
		expect(api.fleet).not.toHaveBeenCalled();
		expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe("original prompt");
	});

	it("fork modal forks at an assistant message without prefilling the composer", async () => {
		vi.mocked(api.forkMessages).mockResolvedValue({
			messages: [{ entryId: "a1", text: "the answer", role: "assistant" }],
		});
		// Assistant forks return empty re-ask text (branch already includes the answer).
		vi.mocked(api.fork).mockResolvedValue({ text: "", cancelled: false });
		const store = makeStore() as any;
		const hydrateSession = vi.fn(async () => {});
		const refreshDiskSessions = vi.fn(async () => {});
		const fakeStore = {
			...store,
			sessions: { forkasst: createSessionViewState("forkasst") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession,
			refreshDiskSessions,
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="forkasst" />);
		// Pre-type a draft into the composer. The no-clobber guard in finishFork must
		// preserve it: an assistant fork returns text "" and must NOT wipe the draft.
		const composer = el.querySelector("textarea") as HTMLTextAreaElement;
		composer.value = "draft in progress";
		composer.dispatchEvent(new InputEvent("input", { bubbles: true }));
		(el.querySelector(".session-bar .right .switcher:last-child") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		[...el.querySelectorAll("button")].find((button) => button.textContent?.includes("fork"))?.click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		// The row is labeled by role.
		expect(el.querySelector(".fork-role")?.textContent).toBe("assistant");
		(el.querySelector(".fork-message") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.fork).toHaveBeenCalledWith("forkasst", "a1");
		expect(hydrateSession).toHaveBeenCalledWith("forkasst");
		expect(refreshDiskSessions).toHaveBeenCalledOnce();
		// No composer pre-fill AND no clobber: the user's in-progress draft survives
		// (assistant forks return "" and must not overwrite the composer).
		expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe("draft in progress");
	});

	it("fork modal informs the user and stays open when a message fork is cancelled", async () => {
		vi.mocked(api.forkMessages).mockResolvedValue({
			messages: [{ entryId: "u1", text: "original prompt", role: "user" }],
		});
		// Extension veto → api.fork returns cancelled with no branch created.
		vi.mocked(api.fork).mockResolvedValue({ text: "", cancelled: true });
		const store = makeStore() as any;
		const hydrateSession = vi.fn(async () => {});
		const refreshDiskSessions = vi.fn(async () => {});
		const fakeStore = {
			...store,
			sessions: { forkmsgcancel: createSessionViewState("forkmsgcancel") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession,
			refreshDiskSessions,
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="forkmsgcancel" />);
		(el.querySelector(".session-bar .right .switcher:last-child") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		[...el.querySelectorAll("button")].find((button) => button.textContent?.includes("fork"))?.click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		// Ignore the mount-time hydration; assert only what the fork handler does.
		hydrateSession.mockClear();
		refreshDiskSessions.mockClear();
		(el.querySelector(".fork-message") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.fork).toHaveBeenCalledWith("forkmsgcancel", "u1");
		// The shared finishFork helper must inform the user for the message-fork flow too:
		// the modal stays open with a message, the composer is not pre-filled, and no
		// session churn happens as if a branch had been created.
		expect(el.querySelector(".fork-message")).not.toBeNull();
		expect(el.querySelector(".pair-error")?.textContent ?? "").toMatch(/no new branch|cancelled/i);
		expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
		expect(hydrateSession).not.toHaveBeenCalled();
		expect(refreshDiskSessions).not.toHaveBeenCalled();
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

	it("preserves attachments and composer text when a built-in command is rejected", async () => {
		stubObjectUrls();
		vi.mocked(api.commands).mockResolvedValue({
			commands: [{ name: "fork", description: "Fork", source: "builtin", dashboard: true }],
		});
		vi.mocked(api.prompt).mockClear();
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { image: createSessionViewState("image") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="image" />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const input = el.querySelector('input[accept="image/*"]') as HTMLInputElement;
		Object.defineProperty(input, "files", {
			configurable: true,
			value: [new File(["img"], "tiny.png", { type: "image/png" })],
		});
		input.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
		textarea.value = "/fork";
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(api.prompt).not.toHaveBeenCalled();
		expect(textarea.value).toBe("/fork");
		expect(el.querySelector(".attachment-thumb")).not.toBeNull();
		expect(el.textContent).toContain("nothing was sent or discarded");
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

	it("fleet cards prefer the latest client assistant text over the runtime fallback", () => {
		const store = makeStore() as any;
		const session = createSessionViewState("preview");
		session.entries = [
			{ kind: "assistant", streaming: false, blocks: [{ kind: "text", text: "older assistant reply" }] },
			{
				kind: "assistant",
				streaming: false,
				blocks: [
					{ kind: "thinking", text: "hidden" },
					{ kind: "text", text: "latest client reply" },
				],
			},
		];
		const fakeStore = {
			...store,
			sessions: { preview: session },
			fleet: () => ({
				runtimes: [
					{
						key: "preview",
						cwd: "/repo",
						state: {
							sessionId: "preview",
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
						lastAssistantText: "stale runtime fallback",
						createdAt: new Date().toISOString(),
						lastActivity: new Date().toISOString(),
					},
				],
				diskSessions: [],
			}),
		};
		const el = mount(() => <FleetScreen store={fakeStore} />);
		expect(el.querySelector(".activity")?.textContent).toContain("latest client reply");
		expect(el.querySelector(".activity")?.textContent).not.toContain("stale runtime fallback");
	});

	it("model selector defaults to scoped models and patches its card without a fleet fetch", async () => {
		vi.mocked(api.models).mockResolvedValue({
			models: [{ provider: "anthropic", id: "all-only", name: "All Only", contextWindow: 1000, reasoning: false }],
		});
		const store = makeStore() as any;
		const setRuntimeModel = vi.fn();
		const fakeStore = {
			...store,
			setRuntimeModel,
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
		vi.mocked(api.fleet).mockClear();
		(el.querySelector(".model-row") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(setRuntimeModel).toHaveBeenCalledWith("k1", {
			model: { provider: "test", id: "m1" },
			thinkingLevel: "off",
			availableThinkingLevels: ["off"],
			settingsRevision: 1,
		});
		expect(vi.mocked(api.fleet)).not.toHaveBeenCalled();
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

	it("hydrateSession re-seeds background agents from its atomic runtime snapshot", async () => {
		vi.mocked(api.hydrate).mockResolvedValue({
			key: "k-reload",
			state: {
				sessionId: "k-reload",
				tasks: [],
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				autoCompactionEnabled: true,
				messageCount: 0,
				pendingMessageCount: 0,
			},
			messages: [],
			backgroundAgents: [
				{
					agentId: "bg7",
					agentType: "feature-dev",
					taskSummary: "registry-seeded task",
					startedAt: new Date().toISOString(),
					status: "running",
					arbitrations: [
						{
							status: "success",
							proposed: { agent: "Explore", model: "provider/frontier", thinking: "high" },
							final: { agent: "feature-dev", model: "provider/cheap", thinking: "low" },
							changed: ["agent", "model", "thinking"],
						},
					],
				},
			],
			barrierSeq: 0,
		});
		const store = makeStore();
		await store.hydrateSession("k-reload");

		expect(store.sessions["k-reload"]?.backgroundAgents.bg7).toMatchObject({
			agentType: "feature-dev",
			taskSummary: "registry-seeded task",
			arbitrations: [{ final: { agent: "feature-dev", model: "provider/cheap", thinking: "low" } }],
		});
		const el = mount(() => <SessionScreen store={store} sessionKey="k-reload" />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(el.textContent).toContain("feature-dev — registry-seeded task");
		expect(el.textContent).toContain("provider/cheap @ low");
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

	const IMAGE_ID = "a".repeat(64);
	const SECOND_IMAGE_ID = "b".repeat(64);
	const imageEntry = (images: ToolEntry["images"], toolName = "read"): ToolEntry => ({
		kind: "tool",
		toolCallId: `image-${toolName}`,
		toolName,
		args: {},
		status: "done",
		resultText: "",
		images,
		startedAt: Date.now(),
	});

	it("requests a bounded preview by default using a same-origin reference URL", () => {
		const read = imageEntry([{ id: IMAGE_ID, mimeType: "image/png", size: 1234 }]);
		const el = mount(() => <Transcript entries={[read]} imageScope={{ runtimeKey: "runtime one" }} />);
		const img = el.querySelector("img.tool-image") as HTMLImageElement | null;

		expect(img?.getAttribute("src")).toBe(`/api/runtimes/runtime%20one/images/${IMAGE_ID}/preview`);
		expect(el.textContent).toContain("load original · 2 KB");
	});

	it("renders photo-button uploads as previews in user transcript entries", () => {
		const user: UserEntry = {
			kind: "user",
			text: "describe this",
			images: [{ id: IMAGE_ID, mimeType: "image/png", size: 1234 }],
		};
		const el = mount(() => <Transcript entries={[user]} imageScope={{ runtimeKey: "runtime" }} />);
		const image = el.querySelector(".entry.user img.tool-image") as HTMLImageElement | null;

		expect(image?.alt).toBe("Uploaded image");
		expect(image?.getAttribute("src")).toBe(`/api/runtimes/runtime/images/${IMAGE_ID}/preview`);
	});

	it("renders image references for extension tools and encoded subagent scopes", () => {
		const custom = imageEntry([{ id: IMAGE_ID, mimeType: "image/webp", size: 10 }], "extension_image");
		const el = mount(() => (
			<Transcript entries={[custom]} imageScope={{ runtimeKey: "runtime", agentId: "agent/one" }} />
		));
		const tool = el.querySelector("details.tool") as HTMLDetailsElement;
		setDetailsOpen(tool, true);
		expect(el.querySelector("img.tool-image")?.getAttribute("src")).toBe(
			`/api/runtimes/runtime/subagents/agent%2Fone/images/${IMAGE_ID}/preview`,
		);
	});

	it("placeholder mode assigns no src until preview loading is explicit", () => {
		setImageDisplayMode("placeholders");
		const read = imageEntry([{ id: IMAGE_ID, mimeType: "image/png", size: 1234 }]);
		const el = mount(() => <Transcript entries={[read]} imageScope={{ runtimeKey: "runtime" }} />);
		expect(el.querySelector("img.tool-image")).toBeNull();
		const button = Array.from(el.querySelectorAll("button")).find(
			(candidate) => candidate.textContent === "load preview",
		)!;
		button.click();
		expect(el.querySelector("img.tool-image")?.getAttribute("src")).toBe(
			`/api/runtimes/runtime/images/${IMAGE_ID}/preview`,
		);
	});

	it("preview click opens a lightbox with the same preview URL", () => {
		const read = imageEntry([{ id: IMAGE_ID, mimeType: "image/png", size: 1234 }]);
		const el = mount(() => <Transcript entries={[read]} imageScope={{ runtimeKey: "runtime" }} />);
		(el.querySelector(".tool-image-button") as HTMLButtonElement).click();
		const dialog = el.querySelector('[role="dialog"]');
		expect(dialog?.querySelector("img")?.getAttribute("src")).toBe(
			`/api/runtimes/runtime/images/${IMAGE_ID}/preview`,
		);
	});

	it("closes the image lightbox with Escape", () => {
		const read = imageEntry([{ id: IMAGE_ID, mimeType: "image/png", size: 1234 }]);
		const el = mount(() => <Transcript entries={[read]} imageScope={{ runtimeKey: "runtime" }} />);
		(el.querySelector(".tool-image-button") as HTMLButtonElement).click();
		expect(el.querySelector('[role="dialog"]')).not.toBeNull();

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

		expect(el.querySelector('[role="dialog"]')).toBeNull();
	});

	it("large explicit originals confirm before assigning their URL", () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		const read = imageEntry([{ id: IMAGE_ID, mimeType: "image/png", size: 2 * 1024 * 1024 }]);
		const el = mount(() => <Transcript entries={[read]} imageScope={{ runtimeKey: "runtime" }} />);
		const action = Array.from(el.querySelectorAll("button")).find((candidate) =>
			candidate.textContent?.includes("load original"),
		)!;
		action.click();
		expect(confirm).toHaveBeenCalledOnce();
		expect(el.querySelector("img.tool-image")?.getAttribute("src")).toContain("/preview");
		confirm.mockReturnValue(true);
		action.click();
		expect(el.querySelector("img.tool-image")?.getAttribute("src")).toBe(
			`/api/runtimes/runtime/images/${IMAGE_ID}/original`,
		);
		confirm.mockRestore();
	});

	it("automatic-original mode assigns only the original without per-image confirmation", () => {
		const confirm = vi.spyOn(window, "confirm");
		setImageDisplayMode("originals");
		const read = imageEntry([{ id: IMAGE_ID, mimeType: "image/gif", size: 2 * 1024 * 1024 }]);
		const el = mount(() => <Transcript entries={[read]} imageScope={{ runtimeKey: "runtime" }} />);
		expect(el.querySelector("img.tool-image")?.getAttribute("src")).toBe(
			`/api/runtimes/runtime/images/${IMAGE_ID}/original`,
		);
		expect(confirm).not.toHaveBeenCalled();
		confirm.mockRestore();
	});

	it("keeps preview fallback and original retry actions after an original load fails", () => {
		const read = imageEntry([{ id: IMAGE_ID, mimeType: "image/png", size: 1234 }]);
		const el = mount(() => <Transcript entries={[read]} imageScope={{ runtimeKey: "runtime" }} />);
		const original = Array.from(el.querySelectorAll("button")).find((candidate) =>
			candidate.textContent?.includes("load original"),
		)!;
		original.click();
		el.querySelector("img.tool-image")?.dispatchEvent(new Event("error"));

		expect(el.querySelector('[role="alert"]')?.textContent).toContain("Could not load original");
		expect(el.querySelector("img.tool-image")).toBeNull();
		expect(el.textContent).toContain("retry preview");
		expect(el.textContent).toContain("load original");

		const retryPreview = Array.from(el.querySelectorAll("button")).find(
			(candidate) => candidate.textContent === "retry preview",
		)!;
		retryPreview.click();
		expect(el.querySelector("img.tool-image")?.getAttribute("src")).toBe(
			`/api/runtimes/runtime/images/${IMAGE_ID}/preview`,
		);
		expect(el.querySelector('[role="alert"]')).toBeNull();
	});

	it("rejects disallowed MIME types and malformed IDs as defense-in-depth", () => {
		const read = imageEntry([
			{ id: IMAGE_ID, mimeType: "image/svg+xml" as "image/png", size: 10 },
			{ id: "bad", mimeType: "image/png", size: 10 },
		]);
		const el = mount(() => <Transcript entries={[read]} imageScope={{ runtimeKey: "runtime" }} />);
		expect(el.querySelector(".tool-images")).toBeNull();
	});

	it("renders multiple valid image references", () => {
		const read = imageEntry([
			{ id: IMAGE_ID, mimeType: "image/png", size: 10 },
			{ id: SECOND_IMAGE_ID, mimeType: "image/webp", size: 20 },
		]);
		const el = mount(() => <Transcript entries={[read]} imageScope={{ runtimeKey: "runtime" }} />);
		expect(el.querySelectorAll("img.tool-image")).toHaveLength(2);
	});
});
