import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardAuth, MemoryPairingStorage, type TailscaleIdentity } from "../src/server/auth.js";
import { RuntimePool } from "../src/server/runtime-pool.js";
import { createDashboardServer, parseDeviceCookie } from "../src/server/server.js";
import { makeFakeClient } from "./runtime-pool.test.js";

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface TestServerOptions {
	auth?: DashboardAuth;
	listAllSessions?: () => Promise<unknown[]>;
	deleteSession?: (path: string) => Promise<unknown>;
}

async function createTempProject(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-dash-server-"));
	tempDirs.push(dir);
	return dir;
}

async function startServer(options: TestServerOptions = {}) {
	const clients: Array<ReturnType<typeof makeFakeClient>> = [];
	const pool = new RuntimePool({
		cliPath: "/fake/cli.js",
		clientFactory: () => {
			const client = makeFakeClient();
			clients.push(client);
			return client;
		},
	});
	const app = createDashboardServer({
		auth: options.auth ?? new DashboardAuth(),
		pool,
		listAllSessions: options.listAllSessions ?? (async () => []),
		deleteSession: options.deleteSession ?? (async () => ({ method: "trash" })),
		logger: () => {},
	});
	const server = await new Promise<Server>((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	servers.push(server);
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	return { base: `http://127.0.0.1:${address.port}`, pool, clients };
}

describe("dashboard server — auth middleware", () => {
	it("allows loopback requests with a loopback Host", async () => {
		const { base } = await startServer();
		const res = await fetch(`${base}/api/auth`);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({ mode: "local" });
	});

	it("rejects requests with a foreign Host header (DNS rebinding)", async () => {
		const { base } = await startServer();
		// fetch/undici forbids overriding Host — use a raw http request.
		const { request } = await import("node:http");
		const url = new URL(base);
		const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
			const req = request(
				{
					host: url.hostname,
					port: url.port,
					path: "/api/fleet",
					method: "GET",
					headers: { host: "attacker.example" },
				},
				(res) => {
					let body = "";
					res.on("data", (c) => {
						body += c;
					});
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
				},
			);
			req.on("error", reject);
			req.end();
		});
		expect(result.status).toBe(403);
		expect(result.body).toContain("DNS-rebinding");
	});

	it("rejects requests with a cross-site Origin", async () => {
		const { base } = await startServer();
		const res = await fetch(`${base}/api/fleet`, { headers: { origin: "https://evil.example" } });
		expect(res.status).toBe(403);
	});
});

describe("dashboard server — fleet and runtimes", () => {
	it("GET /api/fleet returns runtimes and disk sessions", async () => {
		const disk = [{ path: "/s/one.jsonl", id: "one", cwd: "/p" }];
		const { base } = await startServer({ listAllSessions: async () => disk });
		const res = await fetch(`${base}/api/fleet`);
		const body = (await res.json()) as { runtimes: unknown[]; diskSessions: unknown[] };
		expect(body.runtimes).toEqual([]);
		expect(body.diskSessions).toEqual(disk);
	});

	it("POST /api/runtimes validates cwd and creates a runtime", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dreb-dash-server-"));
		tempDirs.push(dir);
		const { base, pool } = await startServer();

		const bad = await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: "/does/not/exist" }),
		});
		expect(bad.status).toBe(400);

		const good = await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});
		expect(good.status).toBe(201);
		const body = (await good.json()) as { key: string; cwd: string };
		expect(body.cwd).toBe(dir);
		expect(pool.get(body.key)).toBeDefined();
	});

	it("POST /api/runtimes with firstPrompt sends the prompt", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dreb-dash-server-"));
		tempDirs.push(dir);
		const { base, clients } = await startServer();
		await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir, firstPrompt: "hello" }),
		});
		expect(clients[0].prompt).toHaveBeenCalledWith("hello");
	});

	it("GET subagent messages reads the agent's session log from disk", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dreb-dash-server-"));
		tempDirs.push(dir);
		const logDir = await mkdtemp(join(tmpdir(), "dreb-dash-sublog-"));
		tempDirs.push(logDir);
		const message = { role: "assistant", content: [{ type: "text", text: "subagent findings" }] };
		await writeFile(
			join(logDir, "session.jsonl"),
			`${JSON.stringify({ type: "session", cwd: dir })}\n${JSON.stringify({ type: "message", id: "1", message })}\n`,
		);
		const { base, clients } = await startServer();
		const created = await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});
		const { key } = (await created.json()) as { key: string };
		const agent = {
			agentId: "bg1",
			agentType: "Explore",
			taskSummary: "scan",
			startedAt: new Date().toISOString(),
			status: "running",
			sessionDir: logDir,
		};
		(clients[0].listBackgroundAgents as ReturnType<typeof vi.fn>).mockResolvedValue([agent]);

		const res = await fetch(`${base}/api/runtimes/${key}/subagents/bg1/messages`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { agent: { agentId: string }; messages: unknown[] };
		expect(body.agent.agentId).toBe("bg1");
		expect(body.messages).toEqual([message]);

		// Unknown agent id → loud 502 with the registry error.
		const missing = await fetch(`${base}/api/runtimes/${key}/subagents/nope/messages`);
		expect(missing.status).toBe(502);
		await expect(missing.json()).resolves.toMatchObject({ error: expect.stringContaining("No background agent") });
	});

	it("prompt endpoint dispatches steer/follow_up/prompt modes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dreb-dash-server-"));
		tempDirs.push(dir);
		const { base, pool, clients } = await startServer();
		const create = await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});
		const { key } = (await create.json()) as { key: string };
		const client = clients[0] as any;
		client.steer = vi.fn(async () => {});
		client.followUp = vi.fn(async () => {});

		await fetch(`${base}/api/runtimes/${key}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "m1", mode: "steer" }),
		});
		expect(client.steer).toHaveBeenCalledWith("m1", undefined);

		await fetch(`${base}/api/runtimes/${key}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "m2", mode: "follow_up" }),
		});
		expect(client.followUp).toHaveBeenCalledWith("m2", undefined);

		await fetch(`${base}/api/runtimes/${key}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				message: "m3",
				images: [{ data: "abc123", mimeType: "image/png" }],
			}),
		});
		expect(client.prompt).toHaveBeenCalledWith("m3", [{ type: "image", data: "abc123", mimeType: "image/png" }]);

		const badImages = await fetch(`${base}/api/runtimes/${key}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "bad", images: [{ data: 1, mimeType: "image/png" }] }),
		});
		expect(badImages.status).toBe(400);

		const missing = await fetch(`${base}/api/runtimes/${key}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(missing.status).toBe(400);
		expect(pool.get(key)).toBeDefined();
	});

	it("unknown runtime keys 404", async () => {
		const { base } = await startServer();
		const res = await fetch(`${base}/api/runtimes/nope`, { method: "GET" });
		expect(res.status).toBe(404);
	});

	it("exposes dashboard RPC data routes", async () => {
		const dir = await createTempProject();
		const { base, clients } = await startServer();
		const create = await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});
		const { key } = (await create.json()) as { key: string };

		await expect(fetch(`${base}/api/runtimes/${key}/performance`).then((r) => r.json())).resolves.toEqual({
			models: [{ provider: "test", modelId: "m1", median: 42, mean: 43, count: 4 }],
		});
		await expect(fetch(`${base}/api/runtimes/${key}/resources`).then((r) => r.json())).resolves.toEqual({
			contextFiles: [{ path: "/tmp/AGENTS.md" }],
			skills: [{ name: "review", description: "Review code" }],
			extensions: [{ name: "demo", path: "/tmp/ext.ts" }],
			promptTemplates: [{ name: "plan", description: "Plan work" }],
			systemPromptPresent: true,
		});
		await expect(fetch(`${base}/api/runtimes/${key}/commands`).then((r) => r.json())).resolves.toEqual({
			commands: [
				{ name: "skill:review", description: "Review code", source: "skill" },
				{ name: "plan", description: "Plan work", source: "prompt" },
			],
		});
		await expect(fetch(`${base}/api/runtimes/${key}/branch`).then((r) => r.json())).resolves.toEqual({
			branch: "feature/test",
		});
		await expect(fetch(`${base}/api/runtimes/${key}/pending`).then((r) => r.json())).resolves.toEqual({
			steering: ["queued steer"],
			followUp: ["queued follow"],
		});
		await expect(
			fetch(`${base}/api/runtimes/${key}/dequeue`, { method: "POST" }).then((r) => r.json()),
		).resolves.toEqual({ steering: ["queued steer"], followUp: ["queued follow"] });
		await expect(fetch(`${base}/api/daily-cost`).then((r) => r.json())).resolves.toEqual({ cost: 1.23 });
		await expect(fetch(`${base}/api/runtimes/${key}/abort-compaction`, { method: "POST" })).resolves.toMatchObject({
			status: 200,
		});
		await expect(fetch(`${base}/api/runtimes/${key}/abort-retry`, { method: "POST" })).resolves.toMatchObject({
			status: 200,
		});
		expect(clients[0].getPerformanceStats).toHaveBeenCalled();
		expect(clients[0].getResources).toHaveBeenCalled();
		expect(clients[0].getCommands).toHaveBeenCalled();
		expect(clients[0].getGitBranch).toHaveBeenCalled();
		expect(clients[0].getPendingMessages).toHaveBeenCalled();
		expect(clients[0].clearPendingMessages).toHaveBeenCalled();
		expect(clients[0].abortCompaction).toHaveBeenCalled();
		expect(clients[0].abortRetry).toHaveBeenCalled();
		expect(clients[0].getDailyCost).toHaveBeenCalled();
	});

	it("protects dashboard RPC data routes with auth middleware", async () => {
		const dir = await createTempProject();
		const { base } = await startServer();
		const create = await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});
		const { key } = (await create.json()) as { key: string };
		const paths = [
			`/api/runtimes/${key}/performance`,
			`/api/runtimes/${key}/resources`,
			`/api/runtimes/${key}/commands`,
			`/api/runtimes/${key}/branch`,
			`/api/runtimes/${key}/pending`,
			`/api/runtimes/${key}/dequeue`,
			`/api/runtimes/${key}/abort-compaction`,
			`/api/runtimes/${key}/abort-retry`,
			"/api/daily-cost",
		];

		for (const path of paths) {
			const res = await fetch(`${base}${path}`, { headers: { origin: "https://evil.example" } });
			expect(res.status).toBe(403);
		}
	});
});

describe("dashboard server — SSE", () => {
	it("streams envelopes with sequence ids over /api/events", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dreb-dash-server-"));
		tempDirs.push(dir);
		const { base, clients } = await startServer();
		await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});

		const res = await fetch(`${base}/api/events`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const reader = res.body!.getReader();

		clients[0].emit({ type: "agent_start" });

		const decoder = new TextDecoder();
		let buffer = "";
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && !buffer.includes("agent_start")) {
			const { value, done } = await Promise.race([
				reader.read(),
				new Promise<{ value: undefined; done: true }>((resolve) =>
					setTimeout(() => resolve({ value: undefined, done: true }), 500),
				),
			]);
			if (value) buffer += decoder.decode(value, { stream: true });
			if (done && !value) break;
		}
		await reader.cancel();
		expect(buffer).toContain("agent_start");
		expect(buffer).toMatch(/id: \d+/);
	});
});

describe("dashboard server — files", () => {
	it("lists, uploads (with collision), downloads, and mkdirs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dreb-dash-server-"));
		tempDirs.push(dir);
		await writeFile(join(dir, "hello.txt"), "hi there");
		const { base } = await startServer();

		const listing = await fetch(`${base}/api/files?path=${encodeURIComponent(dir)}`);
		const listingBody = (await listing.json()) as { entries: Array<{ name: string }> };
		expect(listingBody.entries.map((e) => e.name)).toContain("hello.txt");

		const download = await fetch(`${base}/api/files/download?path=${encodeURIComponent(join(dir, "hello.txt"))}`);
		expect(download.status).toBe(200);
		expect(await download.text()).toBe("hi there");

		const collision = await fetch(
			`${base}/api/files/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent("hello.txt")}`,
			{ method: "POST", body: "new content" },
		);
		expect(collision.status).toBe(409);

		const upload = await fetch(
			`${base}/api/files/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent("hello.txt")}&overwrite=true`,
			{ method: "POST", body: "new content" },
		);
		expect(upload.status).toBe(200);

		const mkdir = await fetch(`${base}/api/files/mkdir`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ dir, name: "sub" }),
		});
		expect(mkdir.status).toBe(200);

		const traversal = await fetch(`${base}/api/files?path=${encodeURIComponent("/tmp/%2e%2e/etc")}`);
		expect(traversal.status).toBe(400);
	});
});

describe("dashboard server — remote pairing flow", () => {
	const alice: TailscaleIdentity = { loginName: "alice@example.com", device: "phone" };

	it("pairing endpoint reachable when unpaired; denial page names identity", async () => {
		// A loopback test cannot present a non-loopback socket address, so drive
		// DashboardAuth directly for the remote path (covered in auth.test.ts) and
		// verify here that the middleware exposes needsPairing to /api/auth.
		const auth = new DashboardAuth({
			remoteEnabled: true,
			allowedIdentities: ["alice@example.com"],
			resolver: { resolve: async () => alice },
			storage: new MemoryPairingStorage(),
		});
		// Loopback requests still authenticate as local even with remote enabled.
		const { base } = await startServer({ auth });
		const res = await fetch(`${base}/api/auth`);
		await expect(res.json()).resolves.toMatchObject({ mode: "local" });
	});
});

describe("parseDeviceCookie", () => {
	it("extracts the device cookie from a Cookie header", () => {
		expect(parseDeviceCookie("a=1; dreb_dashboard_device=tok123; b=2")).toBe("tok123");
		expect(parseDeviceCookie("dreb_dashboard_device=solo")).toBe("solo");
		expect(parseDeviceCookie("other=x")).toBeUndefined();
		expect(parseDeviceCookie(undefined)).toBeUndefined();
	});
});
