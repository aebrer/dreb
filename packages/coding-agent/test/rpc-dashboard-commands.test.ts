import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@dreb/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import { getGitBranch } from "../src/core/git-branch.js";
import * as outputGuard from "../src/core/output-guard.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import type {
	RpcDashboardSnapshot as AggregateRpcDashboardSnapshot,
	RpcEvent as AggregateRpcEvent,
} from "../src/modes/index.js";
import type {
	RpcDashboardSnapshot,
	RpcDashboardSnapshotBarrierEvent,
	RpcEvent,
	RpcEventListener,
	RpcPendingMessages,
	RpcResources,
} from "../src/modes/rpc/index.js";
import { RpcClient } from "../src/modes/rpc/index.js";
import * as jsonl from "../src/modes/rpc/jsonl.js";
import {
	getBuiltinPromptRejection,
	getCommandsForRpc,
	getDashboardMessagesForRpc,
	getPendingMessagesForRpc,
	getResourcesForRpc,
	getStateForRpc,
	runRpcMode,
} from "../src/modes/rpc/rpc-mode.js";
import { createTestResourceLoader, createTestSession } from "./utilities.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-rpc-dashboard-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function model(provider: string, id: string, name = id): Model<any> {
	return {
		provider,
		id,
		name,
		api: "anthropic-messages",
		input: ["text"],
		reasoning: true,
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200_000,
		maxTokens: 8192,
	} as Model<any>;
}

function requireSnapshotBarrier(event: RpcEvent): RpcDashboardSnapshotBarrierEvent {
	if (event.type !== "dashboard_snapshot_barrier") {
		throw new Error(`Expected dashboard snapshot barrier, got ${event.type}`);
	}
	return event;
}

function acceptRpcEventListener(listener: RpcEventListener): RpcEventListener {
	return listener;
}

async function dispatchRpcCommand(
	session: ReturnType<typeof createTestSession>["session"],
	command: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
	const outputs: Array<Record<string, unknown>> = [];
	let handleInputLine: ((line: string) => void) | undefined;
	const existingEndListeners = new Set(process.stdin.listeners("end"));
	const existingErrorListeners = new Set(process.stdin.listeners("error"));
	vi.spyOn(outputGuard, "takeOverStdout").mockImplementation(() => {});
	vi.spyOn(outputGuard, "writeRawStdout").mockImplementation((line) => {
		outputs.push(JSON.parse(line) as Record<string, unknown>);
	});
	vi.spyOn(jsonl, "attachJsonlLineReader").mockImplementation((_stream, onLine) => {
		handleInputLine = onLine;
		return () => {};
	});

	try {
		void runRpcMode(session);
		await vi.waitFor(() => expect(handleInputLine).toBeDefined());
		handleInputLine!(JSON.stringify(command));
		await vi.waitFor(() => expect(outputs).toHaveLength(1));
		return outputs;
	} finally {
		for (const listener of process.stdin.listeners("end")) {
			if (!existingEndListeners.has(listener)) process.stdin.off("end", listener as (...args: unknown[]) => void);
		}
		for (const listener of process.stdin.listeners("error")) {
			if (!existingErrorListeners.has(listener)) {
				process.stdin.off("error", listener as (...args: unknown[]) => void);
			}
		}
	}
}

describe("RPC dashboard state/resources DTOs", () => {
	it("includes scoped models in get_state data", () => {
		const scoped = model("anthropic", "claude-scoped", "Claude Scoped");
		const { session, cleanup } = createTestSession({ inMemory: true });
		session.setScopedModels([{ model: scoped, thinkingLevel: "high" }]);

		try {
			const state = getStateForRpc(session);

			expect(state.scopedModels).toEqual([
				{
					provider: "anthropic",
					id: "claude-scoped",
					name: "Claude Scoped",
					reasoning: true,
					thinkingLevel: "high",
				},
			]);
		} finally {
			cleanup();
		}
	});

	it("includes the current task snapshot in get_state data", () => {
		const { session, cleanup } = createTestSession({ inMemory: true });
		const tasks = [
			{ id: "read", title: "Read existing code", status: "completed" as const },
			{ id: "fix", title: "Fix the RPC state", status: "in_progress" as const },
		];
		(session as unknown as { _tasks: typeof tasks })._tasks = tasks;

		try {
			const state = getStateForRpc(session);

			expect(state.tasks).toEqual(tasks);
			expect(state.tasks).not.toBe(tasks);
			expect(state.tasks[0]).not.toBe(tasks[0]);
		} finally {
			cleanup();
		}
	});

	it("includes automatic retry activity in get_state data", () => {
		const { session, cleanup } = createTestSession({ inMemory: true });
		const retryingSession = session as unknown as {
			_retryPromise: Promise<void>;
			_retryAttempt: number;
		};
		retryingSession._retryPromise = Promise.resolve();
		retryingSession._retryAttempt = 2;

		try {
			const state = getStateForRpc(session);

			expect(state.isRetrying).toBe(true);
			expect(state.retryAttempt).toBe(2);
		} finally {
			cleanup();
		}
	});

	it("includes OAuth subscription usage in get_state data", () => {
		const { session, cleanup } = createTestSession({ inMemory: true });
		const isUsingOAuth = vi.spyOn(session.modelRegistry, "isUsingOAuth").mockReturnValue(true);

		try {
			const state = getStateForRpc(session);

			expect(isUsingOAuth).toHaveBeenCalledWith(session.model);
			expect(state.usingSubscription).toBe(true);
		} finally {
			cleanup();
		}
	});

	it.each([
		{ state: "idle", isRetrying: false },
		{ state: "retry backoff", isRetrying: true },
	])("restores persisted failed attempts during $state dashboard snapshots", ({ isRetrying }) => {
		const failed = {
			role: "assistant",
			stopReason: "error",
			errorMessage: "transient provider failure",
			content: [{ type: "text", text: "partial" }],
		};
		const success = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "recovered" }],
		};
		const persisted = isRetrying ? [failed] : [failed, success];
		const buildSessionContext = vi.fn(() => ({ messages: persisted }));
		const session = {
			isStreaming: false,
			isRetrying,
			messages: isRetrying ? [] : [success],
			sessionManager: { buildSessionContext },
		} as never;

		expect(getDashboardMessagesForRpc(session)).toEqual(persisted);
		expect(buildSessionContext).toHaveBeenCalledOnce();
	});

	it("uses live agent messages while streaming", () => {
		const live = { role: "assistant", content: [{ type: "text", text: "live partial" }] };
		const buildSessionContext = vi.fn(() => ({ messages: [{ role: "assistant", stopReason: "error" }] }));
		const session = {
			isStreaming: true,
			isRetrying: true,
			messages: [live],
			sessionManager: { buildSessionContext },
		} as never;

		expect(getDashboardMessagesForRpc(session)).toEqual([live]);
		expect(buildSessionContext).not.toHaveBeenCalled();
	});

	it("returns queued message metadata without clearing queues", () => {
		const pending = getPendingMessagesForRpc({
			getSteeringMessages: () => ["steer one", "steer two"],
			getFollowUpMessages: () => ["follow one"],
			getSteeringMessagePayloads: () => [{ text: "steer one" }, { text: "steer two" }],
			getFollowUpMessagePayloads: () => [{ text: "follow one" }],
		} as never);

		expect(pending).toEqual({
			steering: ["steer one", "steer two"],
			followUp: ["follow one"],
			steeringMessages: [{ text: "steer one" }, { text: "steer two" }],
			followUpMessages: [{ text: "follow one" }],
		});
	});

	it("returns lean loaded resource metadata without file contents", () => {
		const sourceInfo = createSyntheticSourceInfo("/tmp/resource", { source: "test-source" });
		const skill = {
			name: "review-code",
			description: "Review code",
			filePath: "/tmp/skills/review-code/SKILL.md",
			baseDir: "/tmp/skills/review-code",
			sourceInfo,
			disableModelInvocation: false,
			userInvocable: true,
		};
		const prompt = {
			name: "plan",
			description: "Make a plan",
			content: "hidden prompt body",
			filePath: "/tmp/prompts/plan.md",
			sourceInfo,
		};
		const resourceLoader = createTestResourceLoader({
			agentsFiles: [{ path: "/tmp/AGENTS.md", content: "huge hidden context" }],
			skills: [skill],
			prompts: [prompt],
			systemPrompt: "hidden system prompt",
			extensionsResult: {
				extensions: [
					{
						path: "/tmp/extensions/example.ts",
						sourceInfo,
						handlers: new Map(),
						tools: new Map(),
						messageRenderers: new Map(),
						commands: new Map(),
						flags: new Map(),
						shortcuts: new Map(),
					} as never,
				],
				errors: [],
				runtime: createExtensionRuntime(),
			},
		});

		const resources = getResourcesForRpc({
			resourceLoader,
			getFilteredSkills: () => [skill],
			promptTemplates: [prompt],
		} as never);

		expect(resources).toEqual({
			contextFiles: [{ path: "/tmp/AGENTS.md" }],
			skills: [{ name: "review-code", description: "Review code" }],
			extensions: [{ name: "test-source", path: "/tmp/extensions/example.ts" }],
			promptTemplates: [{ name: "plan", description: "Make a plan" }],
			systemPromptPresent: true,
		});
		expect(JSON.stringify(resources)).not.toContain("huge hidden context");
		expect(JSON.stringify(resources)).not.toContain("hidden prompt body");
		expect(JSON.stringify(resources)).not.toContain("hidden system prompt");
	});

	it("discovers all registered built-ins without widening the extension command contract", () => {
		const sourceInfo = createSyntheticSourceInfo("/tmp/fork.ts", { source: "extension" });
		const commands = getCommandsForRpc({
			extensionRunner: {
				getRegisteredCommands: () => [
					{ invocationName: "fork", description: "collision", sourceInfo },
					{ invocationName: "custom", description: "custom", sourceInfo },
				],
			},
			promptTemplates: [],
			getFilteredSkills: () => [],
		} as never);

		expect(commands.find((command) => command.name === "fork")).toEqual({
			name: "fork",
			description: "Create a new fork from a previous message",
			source: "builtin",
			dashboard: true,
		});
		for (const name of ["copy", "hotkeys", "buddy"]) {
			expect(commands.find((command) => command.name === name)).toMatchObject({
				name,
				source: "builtin",
				dashboard: false,
			});
		}
		expect(commands.find((command) => command.name === "custom")).toMatchObject({
			source: "extension",
			sourceInfo,
		});
		expect(commands.some((command) => command.name === "debug" || command.name === "arminsayshi")).toBe(false);
	});

	it("rejects complete built-in tokens but not prefixes or unknown slash text", () => {
		expect(getBuiltinPromptRejection("/fork")).toContain("was not sent to the model");
		expect(getBuiltinPromptRejection("/fork anything")).toContain("/fork");
		expect(getBuiltinPromptRejection("/forklift")).toBeUndefined();
		expect(getBuiltinPromptRejection("/custom args")).toBeUndefined();
	});
});

describe("git branch helper used by RPC", () => {
	it("resolves a branch from the supplied cwd", async () => {
		const dir = await createTempDir();
		mkdirSync(join(dir, ".git"));
		writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feature/dashboard\n");

		expect(getGitBranch(dir)).toBe("feature/dashboard");
	});
});

describe("runRpcMode dashboard dispatcher", () => {
	it.each([
		{ command: "prompt", method: "prompt" },
		{ command: "steer", method: "steer" },
		{ command: "follow_up", method: "followUp" },
	] as const)("rejects built-ins at the RPC $command boundary", async ({ command, method }) => {
		const { session, cleanup } = createTestSession({ inMemory: true });
		const invoke = vi.spyOn(session, method).mockResolvedValue(undefined as never);

		try {
			const outputs = await dispatchRpcCommand(session, {
				id: `builtin-${command}`,
				type: command,
				message: "/fork",
			});
			expect(outputs[0]).toMatchObject({
				id: `builtin-${command}`,
				command,
				success: false,
				error: expect.stringContaining("was not sent to the model"),
			});
			expect(invoke).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it.each([
		{ command: "prompt", method: "prompt", message: "/forklift" },
		{ command: "steer", method: "steer", message: "/forklift" },
		{ command: "follow_up", method: "followUp", message: "/forklift" },
		{ command: "prompt", method: "prompt", message: "/unknown args" },
		{ command: "steer", method: "steer", message: "/unknown args" },
		{ command: "follow_up", method: "followUp", message: "/unknown args" },
	] as const)("allows $message through the RPC $command boundary", async ({ command, method, message }) => {
		const { session, cleanup } = createTestSession({ inMemory: true });
		const invoke = vi.spyOn(session, method).mockResolvedValue(undefined as never);

		try {
			const outputs = await dispatchRpcCommand(session, {
				id: `ordinary-${command}`,
				type: command,
				message,
			});
			expect(outputs[0]).toMatchObject({
				id: `ordinary-${command}`,
				command,
				success: true,
			});
			expect(invoke).toHaveBeenCalledOnce();
			expect(invoke.mock.calls[0]?.[0]).toBe(message);
		} finally {
			cleanup();
		}
	});

	it("emits a dashboard snapshot barrier and includes pending UI requests in the response", async () => {
		const { session, cleanup } = createTestSession({ inMemory: true });
		const tasks = [
			{ id: "read", title: "Read dispatcher pattern", status: "completed" as const },
			{ id: "test", title: "Assert snapshot ordering", status: "in_progress" as const },
		];
		(session as unknown as { _tasks: typeof tasks })._tasks = tasks;
		const outputs: Array<Record<string, unknown>> = [];
		let handleInputLine: ((line: string) => void) | undefined;
		let resolveSnapshotOutputs: (() => void) | undefined;
		const snapshotOutputs = new Promise<void>((resolve) => {
			resolveSnapshotOutputs = resolve;
		});
		const existingEndListeners = new Set(process.stdin.listeners("end"));
		const existingErrorListeners = new Set(process.stdin.listeners("error"));

		vi.spyOn(outputGuard, "takeOverStdout").mockImplementation(() => {});
		vi.spyOn(outputGuard, "writeRawStdout").mockImplementation((line) => {
			outputs.push(JSON.parse(line) as Record<string, unknown>);
			if (outputs.length === 3) {
				resolveSnapshotOutputs?.();
			}
		});
		vi.spyOn(jsonl, "attachJsonlLineReader").mockImplementation((_stream, onLine) => {
			handleInputLine = onLine;
			return () => {};
		});

		try {
			// runRpcMode intentionally never resolves; this exercises its real JSONL
			// command dispatcher while the test captures the stdout boundary.
			void runRpcMode(session);
			await vi.waitFor(() => expect(handleInputLine).toBeDefined());

			const pendingAsk = session.extensionRunner!.createContext().ui.ask({
				title: "Choose a database",
				questions: [{ question: "Which one?", options: ["SQLite", "Postgres"] }],
			});
			const request = outputs[0]!;
			expect(request).toMatchObject({ type: "extension_ui_request", method: "ask" });

			handleInputLine!(JSON.stringify({ type: "get_dashboard_snapshot" }));
			await snapshotOutputs;

			expect(outputs).toHaveLength(3);
			const barrier = outputs[1]!;
			const response = outputs[2]!;

			expect(barrier).toEqual({ type: "dashboard_snapshot_barrier", snapshotId: expect.any(String) });
			const snapshotId = barrier.snapshotId;
			expect(snapshotId).not.toBe("");
			expect(response).toMatchObject({
				type: "response",
				command: "get_dashboard_snapshot",
				success: true,
				data: {
					snapshotId,
					state: { tasks },
					pendingExtensionUiRequests: [request],
				},
			});

			handleInputLine!(
				JSON.stringify({ type: "extension_ui_response", id: request.id, answers: [{ selected: ["SQLite"] }] }),
			);
			await expect(pendingAsk).resolves.toEqual({ answers: [{ selected: ["SQLite"], skipped: false }] });
		} finally {
			cleanup();
			for (const listener of process.stdin.listeners("end")) {
				if (!existingEndListeners.has(listener)) {
					process.stdin.off("end", listener as (...args: unknown[]) => void);
				}
			}
			for (const listener of process.stdin.listeners("error")) {
				if (!existingErrorListeners.has(listener)) {
					process.stdin.off("error", listener as (...args: unknown[]) => void);
				}
			}
		}
	});
});

describe("runRpcMode prompt handling for subagent children", () => {
	async function startRpcHarness(session: ReturnType<typeof createTestSession>["session"]): Promise<{
		outputs: Array<Record<string, unknown>>;
		handleInputLine: (line: string) => void;
		cleanupListeners: () => void;
	}> {
		const outputs: Array<Record<string, unknown>> = [];
		let handleInputLine: ((line: string) => void) | undefined;
		const existingEndListeners = new Set(process.stdin.listeners("end"));
		const existingErrorListeners = new Set(process.stdin.listeners("error"));
		vi.spyOn(outputGuard, "takeOverStdout").mockImplementation(() => {});
		vi.spyOn(outputGuard, "writeRawStdout").mockImplementation((line) => {
			outputs.push(JSON.parse(line) as Record<string, unknown>);
		});
		vi.spyOn(jsonl, "attachJsonlLineReader").mockImplementation((_stream, onLine) => {
			handleInputLine = onLine;
			return () => {};
		});
		// runRpcMode intentionally never resolves; this exercises its real JSONL
		// command dispatcher while the test captures the stdout boundary.
		void runRpcMode(session);
		await vi.waitFor(() => expect(handleInputLine).toBeDefined());
		return {
			outputs,
			handleInputLine: (line) => handleInputLine!(line),
			cleanupListeners: () => {
				for (const listener of process.stdin.listeners("end")) {
					if (!existingEndListeners.has(listener)) {
						process.stdin.off("end", listener as (...args: unknown[]) => void);
					}
				}
				for (const listener of process.stdin.listeners("error")) {
					if (!existingErrorListeners.has(listener)) {
						process.stdin.off("error", listener as (...args: unknown[]) => void);
					}
				}
			},
		};
	}

	it("reports a late failure when a subagent child's prompt settles without an agent loop", async () => {
		const { session, cleanup } = createTestSession({ inMemory: true });
		(session as unknown as { _uiType: string })._uiType = "agent";
		// Extension-command-style settle: prompt resolves without any agent event.
		vi.spyOn(session, "prompt").mockResolvedValue(undefined);
		const harness = await startRpcHarness(session);

		try {
			harness.handleInputLine(JSON.stringify({ id: "p1", type: "prompt", message: "do the task" }));
			await vi.waitFor(() => expect(harness.outputs).toHaveLength(2));
			// The instantly-resolving mock can deliver the late failure a microtask
			// before the synchronous ack is written, so match by content not order.
			expect(harness.outputs.find((o) => o.id === "p1" && o.success === true)).toBeDefined();
			expect(harness.outputs.find((o) => o.id === "p1" && o.success === false)).toMatchObject({
				command: "prompt",
				error: expect.stringContaining("without starting the agent loop"),
			});
		} finally {
			harness.cleanupListeners();
			cleanup();
		}
	});

	it("reports no late failure when the subagent child's agent loop actually started", async () => {
		const { session, cleanup } = createTestSession({ inMemory: true });
		(session as unknown as { _uiType: string })._uiType = "agent";
		vi.spyOn(session, "prompt").mockImplementation(async () => {
			(session.agent as unknown as { emit: (event: Record<string, unknown>) => void }).emit({
				type: "agent_start",
				model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			});
		});
		const harness = await startRpcHarness(session);

		try {
			harness.handleInputLine(JSON.stringify({ id: "p2", type: "prompt", message: "do the task" }));
			await vi.waitFor(() => expect(harness.outputs.some((o) => o.id === "p2")).toBe(true));
			expect(harness.outputs.find((o) => o.id === "p2")).toMatchObject({
				id: "p2",
				command: "prompt",
				success: true,
			});
			// Flush pending microtasks/timers: no late error response may follow the ack.
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(harness.outputs.filter((o) => o.id === "p2" && o.success === false)).toHaveLength(0);
		} finally {
			harness.cleanupListeners();
			cleanup();
		}
	});

	it("leaves non-subagent sessions without the no-loop failure signal", async () => {
		const { session, cleanup } = createTestSession({ inMemory: true });
		vi.spyOn(session, "prompt").mockResolvedValue(undefined);
		const harness = await startRpcHarness(session);

		try {
			harness.handleInputLine(JSON.stringify({ id: "p3", type: "prompt", message: "do the task" }));
			await vi.waitFor(() => expect(harness.outputs).toHaveLength(1));
			expect(harness.outputs[0]).toMatchObject({ id: "p3", command: "prompt", success: true });
			// Flush pending microtasks/timers: the ack must remain the only response.
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(harness.outputs).toHaveLength(1);
		} finally {
			harness.cleanupListeners();
			cleanup();
		}
	});
});

describe("RpcClient dashboard command methods", () => {
	it("getResources sends get_resources and unwraps resources", async () => {
		const client = new RpcClient() as any;
		const data: RpcResources = {
			contextFiles: [],
			skills: [],
			extensions: [],
			promptTemplates: [],
			systemPromptPresent: false,
		};
		client.send = vi.fn().mockResolvedValue({ type: "response", command: "get_resources", success: true, data });

		await expect(client.getResources()).resolves.toBe(data);
		expect(client.send).toHaveBeenCalledWith({ type: "get_resources" });
	});

	it("getDashboardSnapshot sends the ordered snapshot command", async () => {
		const client = new RpcClient() as any;
		const data = { snapshotId: "snap-1", state: { tasks: [] }, messages: [], backgroundAgents: [] };
		client.send = vi
			.fn()
			.mockResolvedValue({ type: "response", command: "get_dashboard_snapshot", success: true, data });

		await expect(client.getDashboardSnapshot()).resolves.toBe(data);
		expect(client.send).toHaveBeenCalledWith({ type: "get_dashboard_snapshot" });
	});

	it("exposes snapshot barrier and snapshot types from public RPC exports", () => {
		const barrier = {
			type: "dashboard_snapshot_barrier",
			snapshotId: "snap-typed",
		} satisfies RpcDashboardSnapshotBarrierEvent;
		const rpcEvent: RpcEvent = barrier;
		const aggregateEvent: AggregateRpcEvent = barrier;
		const snapshot = {
			snapshotId: "snap-typed",
			state: {
				scopedModels: [],
				tasks: [],
				usingSubscription: false,
				thinkingLevel: "high",
				isStreaming: false,
				isRetrying: false,
				retryAttempt: 0,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				sessionId: "session-1",
				autoCompactionEnabled: false,
				messageCount: 0,
				pendingMessageCount: 0,
			},
			messages: [],
			backgroundAgents: [],
			pendingExtensionUiRequests: [],
		} satisfies RpcDashboardSnapshot;
		const aggregateSnapshot: AggregateRpcDashboardSnapshot = snapshot;

		expect(requireSnapshotBarrier(rpcEvent).snapshotId).toBe("snap-typed");
		expect(requireSnapshotBarrier(aggregateEvent).snapshotId).toBe("snap-typed");
		expect(aggregateSnapshot.snapshotId).toBe("snap-typed");
	});

	it("delivers typed snapshot barrier events to RpcClient listeners", () => {
		const client = new RpcClient() as any;
		const received: RpcDashboardSnapshotBarrierEvent[] = [];
		client.onEvent(
			acceptRpcEventListener((event) => {
				const barrier = requireSnapshotBarrier(event);
				received.push(barrier);
			}),
		);

		client.handleLine(JSON.stringify({ type: "dashboard_snapshot_barrier", snapshotId: "snap-typed" }));

		expect(received).toEqual([{ type: "dashboard_snapshot_barrier", snapshotId: "snap-typed" }]);
	});

	it("does not deliver malformed snapshot barrier frames to RpcClient listeners", () => {
		const client = new RpcClient() as any;
		const received: RpcEvent[] = [];
		client.onEvent((event: RpcEvent) => received.push(event));

		client.handleLine(JSON.stringify({ type: "dashboard_snapshot_barrier", snapshotId: 42 }));

		expect(received).toEqual([]);
	});

	it("parses a snapshot barrier before the response promise microtask", async () => {
		const client = new RpcClient() as any;
		const order: string[] = [];
		client.onEvent(() => order.push("barrier"));
		const response = new Promise<void>((resolve) => {
			client.pendingRequests.set("req_snapshot", { resolve, reject: vi.fn() });
		}).then(() => order.push("response"));

		// Wire order, not stdout chunk coalescing, guarantees that a barrier parsed
		// in one chunk still precedes a response delivered in a later chunk.
		client.handleLine(JSON.stringify({ type: "dashboard_snapshot_barrier", snapshotId: "snap-1" }));
		await Promise.resolve();
		client.handleLine(
			JSON.stringify({
				id: "req_snapshot",
				type: "response",
				command: "get_dashboard_snapshot",
				success: true,
				data: { snapshotId: "snap-1", state: { tasks: [] }, messages: [], backgroundAgents: [] },
			}),
		);
		await response;

		expect(order).toEqual(["barrier", "response"]);
	});

	it("getGitBranch sends get_git_branch and unwraps the branch", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "get_git_branch",
			success: true,
			data: { branch: "main" },
		});

		await expect(client.getGitBranch()).resolves.toBe("main");
		expect(client.send).toHaveBeenCalledWith({ type: "get_git_branch" });
	});

	it("getDailyCost sends get_daily_cost and unwraps the cost", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "get_daily_cost",
			success: true,
			data: { cost: 1.23 },
		});

		await expect(client.getDailyCost()).resolves.toBe(1.23);
		expect(client.send).toHaveBeenCalledWith({ type: "get_daily_cost" });
	});

	it("getPendingMessages sends get_pending_messages and unwraps queues", async () => {
		const client = new RpcClient() as any;
		const data: RpcPendingMessages = { steering: ["steer"], followUp: ["follow"] };
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "get_pending_messages",
			success: true,
			data,
		});

		await expect(client.getPendingMessages()).resolves.toEqual(data);
		expect(client.send).toHaveBeenCalledWith({ type: "get_pending_messages" });
	});

	it("clearPendingMessages sends clear_pending_messages and unwraps cleared queues", async () => {
		const client = new RpcClient() as any;
		const data: RpcPendingMessages = { steering: ["old steer"], followUp: ["old follow"] };
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "clear_pending_messages",
			success: true,
			data,
		});

		await expect(client.clearPendingMessages()).resolves.toEqual(data);
		expect(client.send).toHaveBeenCalledWith({ type: "clear_pending_messages" });
	});

	it("abortCompaction sends abort_compaction", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({ type: "response", command: "abort_compaction", success: true });

		await expect(client.abortCompaction()).resolves.toBeUndefined();
		expect(client.send).toHaveBeenCalledWith({ type: "abort_compaction" });
	});

	it("abortRetry sends abort_retry", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({ type: "response", command: "abort_retry", success: true });

		await expect(client.abortRetry()).resolves.toBeUndefined();
		expect(client.send).toHaveBeenCalledWith({ type: "abort_retry" });
	});
});
