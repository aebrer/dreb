import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileApi } from "../src/files.js";
import { DashboardRuntimePool, type RpcClientLike, type RuntimeEventListener } from "../src/runtime.js";
import { createDashboardServer } from "../src/server.js";
import { SessionApi, type SessionLister } from "../src/sessions.js";

class FakeRpcClient implements RpcClientLike {
	private listeners: RuntimeEventListener[] = [];
	prompts: string[] = [];
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	onEvent(listener: RuntimeEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((candidate) => candidate !== listener);
		};
	}
	emit(event: { type: string; [key: string]: unknown }): void {
		for (const listener of this.listeners) listener(event);
	}
	async prompt(message: string): Promise<void> {
		this.prompts.push(message);
	}
	async steer(): Promise<void> {}
	async followUp(): Promise<void> {}
	async abort(): Promise<void> {}
	async getState(): Promise<any> {
		return { sessionId: "s1", thinkingLevel: "medium", isStreaming: false };
	}
	async getMessages(): Promise<any[]> {
		return [];
	}
	async setModel(): Promise<unknown> {
		return null;
	}
	async setThinkingLevel(): Promise<void> {}
	async setSteeringMode(): Promise<void> {}
	async setFollowUpMode(): Promise<void> {}
	async switchSession(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
}

const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				}),
		),
	);
});

describe("dashboard server", () => {
	it("serves health, static assets, sessions, files, and runtime JSON routes", async () => {
		const root = await mkdtemp(join(tmpdir(), "dreb-dashboard-server-"));
		const fake = new FakeRpcClient();
		const sessionLister: SessionLister = {
			listAll: async () => [],
			listProject: async () => [],
		};
		const server = await listen(
			createDashboardServer({
				files: new FileApi({ cwd: root, homeDir: root }),
				sessions: new SessionApi(sessionLister),
				runtimes: new DashboardRuntimePool({ factory: () => fake, validateSessionProject: false }),
			}),
		);

		await expectJson(`${server.url}/api/health`, { ok: true });
		const index = await fetch(`${server.url}/`);
		expect(index.status).toBe(200);
		expect(await index.text()).toContain("dreb dashboard");
		await expectJson(`${server.url}/api/roots`, { roots: [{ id: "cwd", label: "Current project", path: root }] });
		await expectJson(`${server.url}/api/sessions`, { sessions: [] });
		await expectJson(
			`${server.url}/api/runtime/r1/prompt`,
			{ ok: true },
			{ method: "POST", body: JSON.stringify({ cwd: root, message: "hi" }) },
		);
		expect(fake.prompts).toEqual(["hi"]);
	});

	it("fans runtime events out over SSE", async () => {
		const root = await mkdtemp(join(tmpdir(), "dreb-dashboard-server-"));
		const fake = new FakeRpcClient();
		const server = await listen(
			createDashboardServer({
				runtimes: new DashboardRuntimePool({ factory: () => fake, validateSessionProject: false }),
			}),
		);
		const abort = new AbortController();
		const response = await fetch(`${server.url}/api/runtime/r1/events?cwd=${encodeURIComponent(root)}`, {
			signal: abort.signal,
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = response.body!.getReader();
		const ready = await readChunk(reader);
		expect(ready).toContain("event: ready");

		fake.emit({ type: "agent_chunk", text: "hello" });
		const event = await readChunk(reader);
		expect(event).toContain("event: agent");
		expect(event).toContain('"type":"agent_chunk"');
		abort.abort();
	});
});

async function listen(server: Server): Promise<{ url: string }> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Server did not bind to TCP");
	return { url: `http://127.0.0.1:${address.port}` };
}

async function expectJson(url: string, expected: unknown, init?: RequestInit): Promise<void> {
	const response = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
	expect(response.status).toBe(200);
	await expect(response.json()).resolves.toEqual(expected);
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	const result = await Promise.race([
		reader.read(),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for SSE chunk")), 2000)),
	]);
	if (result.done) throw new Error("SSE stream ended");
	return new TextDecoder().decode(result.value);
}
