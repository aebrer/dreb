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
import {
	addComposerHistoryEntry,
	evictComposerMemory,
	getComposerDraft,
	getComposerHistory,
	setComposerDraft,
} from "../../src/client/state/composer-memory.js";
import { MAX_COMPLETED_BACKGROUND_AGENTS } from "../../src/client/state/reducer.js";
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

function agentSnapshot(agentId: string, status: BackgroundAgentDto["status"], startedAtMs = 0): BackgroundAgentDto {
	return {
		agentId,
		agentType: "Explore",
		taskSummary: "scan things",
		startedAt: new Date(startedAtMs).toISOString(),
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
	for (const key of ["s1", "composer-round-trip", "removed-session"]) evictComposerMemory(key);
	vi.clearAllMocks();
});

describe("composer memory", () => {
	it("sets and evicts per-session draft and history", () => {
		const key = "composer-round-trip";

		setComposerDraft(key, "draft text");
		addComposerHistoryEntry(key, "first prompt");
		addComposerHistoryEntry(key, "second prompt");

		expect(getComposerDraft(key)).toBe("draft text");
		expect(getComposerHistory(key)).toEqual(["first prompt", "second prompt"]);

		evictComposerMemory(key);

		expect(getComposerDraft(key)).toBeUndefined();
		expect(getComposerHistory(key)).toEqual([]);
	});
});

describe("app store SSE sync", () => {
	it("creates per-key session state lazily and routes events", async () => {
		const store = await makeStartedStore();

		emit("a", { type: "agent_start" });
		emit("b", { type: "agent_start" });
		emit("a", { type: "agent_end", messages: [] });

		expect(store.sessions.a?.streaming).toBe(false);
		expect(store.sessions.b?.streaming).toBe(true);
	});

	it("dashboard_resync clears all session state (caller rehydrates)", async () => {
		const store = await makeStartedStore();

		emit("a", { type: "agent_start" });
		expect(store.sessions.a).toBeDefined();

		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		expect(store.sessions.a).toBeUndefined();
		expect(store.revisions.a).toBeUndefined();
	});

	it("runtime_removed deletes session state, revision state, composer memory, and refreshes fleet", async () => {
		const store = await makeStartedStore();
		const key = "removed-session";

		emit(key, { type: "message_start", message: { role: "user", content: "hello" } });
		setComposerDraft(key, "draft text");
		addComposerHistoryEntry(key, "history text");
		expect(store.sessions[key]).toBeDefined();
		expect(store.revisions[key]).toBeDefined();
		expect(getComposerDraft(key)).toBe("draft text");
		expect(getComposerHistory(key)).toEqual(["history text"]);

		emit(key, { type: "runtime_removed" });

		expect(store.sessions[key]).toBeUndefined();
		expect(store.revisions[key]).toBeUndefined();
		expect(key in store.sessions).toBe(false);
		expect(key in store.revisions).toBe(false);
		expect(getComposerDraft(key)).toBeUndefined();
		expect(getComposerHistory(key)).toEqual([]);
		expect(api.fleet).toHaveBeenCalledTimes(2);
	});

	it("applies streaming text deltas without replacing stable entry identities", async () => {
		const store = await makeStartedStore();

		emit("s1", { type: "agent_start" });
		emit("s1", { type: "message_start", message: { role: "user", content: "hello" } });
		emit("s1", { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
		emit("s1", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "first" },
		});
		const session = store.sessions.s1;
		if (!session) throw new Error("session was not created");
		const entriesBefore = session.entries;
		const userBefore = entriesBefore[0];
		const assistantBefore = entriesBefore[1];
		const revisionBefore = store.revisions.s1;

		emit("s1", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " second" },
		});

		expect(store.sessions.s1?.entries).toBe(entriesBefore);
		expect(store.sessions.s1?.entries[0]).toBe(userBefore);
		expect(store.sessions.s1?.entries[1]).toBe(assistantBefore);
		expect(store.sessions.s1?.entries[1]).toMatchObject({
			kind: "assistant",
			blocks: [{ kind: "text", text: "first second" }],
		});
		expect(store.revisions.s1).toBe((revisionBefore ?? 0) + 1);
	});
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

	it("caps completed background agents when hydrating the session registry", async () => {
		const agents: BackgroundAgentDto[] = [];
		for (let i = 0; i < 25; i++) agents.push(agentSnapshot(`done-${i}`, "completed", i * 1000));
		agents.push(agentSnapshot("running-old", "running", 0));
		vi.mocked(api.backgroundAgents).mockResolvedValue({ agents });
		const store = createAppStore();

		await store.hydrateSession("s1");

		const completed = Object.values(store.sessions.s1?.backgroundAgents ?? {}).filter(
			(agent) => agent.status !== "running",
		);
		expect(completed).toHaveLength(MAX_COMPLETED_BACKGROUND_AGENTS);
		expect(store.sessions.s1?.backgroundAgents["done-0"]).toBeUndefined();
		expect(store.sessions.s1?.backgroundAgents["done-4"]).toBeUndefined();
		expect(store.sessions.s1?.backgroundAgents["done-5"]).toBeDefined();
		expect(store.sessions.s1?.backgroundAgents["running-old"]?.status).toBe("running");
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
