import { describe, expect, it } from "vitest";
import { DashboardRuntimePool, type RpcClientLike, type RuntimeEventListener } from "../src/runtime.js";

class FakeRpcClient implements RpcClientLike {
	started = false;
	stopped = false;
	calls: Array<[string, unknown[]]> = [];
	private listeners: RuntimeEventListener[] = [];

	async start(): Promise<void> {
		this.started = true;
	}

	async stop(): Promise<void> {
		this.stopped = true;
	}

	onEvent(listener: RuntimeEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((candidate) => candidate !== listener);
		};
	}

	emit(event: { type: string; [key: string]: unknown }): void {
		for (const listener of this.listeners) listener(event);
	}

	async prompt(...args: Parameters<RpcClientLike["prompt"]>): Promise<void> {
		this.calls.push(["prompt", args]);
	}

	async steer(...args: Parameters<RpcClientLike["steer"]>): Promise<void> {
		this.calls.push(["steer", args]);
	}

	async followUp(...args: Parameters<RpcClientLike["followUp"]>): Promise<void> {
		this.calls.push(["followUp", args]);
	}

	async abort(): Promise<void> {
		this.calls.push(["abort", []]);
	}

	async getState(): Promise<any> {
		return { sessionId: "s1", thinkingLevel: "medium", isStreaming: false };
	}

	async getMessages(): Promise<any[]> {
		return [{ role: "user", content: "hello" }];
	}

	async setModel(...args: Parameters<RpcClientLike["setModel"]>): Promise<unknown> {
		this.calls.push(["setModel", args]);
		return { provider: args[0], id: args[1] };
	}

	async setThinkingLevel(...args: Parameters<RpcClientLike["setThinkingLevel"]>): Promise<void> {
		this.calls.push(["setThinkingLevel", args]);
	}

	async setSteeringMode(...args: Parameters<RpcClientLike["setSteeringMode"]>): Promise<void> {
		this.calls.push(["setSteeringMode", args]);
	}

	async setFollowUpMode(...args: Parameters<RpcClientLike["setFollowUpMode"]>): Promise<void> {
		this.calls.push(["setFollowUpMode", args]);
	}

	async switchSession(...args: Parameters<RpcClientLike["switchSession"]>): Promise<{ cancelled: boolean }> {
		this.calls.push(["switchSession", args]);
		return { cancelled: false };
	}
}

describe("DashboardRuntimePool", () => {
	it("starts injected RPC clients and forwards runtime commands", async () => {
		const fake = new FakeRpcClient();
		const pool = new DashboardRuntimePool({ factory: () => fake, validateSessionProject: false });
		const runtime = await pool.getOrCreate({ id: "r1", cwd: process.cwd(), sessionPath: "/tmp/session.jsonl" });

		expect(fake.started).toBe(true);
		expect(fake.calls[0]).toEqual(["switchSession", ["/tmp/session.jsonl"]]);
		await runtime.prompt("hello");
		await runtime.steer("wait");
		await runtime.followUp("next");
		await runtime.abort();
		await runtime.setModel("openai", "gpt-test");
		await runtime.setThinkingLevel("medium" as never);
		await runtime.setSteeringMode("all");
		await runtime.setFollowUpMode("one-at-a-time");

		expect(fake.calls.map(([name]) => name)).toEqual([
			"switchSession",
			"prompt",
			"steer",
			"followUp",
			"abort",
			"setModel",
			"setThinkingLevel",
			"setSteeringMode",
			"setFollowUpMode",
		]);
	});

	it("fans out RPC events to runtime listeners", async () => {
		const fake = new FakeRpcClient();
		const pool = new DashboardRuntimePool({ factory: () => fake, validateSessionProject: false });
		const runtime = await pool.getOrCreate({ id: "r1", cwd: process.cwd() });
		const events: unknown[] = [];
		runtime.onEvent((event) => events.push(event));

		fake.emit({ type: "agent_chunk", text: "hi" });
		expect(events).toEqual([{ type: "agent_chunk", text: "hi" }]);
	});

	it("refuses to switch project or session inside an existing runtime", async () => {
		const pool = new DashboardRuntimePool({ factory: () => new FakeRpcClient(), validateSessionProject: false });
		await pool.getOrCreate({ id: "fixed", cwd: "/tmp/project-a", sessionPath: "/tmp/a.jsonl" });

		await expect(
			pool.getOrCreate({ id: "fixed", cwd: "/tmp/project-b", sessionPath: "/tmp/a.jsonl" }),
		).rejects.toThrow("Runtime cannot switch projects");
		await expect(
			pool.getOrCreate({ id: "fixed", cwd: "/tmp/project-a", sessionPath: "/tmp/b.jsonl" }),
		).rejects.toThrow("Runtime cannot switch sessions");
	});
});
