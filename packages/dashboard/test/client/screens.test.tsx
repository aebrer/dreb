// @vitest-environment jsdom
/**
 * Screen smoke tests — every shipped screen renders without throwing, with
 * both empty state and populated state where meaningful (SPEC §9.11).
 */

import { render } from "solid-js/web/dist/web.js";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the API module: screens fetch on mount; smoke tests must not hit a server.
vi.mock("../../src/client/api.js", () => ({
	api: {
		auth: vi.fn(async () => ({ mode: "local", needsPairing: false })),
		fleet: vi.fn(async () => ({ runtimes: [], diskSessions: [] })),
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
		listFiles: vi.fn(async () => ({
			path: "/home/test",
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
import { Transcript } from "../../src/client/components/transcript.js";
import { FilesScreen } from "../../src/client/screens/files.js";
import { FleetScreen, fleetGroupKey } from "../../src/client/screens/fleet.js";
import { PairingScreen } from "../../src/client/screens/pairing.js";
import { formatTokens, SessionScreen } from "../../src/client/screens/session.js";
import { SettingsScreen } from "../../src/client/screens/settings.js";
import { SubagentScreen } from "../../src/client/screens/subagent.js";
import { setExpandThinking } from "../../src/client/state/preferences.js";
import {
	applySessionEvent,
	createSessionViewState,
	type SessionViewState,
	type ToolEntry,
} from "../../src/client/state/reducer.js";
import { createAppStore } from "../../src/client/state/store.js";

const disposers: Array<() => void> = [];

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	document.body.innerHTML = "";
	setExpandThinking(false);
	window.localStorage.clear();
	vi.mocked(connectEvents).mockImplementation(() => () => {});
	vi.mocked(api.models).mockResolvedValue({ models: [] });
	vi.mocked(api.settingsModels).mockResolvedValue({ models: [] });
	vi.mocked(api.agentTypes).mockResolvedValue({ agentTypes: [] });
	vi.mocked(api.settings).mockResolvedValue({ defaultProvider: "anthropic", defaultModel: "m1" });
	vi.mocked(api.saveSettings).mockImplementation(async (settings) => settings);
	vi.mocked(api.devices).mockResolvedValue({ devices: [] });
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
	vi.mocked(api.pending).mockResolvedValue({ steering: [], followUp: [] });
	vi.mocked(api.dequeue).mockResolvedValue({ steering: [], followUp: [] });
	vi.mocked(api.forkMessages).mockResolvedValue({ messages: [] });
	vi.mocked(api.fork).mockResolvedValue({ text: "", cancelled: false });
	vi.mocked(api.dailyCost).mockResolvedValue({ cost: 0.42 });
	vi.unstubAllGlobals();
	vi.mocked(api.places).mockResolvedValue({ places: [{ label: "home", path: "/home/test" }] });
	vi.mocked(api.listFiles).mockResolvedValue({
		path: "/home/test",
		entries: [
			{ name: "src", type: "dir", size: 0, modified: new Date().toISOString() },
			{ name: "readme.md", type: "file", size: 1200, modified: new Date().toISOString() },
		],
	});
});

function mount(element: () => any): HTMLElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	disposers.push(render(element, container));
	return container;
}

function makeStore() {
	// createAppStore touches window.location.hash — jsdom provides it.
	return createAppStore();
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

	it("settings renders defaults, devices, and the live-sessions copy", async () => {
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(el.textContent).toContain("Live sessions keep their current values");
		expect(el.textContent).toContain("default model");
		expect(el.textContent).toContain("devices");
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
		expect(el.textContent).toContain("auto-load nested context");
		expect(el.textContent).toContain("hide thinking blocks");
		expect(el.textContent).toContain("transport");
		expect(el.textContent).toContain("agent models");
		expect(el.textContent).toContain("Explore");
		expect(el.textContent).toContain("default");
		expect(el.textContent).toContain("TUI-only settings");
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
});

describe("dashboard client regressions", () => {
	it("formats token counts like the TUI footer", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1200)).toBe("1.2k");
		expect(formatTokens(45000)).toBe("45k");
		expect(formatTokens(1_200_000)).toBe("1.2M");
		expect(formatTokens(12_000_000)).toBe("12M");
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
		const el = mount(() => (
			<Transcript
				entries={[
					{
						kind: "assistant",
						blocks: [
							{
								kind: "text",
								text: "**bold**\n\n```ts\nconst x = 1;\n```\n\n<script>window.evil = true</script>",
							},
						],
						streaming: false,
					},
				]}
			/>
		));

		expect(el.querySelector("strong")?.textContent).toBe("bold");
		expect(el.querySelector("pre code")?.textContent).toContain("const x = 1");
		expect(el.querySelector("script")).toBeNull();
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

	it("settings toggles the browser-local expand-thinking preference", async () => {
		const store = makeStore();
		const el = mount(() => <SettingsScreen store={store} />);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const checkbox = el.querySelector(".checkbox-control input") as HTMLInputElement | null;
		expect(checkbox).not.toBeNull();
		expect(window.localStorage.getItem("dreb.dashboard.expandThinking")).toBeNull();

		checkbox!.click();

		expect(window.localStorage.getItem("dreb.dashboard.expandThinking")).toBe("true");
		expect(checkbox!.checked).toBe(true);
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
		const boxes = el.querySelectorAll(".checkbox-control input");
		const notifications = boxes[1] as HTMLInputElement;

		notifications.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(fakeNotification.requestPermission).toHaveBeenCalled();
		expect(notifications.checked).toBe(true);
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
		vi.mocked(api.listFiles).mockResolvedValue({ path: "/home/slow", entries: [] });

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

		const headers = [...el.querySelectorAll(".model-provider-heading")].map((node) => node.textContent);
		expect(headers).toEqual(["anthropic", "github-copilot"]);
		expect(el.querySelectorAll(".model-row")).toHaveLength(2);
		expect(el.querySelector(".model-row.current")?.textContent).toContain("github-copilot");
		expect(el.querySelector(".model-row.current")?.textContent).toContain("✓");
	});

	it("queued messages render as chips and restore all text to the composer", async () => {
		vi.mocked(api.pending).mockResolvedValue({ steering: ["steer one"], followUp: ["follow one"] });
		vi.mocked(api.dequeue).mockResolvedValue({ steering: ["steer one"], followUp: ["follow one"] });
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

		[...el.querySelectorAll("button")].find((button) => button.textContent?.includes("restore"))?.click();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(api.dequeue).toHaveBeenCalledWith("queued");
		expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe("steer one\n\nfollow one");
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

	it("image file attachments are sent with the prompt", async () => {
		vi.mocked(api.prompt).mockClear();
		const store = makeStore() as any;
		const fakeStore = {
			...store,
			sessions: { image: createSessionViewState("image") },
			fleet: () => ({ runtimes: [], diskSessions: [] }),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="image" />);
		const input = el.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File(["img"], "tiny.png", { type: "image/png" });
		Object.defineProperty(input, "files", { configurable: true, value: [file] });
		input.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
		textarea.value = "describe this";
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(api.prompt).toHaveBeenCalledWith("image", "describe this", undefined, [
			expect.objectContaining({ mimeType: "image/png", data: expect.any(String) }),
		]);
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

		expect(api.subagentMessages).toHaveBeenCalledWith("k-reload", "bg9");
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
