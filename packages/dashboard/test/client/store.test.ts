// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundAgentDto, RuntimeInfoDto } from "../../src/shared/protocol.js";

vi.mock("../../src/client/api.js", () => ({
	api: {
		auth: vi.fn(),
		fleet: vi.fn(),
		messages: vi.fn(),
		backgroundAgents: vi.fn(),
		runtime: vi.fn(),
		subagentMessages: vi.fn(),
	},
	connectEvents: vi.fn(() => () => {}),
}));

import { api, connectEvents, type EventStreamHandlers } from "../../src/client/api.js";
import { createAppStore } from "../../src/client/state/store.js";

let eventHandlers: EventStreamHandlers | undefined;
let seq = 0;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function runtimeSnapshot(key: string, streaming: boolean): RuntimeInfoDto {
	return {
		key,
		cwd: "/tmp/project",
		state: {
			sessionId: key,
			thinkingLevel: "off",
			isStreaming: streaming,
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

function agentSnapshot(agentId: string, status: BackgroundAgentDto["status"]): BackgroundAgentDto {
	return {
		agentId,
		agentType: "Explore",
		taskSummary: "scan things",
		startedAt: new Date(0).toISOString(),
		status,
	};
}

async function makeStartedStore() {
	const store = createAppStore();
	await store.start();
	if (!eventHandlers) throw new Error("connectEvents was not called");
	return store;
}

function emit(key: string, event: Record<string, unknown>): void {
	if (!eventHandlers) throw new Error("store event stream is not connected");
	eventHandlers.onEnvelope({ seq: ++seq, key, event });
}

beforeEach(() => {
	eventHandlers = undefined;
	seq = 0;
	window.location.hash = "#/";
	vi.mocked(api.auth).mockResolvedValue({ mode: "local", needsPairing: false });
	vi.mocked(api.fleet).mockResolvedValue({ runtimes: [], diskSessions: [] });
	vi.mocked(api.messages).mockResolvedValue({ messages: [] });
	vi.mocked(api.backgroundAgents).mockResolvedValue({ agents: [] });
	vi.mocked(api.runtime).mockResolvedValue(runtimeSnapshot("default", false));
	vi.mocked(api.subagentMessages).mockResolvedValue({ agent: agentSnapshot("bg1", "completed"), messages: [] });
	vi.mocked(connectEvents).mockImplementation((handlers) => {
		eventHandlers = handlers;
		return () => {};
	});
});

afterEach(() => {
	window.location.hash = "#/";
	vi.clearAllMocks();
});

describe("app store hydration", () => {
	it("hydrates the initial session snapshot when no live revision changes", async () => {
		vi.mocked(api.messages).mockResolvedValue({
			messages: [{ role: "assistant", content: [{ type: "text", text: "snapshot text" }] }],
		});
		vi.mocked(api.runtime).mockResolvedValue(runtimeSnapshot("s1", true));
		const store = createAppStore();

		await store.hydrateSession("s1");

		expect(store.sessions.s1?.entries[0]).toMatchObject({
			kind: "assistant",
			blocks: [{ kind: "text", text: "snapshot text" }],
		});
		expect(store.sessions.s1?.streaming).toBe(true);
		expect(store.sessions.s1?.workingSince).toEqual(expect.any(Number));
	});

	it("does not let a stale session REST snapshot clobber newer live SSE state", async () => {
		const messages = deferred<{ messages: unknown[] }>();
		const agents = deferred<{ agents: BackgroundAgentDto[] }>();
		const runtime = deferred<RuntimeInfoDto>();
		vi.mocked(api.messages).mockReturnValueOnce(messages.promise);
		vi.mocked(api.backgroundAgents).mockReturnValueOnce(agents.promise);
		vi.mocked(api.runtime).mockReturnValueOnce(runtime.promise);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSession("s1");
		emit("s1", { type: "agent_start" });
		emit("s1", { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
		emit("s1", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "live SSE text" },
		});
		messages.resolve({ messages: [{ role: "assistant", content: [{ type: "text", text: "stale snapshot" }] }] });
		agents.resolve({ agents: [] });
		runtime.resolve(runtimeSnapshot("s1", false));

		await hydrate;

		const session = store.sessions.s1;
		expect(session?.streaming).toBe(true);
		expect(session?.workingSince).toEqual(expect.any(Number));
		expect(session?.entries[0]).toMatchObject({
			kind: "assistant",
			streaming: true,
			blocks: [{ kind: "text", text: "live SSE text" }],
		});
		expect(JSON.stringify(session?.entries)).not.toContain("stale snapshot");
	});

	it("does not let a stale subagent REST snapshot clobber newer live SSE state", async () => {
		const snapshot = deferred<{ agent: BackgroundAgentDto; messages: unknown[] }>();
		vi.mocked(api.subagentMessages).mockReturnValueOnce(snapshot.promise);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSubagent("s1", "bg1");
		emit("s1", { type: "background_agent_event", agentId: "bg1", event: { type: "agent_start" } });
		emit("s1", {
			type: "background_agent_event",
			agentId: "bg1",
			event: { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
		});
		emit("s1", {
			type: "background_agent_event",
			agentId: "bg1",
			event: {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "live child text" },
			},
		});
		snapshot.resolve({
			agent: agentSnapshot("bg1", "completed"),
			messages: [{ role: "assistant", content: [{ type: "text", text: "stale child snapshot" }] }],
		});

		await hydrate;

		const subagent = store.sessions.s1?.subagents.bg1;
		expect(subagent?.streaming).toBe(true);
		expect(subagent?.entries[0]).toMatchObject({
			kind: "assistant",
			streaming: true,
			blocks: [{ kind: "text", text: "live child text" }],
		});
		expect(JSON.stringify(subagent?.entries)).not.toContain("stale child snapshot");
	});
});
