// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundAgentDto, RuntimeHydrationDto, RuntimeInfoDto } from "../../src/shared/protocol.js";

vi.mock("../../src/client/api.js", () => ({
	api: {
		auth: vi.fn(),
		fleet: vi.fn(),
		sessions: vi.fn(),
		resync: vi.fn(),
		hydrate: vi.fn(),
		messages: vi.fn(),
		backgroundAgents: vi.fn(),
		runtime: vi.fn(),
		stats: vi.fn(),
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

function abortError(): DOMException {
	return new DOMException("Aborted", "AbortError");
}

function rejectAfterAbort<T>(signal: AbortSignal | undefined): Promise<T> {
	return new Promise<T>((_, reject) => {
		if (!signal) throw new Error("expected AbortSignal");
		signal.addEventListener("abort", () => reject(abortError()), { once: true });
	});
}

function runtimeSnapshot(key: string, streaming: boolean): RuntimeInfoDto {
	return {
		key,
		cwd: "/tmp/project",
		state: {
			sessionId: key,
			tasks: [],
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

function hydrationSnapshot(key: string, streaming: boolean): RuntimeHydrationDto {
	const runtime = runtimeSnapshot(key, streaming);
	return {
		key,
		state: runtime.state,
		messages: [],
		backgroundAgents: [],
		barrierSeq: 0,
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

async function flushAsyncWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	eventHandlers = undefined;
	seq = 0;
	window.location.hash = "#/";
	vi.mocked(api.auth).mockResolvedValue({ mode: "local", needsPairing: false });
	vi.mocked(api.fleet).mockResolvedValue({ runtimes: [], diskSessions: [] });
	vi.mocked(api.sessions).mockResolvedValue({ sessions: [] });
	vi.mocked(api.resync).mockResolvedValue({ fleet: { runtimes: [], diskSessions: [] }, barrierSeq: 0 });
	vi.mocked(api.hydrate).mockResolvedValue(hydrationSnapshot("default", false));
	vi.mocked(api.messages).mockResolvedValue({ messages: [] });
	vi.mocked(api.backgroundAgents).mockResolvedValue({ agents: [] });
	vi.mocked(api.runtime).mockResolvedValue(runtimeSnapshot("default", false));
	vi.mocked(api.stats).mockResolvedValue({
		sessionId: "default",
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
	});
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

	it("reconciles only envelopes after the explicit resync barrier", async () => {
		const snapshot = runtimeSnapshot("a", true);
		snapshot.state.tasks = [{ id: "restore", title: "restore tasks", status: "in_progress" }];
		vi.mocked(api.resync).mockResolvedValue({
			fleet: { runtimes: [snapshot], diskSessions: [] },
			active: {
				key: "a",
				state: snapshot.state,
				messages: [{ role: "user", content: "from snapshot" }],
				backgroundAgents: [],
				barrierSeq: 3,
			},
			barrierSeq: 3,
		});
		const store = await makeStartedStore();

		emit("a", { type: "agent_start" });
		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		// This pre-snapshot frame is represented by the authoritative snapshot,
		// so applying it again would create a duplicate transcript entry. The HTTP
		// barrier is authoritative; no second SSE reason=snapshot frame exists.
		emit("a", { type: "message_start", message: { role: "user", content: "discard me" } });
		await Promise.resolve();
		emit("a", { type: "tasks_update", tasks: [{ id: "live", title: "live task", status: "completed" }] });
		await Promise.resolve();

		expect(store.sessions.a?.entries).toMatchObject([{ kind: "user", text: "from snapshot" }]);
		expect(store.sessions.a?.tasks).toEqual([{ id: "live", title: "live task", status: "completed" }]);
		expect(store.resyncing()).toBe(false);
	});

	it.each([false, true])(
		"clears stale status, command, attention, and extension affordances when resync restores streaming=%s",
		async (streaming) => {
			const snapshot = runtimeSnapshot("a", streaming);
			vi.mocked(api.resync).mockResolvedValueOnce({
				fleet: { runtimes: [snapshot], diskSessions: [] },
				active: {
					key: "a",
					state: snapshot.state,
					messages: [],
					backgroundAgents: [],
					barrierSeq: 20,
				},
				barrierSeq: 20,
			});
			const store = await makeStartedStore();

			emit("a", { type: "agent_start" });
			emit("a", { type: "tool_execution_start", toolCallId: "stale", toolName: "stale_tool", args: {} });
			emit("a", { type: "parent_paused_for_background_agents", runningAgentCount: 1 });
			emit("a", { type: "auto_retry_end", success: false, finalError: "model failed" });
			emit("a", { type: "suggest_next", command: "try again" });
			emit("a", {
				type: "extension_ui_request",
				method: "setWidget",
				widgetPlacement: "aboveEditor",
				widgetLines: ["stale widget"],
			});
			emit("a", { type: "extension_ui_request", method: "notify", message: "stale toast" });
			emit("a", { type: "extension_ui_request", method: "setTitle", title: "stale title" });
			emit("a", { type: "extension_ui_request", method: "set_editor_text", text: "stale draft" });
			expect(store.sessions.a?.statusEntries.map((entry) => entry.key)).toEqual(["paused", "error"]);
			expect(store.sessions.a?.suggestedCommand).toBe("try again");
			expect(store.sessions.a?.lastError).toBe("model failed");
			expect(store.sessions.a?.needsAttention).toBe(true);
			expect(store.sessions.a?.widgets.above).toEqual(["stale widget"]);
			expect(store.sessions.a?.toasts).toHaveLength(1);
			expect(store.sessions.a?.title).toBe("stale title");
			expect(store.sessions.a?.composerPrefill).toBe("stale draft");
			expect(store.sessions.a?.workingText).toBe("stale_tool");

			emit("", { type: "dashboard_resync", reason: "buffer_gap" });
			await vi.waitFor(() => expect(store.resyncing()).toBe(false));

			expect(store.sessions.a?.streaming).toBe(streaming);
			expect(store.sessions.a?.statusEntries).toEqual([]);
			expect(store.sessions.a?.suggestedCommand).toBeUndefined();
			expect(store.sessions.a?.lastError).toBeUndefined();
			expect(store.sessions.a?.needsAttention).toBe(false);
			expect(store.sessions.a?.widgets).toEqual({ above: [], below: [] });
			expect(store.sessions.a?.toasts).toEqual([]);
			expect(store.sessions.a?.title).toBeUndefined();
			expect(store.sessions.a?.composerPrefill).toBeUndefined();
			if (streaming) {
				expect(store.sessions.a?.workingText).toBe("working");
				expect(store.sessions.a?.workingSince).toEqual(expect.any(Number));
			} else {
				expect(store.sessions.a?.workingText).toBeUndefined();
				expect(store.sessions.a?.workingSince).toBeUndefined();
			}
		},
	);

	it("clears a stale extension UI modal when it is absent from the authoritative resync", async () => {
		const snapshot = runtimeSnapshot("a", false);
		vi.mocked(api.resync).mockResolvedValueOnce({
			fleet: { runtimes: [snapshot], diskSessions: [] },
			active: {
				key: "a",
				state: snapshot.state,
				messages: [],
				backgroundAgents: [],
				barrierSeq: 20,
			},
			barrierSeq: 20,
		});
		const store = await makeStartedStore();

		emit("a", {
			type: "extension_ui_request",
			method: "confirm",
			id: "req-1",
			title: "Approve?",
			message: "stale prompt",
		});
		expect(store.sessions.a?.uiRequests).toMatchObject([{ id: "req-1", method: "confirm" }]);
		expect(store.sessions.a?.needsAttention).toBe(true);

		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		await vi.waitFor(() => expect(store.resyncing()).toBe(false));

		expect(store.sessions.a?.uiRequests).toEqual([]);
		expect(store.sessions.a?.needsAttention).toBe(false);
	});

	it("clears stale extension UI state before replaying post-barrier requests", async () => {
		const snapshot = runtimeSnapshot("a", false);
		const request = deferred<Awaited<ReturnType<typeof api.resync>>>();
		vi.mocked(api.resync).mockReturnValueOnce(request.promise);
		const store = await makeStartedStore();

		emit("a", {
			type: "extension_ui_request",
			method: "confirm",
			id: "stale-request",
			title: "Stale prompt",
			message: "handled before the snapshot barrier",
		});
		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		emit("a", {
			type: "extension_ui_request",
			method: "confirm",
			id: "fresh-request",
			title: "Fresh prompt",
			message: "created after the snapshot barrier",
		});

		request.resolve({
			fleet: { runtimes: [snapshot], diskSessions: [] },
			active: {
				key: "a",
				state: snapshot.state,
				messages: [],
				backgroundAgents: [],
				barrierSeq: 2,
			},
			barrierSeq: 2,
		});
		await vi.waitFor(() => expect(store.resyncing()).toBe(false));

		expect(store.sessions.a?.uiRequests).toMatchObject([{ id: "fresh-request", method: "confirm" }]);
		expect(store.sessions.a?.needsAttention).toBe(true);
	});

	it("keeps later parent registry metadata while hydrating an earlier subagent transcript", async () => {
		const snapshot = runtimeSnapshot("a", false);
		const activeAgent = agentSnapshot("bg1", "running");
		const parentAgent = { ...agentSnapshot("bg1", "completed"), sessionFile: "/tmp/bg1.jsonl" };
		vi.mocked(api.resync).mockResolvedValueOnce({
			fleet: { runtimes: [snapshot], diskSessions: [] },
			active: {
				key: "a",
				state: snapshot.state,
				messages: [],
				backgroundAgents: [parentAgent],
				barrierSeq: 1,
				subagent: {
					agentId: "bg1",
					agent: activeAgent,
					messages: [{ role: "assistant", content: [{ type: "text", text: "disk transcript" }] }],
					barrierSeq: 1,
				},
			},
			barrierSeq: 1,
		});
		const store = await makeStartedStore();

		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		await vi.waitFor(() => expect(store.resyncing()).toBe(false));

		expect(store.sessions.a?.backgroundAgents.bg1).toMatchObject({
			status: "completed",
			sessionFile: "/tmp/bg1.jsonl",
		});
		expect(store.sessions.a?.subagents.bg1).toMatchObject({
			streaming: false,
			entries: [{ kind: "assistant", blocks: [{ kind: "text", text: "disk transcript" }] }],
		});
	});

	it("replays subagent relays between its disk barrier and the parent snapshot barrier", async () => {
		window.location.hash = "#/session/a/subagent/bg1";
		const snapshot = runtimeSnapshot("a", true);
		const delayed = deferred<{
			fleet: { runtimes: RuntimeInfoDto[]; diskSessions: [] };
			active: {
				key: string;
				state: RuntimeInfoDto["state"];
				messages: unknown[];
				backgroundAgents: BackgroundAgentDto[];
				barrierSeq: number;
				subagent: { agentId: string; agent: BackgroundAgentDto; messages: unknown[]; barrierSeq: number };
			};
			barrierSeq: number;
		}>();
		vi.mocked(api.resync).mockReturnValueOnce(delayed.promise);
		const store = await makeStartedStore();

		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		emit("a", {
			type: "background_agent_event",
			agentId: "bg1",
			event: { type: "message_start", message: { role: "assistant" } },
		});
		emit("a", {
			type: "background_agent_event",
			agentId: "bg1",
			event: { type: "message_update", assistantMessageEvent: { type: "text_start" } },
		});
		emit("a", {
			type: "background_agent_event",
			agentId: "bg1",
			event: {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "between barriers" },
			},
		});
		delayed.resolve({
			fleet: { runtimes: [snapshot], diskSessions: [] },
			active: {
				key: "a",
				state: snapshot.state,
				messages: [],
				backgroundAgents: [agentSnapshot("bg1", "running")],
				barrierSeq: 4,
				subagent: {
					agentId: "bg1",
					agent: agentSnapshot("bg1", "running"),
					messages: [],
					barrierSeq: 1,
				},
			},
			barrierSeq: 4,
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(store.sessions.a?.subagents.bg1?.entries).toMatchObject([
			{ kind: "assistant", blocks: [{ kind: "text", text: "between barriers" }] },
		]);
	});

	it("coalesces a second barrier into one sequential follow-up snapshot", async () => {
		const first = deferred<{ fleet: { runtimes: []; diskSessions: [] }; barrierSeq: number }>();
		const second = deferred<{ fleet: { runtimes: []; diskSessions: [] }; barrierSeq: number }>();
		vi.mocked(api.resync).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const store = await makeStartedStore();

		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		expect(api.resync).toHaveBeenCalledOnce();
		first.resolve({ fleet: { runtimes: [], diskSessions: [] }, barrierSeq: 2 });
		await vi.waitFor(() => expect(api.resync).toHaveBeenCalledTimes(2));
		expect(store.resyncing()).toBe(true);
		second.resolve({ fleet: { runtimes: [], diskSessions: [] }, barrierSeq: 3 });
		await vi.waitFor(() => expect(store.resyncing()).toBe(false));
	});

	it("stop() prevents a queued follow-up resync from firing after teardown", async () => {
		vi.useFakeTimers();
		try {
			const delayed = deferred<Awaited<ReturnType<typeof api.resync>>>();
			vi.mocked(api.resync).mockReturnValueOnce(delayed.promise);
			const store = await makeStartedStore();

			emit("", { type: "dashboard_resync", reason: "buffer_gap" });
			emit("", { type: "dashboard_resync", reason: "buffer_gap" });
			expect(api.resync).toHaveBeenCalledOnce();

			store.stop();
			delayed.resolve({ fleet: { runtimes: [], diskSessions: [] }, barrierSeq: 1 });
			await vi.advanceTimersByTimeAsync(0);

			expect(api.resync).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("navigates to fleet when active-route resync returns no active runtime", async () => {
		window.location.hash = "#/session/stale-key";
		vi.mocked(api.resync).mockResolvedValueOnce({ fleet: { runtimes: [], diskSessions: [] }, barrierSeq: 1 });
		const store = await makeStartedStore();

		emit("stale-key", { type: "agent_start" });
		expect(store.sessions["stale-key"]).toBeDefined();

		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		await vi.waitFor(() => expect(window.location.hash).toBe("#/"));

		expect(api.resync).toHaveBeenCalledWith("stale-key", undefined, expect.any(AbortSignal));
		expect(store.sessions["stale-key"]).toBeUndefined();
		expect(store.notices()).toEqual([
			expect.objectContaining({ text: "session stale-key was stopped", tone: "warning" }),
		]);
	});

	it("keeps a failed resync visibly degraded and automatically retries with bounded cleanup", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(api.resync)
				.mockRejectedValueOnce(new Error("snapshot failed"))
				.mockResolvedValueOnce({ fleet: { runtimes: [], diskSessions: [] }, barrierSeq: 2 });
			const store = await makeStartedStore();
			eventHandlers?.onStatusChange?.({ state: "connected", attempt: 0, lastAppliedSeq: 41 });

			emit("", { type: "dashboard_resync", reason: "buffer_gap" });
			await flushAsyncWork();
			expect(store.resyncError()).toBe("snapshot failed");
			expect(store.resyncing()).toBe(false);
			expect(store.connection()).toMatchObject({ state: "retrying", retryDelayMs: 1000 });
			expect(() => emit("a", { type: "agent_start" })).toThrow(/refusing to acknowledge/);
			expect(store.sessions.a).toBeUndefined();

			await vi.advanceTimersByTimeAsync(999);
			expect(api.resync).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			await flushAsyncWork();
			expect(api.resync).toHaveBeenCalledTimes(2);
			expect(store.resyncing()).toBe(false);
			expect(store.resyncError()).toBeUndefined();
			expect(store.connection()).toMatchObject({ state: "connected", lastAppliedSeq: 41 });

			vi.mocked(api.resync).mockRejectedValueOnce(new Error("stays down"));
			emit("", { type: "dashboard_resync", reason: "buffer_gap" });
			await flushAsyncWork();
			store.stop();
			await vi.advanceTimersByTimeAsync(30_000);
			expect(api.resync).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not restore a stale connected status when SSE retry status hands off during REST recovery", async () => {
		vi.useFakeTimers();
		try {
			const retrySnapshot = deferred<{ fleet: { runtimes: []; diskSessions: [] }; barrierSeq: number }>();
			vi.mocked(api.resync)
				.mockRejectedValueOnce(new Error("snapshot failed"))
				.mockReturnValueOnce(retrySnapshot.promise);
			const store = await makeStartedStore();
			eventHandlers?.onStatusChange?.({ state: "connected", attempt: 0, lastAppliedSeq: 41 });

			emit("", { type: "dashboard_resync", reason: "buffer_gap" });
			await flushAsyncWork();
			expect(store.connection()).toMatchObject({ state: "retrying", retryDelayMs: 1000, lastAppliedSeq: 41 });
			expect(store.resyncing()).toBe(false);

			eventHandlers?.onStatusChange?.({
				state: "retrying",
				attempt: 3,
				retryDelayMs: 5_000,
				retryAt: Date.now() + 5_000,
				lastAppliedSeq: 41,
			});
			await vi.advanceTimersByTimeAsync(1_000);
			expect(api.resync).toHaveBeenCalledTimes(2);
			expect(store.resyncing()).toBe(true);

			retrySnapshot.resolve({ fleet: { runtimes: [], diskSessions: [] }, barrierSeq: 2 });
			await flushAsyncWork();
			expect(store.resyncing()).toBe(false);
			expect(store.resyncError()).toBeUndefined();
			expect(store.connection()).toMatchObject({
				state: "retrying",
				attempt: 3,
				retryDelayMs: 5_000,
				lastAppliedSeq: 41,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("backs off failed resync retries exponentially with one timer and request at a time", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(api.resync).mockRejectedValue(new Error("still down"));
			const store = await makeStartedStore();
			eventHandlers?.onStatusChange?.({ state: "connected", attempt: 0, lastAppliedSeq: 7 });

			emit("", { type: "dashboard_resync", reason: "buffer_gap" });
			const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
			for (const [index, delay] of expectedDelays.entries()) {
				await flushAsyncWork();
				expect(api.resync).toHaveBeenCalledTimes(index + 1);
				expect(store.resyncing()).toBe(false);
				expect(store.connection()).toMatchObject({ state: "retrying", retryDelayMs: delay });
				expect(vi.getTimerCount()).toBe(1);
				await vi.advanceTimersByTimeAsync(delay - 1);
				expect(api.resync).toHaveBeenCalledTimes(index + 1);
				expect(vi.getTimerCount()).toBe(1);
				await vi.advanceTimersByTimeAsync(1);
			}

			await flushAsyncWork();
			expect(api.resync).toHaveBeenCalledTimes(expectedDelays.length + 1);
			store.stop();
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(api.resync).toHaveBeenCalledTimes(expectedDelays.length + 1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails loudly on recovery queue overflow and never applies its incomplete envelopes", async () => {
		const delayed = deferred<{ fleet: { runtimes: []; diskSessions: [] }; barrierSeq: number }>();
		vi.mocked(api.resync).mockReturnValueOnce(delayed.promise);
		const store = await makeStartedStore();
		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		for (let i = 0; i < 2_000; i++) {
			eventHandlers?.onEnvelope({ seq: 10 + i, key: "overflow", event: { type: "agent_start" } });
		}
		expect(() => eventHandlers?.onEnvelope({ seq: 2010, key: "overflow", event: { type: "agent_start" } })).toThrow(
			/queue overflowed/,
		);
		expect(store.resyncError()).toContain("queue overflowed");
		expect(store.sessions.overflow).toBeUndefined();
		// A later barrier requests a retry, but the first HTTP recovery must settle
		// before another starts so resync remains single-flight.
		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		expect(api.resync).toHaveBeenCalledOnce();
		delayed.resolve({ fleet: { runtimes: [], diskSessions: [] }, barrierSeq: 1 });
		await vi.waitFor(() => expect(api.resync).toHaveBeenCalledTimes(2));
		expect(store.sessions.overflow).toBeUndefined();
	});

	it("reconciles ordinary queued envelopes below both recovery limits", async () => {
		const delayed = deferred<{ fleet: { runtimes: []; diskSessions: [] }; barrierSeq: number }>();
		vi.mocked(api.resync).mockReturnValueOnce(delayed.promise);
		const store = await makeStartedStore();

		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		emit("ordinary-queue", { type: "agent_start" });
		delayed.resolve({ fleet: { runtimes: [], diskSessions: [] }, barrierSeq: 0 });
		await vi.waitFor(() => expect(store.resyncing()).toBe(false));

		expect(store.sessions["ordinary-queue"]?.streaming).toBe(true);
	});

	it("ignores stale envelopes after an authoritative resync while applying later ones", async () => {
		const snapshot = runtimeSnapshot("a", false);
		vi.mocked(api.resync).mockResolvedValueOnce({
			fleet: { runtimes: [snapshot], diskSessions: [] },
			active: {
				key: "a",
				state: snapshot.state,
				messages: [{ role: "user", content: "from snapshot" }],
				backgroundAgents: [],
				barrierSeq: 10,
			},
			barrierSeq: 10,
		});
		const store = await makeStartedStore();

		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		await vi.waitFor(() => expect(store.resyncing()).toBe(false));

		// The transaction is complete: this exercises the persistent barrier guard,
		// not filtering of envelopes queued while the snapshot was in flight.
		seq = 9;
		emit("a", { type: "message_start", message: { role: "user", content: "stale duplicate" } });
		emit("a", { type: "message_start", message: { role: "user", content: "later live event" } });

		expect(store.sessions.a?.entries).toHaveLength(2);
		expect(store.sessions.a?.entries).toMatchObject([
			{ kind: "user", text: "from snapshot" },
			{ kind: "user", text: "later live event" },
		]);
	});

	it("fails on byte overflow before the envelope count limit and discards the partial queue", async () => {
		const delayed = deferred<{ fleet: { runtimes: []; diskSessions: [] }; barrierSeq: number }>();
		vi.mocked(api.resync).mockReturnValueOnce(delayed.promise);
		const store = await makeStartedStore();
		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		const projectedFrame = "x".repeat(1_000_000);

		for (let i = 0; i < 3; i++) {
			eventHandlers?.onEnvelope({
				seq: 10 + i,
				key: "byte-overflow",
				event: { type: "agent_start", projectedFrame },
			});
		}
		expect(() =>
			eventHandlers?.onEnvelope({
				seq: 13,
				key: "byte-overflow",
				event: { type: "agent_start", projectedFrame },
			}),
		).toThrow(/queue overflowed/);

		expect(store.resyncError()).toContain("queue overflowed");
		expect(store.sessions["byte-overflow"]).toBeUndefined();
		expect(api.resync).toHaveBeenCalledOnce();
		// The queue has only four envelopes, far below the 2,000-envelope cap.
		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		delayed.resolve({ fleet: { runtimes: [], diskSessions: [] }, barrierSeq: 1 });
		await vi.waitFor(() => expect(api.resync).toHaveBeenCalledTimes(2));
		expect(store.sessions["byte-overflow"]).toBeUndefined();
	});

	it("times out a pending resync through its AbortSignal", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(api.resync).mockImplementationOnce((_key, _agentId, signal) => rejectAfterAbort(signal));
			const store = await makeStartedStore();

			emit("", { type: "dashboard_resync", reason: "buffer_gap" });
			const signal = vi.mocked(api.resync).mock.calls[0]?.[2];
			expect(signal?.aborted).toBe(false);

			await vi.advanceTimersByTimeAsync(30_000);

			expect(signal?.aborted).toBe(true);
			expect(signal?.reason).toBe("Dashboard recovery timed out");
			expect(store.resyncError()).toBe("Dashboard recovery timed out");
			expect(store.resyncing()).toBe(false);
			expect(store.connection()).toMatchObject({ state: "retrying", retryDelayMs: 1000 });
			store.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("runtime_removed deletes session state, revision state, and composer memory without a fleet fetch", async () => {
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
		expect(store.notices()).toEqual([]);
		expect(api.fleet).toHaveBeenCalledOnce();
	});

	it("runtime_removed redirects the actively viewed session to fleet with a notice", async () => {
		window.location.hash = "#/session/removed-session";
		const store = await makeStartedStore();

		emit("removed-session", { type: "runtime_removed" });

		expect(window.location.hash).toBe("#/");
		expect(store.notices()).toEqual([
			expect.objectContaining({ text: "session removed-session was stopped", tone: "warning" }),
		]);
	});

	it("runtime_removed redirects an actively viewed subagent when its parent session stops", async () => {
		window.location.hash = "#/session/parent-session/subagent/bg1";
		const store = await makeStartedStore();

		emit("parent-session", { type: "runtime_removed" });

		expect(window.location.hash).toBe("#/");
		expect(store.notices()).toEqual([
			expect.objectContaining({ text: "session parent-session was stopped", tone: "warning" }),
		]);
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
	it("hydrates the initial session snapshot with one atomic API call", async () => {
		const snapshot = hydrationSnapshot("s1", true);
		snapshot.messages = [{ role: "assistant", content: [{ type: "text", text: "snapshot text" }] }];
		vi.mocked(api.hydrate).mockResolvedValueOnce(snapshot);
		const store = createAppStore();

		await store.hydrateSession("s1");
		expect(api.hydrate).toHaveBeenCalledWith("s1", undefined);
		expect(api.messages).not.toHaveBeenCalled();
		expect(api.backgroundAgents).not.toHaveBeenCalled();
		expect(api.runtime).not.toHaveBeenCalled();

		expect(store.sessions.s1?.entries[0]).toMatchObject({
			kind: "assistant",
			blocks: [{ kind: "text", text: "snapshot text" }],
		});
		expect(store.sessions.s1?.streaming).toBe(true);
		expect(store.sessions.s1?.workingSince).toEqual(expect.any(Number));
	});

	it("authoritatively lowers the matching fleet count when hydrate recovers a forked session", async () => {
		const live = runtimeSnapshot("s1", false);
		live.state.messageCount = 12;
		vi.mocked(api.fleet).mockResolvedValueOnce({ runtimes: [live], diskSessions: [] });
		const snapshot = hydrationSnapshot("s1", false);
		snapshot.state.messageCount = 3;
		vi.mocked(api.hydrate).mockResolvedValueOnce(snapshot);
		const store = await makeStartedStore();

		await store.hydrateSession("s1");

		expect(store.fleet().runtimes[0]?.state.messageCount).toBe(3);
	});

	it("caps completed background agents when hydrating the session registry", async () => {
		const agents: BackgroundAgentDto[] = [];
		for (let i = 0; i < 25; i++) agents.push(agentSnapshot(`done-${i}`, "completed", i * 1000));
		agents.push(agentSnapshot("running-old", "running", 0));
		const snapshot = hydrationSnapshot("s1", false);
		snapshot.backgroundAgents = agents;
		vi.mocked(api.hydrate).mockResolvedValueOnce(snapshot);
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

	it("installs the hydrate baseline and replays only post-barrier live envelopes in order", async () => {
		const response = deferred<RuntimeHydrationDto>();
		vi.mocked(api.hydrate).mockReturnValueOnce(response.promise);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSession("s1");
		// This event is already represented by the server's atomic snapshot.
		emit("s1", { type: "message_start", message: { role: "user", content: "prior transcript" } });
		emit("s1", { type: "message_start", message: { role: "user", content: "post-barrier delta" } });
		emit("s1", { type: "tasks_update", tasks: [{ id: "first", title: "first", status: "pending" }] });
		emit("s1", { type: "tasks_update", tasks: [{ id: "last", title: "last", status: "completed" }] });
		const snapshot = hydrationSnapshot("s1", false);
		snapshot.barrierSeq = 1;
		snapshot.messages = [{ role: "user", content: "prior transcript" }];
		snapshot.state.tasks = [{ id: "snapshot", title: "snapshot", status: "pending" }];
		response.resolve(snapshot);
		await hydrate;

		expect(store.sessions.s1?.entries).toMatchObject([
			{ kind: "user", text: "prior transcript" },
			{ kind: "user", text: "post-barrier delta" },
		]);
		expect(store.sessions.s1?.entries).toHaveLength(2);
		expect(store.sessions.s1?.tasks).toEqual([{ id: "last", title: "last", status: "completed" }]);
	});

	it("restores runtime tasks during a hard-refresh hydrate even when startup SSE events race it", async () => {
		const snapshot = deferred<RuntimeHydrationDto>();
		vi.mocked(api.hydrate).mockReturnValueOnce(snapshot.promise);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSession("s1");
		emit("s1", { type: "agent_start" });
		const restore = hydrationSnapshot("s1", false);
		restore.state.tasks = [{ id: "restore", title: "restore me", status: "in_progress" }];
		restore.messages = [{ role: "assistant", content: [{ type: "text", text: "stale snapshot" }] }];
		snapshot.resolve(restore);
		await hydrate;
		emit("s1", { type: "agent_start" });

		expect(store.sessions.s1?.tasks).toEqual([{ id: "restore", title: "restore me", status: "in_progress" }]);
		expect(JSON.stringify(store.sessions.s1?.entries)).toContain("stale snapshot");
	});

	it("does not overwrite a newer live tasks_update with an older hydrate snapshot", async () => {
		const snapshot = deferred<RuntimeHydrationDto>();
		vi.mocked(api.hydrate).mockReturnValueOnce(snapshot.promise);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSession("s1");
		emit("s1", { type: "tasks_update", tasks: [{ id: "live", title: "live task", status: "completed" }] });
		const stale = hydrationSnapshot("s1", false);
		stale.state.tasks = [{ id: "stale", title: "stale task", status: "pending" }];
		snapshot.resolve(stale);
		await hydrate;

		expect(store.sessions.s1?.tasks).toEqual([{ id: "live", title: "live task", status: "completed" }]);
	});

	it("does not create a stub session when an aborted hydration rejects", async () => {
		const key = "abort-hydrate";
		vi.mocked(api.hydrate).mockImplementationOnce((_key: string, signal?: AbortSignal) => rejectAfterAbort(signal));
		const store = createAppStore();
		const controller = new AbortController();

		const hydrate = store.hydrateSession(key, controller.signal).catch(() => undefined);
		controller.abort();
		await hydrate;

		expect(store.sessions[key]).toBeUndefined();
		expect(store.revisions[key]).toBeUndefined();
		expect(key in store.sessions).toBe(false);
		expect(key in store.revisions).toBe(false);
	});

	it("surfaces genuine hydration rejections when the request was not aborted", async () => {
		vi.mocked(api.hydrate).mockRejectedValueOnce(new Error("hydrate failed"));
		const store = createAppStore();

		await expect(store.hydrateSession("bad-hydrate")).rejects.toThrow("hydrate failed");
	});

	it("does not let a runtime_removed generation bump recreate a deleted session after hydration resolves", async () => {
		const snapshot = deferred<RuntimeHydrationDto>();
		vi.mocked(api.hydrate).mockReturnValueOnce(snapshot.promise);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSession("removed-mid-flight");
		emit("removed-mid-flight", { type: "runtime_removed" });
		const stale = hydrationSnapshot("removed-mid-flight", false);
		stale.messages = [{ role: "assistant", content: [{ type: "text", text: "phantom" }] }];
		snapshot.resolve(stale);
		await hydrate;

		expect(store.sessions["removed-mid-flight"]).toBeUndefined();
		expect("removed-mid-flight" in store.sessions).toBe(false);
	});

	it("does not let dashboard_resync recreate a cleared session after hydration resolves", async () => {
		const snapshot = deferred<RuntimeHydrationDto>();
		vi.mocked(api.hydrate).mockReturnValueOnce(snapshot.promise);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSession("resync-mid-flight");
		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		const stale = hydrationSnapshot("resync-mid-flight", false);
		stale.messages = [{ role: "assistant", content: [{ type: "text", text: "phantom" }] }];
		snapshot.resolve(stale);
		await hydrate;

		expect(store.sessions["resync-mid-flight"]).toBeUndefined();
		expect("resync-mid-flight" in store.sessions).toBe(false);
	});

	it("does not let runtime_removed recreate a deleted session through stale subagent hydration", async () => {
		const snapshot = deferred<{ agent: BackgroundAgentDto; messages: unknown[] }>();
		vi.mocked(api.subagentMessages).mockReturnValueOnce(snapshot.promise);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSubagent("removed-parent", "bg1");
		emit("removed-parent", { type: "runtime_removed" });
		snapshot.resolve({
			agent: agentSnapshot("bg1", "completed"),
			messages: [{ role: "assistant", content: [{ type: "text", text: "phantom child" }] }],
		});
		await hydrate;

		expect(store.sessions["removed-parent"]).toBeUndefined();
		expect("removed-parent" in store.sessions).toBe(false);
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

	it("fails loudly on hydration queue overflow and never applies its incomplete snapshot", async () => {
		const snapshot = deferred<RuntimeHydrationDto>();
		vi.mocked(api.hydrate).mockReturnValueOnce(snapshot.promise);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSession("overflow");
		for (let i = 0; i < 2_000; i++) {
			eventHandlers?.onEnvelope({ seq: 10 + i, key: "overflow", event: { type: "agent_start" } });
		}
		expect(() => eventHandlers?.onEnvelope({ seq: 2010, key: "overflow", event: { type: "agent_start" } })).toThrow(
			/queue overflowed/,
		);

		// The queued envelopes already created session state, but the hydrate
		// snapshot itself must be discarded.
		const stale = hydrationSnapshot("overflow", false);
		stale.messages = [{ role: "assistant", content: [{ type: "text", text: "snapshot" }] }];
		snapshot.resolve(stale);
		await hydrate;
		expect(store.sessions.overflow).toBeDefined();
		expect(store.sessions.overflow?.entries).toHaveLength(0);
	});

	it("fails on hydration byte overflow before the envelope count limit", async () => {
		const snapshot = deferred<RuntimeHydrationDto>();
		vi.mocked(api.hydrate).mockReturnValueOnce(snapshot.promise);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSession("byte-overflow");
		const projectedFrame = "x".repeat(1_000_000);
		for (let i = 0; i < 3; i++) {
			eventHandlers?.onEnvelope({
				seq: 10 + i,
				key: "byte-overflow",
				event: { type: "agent_start", projectedFrame },
			});
		}
		expect(() =>
			eventHandlers?.onEnvelope({
				seq: 13,
				key: "byte-overflow",
				event: { type: "agent_start", projectedFrame },
			}),
		).toThrow(/queue overflowed/);

		const stale = hydrationSnapshot("byte-overflow", false);
		stale.messages = [{ role: "assistant", content: [{ type: "text", text: "snapshot" }] }];
		snapshot.resolve(stale);
		await hydrate;
		expect(store.sessions["byte-overflow"]).toBeDefined();
		expect(store.sessions["byte-overflow"]?.entries).toHaveLength(0);
	});

	it("discards a superseded hydration and applies only the latest snapshot", async () => {
		const first = deferred<RuntimeHydrationDto>();
		vi.mocked(api.hydrate).mockReturnValueOnce(first.promise);
		const store = await makeStartedStore();

		const hydrate1 = store.hydrateSession("supersede");
		emit("supersede", { type: "agent_start" });

		const second = deferred<RuntimeHydrationDto>();
		vi.mocked(api.hydrate).mockReturnValueOnce(second.promise);
		const hydrate2 = store.hydrateSession("supersede");

		// The first (superseded) hydration resolves later and must be discarded.
		const stale = hydrationSnapshot("supersede", false);
		stale.messages = [{ role: "assistant", content: [{ type: "text", text: "stale" }] }];
		first.resolve(stale);
		await hydrate1;
		// The emitted agent_start set streaming=true; the stale snapshot must not
		// have overwritten it or added its messages.
		expect(store.sessions.supersede?.streaming).toBe(true);
		expect(store.sessions.supersede?.entries).toHaveLength(0);

		// The second hydration applies normally.
		const fresh = hydrationSnapshot("supersede", false);
		fresh.messages = [{ role: "assistant", content: [{ type: "text", text: "fresh" }] }];
		second.resolve(fresh);
		await hydrate2;
		expect(store.sessions.supersede?.streaming).toBe(false);
		expect(store.sessions.supersede?.entries).toHaveLength(1);
	});

	it("applies a hydrate after an unrelated runtime changes in a fleet snapshot", async () => {
		const runtimeA = runtimeSnapshot("a", false);
		const runtimeB = runtimeSnapshot("b", false);
		vi.mocked(api.fleet).mockResolvedValueOnce({ runtimes: [runtimeA, runtimeB], diskSessions: [] });
		const snapshot = deferred<RuntimeHydrationDto>();
		vi.mocked(api.hydrate).mockReturnValueOnce(snapshot.promise);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSession("a");
		const unchangedA = runtimeSnapshot("a", false);
		const changedB = runtimeSnapshot("b", true);
		changedB.state.messageCount = 9;
		emit("", { type: "fleet_snapshot", runtimes: [unchangedA, changedB] });

		const hydratedA = hydrationSnapshot("a", false);
		hydratedA.state.messageCount = 4;
		snapshot.resolve(hydratedA);
		await hydrate;

		expect(store.fleet().runtimes.find((runtime) => runtime.key === "a")?.state.messageCount).toBe(4);
		expect(store.fleet().runtimes.find((runtime) => runtime.key === "b")?.state).toMatchObject({
			isStreaming: true,
			messageCount: 9,
		});
	});

	it("applies a hydrate after a disk-only fleet mutation", async () => {
		vi.mocked(api.fleet).mockResolvedValueOnce({ runtimes: [runtimeSnapshot("a", false)], diskSessions: [] });
		const snapshot = deferred<RuntimeHydrationDto>();
		vi.mocked(api.hydrate).mockReturnValueOnce(snapshot.promise);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSession("a");
		vi.mocked(api.sessions).mockResolvedValueOnce({
			sessions: [
				{
					path: "/disk.jsonl",
					id: "disk",
					cwd: "/tmp",
					created: "a",
					modified: "b",
					messageCount: 1,
					firstMessage: "hello",
				},
			],
		});
		await store.refreshDiskSessions();

		const hydratedA = hydrationSnapshot("a", false);
		hydratedA.state.messageCount = 4;
		snapshot.resolve(hydratedA);
		await hydrate;

		expect(store.fleet().runtimes[0]?.state.messageCount).toBe(4);
		expect(store.fleet().diskSessions.map((session) => session.id)).toEqual(["disk"]);
	});

	it("keeps newer same-runtime fleet_snapshot state when a stale hydrate resolves", async () => {
		const initial = runtimeSnapshot("race", false);
		initial.state.model = { provider: "old", id: "old-model" };
		vi.mocked(api.fleet).mockResolvedValueOnce({ runtimes: [initial], diskSessions: [] });
		const snapshot = deferred<RuntimeHydrationDto>();
		vi.mocked(api.hydrate).mockReturnValueOnce(snapshot.promise);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSession("race");
		// A fleet_snapshot arrives mid-hydrate with newer state.
		emit("", {
			type: "fleet_snapshot",
			runtimes: [
				{
					key: "race",
					cwd: "/tmp/project",
					state: {
						sessionId: "race",
						tasks: [],
						thinkingLevel: "off",
						isStreaming: true,
						isCompacting: false,
						steeringMode: "all",
						followUpMode: "all",
						autoCompactionEnabled: true,
						messageCount: 5,
						pendingMessageCount: 0,
						model: { provider: "new", id: "new-model" },
					},
					backgroundAgents: [],
					needsAttention: false,
					createdAt: new Date(0).toISOString(),
					lastActivity: new Date(0).toISOString(),
				},
			],
		});
		// The hydrate resolves with older state.
		const stale = hydrationSnapshot("race", false);
		stale.state.model = { provider: "old", id: "old-model" };
		snapshot.resolve(stale);
		await hydrate;

		// The card keeps the newer snapshot state.
		const card = store.fleet().runtimes.find((r) => r.key === "race");
		expect(card?.state.isStreaming).toBe(true);
		expect(card?.state.model?.id).toBe("new-model");
		expect(card?.state.messageCount).toBe(5);
	});
});

describe("fleet snapshot and inventory store foundation", () => {
	function fleetSnapshot(key: string, messageCount = 0): RuntimeInfoDto {
		const runtime = runtimeSnapshot(key, false);
		runtime.state.messageCount = messageCount;
		return runtime;
	}

	function stats(totalMessages: number, tokensTotal: number, cost: number) {
		return {
			sessionId: "s",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 0,
			toolResults: 0,
			totalMessages,
			tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: tokensTotal },
			cost,
			contextUsage: { tokens: tokensTotal, contextWindow: 100_000, percent: 10 },
		};
	}

	it("does not fetch the full fleet for lifecycle events", async () => {
		const store = await makeStartedStore();
		vi.mocked(api.fleet).mockClear();

		emit("a", { type: "agent_start" });
		emit("a", { type: "agent_end", messages: [] });
		emit("a", { type: "background_agent_start", agent: agentSnapshot("bg", "running") });
		emit("a", { type: "background_agent_end", agentId: "bg" });
		emit("a", { type: "runtime_removed" });

		expect(api.fleet).not.toHaveBeenCalled();
		expect(store.fleet().runtimes).toEqual([]);
	});

	it("atomically replaces fleet snapshot membership while preserving enriched card fields", async () => {
		const existing = fleetSnapshot("keep", 12);
		existing.state.contextUsage = { tokens: 12, contextWindow: 100, percent: 12 };
		existing.stats = { tokensTotal: 12, cost: 0.12 };
		existing.lastAssistantText = "initial preview";
		vi.mocked(api.fleet).mockResolvedValueOnce({
			runtimes: [existing, fleetSnapshot("gone", 1)],
			diskSessions: [
				{
					path: "/disk.jsonl",
					id: "disk",
					cwd: "/tmp",
					created: "a",
					modified: "b",
					messageCount: 1,
					firstMessage: "hi",
				},
			],
		});
		const store = await makeStartedStore();

		const snapshot = fleetSnapshot("keep", 4);
		snapshot.state.contextUsage = { tokens: 4, contextWindow: 100, percent: 4 };
		emit("", { type: "fleet_snapshot", runtimes: [snapshot, fleetSnapshot("new", 2)] });

		expect(store.fleet().runtimes.map((runtime) => runtime.key)).toEqual(["keep", "new"]);
		expect(store.fleet().diskSessions).toHaveLength(1);
		expect(store.fleet().runtimes[0]).toMatchObject({
			stats: { tokensTotal: 12, cost: 0.12 },
			lastAssistantText: "initial preview",
			state: { messageCount: 4, contextUsage: { tokens: 12 } },
		});
		expect(store.sessions[""]).toBeUndefined();
	});

	it("refreshes only disk inventory when cross-client membership changes or a runtime is removed", async () => {
		vi.mocked(api.fleet).mockResolvedValueOnce({ runtimes: [fleetSnapshot("existing")], diskSessions: [] });
		await makeStartedStore();
		vi.mocked(api.fleet).mockClear();
		vi.mocked(api.sessions).mockClear();
		vi.mocked(api.sessions).mockResolvedValue({ sessions: [] });

		emit("", { type: "fleet_snapshot", runtimes: [fleetSnapshot("existing"), fleetSnapshot("other-tab")] });
		await flushAsyncWork();
		emit("other-tab", { type: "runtime_removed" });
		await flushAsyncWork();

		expect(api.sessions).toHaveBeenCalledTimes(2);
		expect(api.fleet).not.toHaveBeenCalled();
	});

	it("does not scan disk inventory for lifecycle events or same-membership fleet snapshots", async () => {
		vi.mocked(api.fleet).mockResolvedValueOnce({ runtimes: [fleetSnapshot("live")], diskSessions: [] });
		await makeStartedStore();
		vi.mocked(api.sessions).mockClear();

		emit("live", { type: "agent_start" });
		emit("live", { type: "agent_end", messages: [] });
		emit("", { type: "fleet_snapshot", runtimes: [fleetSnapshot("live")] });
		await flushAsyncWork();

		expect(api.sessions).not.toHaveBeenCalled();
	});

	it("surfaces membership inventory failures without discarding the previous disk rows", async () => {
		vi.mocked(api.fleet).mockResolvedValueOnce({
			runtimes: [fleetSnapshot("live")],
			diskSessions: [
				{
					path: "/previous.jsonl",
					id: "previous",
					cwd: "/tmp",
					created: "a",
					modified: "b",
					messageCount: 1,
					firstMessage: "previous",
				},
			],
		});
		const store = await makeStartedStore();
		vi.mocked(api.sessions).mockRejectedValueOnce(new Error("inventory unavailable"));

		emit("", { type: "fleet_snapshot", runtimes: [fleetSnapshot("live"), fleetSnapshot("new")] });
		await flushAsyncWork();

		expect(store.fleetError()).toBe("inventory unavailable");
		expect(store.fleet().diskSessions.map((session) => session.id)).toEqual(["previous"]);
	});

	it("applies queued global snapshots only after their resync barrier", async () => {
		const recovery = deferred<Awaited<ReturnType<typeof api.resync>>>();
		vi.mocked(api.resync).mockReturnValueOnce(recovery.promise);
		const store = await makeStartedStore();

		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		emit("", { type: "fleet_snapshot", runtimes: [fleetSnapshot("queued")] });
		recovery.resolve({ fleet: { runtimes: [fleetSnapshot("snapshot")], diskSessions: [] }, barrierSeq: 1 });
		await vi.waitFor(() => expect(store.resyncing()).toBe(false));

		expect(store.fleet().runtimes.map((runtime) => runtime.key)).toEqual(["queued"]);
	});

	it("removes a runtime immediately and blocks a stale full response from resurrecting it", async () => {
		const delayed = deferred<{ runtimes: RuntimeInfoDto[]; diskSessions: [] }>();
		vi.mocked(api.fleet).mockResolvedValueOnce({ runtimes: [fleetSnapshot("gone")], diskSessions: [] });
		const store = await makeStartedStore();
		vi.mocked(api.fleet).mockReturnValueOnce(delayed.promise);
		const refresh = store.refreshFleet();

		emit("gone", { type: "runtime_removed" });
		delayed.resolve({ runtimes: [fleetSnapshot("gone")], diskSessions: [] });
		await refresh;

		expect(store.fleet().runtimes).toEqual([]);
	});

	it("refreshes disk inventory without fetching or replacing live runtimes", async () => {
		vi.mocked(api.fleet).mockResolvedValueOnce({ runtimes: [fleetSnapshot("live")], diskSessions: [] });
		const store = await makeStartedStore();
		vi.mocked(api.fleet).mockClear();
		vi.mocked(api.sessions).mockResolvedValueOnce({
			sessions: [
				{
					path: "/new.jsonl",
					id: "new",
					cwd: "/tmp",
					created: "a",
					modified: "b",
					messageCount: 2,
					firstMessage: "hello",
				},
			],
		});

		await store.refreshDiskSessions();

		expect(api.sessions).toHaveBeenCalledOnce();
		expect(api.fleet).not.toHaveBeenCalled();
		expect(store.fleet().runtimes.map((runtime) => runtime.key)).toEqual(["live"]);
		expect(store.fleet().diskSessions.map((session) => session.id)).toEqual(["new"]);
	});

	it("refreshes disk inventory when another client reports a deletion", async () => {
		const store = await makeStartedStore();
		vi.mocked(api.sessions).mockResolvedValueOnce({ sessions: [] });

		emit("", { type: "disk_sessions_changed" });
		await vi.waitFor(() => expect(api.sessions).toHaveBeenCalledOnce());

		expect(api.fleet).toHaveBeenCalledOnce();
		expect(store.fleetError()).toBeUndefined();
		expect(store.sessions[""]).toBeUndefined();
	});

	it("ignores out-of-order disk inventory responses", async () => {
		const first = deferred<{ sessions: [] }>();
		const second = deferred<{
			sessions: Array<{
				path: string;
				id: string;
				cwd: string;
				created: string;
				modified: string;
				messageCount: number;
				firstMessage: string;
			}>;
		}>();
		const store = await makeStartedStore();
		vi.mocked(api.sessions).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

		const firstRefresh = store.refreshDiskSessions();
		const secondRefresh = store.refreshDiskSessions();
		second.resolve({
			sessions: [
				{
					path: "/new.jsonl",
					id: "new",
					cwd: "/tmp",
					created: "a",
					modified: "b",
					messageCount: 1,
					firstMessage: "new",
				},
			],
		});
		await secondRefresh;
		first.resolve({ sessions: [] });
		await firstRefresh;

		expect(store.fleet().diskSessions.map((session) => session.id)).toEqual(["new"]);
	});

	it("upserts runtime and patches direct model/thinking responses without allowing a stale full response", async () => {
		const delayed = deferred<{ runtimes: RuntimeInfoDto[]; diskSessions: [] }>();
		const store = await makeStartedStore();
		vi.mocked(api.fleet).mockReturnValueOnce(delayed.promise);

		const refresh = store.refreshFleet();
		store.upsertRuntime(fleetSnapshot("created"));
		store.setRuntimeModel("created", { provider: "test", id: "new-model" });
		store.setRuntimeThinkingLevel("created", "high");
		delayed.resolve({ runtimes: [fleetSnapshot("stale")], diskSessions: [] });
		await refresh;

		expect(store.fleet().runtimes).toHaveLength(1);
		expect(store.fleet().runtimes[0]).toMatchObject({
			key: "created",
			state: { model: { provider: "test", id: "new-model" } },
		});
	});

	it("ignores out-of-order full fleet responses", async () => {
		const first = deferred<{ runtimes: RuntimeInfoDto[]; diskSessions: [] }>();
		const second = deferred<{ runtimes: RuntimeInfoDto[]; diskSessions: [] }>();
		const store = await makeStartedStore();
		vi.mocked(api.fleet).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

		const firstRefresh = store.refreshFleet();
		const secondRefresh = store.refreshFleet();
		second.resolve({ runtimes: [fleetSnapshot("new")], diskSessions: [] });
		await secondRefresh;
		first.resolve({ runtimes: [fleetSnapshot("old")], diskSessions: [] });
		await firstRefresh;

		expect(store.fleet().runtimes.map((runtime) => runtime.key)).toEqual(["new"]);
	});

	it("merges concurrent stats into live cards and retains last-good values on partial failure", async () => {
		vi.mocked(api.fleet).mockResolvedValueOnce({
			runtimes: [fleetSnapshot("a", 1), fleetSnapshot("b", 2)],
			diskSessions: [],
		});
		const store = await makeStartedStore();
		vi.mocked(api.stats)
			.mockResolvedValueOnce(stats(5, 50, 0.5))
			.mockRejectedValueOnce(new Error("b stats unavailable"));

		await store.refreshFleetStats();

		expect(api.stats).toHaveBeenCalledWith("a", expect.any(AbortSignal));
		expect(api.stats).toHaveBeenCalledWith("b", expect.any(AbortSignal));
		expect(store.fleet().runtimes[0]).toMatchObject({
			stats: { tokensTotal: 50, cost: 0.5 },
			state: { messageCount: 5, contextUsage: { tokens: 50 } },
		});
		expect(store.fleet().runtimes[1]).not.toHaveProperty("stats");
		expect(store.fleetStatsError()).toContain("b stats unavailable");
	});

	it("times out a stalled stats request, preserves last-good values, and allows the next poll", async () => {
		vi.useFakeTimers();
		try {
			const runtime = fleetSnapshot("stalled", 4);
			runtime.state.contextUsage = { tokens: 40, contextWindow: 100_000, percent: 10 };
			runtime.stats = { tokensTotal: 40, cost: 0.4 };
			vi.mocked(api.fleet).mockResolvedValueOnce({ runtimes: [runtime], diskSessions: [] });
			const store = await makeStartedStore();
			const stalled = deferred<ReturnType<typeof stats>>();
			vi.mocked(api.stats)
				.mockReturnValueOnce(stalled.promise)
				.mockResolvedValueOnce(stats(6, 60, 0.6));

			const first = store.refreshFleetStats();
			const shared = store.refreshFleetStats();
			expect(shared).toBe(first);
			const signal = vi.mocked(api.stats).mock.calls[0]?.[1];
			expect(signal?.aborted).toBe(false);

			await vi.advanceTimersByTimeAsync(10_000);
			await first;

			expect(signal?.aborted).toBe(true);
			expect(store.fleetStatsError()).toBe("Stats request for runtime stalled timed out after 10000 ms");
			expect(store.fleet().runtimes[0]).toMatchObject({
				stats: { tokensTotal: 40, cost: 0.4 },
				state: { messageCount: 4, contextUsage: { tokens: 40 } },
			});
			expect(vi.getTimerCount()).toBe(0);

			await store.refreshFleetStats();

			expect(api.stats).toHaveBeenCalledTimes(2);
			expect(store.fleetStatsError()).toBeUndefined();
			expect(store.fleet().runtimes[0]).toMatchObject({
				stats: { tokensTotal: 60, cost: 0.6 },
				state: { messageCount: 6, contextUsage: { tokens: 60 } },
			});
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("allows an uncontended stats response to lower a forked count but preserves a newer live count", async () => {
		vi.mocked(api.fleet).mockResolvedValueOnce({ runtimes: [fleetSnapshot("live", 12)], diskSessions: [] });
		const store = await makeStartedStore();
		vi.mocked(api.stats).mockResolvedValueOnce(stats(3, 30, 0.3));

		await store.refreshFleetStats();
		expect(store.fleet().runtimes[0]?.state.messageCount).toBe(3);

		const delayed = deferred<ReturnType<typeof stats>>();
		vi.mocked(api.stats).mockReturnValueOnce(delayed.promise);
		const refresh = store.refreshFleetStats();
		emit("", { type: "fleet_snapshot", runtimes: [fleetSnapshot("live", 8)] });
		delayed.resolve(stats(2, 20, 0.2));
		await refresh;

		expect(store.fleet().runtimes[0]?.state.messageCount).toBe(8);
	});

	it("shares an in-flight stats request and discards stats for runtimes removed while it waits", async () => {
		const delayed = deferred<ReturnType<typeof stats>>();
		vi.mocked(api.fleet).mockResolvedValueOnce({ runtimes: [fleetSnapshot("gone")], diskSessions: [] });
		const store = await makeStartedStore();
		vi.mocked(api.stats).mockReturnValueOnce(delayed.promise);

		const first = store.refreshFleetStats();
		const second = store.refreshFleetStats();
		expect(first).toBe(second);
		expect(api.stats).toHaveBeenCalledOnce();
		emit("gone", { type: "runtime_removed" });
		delayed.resolve(stats(10, 100, 1));
		await first;

		expect(store.fleet().runtimes).toEqual([]);
		expect(store.fleetStatsError()).toBeUndefined();
	});
});
