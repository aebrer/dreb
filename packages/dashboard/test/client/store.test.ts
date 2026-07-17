// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundAgentDto, RuntimeInfoDto } from "../../src/shared/protocol.js";

vi.mock("../../src/client/api.js", () => ({
	api: {
		auth: vi.fn(),
		fleet: vi.fn(),
		resync: vi.fn(),
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
	vi.mocked(api.resync).mockResolvedValue({ fleet: { runtimes: [], diskSessions: [] }, barrierSeq: 0 });
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
		expect(store.notices()).toEqual([]);
		expect(api.fleet).toHaveBeenCalledTimes(2);
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

	it("restores runtime tasks during a hard-refresh hydrate even when startup SSE events race it", async () => {
		const messages = deferred<{ messages: unknown[] }>();
		const agents = deferred<{ agents: BackgroundAgentDto[] }>();
		const runtime = runtimeSnapshot("s1", false);
		runtime.state.tasks = [{ id: "restore", title: "restore me", status: "in_progress" }];
		vi.mocked(api.messages).mockReturnValueOnce(messages.promise);
		vi.mocked(api.backgroundAgents).mockReturnValueOnce(agents.promise);
		vi.mocked(api.runtime).mockResolvedValueOnce(runtime);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSession("s1");
		emit("s1", { type: "agent_start" });
		messages.resolve({ messages: [{ role: "assistant", content: [{ type: "text", text: "stale snapshot" }] }] });
		agents.resolve({ agents: [] });
		await hydrate;
		emit("s1", { type: "agent_start" });

		expect(store.sessions.s1?.tasks).toEqual([{ id: "restore", title: "restore me", status: "in_progress" }]);
		expect(JSON.stringify(store.sessions.s1?.entries)).not.toContain("stale snapshot");
	});

	it("does not overwrite a newer live tasks_update with an older runtime hydrate", async () => {
		const messages = deferred<{ messages: unknown[] }>();
		const agents = deferred<{ agents: BackgroundAgentDto[] }>();
		const runtime = runtimeSnapshot("s1", false);
		runtime.state.tasks = [{ id: "stale", title: "stale task", status: "pending" }];
		vi.mocked(api.messages).mockReturnValueOnce(messages.promise);
		vi.mocked(api.backgroundAgents).mockReturnValueOnce(agents.promise);
		vi.mocked(api.runtime).mockResolvedValueOnce(runtime);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSession("s1");
		emit("s1", { type: "tasks_update", tasks: [{ id: "live", title: "live task", status: "completed" }] });
		messages.resolve({ messages: [] });
		agents.resolve({ agents: [] });
		await hydrate;

		expect(store.sessions.s1?.tasks).toEqual([{ id: "live", title: "live task", status: "completed" }]);
	});

	it("does not create a stub session when aborted hydration calls reject", async () => {
		const key = "abort-hydrate";
		vi.mocked(api.messages).mockImplementationOnce((_key: string, signal?: AbortSignal) => rejectAfterAbort(signal));
		vi.mocked(api.backgroundAgents).mockImplementationOnce((_key: string, signal?: AbortSignal) =>
			rejectAfterAbort(signal),
		);
		vi.mocked(api.runtime).mockImplementationOnce((_key: string, signal?: AbortSignal) => rejectAfterAbort(signal));
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
		vi.mocked(api.messages).mockRejectedValueOnce(new Error("messages failed"));
		vi.mocked(api.backgroundAgents).mockRejectedValueOnce(new Error("agents failed"));
		vi.mocked(api.runtime).mockRejectedValueOnce(new Error("runtime failed"));
		const store = createAppStore();

		await expect(store.hydrateSession("bad-hydrate")).rejects.toThrow("messages failed");
	});

	it("does not let a runtime_removed generation bump recreate a deleted session after hydration resolves", async () => {
		const messages = deferred<{ messages: unknown[] }>();
		const agents = deferred<{ agents: BackgroundAgentDto[] }>();
		const runtime = deferred<RuntimeInfoDto>();
		vi.mocked(api.messages).mockReturnValueOnce(messages.promise);
		vi.mocked(api.backgroundAgents).mockReturnValueOnce(agents.promise);
		vi.mocked(api.runtime).mockReturnValueOnce(runtime.promise);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSession("removed-mid-flight");
		emit("removed-mid-flight", { type: "runtime_removed" });
		messages.resolve({ messages: [{ role: "assistant", content: [{ type: "text", text: "phantom" }] }] });
		agents.resolve({ agents: [] });
		runtime.resolve(runtimeSnapshot("removed-mid-flight", false));
		await hydrate;

		expect(store.sessions["removed-mid-flight"]).toBeUndefined();
		expect("removed-mid-flight" in store.sessions).toBe(false);
	});

	it("does not let dashboard_resync recreate a cleared session after hydration resolves", async () => {
		const messages = deferred<{ messages: unknown[] }>();
		const agents = deferred<{ agents: BackgroundAgentDto[] }>();
		const runtime = deferred<RuntimeInfoDto>();
		vi.mocked(api.messages).mockReturnValueOnce(messages.promise);
		vi.mocked(api.backgroundAgents).mockReturnValueOnce(agents.promise);
		vi.mocked(api.runtime).mockReturnValueOnce(runtime.promise);
		const store = await makeStartedStore();

		const hydrate = store.hydrateSession("resync-mid-flight");
		emit("", { type: "dashboard_resync", reason: "buffer_gap" });
		messages.resolve({ messages: [{ role: "assistant", content: [{ type: "text", text: "phantom" }] }] });
		agents.resolve({ agents: [] });
		runtime.resolve(runtimeSnapshot("resync-mid-flight", false));
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
});
