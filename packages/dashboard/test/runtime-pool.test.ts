import { EventEmitter } from "node:events";
import type { RpcClient } from "@dreb/coding-agent/rpc";
import { describe, expect, it, vi } from "vitest";
import { EventHub } from "../src/server/event-hub.js";
import { MAX_COMPLETED_BACKGROUND_AGENTS, RuntimePool } from "../src/server/runtime-pool.js";

/** Minimal fake RpcClient: event emitter + spied lifecycle methods. */
// biome-ignore lint/suspicious/noExportsInTest: shared with server.test.ts
export function makeFakeClient() {
	const emitter = new EventEmitter();
	const client = {
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		onEvent: vi.fn((listener: (event: unknown) => void) => {
			emitter.on("event", listener);
			return () => emitter.off("event", listener);
		}),
		onExit: vi.fn((listener: (info: unknown) => void) => {
			emitter.on("exit", listener);
			return () => emitter.off("exit", listener);
		}),
		getState: vi.fn(async () => ({
			sessionId: "s1",
			thinkingLevel: "medium",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		})),
		getSessionStats: vi.fn(async () => ({
			sessionFile: undefined,
			sessionId: "s1",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 2,
			tokens: { input: 1200, output: 300, cacheRead: 40, cacheWrite: 5, total: 1545 },
			cost: 0.42,
		})),
		getPerformanceStats: vi.fn(async () => ({
			models: [{ provider: "test", modelId: "m1", median: 42, mean: 43, count: 4 }],
		})),
		getResources: vi.fn(async () => ({
			contextFiles: [{ path: "/tmp/AGENTS.md" }],
			skills: [{ name: "review", description: "Review code" }],
			extensions: [{ name: "demo", path: "/tmp/ext.ts" }],
			promptTemplates: [{ name: "plan", description: "Plan work" }],
			systemPromptPresent: true,
		})),
		getCommands: vi.fn(async () => [
			{ name: "skill:review", description: "Review code", source: "skill" },
			{ name: "plan", description: "Plan work", source: "prompt" },
		]),
		getGitBranch: vi.fn(async () => "feature/test"),
		getDailyCost: vi.fn(async () => 1.23),
		getAvailableModels: vi.fn(async () => [
			{ provider: "test", id: "m1", name: "Test Model", contextWindow: 200000, reasoning: false },
		]),
		getSettings: vi.fn(async () => ({
			defaultProvider: "test",
			defaultModel: "m1",
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			compactionEnabled: true,
			retryEnabled: true,
			autoLoadNestedContext: false,
			trustedContextFolders: [],
			effectiveTrustedContextRoots: [],
		})),
		setSettings: vi.fn(async (settings: Record<string, unknown>) => ({
			defaultProvider: "test",
			defaultModel: "m1",
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			compactionEnabled: true,
			retryEnabled: true,
			autoLoadNestedContext: false,
			trustedContextFolders: [],
			effectiveTrustedContextRoots: [],
			...settings,
		})),
		evaluateContextTrust: vi.fn(async (path: string) => ({ canonicalTarget: path, state: "untrusted" as const })),
		trustContextFolder: vi.fn(async (path: string) => ({
			evaluation: { canonicalTarget: path, state: "trusted-root" as const, grantingRoot: path },
			settings: {
				autoLoadNestedContext: false,
				trustedContextFolders: [path],
				effectiveTrustedContextRoots: [path],
				steeringMode: "all" as const,
				followUpMode: "one-at-a-time" as const,
				compactionEnabled: true,
				retryEnabled: true,
			},
			addedRoot: path,
		})),
		untrustContextFolder: vi.fn(async (path: string) => ({
			evaluation: { canonicalTarget: path, state: "untrusted" as const },
			settings: {
				autoLoadNestedContext: false,
				trustedContextFolders: [],
				effectiveTrustedContextRoots: [],
				steeringMode: "all" as const,
				followUpMode: "one-at-a-time" as const,
				compactionEnabled: true,
				retryEnabled: true,
			},
			removedRoot: path,
		})),
		listAgentTypes: vi.fn(async () => [{ name: "Explore", description: "Explore the codebase" }]),
		getLastAssistantText: vi.fn(async () => "last assistant activity preview"),
		listBackgroundAgents: vi.fn(async () => [] as unknown[]),
		getPendingMessages: vi.fn(async () => ({ steering: ["queued steer"], followUp: ["queued follow"] })),
		clearPendingMessages: vi.fn(async () => ({ steering: ["queued steer"], followUp: ["queued follow"] })),
		prompt: vi.fn(async () => {}),
		steer: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
		abortCompaction: vi.fn(async () => {}),
		abortRetry: vi.fn(async () => {}),
		emit: (event: Record<string, unknown>) => emitter.emit("event", event),
		emitExit: (info: Record<string, unknown>) => emitter.emit("exit", info),
	};
	return client as unknown as RpcClient & {
		emit: (e: Record<string, unknown>) => void;
		emitExit: (e: Record<string, unknown>) => void;
	};
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makePool() {
	const clients: Array<ReturnType<typeof makeFakeClient>> = [];
	const pool = new RuntimePool({
		cliPath: "/fake/cli.js",
		clientFactory: () => {
			const client = makeFakeClient();
			clients.push(client);
			return client;
		},
	});
	return { pool, clients };
}

describe("RuntimePool", () => {
	it("creates runtimes with unique keys and starts their clients", async () => {
		const { pool, clients } = makePool();
		const a = await pool.create("/tmp");
		const b = await pool.create("/tmp");
		expect(a.key).not.toBe(b.key);
		expect(clients).toHaveLength(2);
		expect(clients[0].start).toHaveBeenCalled();
		expect(pool.list()).toHaveLength(2);
	});

	it("stops and removes runtimes", async () => {
		const { pool, clients } = makePool();
		const handle = await pool.create("/tmp");
		expect(await pool.stop(handle.key)).toBe(true);
		expect(clients[0].stop).toHaveBeenCalled();
		expect(pool.list()).toHaveLength(0);
		expect(await pool.stop(handle.key)).toBe(false);
	});

	it("stopAll() stops session runtimes and utility runtimes", async () => {
		const { pool, clients } = makePool();
		await pool.create("/tmp/a");
		await pool.create("/tmp/b");
		await pool.ensureUtilityRuntime("/tmp/utility");

		await pool.stopAll();

		expect(clients).toHaveLength(3);
		expect(clients[0].stop).toHaveBeenCalled();
		expect(clients[1].stop).toHaveBeenCalled();
		expect(clients[2].stop).toHaveBeenCalled();
		expect(pool.list()).toHaveLength(0);
	});

	it("stop() publishes runtime_removed but stopAll() does not", async () => {
		const { pool } = makePool();
		const seen: Array<[string, Record<string, unknown>]> = [];
		pool.onEvent((key, event) => seen.push([key, event]));
		const stopped = await pool.create("/tmp/stopped");
		await pool.create("/tmp/shutdown");

		expect(await pool.stop(stopped.key)).toBe(true);
		expect(seen).toEqual([[stopped.key, { type: "runtime_removed" }]]);

		seen.length = 0;
		await pool.stopAll();
		expect(seen).toEqual([]);
	});

	it("stopAll() stops in-flight runtime startup and does not register it", async () => {
		const start = deferred<void>();
		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		const pool = new RuntimePool({
			cliPath: "/fake/cli.js",
			clientFactory: () => {
				const client = makeFakeClient();
				vi.mocked(client.start).mockReturnValue(start.promise);
				clients.push(client);
				return client;
			},
		});
		const createPromise = pool.create("/tmp/slow");

		const stopPromise = pool.stopAll();
		expect(clients[0].stop).toHaveBeenCalled();
		start.resolve();

		await expect(createPromise).rejects.toThrow(/closing/i);
		await stopPromise;
		expect(pool.list()).toHaveLength(0);
	});

	it("stopAll() stops in-flight utility startup and does not cache it", async () => {
		const start = deferred<void>();
		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		const pool = new RuntimePool({
			cliPath: "/fake/cli.js",
			clientFactory: () => {
				const client = makeFakeClient();
				vi.mocked(client.start).mockReturnValue(start.promise);
				clients.push(client);
				return client;
			},
		});
		const utilityPromise = pool.ensureUtilityRuntime("/tmp/utility");

		const stopPromise = pool.stopAll();
		expect(clients[0].stop).toHaveBeenCalled();
		start.resolve();

		await expect(utilityPromise).rejects.toThrow(/closing/i);
		await stopPromise;
		expect(pool.list()).toHaveLength(0);
	});

	it("ensureUtilityRuntime() retries after a startup failure", async () => {
		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		let first = true;
		const pool = new RuntimePool({
			cliPath: "/fake/cli.js",
			clientFactory: () => {
				const client = makeFakeClient();
				if (first) {
					first = false;
					vi.mocked(client.start).mockRejectedValueOnce(new Error("start failed"));
				}
				clients.push(client);
				return client;
			},
		});

		await expect(pool.ensureUtilityRuntime("/tmp/utility")).rejects.toThrow("start failed");
		const handle = await pool.ensureUtilityRuntime("/tmp/utility");

		expect(clients).toHaveLength(2);
		expect(handle.client).toBe(clients[1]);
	});

	it("ensureUtilityRuntime() deduplicates concurrent starts for the same cwd", async () => {
		const start = deferred<void>();
		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		const pool = new RuntimePool({
			cliPath: "/fake/cli.js",
			clientFactory: () => {
				const client = makeFakeClient();
				vi.mocked(client.start).mockReturnValue(start.promise);
				clients.push(client);
				return client;
			},
		});
		const first = pool.ensureUtilityRuntime("/tmp/utility");
		const second = pool.ensureUtilityRuntime("/tmp/utility");
		start.resolve();

		const firstHandle = await first;
		await expect(second).resolves.toBe(firstHandle);
		expect(clients).toHaveLength(1);
	});

	it("publishes a terminal event and records a runtime error when the RPC child exits", async () => {
		const logs: string[] = [];
		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		const pool = new RuntimePool({
			cliPath: "/fake/cli.js",
			logger: (line) => logs.push(line),
			clientFactory: () => {
				const client = makeFakeClient();
				clients.push(client);
				return client;
			},
		});
		const hub = new EventHub();
		const envelopes: ReturnType<EventHub["publish"]>[] = [];
		pool.onEvent((key, event) => envelopes.push(hub.publish(key, event)));
		const handle = await pool.create("/tmp");

		clients[0].emitExit({ code: 137, signal: "SIGKILL" });

		expect(handle.error).toBe("RPC process exited (code 137, signal SIGKILL)");
		expect(handle.attention.get("error")).toBe(handle.error);
		expect(envelopes).toHaveLength(1);
		expect(envelopes[0]).toMatchObject({
			seq: 1,
			key: handle.key,
			event: {
				type: "agent_end",
				messages: [],
				aborted: true,
				errorMessage: "RPC process exited (code 137, signal SIGKILL)",
			},
		});
		expect(logs.join("\n")).toContain("RPC process exited");
	});

	it("tags events with the runtime key", async () => {
		const { pool, clients } = makePool();
		const handle = await pool.create("/tmp");
		const seen: Array<[string, unknown]> = [];
		pool.onEvent((key, event) => seen.push([key, event]));
		clients[0].emit({ type: "agent_start" });
		expect(seen).toEqual([[handle.key, { type: "agent_start" }]]);
	});

	it("tracks needs-attention from extension UI requests and clears on agent_start", async () => {
		const { pool, clients } = makePool();
		const handle = await pool.create("/tmp");
		clients[0].emit({ type: "extension_ui_request", id: "u1", method: "confirm" });
		expect(handle.attention.size).toBe(1);
		clients[0].emit({ type: "agent_start" });
		expect(handle.attention.size).toBe(0);
	});

	it("tracks needs-attention from parent_paused and clears on agent_end", async () => {
		const { pool, clients } = makePool();
		const handle = await pool.create("/tmp");
		clients[0].emit({ type: "parent_paused_for_background_agents", runningAgentCount: 2 });
		expect(handle.attention.has("paused")).toBe(true);
		clients[0].emit({ type: "agent_end" });
		expect(handle.attention.has("paused")).toBe(false);
	});

	it("tracks background agents from lifecycle events", async () => {
		const { pool, clients } = makePool();
		const handle = await pool.create("/tmp");
		clients[0].emit({
			type: "background_agent_start",
			agentId: "bg1",
			agentType: "Explore",
			taskSummary: "look around",
			sessionDir: "/subagent-sessions/bg1",
		});
		expect(handle.backgroundAgents.get("bg1")?.status).toBe("running");
		expect(handle.backgroundAgents.get("bg1")?.sessionDir).toBe("/subagent-sessions/bg1");

		clients[0].emit({ type: "background_agent_end", agentId: "bg1", success: true, sessionFile: "/s/bg1.jsonl" });
		expect(handle.backgroundAgents.get("bg1")?.status).toBe("completed");
		expect(handle.backgroundAgents.get("bg1")?.sessionFile).toBe("/s/bg1.jsonl");
	});

	it("caps completed background agents from lifecycle events while preserving running agents", async () => {
		vi.useFakeTimers();
		try {
			const { pool, clients } = makePool();
			const handle = await pool.create("/tmp");
			clients[0].emit({
				type: "background_agent_start",
				agentId: "running-oldest",
				agentType: "Explore",
				taskSummary: "still running",
			});

			for (let i = 0; i < MAX_COMPLETED_BACKGROUND_AGENTS + 5; i += 1) {
				vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
				clients[0].emit({
					type: "background_agent_start",
					agentId: `done-${i}`,
					agentType: "Explore",
					taskSummary: `task ${i}`,
				});
				clients[0].emit({ type: "background_agent_end", agentId: `done-${i}`, success: true });
			}

			const completed = [...handle.backgroundAgents.values()].filter((agent) => agent.status !== "running");
			expect(handle.backgroundAgents.get("running-oldest")?.status).toBe("running");
			expect(completed.map((agent) => agent.agentId)).toEqual(
				Array.from({ length: MAX_COMPLETED_BACKGROUND_AGENTS }, (_, i) => `done-${i + 5}`),
			);

			const info = await pool.describe(handle);
			expect(info.backgroundAgents).toHaveLength(MAX_COMPLETED_BACKGROUND_AGENTS + 1);
			expect(info.backgroundAgents.some((agent) => agent.agentId === "running-oldest")).toBe(true);
			expect(
				info.backgroundAgents.filter((agent) => agent.status !== "running").map((agent) => agent.agentId),
			).toEqual(Array.from({ length: MAX_COMPLETED_BACKGROUND_AGENTS }, (_, i) => `done-${i + 5}`));
		} finally {
			vi.useRealTimers();
		}
	});

	it("describe() reports state, agents, and attention", async () => {
		const { pool, clients } = makePool();
		const handle = await pool.create("/tmp");
		clients[0].emit({ type: "extension_ui_request", id: "u1", method: "select" });
		const info = await pool.describe(handle);
		expect(info.key).toBe(handle.key);
		expect(info.cwd).toBe("/tmp");
		expect(info.needsAttention).toBe(true);
		expect(info.state.sessionId).toBe("s1");
		expect(info.stats).toEqual({ tokensTotal: 1545, cost: 0.42 });
		expect(info.lastAssistantText).toBe("last assistant activity preview");
	});

	it("describe() truncates last assistant previews for fleet cards", async () => {
		const { pool, clients } = makePool();
		const handle = await pool.create("/tmp");
		vi.mocked(clients[0].getLastAssistantText).mockResolvedValue("x".repeat(250));

		const info = await pool.describe(handle);

		expect(info.lastAssistantText).toHaveLength(200);
	});

	it("create() seeds background agents from the RPC registry", async () => {
		const { pool, clients } = makePool();
		const handlePromise = pool.create("/tmp");
		const client = clients[0];
		vi.mocked(client.listBackgroundAgents).mockResolvedValue([
			{
				agentId: "rehydrated",
				agentType: "Explore",
				taskSummary: "from disk",
				startedAt: new Date().toISOString(),
				status: "completed",
			},
		] as any);
		const handle = await handlePromise;

		expect(handle.backgroundAgents.get("rehydrated")?.taskSummary).toBe("from disk");
	});

	it("create() caps seeded completed background agents while preserving running agents", async () => {
		const seeded = [
			{
				agentId: "seed-running",
				agentType: "Explore",
				taskSummary: "still running",
				startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
				status: "running",
			},
			...Array.from({ length: MAX_COMPLETED_BACKGROUND_AGENTS + 3 }, (_, i) => ({
				agentId: `seed-done-${i}`,
				agentType: "Explore",
				taskSummary: `seeded ${i}`,
				startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i + 1)).toISOString(),
				status: "completed",
			})),
		];
		const pool = new RuntimePool({
			cliPath: "/fake/cli.js",
			clientFactory: () => {
				const client = makeFakeClient();
				vi.mocked(client.listBackgroundAgents).mockResolvedValue(seeded as any);
				return client;
			},
		});

		const handle = await pool.create("/tmp");
		const info = await pool.describe(handle);

		expect(handle.backgroundAgents.has("seed-running")).toBe(true);
		expect(info.backgroundAgents).toHaveLength(MAX_COMPLETED_BACKGROUND_AGENTS + 1);
		expect(info.backgroundAgents.filter((agent) => agent.status !== "running").map((agent) => agent.agentId)).toEqual(
			Array.from({ length: MAX_COMPLETED_BACKGROUND_AGENTS }, (_, i) => `seed-done-${i + 3}`),
		);
	});

	it("describe() reports runtime errors instead of throwing when state is unavailable", async () => {
		const logs: string[] = [];
		const pool = new RuntimePool({
			cliPath: "/fake/cli.js",
			logger: (line) => logs.push(line),
			clientFactory: () => {
				const client = makeFakeClient();
				vi.mocked(client.getState).mockRejectedValue(new Error("RPC process exited"));
				vi.mocked(client.getSessionStats).mockRejectedValue(new Error("dead"));
				vi.mocked(client.getLastAssistantText).mockRejectedValue(new Error("dead"));
				return client;
			},
		});
		const handle = await pool.create("/tmp");

		const info = await pool.describe(handle);

		expect(info.error).toContain("RPC process exited");
		expect(info.needsAttention).toBe(true);
		expect(info.state.isStreaming).toBe(false);
		expect(logs.join("\n")).toContain("state unavailable");
	});

	it("describe() persists terminal retry errors across fleet refreshes", async () => {
		const { pool, clients } = makePool();
		const handle = await pool.create("/tmp");
		clients[0].emit({ type: "auto_retry_end", success: false, finalError: "provider unavailable" });

		const info = await pool.describe(handle);

		expect(info.error).toBe("provider unavailable");
		expect(info.needsAttention).toBe(true);
	});

	it("describe() logs and omits stats when the stats call fails", async () => {
		const logs: string[] = [];
		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		const pool = new RuntimePool({
			cliPath: "/fake/cli.js",
			logger: (line) => logs.push(line),
			clientFactory: () => {
				const client = makeFakeClient();
				vi.mocked(client.getSessionStats).mockRejectedValue(new Error("stats unavailable"));
				clients.push(client);
				return client;
			},
		});
		const handle = await pool.create("/tmp");

		const info = await pool.describe(handle);

		expect(info.stats).toBeUndefined();
		expect(logs.join("\n")).toContain("stats unavailable");
	});

	it("describe() logs and omits last assistant text when that call fails", async () => {
		const logs: string[] = [];
		const pool = new RuntimePool({
			cliPath: "/fake/cli.js",
			logger: (line) => logs.push(line),
			clientFactory: () => {
				const client = makeFakeClient();
				vi.mocked(client.getLastAssistantText).mockRejectedValue(new Error("preview unavailable"));
				return client;
			},
		});
		const handle = await pool.create("/tmp");

		const info = await pool.describe(handle);

		expect(info.lastAssistantText).toBeUndefined();
		expect(logs.join("\n")).toContain("preview unavailable");
	});

	it("a throwing pool listener does not break event distribution", async () => {
		const { pool, clients } = makePool();
		await pool.create("/tmp");
		pool.onEvent(() => {
			throw new Error("subscriber bug");
		});
		const seen: unknown[] = [];
		pool.onEvent((_k, e) => seen.push(e));
		clients[0].emit({ type: "agent_start" });
		expect(seen).toHaveLength(1);
	});
});
