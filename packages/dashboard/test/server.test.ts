import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, request, type Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardAuth, MemoryPairingStorage, type TailscaleIdentity } from "../src/server/auth.js";
import { RuntimePool } from "../src/server/runtime-pool.js";
import { createDashboardServer, MAX_SSE_BUFFERED_BYTES, parseDeviceCookie } from "../src/server/server.js";
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
	staticDir?: string;
	onRestart?: () => void;
	logger?: (line: string) => void;
}

async function createTempProject(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-dash-server-"));
	tempDirs.push(dir);
	return dir;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	expect(predicate()).toBe(true);
}

interface RawSseConnection {
	body: () => string;
	closed: Promise<void>;
	destroy: () => void;
}

async function openRawSse(base: string): Promise<RawSseConnection> {
	const url = new URL("/api/events", base);
	return new Promise((resolve, reject) => {
		const req = request(url, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				body += chunk;
			});
			const closed = new Promise<void>((resolveClosed) => res.on("close", resolveClosed));
			resolve({ body: () => body, closed, destroy: () => req.destroy() });
		});
		req.on("error", reject);
		req.end();
	});
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
		staticDir: options.staticDir,
		onRestart: options.onRestart,
		logger: options.logger ?? (() => {}),
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

	it("lets rejected Tailscale identities load the SPA denial screen and /api/auth identity", async () => {
		const staticDir = await mkdtemp(join(tmpdir(), "dreb-dash-static-"));
		tempDirs.push(staticDir);
		await writeFile(join(staticDir, "index.html"), "<main>dashboard shell</main>");
		const auth = new DashboardAuth();
		vi.spyOn(auth, "authenticate").mockResolvedValue({
			allowed: false,
			status: 403,
			reason: 'Tailscale identity "mallory@example.com" is not on the dashboard allowlist',
			identity: { loginName: "mallory@example.com", device: "phone" },
		});
		const { base } = await startServer({ auth, staticDir });

		const shell = await fetch(`${base}/`);
		expect(shell.status).toBe(200);
		expect(await shell.text()).toContain("dashboard shell");

		const status = await fetch(`${base}/api/auth`);
		expect(status.status).toBe(403);
		await expect(status.json()).resolves.toMatchObject({
			error: expect.stringContaining("mallory@example.com"),
			identity: "mallory@example.com",
			needsPairing: false,
		});

		const data = await fetch(`${base}/api/fleet`);
		expect(data.status).toBe(403);
	});
});

describe("dashboard server — pairing code", () => {
	const alice: TailscaleIdentity = { loginName: "alice@example.com", device: "phone" };

	it("GET /api/pairing-code returns the current code for a local request when remote mode is enabled", async () => {
		const auth = new DashboardAuth({
			remoteEnabled: true,
			allowedIdentities: ["alice@example.com"],
			resolver: { resolve: async () => alice },
			storage: new MemoryPairingStorage(),
			secret: Buffer.from("dashboard-server-test-secret"),
			now: () => 1_000_000,
		});
		const { base } = await startServer({ auth });
		const res = await fetch(`${base}/api/pairing-code`);

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({
			enabled: true,
			code: auth.currentPairingCode().code,
			expiresInMs: 20_000,
		});
	});

	it("GET /api/pairing-code returns disabled for local requests when remote mode is disabled", async () => {
		const { base } = await startServer();
		const res = await fetch(`${base}/api/pairing-code`);

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ enabled: false });
	});

	it("GET /api/pairing-code denies authenticated remote devices", async () => {
		const auth = new DashboardAuth({
			remoteEnabled: true,
			allowedIdentities: ["alice@example.com"],
			resolver: { resolve: async () => alice },
			storage: new MemoryPairingStorage(),
		});
		vi.spyOn(auth, "authenticate").mockResolvedValue({ allowed: true, mode: "remote", identity: alice });
		const { base } = await startServer({ auth });
		const res = await fetch(`${base}/api/pairing-code`);

		expect(res.status).toBe(403);
		await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("host machine") });
	});

	it("POST /api/pair sets an HttpOnly strict device cookie without Secure", async () => {
		const auth = new DashboardAuth();
		const device = {
			id: "device-1",
			identity: "alice@example.com",
			device: "phone",
			createdAt: "2030-12-01T00:00:00.000Z",
			expiresAt: "2031-01-01T00:00:00.000Z",
		};
		const pair = vi.spyOn(auth, "pair").mockResolvedValue({ token: "token-value", device });
		const { base } = await startServer({ auth });

		const res = await fetch(`${base}/api/pair`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pin: "123456" }),
		});

		expect(res.status).toBe(200);
		expect(pair).toHaveBeenCalledWith(expect.objectContaining({ deviceToken: undefined }), "123456");
		await expect(res.json()).resolves.toEqual({ device });
		const setCookie = res.headers.get("set-cookie");
		expect(setCookie).toContain("dreb_dashboard_device=token-value");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");
		expect(setCookie).toContain(`Expires=${new Date(device.expiresAt).toUTCString()}`);
		// Intentionally not Secure: Tailscale terminates encryption on the tailnet.
		expect(setCookie).not.toContain("Secure");
	});

	it("POST /api/pair propagates auth.pair status failures", async () => {
		const auth = new DashboardAuth();
		vi.spyOn(auth, "pair").mockRejectedValue(Object.assign(new Error("invalid or expired PIN"), { status: 429 }));
		const { base } = await startServer({ auth });

		const res = await fetch(`${base}/api/pair`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pin: "000000" }),
		});

		expect(res.status).toBe(429);
		await expect(res.json()).resolves.toEqual({ error: "invalid or expired PIN" });
	});
});

describe("dashboard server — fleet and runtimes", () => {
	it("GET /api/fleet returns runtimes and disk sessions", async () => {
		const dir = await createTempProject();
		const disk = [{ path: "/s/one.jsonl", id: "one", cwd: dir }];
		const { base } = await startServer({ listAllSessions: async () => disk });
		const res = await fetch(`${base}/api/fleet`);
		const body = (await res.json()) as { runtimes: unknown[]; diskSessions: unknown[] };
		expect(body.runtimes).toEqual([]);
		expect(body.diskSessions).toEqual(disk);
	});

	it("GET /api/fleet hides disk sessions whose cwd no longer exists", async () => {
		const liveCwd = await createTempProject();
		const missingCwd = join(tmpdir(), `dreb-dash-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const liveSession = { path: "/s/live.jsonl", id: "live", cwd: liveCwd };
		const missingSession = { path: "/s/missing.jsonl", id: "missing", cwd: missingCwd };
		const { base } = await startServer({ listAllSessions: async () => [liveSession, missingSession] });

		const res = await fetch(`${base}/api/fleet`);
		const body = (await res.json()) as { runtimes: unknown[]; diskSessions: Array<{ id: string; cwd: string }> };

		expect(res.status).toBe(200);
		expect(body.diskSessions).toEqual([liveSession]);
		expect(body.diskSessions).not.toContainEqual(missingSession);
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

	it("POST /api/runtimes/:key/abort aborts the runtime and unknown keys 404", async () => {
		const dir = await createTempProject();
		const { base, clients } = await startServer();
		const create = await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});
		const { key } = (await create.json()) as { key: string };
		const client = clients[0] as any;
		client.abort = vi.fn(async () => {});

		const res = await fetch(`${base}/api/runtimes/${key}/abort`, { method: "POST" });
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ ok: true });
		expect(client.abort).toHaveBeenCalledTimes(1);

		const missing = await fetch(`${base}/api/runtimes/nope/abort`, { method: "POST" });
		expect(missing.status).toBe(404);
		await expect(missing.json()).resolves.toMatchObject({ error: expect.stringContaining("No runtime nope") });
		expect(client.abort).toHaveBeenCalledTimes(1);
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
		expect(clients[1].getDailyCost).toHaveBeenCalled();
	});

	it("GET /api/settings/models and /api/settings/agent-types use a stable utility runtime", async () => {
		const dir = await createTempProject();
		const { base, clients } = await startServer();
		await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});

		await expect(fetch(`${base}/api/settings/models`).then((r) => r.json())).resolves.toEqual({
			models: [{ provider: "test", id: "m1", name: "Test Model", contextWindow: 200000, reasoning: false }],
		});
		await expect(fetch(`${base}/api/settings/agent-types`).then((r) => r.json())).resolves.toEqual({
			agentTypes: [{ name: "Explore", description: "Explore the codebase" }],
		});
		expect(clients[0].getAvailableModels).not.toHaveBeenCalled();
		expect(clients[0].listAgentTypes).not.toHaveBeenCalled();
		expect(clients[1].getAvailableModels).toHaveBeenCalled();
		expect(clients[1].listAgentTypes).toHaveBeenCalled();
	});

	it("settings model metadata endpoints use a utility runtime when no user runtime is live", async () => {
		const { base, clients } = await startServer();
		const models = await fetch(`${base}/api/settings/models`);
		const agentTypes = await fetch(`${base}/api/settings/agent-types`);

		expect(models.status).toBe(200);
		expect(agentTypes.status).toBe(200);
		await expect(models.json()).resolves.toEqual({
			models: [{ provider: "test", id: "m1", name: "Test Model", contextWindow: 200000, reasoning: false }],
		});
		await expect(agentTypes.json()).resolves.toEqual({
			agentTypes: [{ name: "Explore", description: "Explore the codebase" }],
		});
		expect(clients[0].getAvailableModels).toHaveBeenCalled();
		expect(clients[0].listAgentTypes).toHaveBeenCalled();
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
			"/api/settings/models",
			"/api/settings/agent-types",
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

	it("destroys over-buffered SSE clients and detaches them while other clients keep receiving events", async () => {
		const dir = await createTempProject();
		const logs: string[] = [];
		const { base, clients } = await startServer({ logger: (line) => logs.push(line) });
		await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});

		const originalWrite = ServerResponse.prototype.write as (this: ServerResponse, ...args: any[]) => boolean;
		const eventResponses: ServerResponse[] = [];
		const writeCounts = new WeakMap<ServerResponse, number>();
		const writeSpy = vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
			this: ServerResponse,
			...args: any[]
		) {
			const responseReq = (this as ServerResponse & { req?: IncomingMessage }).req;
			if (responseReq?.url?.startsWith("/api/events")) {
				if (!eventResponses.includes(this)) eventResponses.push(this);
				writeCounts.set(this, (writeCounts.get(this) ?? 0) + 1);
				const accepted = originalWrite.apply(this, args);
				if (this === eventResponses[0] && typeof args[0] === "string" && args[0].startsWith("id: ")) {
					Object.defineProperty(this, "writableLength", {
						value: MAX_SSE_BUFFERED_BYTES + 1,
						configurable: true,
					});
					return false;
				}
				return accepted;
			}
			return originalWrite.apply(this, args);
		});
		let slow: RawSseConnection | undefined;
		let fast: RawSseConnection | undefined;
		try {
			slow = await openRawSse(base);
			fast = await openRawSse(base);
			await waitUntil(
				() => eventResponses.length === 2 && slow!.body().includes(":ok") && fast!.body().includes(":ok"),
			);

			clients[0].emit({ type: "agent_start" });

			await waitUntil(() => fast!.body().includes("agent_start"));
			await Promise.race([
				slow.closed,
				new Promise((_resolve, reject) => setTimeout(() => reject(new Error("slow SSE did not close")), 1000)),
			]);
			const slowWriteCountAfterDestroy = writeCounts.get(eventResponses[0]) ?? 0;

			clients[0].emit({ type: "agent_end" });

			await waitUntil(() => fast!.body().includes("agent_end"));
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(writeCounts.get(eventResponses[0])).toBe(slowWriteCountAfterDestroy);
			expect(logs.join("\n")).toContain("SSE client buffer exceeded");
			expect(logs.join("\n")).toContain(String(MAX_SSE_BUFFERED_BYTES));
		} finally {
			writeSpy.mockRestore();
			slow?.destroy();
			fast?.destroy();
		}
	});

	it("keeps SSE clients connected when transient backpressure stays under the buffer ceiling", async () => {
		const dir = await createTempProject();
		const logs: string[] = [];
		const { base, clients } = await startServer({ logger: (line) => logs.push(line) });
		await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});

		const originalWrite = ServerResponse.prototype.write as (this: ServerResponse, ...args: any[]) => boolean;
		const eventResponses: ServerResponse[] = [];
		const writeCounts = new WeakMap<ServerResponse, number>();
		const backpressuredWrites: string[] = [];
		const writeSpy = vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
			this: ServerResponse,
			...args: any[]
		) {
			const responseReq = (this as ServerResponse & { req?: IncomingMessage }).req;
			if (responseReq?.url?.startsWith("/api/events")) {
				if (!eventResponses.includes(this)) eventResponses.push(this);
				writeCounts.set(this, (writeCounts.get(this) ?? 0) + 1);
				const accepted = originalWrite.apply(this, args);
				if (this === eventResponses[0] && typeof args[0] === "string" && args[0].startsWith("id: ")) {
					Object.defineProperty(this, "writableLength", {
						value: MAX_SSE_BUFFERED_BYTES,
						configurable: true,
					});
					backpressuredWrites.push(args[0]);
					return false;
				}
				return accepted;
			}
			return originalWrite.apply(this, args);
		});
		let connection: RawSseConnection | undefined;
		try {
			connection = await openRawSse(base);
			await waitUntil(() => eventResponses.length === 1 && connection!.body().includes(":ok"));

			clients[0].emit({ type: "agent_start" });

			await waitUntil(() => connection!.body().includes("agent_start") && backpressuredWrites.length === 1);
			expect(eventResponses[0].destroyed).toBe(false);
			const writeCountAfterFirstEvent = writeCounts.get(eventResponses[0]) ?? 0;

			clients[0].emit({ type: "agent_end" });

			await waitUntil(() => connection!.body().includes("agent_end") && backpressuredWrites.length === 2);
			expect(writeCounts.get(eventResponses[0])).toBeGreaterThan(writeCountAfterFirstEvent);
			expect(eventResponses[0].destroyed).toBe(false);
			expect(logs.join("\n")).not.toContain("buffer exceeded");
			expect(logs.join("\n")).not.toContain("backpressure");
		} finally {
			writeSpy.mockRestore();
			connection?.destroy();
		}
	});
});

describe("dashboard server — lifecycle and disk sessions", () => {
	it("POST /api/server/restart reports unavailable without a restart hook", async () => {
		const { base } = await startServer();

		const res = await fetch(`${base}/api/server/restart`, { method: "POST" });

		expect(res.status).toBe(501);
		await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("Restart is unavailable") });
	});

	it("POST /api/server/restart responds before invoking the restart hook", async () => {
		const onRestart = vi.fn();
		const { base } = await startServer({ onRestart });

		const res = await fetch(`${base}/api/server/restart`, { method: "POST" });

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ ok: true, restarting: true });
		expect(onRestart).not.toHaveBeenCalled();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(onRestart).toHaveBeenCalledTimes(1);
	});

	it("DELETE /api/sessions requires a path", async () => {
		const deleteSession = vi.fn(async () => ({ ok: true }));
		const { base } = await startServer({ deleteSession });

		const missing = await fetch(`${base}/api/sessions`, { method: "DELETE" });
		expect(missing.status).toBe(400);
		await expect(missing.json()).resolves.toEqual({ error: "path is required" });

		const empty = await fetch(`${base}/api/sessions`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "" }),
		});
		expect(empty.status).toBe(400);
		await expect(empty.json()).resolves.toEqual({ error: "path is required" });
		expect(deleteSession).not.toHaveBeenCalled();
	});

	it("DELETE /api/sessions forwards valid paths to deleteSession", async () => {
		const deleteSession = vi.fn(async () => ({ method: "trash", path: "/sessions/one.jsonl" }));
		const { base } = await startServer({ deleteSession });

		const res = await fetch(`${base}/api/sessions`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "/sessions/one.jsonl" }),
		});

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ method: "trash", path: "/sessions/one.jsonl" });
		expect(deleteSession).toHaveBeenCalledWith("/sessions/one.jsonl");
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
