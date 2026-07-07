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
		prompt: vi.fn(async () => {}),
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
