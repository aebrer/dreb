// @vitest-environment jsdom
/**
 * Screen smoke tests — every shipped screen renders without throwing, with
 * both empty state and populated state where meaningful (SPEC §9.11).
 */

import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the API module: screens fetch on mount; smoke tests must not hit a server.
vi.mock("../../src/client/api.js", () => ({
	api: {
		auth: vi.fn(async () => ({ mode: "local", needsPairing: false })),
		fleet: vi.fn(async () => ({ runtimes: [], diskSessions: [] })),
		messages: vi.fn(async () => ({ messages: [] })),
		models: vi.fn(async () => ({ models: [] })),
		settings: vi.fn(async () => ({ defaultProvider: "anthropic", defaultModel: "m1" })),
		devices: vi.fn(async () => ({ devices: [] })),
		version: vi.fn(async () => ({ version: "0.0.0-test" })),
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
		prompt: vi.fn(async () => ({})),
		abort: vi.fn(async () => ({})),
	},
	connectEvents: vi.fn(() => () => {}),
}));

import { FilesScreen } from "../../src/client/screens/files.js";
import { FleetScreen } from "../../src/client/screens/fleet.js";
import { PairingScreen } from "../../src/client/screens/pairing.js";
import { SessionScreen } from "../../src/client/screens/session.js";
import { SettingsScreen } from "../../src/client/screens/settings.js";
import { SubagentScreen } from "../../src/client/screens/subagent.js";
import { applySessionEvent, createSessionViewState, type SessionViewState } from "../../src/client/state/reducer.js";
import { createAppStore } from "../../src/client/state/store.js";

const disposers: Array<() => void> = [];

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	document.body.innerHTML = "";
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

describe("screen smoke tests", () => {
	it("fleet renders (empty state)", () => {
		const store = makeStore();
		const el = mount(() => <FleetScreen store={store} />);
		expect(el.textContent).toContain("fleet");
		expect(el.textContent).toContain("No sessions yet");
	});

	it("session view renders with a populated transcript", () => {
		const store = makeStore() as any;
		// Inject session state directly (store internals sync from the reducer).
		const session = populatedSession("k1");
		store.sessions.k1 = undefined; // ensure key exists path
		// createStore proxies: assign via the exposed setter path — simplest is
		// rendering with the raw state injected through a wrapper store object.
		const fakeStore = {
			...store,
			sessions: { k1: session },
			fleet: () => ({
				runtimes: [
					{
						key: "k1",
						cwd: "/tmp",
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
							contextUsage: { tokens: 50000, contextWindow: 200000, percent: 25 },
						},
						backgroundAgents: [],
						needsAttention: false,
						lastActivity: new Date().toISOString(),
					},
				],
				diskSessions: [],
			}),
			hydrateSession: async () => {},
		};
		const el = mount(() => <SessionScreen store={fakeStore} sessionKey="k1" />);
		expect(el.textContent).toContain("hello world");
		expect(el.textContent).toContain("edit");
		expect(el.textContent).toContain("task one");
		expect(el.textContent).toContain("steer");
		expect(el.textContent).toContain("follow-up");
		expect(el.textContent).toContain("■ stop");
		expect(el.textContent).toContain("ctx");
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
