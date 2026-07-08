import { EventEmitter } from "node:events";
import type { RpcClient } from "@dreb/coding-agent/rpc";
import { describe, expect, it, vi } from "vitest";
import { RuntimePool } from "../src/server/runtime-pool.js";

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
		})),
		setSettings: vi.fn(async (settings: Record<string, unknown>) => ({
			defaultProvider: "test",
			defaultModel: "m1",
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			compactionEnabled: true,
			retryEnabled: true,
			...settings,
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
	};
	return client as unknown as RpcClient & { emit: (e: Record<string, unknown>) => void };
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
