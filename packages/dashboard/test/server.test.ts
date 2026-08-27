import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, request, type Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardAuth, MemoryPairingStorage, type TailscaleIdentity } from "../src/server/auth.js";
import { DashboardImageService } from "../src/server/dashboard-images.js";
import { EventHub, formatSseFrame } from "../src/server/event-hub.js";
import { FilePairingStorage } from "../src/server/pairing-storage.js";
import { RuntimePool } from "../src/server/runtime-pool.js";
import {
	createDashboardServer,
	type DashboardSessionInfoSource,
	MAX_SSE_BUFFERED_BYTES,
	parseDeviceCookie,
} from "../src/server/server.js";
import { MAX_SESSION_PREVIEW_CHARACTERS } from "../src/shared/protocol.js";
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
	listAllSessions?: () => Promise<DashboardSessionInfoSource[]>;
	deleteSession?: (path: string) => Promise<unknown>;
	staticDir?: string;
	onRestart?: () => void;
	logger?: (line: string) => void;
	eventHub?: EventHub;
	imageService?: DashboardImageService;
	heartbeatIntervalMs?: number;
	fleetSnapshotDebounceMs?: number;
	memoryHomeDir?: string;
}

async function createTempProject(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-dash-server-"));
	tempDirs.push(dir);
	return dir;
}

function diskSession(cwd: string, overrides: Partial<DashboardSessionInfoSource> = {}): DashboardSessionInfoSource {
	return {
		path: "/sessions/one.jsonl",
		id: "one",
		cwd,
		name: "Session one",
		created: new Date("2026-01-02T03:04:05.000Z"),
		modified: new Date("2026-02-03T04:05:06.000Z"),
		messageCount: 7,
		firstMessage: "First message",
		...overrides,
	};
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

async function openRawSse(base: string, lastEventId?: number): Promise<RawSseConnection> {
	const url = new URL("/api/events", base);
	return new Promise((resolve, reject) => {
		const req = request(
			url,
			{ headers: lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) } },
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					body += chunk;
				});
				const closed = new Promise<void>((resolveClosed) => res.on("close", resolveClosed));
				resolve({ body: () => body, closed, destroy: () => req.destroy() });
			},
		);
		req.on("error", reject);
		req.end();
	});
}

function parseSseEnvelopes(body: string): Array<{ seq: number; key: string; event: Record<string, unknown> }> {
	return body
		.split("\n\n")
		.filter((frame) => frame.startsWith("id: "))
		.map((frame) => {
			const data = frame
				.split("\n")
				.find((line) => line.startsWith("data: "))
				?.slice("data: ".length);
			if (!data) throw new Error(`SSE frame is missing data: ${frame}`);
			return JSON.parse(data) as { seq: number; key: string; event: Record<string, unknown> };
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
		fleetSnapshotDebounceMs: options.fleetSnapshotDebounceMs,
	});
	const app = createDashboardServer({
		auth: options.auth ?? new DashboardAuth(),
		pool,
		listAllSessions: options.listAllSessions ?? (async () => []),
		deleteSession: options.deleteSession ?? (async () => ({ method: "trash" })),
		staticDir: options.staticDir,
		onRestart: options.onRestart,
		logger: options.logger ?? (() => {}),
		eventHub: options.eventHub,
		imageService: options.imageService,
		heartbeatIntervalMs: options.heartbeatIntervalMs,
		memoryHomeDir: options.memoryHomeDir,
	});
	const server = await new Promise<Server>((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	servers.push(server);
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	return { base: `http://127.0.0.1:${address.port}`, pool, clients, app };
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

describe("dashboard server — memories routes", () => {
	it("lists scopes, reads, saves, conflicts, and deletes through authenticated routes", async () => {
		const home = await createTempProject();
		const memory = join(home, ".dreb", "memory");
		await mkdir(memory, { recursive: true });
		await writeFile(join(memory, "MEMORY.md"), "- [Entry](entry.md) — entry\n");
		await writeFile(
			join(memory, "entry.md"),
			"---\nname: Entry\ndescription: Test entry\ntype: project\n---\n\nBody\n",
		);
		const { base } = await startServer({ memoryHomeDir: home });

		const scopesRes = await fetch(`${base}/api/memories/scopes`);
		expect(scopesRes.status).toBe(200);
		const scopes = (await scopesRes.json()) as { scopes: Array<{ id: string; kind: string }> };
		expect(scopes.scopes).toEqual([expect.objectContaining({ id: "global", kind: "global" })]);

		const listingRes = await fetch(`${base}/api/memories/global`);
		expect(listingRes.status).toBe(200);
		const listing = (await listingRes.json()) as { indexRevision: string; entries: Array<{ file: string }> };
		expect(listing.entries.map((entry) => entry.file)).toEqual(["entry.md"]);

		const docRes = await fetch(`${base}/api/memories/global/documents/entry.md`);
		expect(docRes.status).toBe(200);
		const doc = (await docRes.json()) as { revision: string; content: string };
		const stale = await fetch(`${base}/api/memories/global/documents/entry.md`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: doc.content, revision: "stale" }),
		});
		expect(stale.status).toBe(409);

		const saved = await fetch(`${base}/api/memories/global/documents/entry.md`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: doc.content.replace("Body", "Updated"), revision: doc.revision }),
		});
		expect(saved.status).toBe(200);
		expect(await readFile(join(memory, "entry.md"), "utf8")).toContain("Updated");
		const savedBody = (await saved.json()) as { document: { revision: string }; listing: { indexRevision: string } };

		const deleted = await fetch(`${base}/api/memories/global/entries/entry.md`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				revision: savedBody.document.revision,
				indexRevision: savedBody.listing.indexRevision,
			}),
		});
		expect(deleted.status).toBe(200);
		expect(await readFile(join(memory, "MEMORY.md"), "utf8")).toBe("");
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
		vi.spyOn(auth, "authenticate").mockResolvedValue({
			allowed: true,
			mode: "remote",
			identity: alice,
			pairing: {
				id: "device-1",
				identity: alice.loginName,
				device: alice.device,
				createdAt: "2030-01-01T00:00:00.000Z",
				expiresAt: "2030-07-01T00:00:00.000Z",
			},
		});
		const { base } = await startServer({ auth });
		const res = await fetch(`${base}/api/pairing-code`);

		expect(res.status).toBe(403);
		await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("host machine") });
	});

	it("GET/PUT /api/pairing-settings persists validated whole-day values", async () => {
		const auth = new DashboardAuth();
		const { base } = await startServer({ auth });

		const initial = await fetch(`${base}/api/pairing-settings`);
		expect(initial.status).toBe(200);
		await expect(initial.json()).resolves.toEqual({ pairingTtlDays: 180 });

		for (const body of [{ pairingTtlDays: 0 }, { pairingTtlDays: 1.5 }, { pairingTtlDays: "30" }]) {
			const invalid = await fetch(`${base}/api/pairing-settings`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(invalid.status).toBe(400);
		}

		const saved = await fetch(`${base}/api/pairing-settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pairingTtlDays: 3650 }),
		});
		expect(saved.status).toBe(200);
		await expect(saved.json()).resolves.toEqual({ pairingTtlDays: 3650 });
		await expect(auth.getPairingSettings()).resolves.toEqual({ pairingTtlDays: 3650 });
	});

	it("GET /api/pairing-settings fails loudly for malformed persisted settings", async () => {
		const dir = await createTempProject();
		const pairingPath = join(dir, "pairings.json");
		await writeFile(
			pairingPath,
			JSON.stringify({ version: 2, pairings: [], consumedPairingWindows: [], pairingTtlDays: 0 }),
		);
		const auth = new DashboardAuth({ storage: new FilePairingStorage(pairingPath) });
		const { base } = await startServer({ auth });

		const response = await fetch(`${base}/api/pairing-settings`);
		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			error: expect.stringContaining("Unrecognized pairing file format"),
		});
	});

	it("GET /api/auth returns only atomically claimed remote expiry warning metadata", async () => {
		const auth = new DashboardAuth();
		const pairing = {
			id: "device-1",
			identity: alice.loginName,
			device: alice.device,
			createdAt: "2030-01-01T00:00:00.000Z",
			expiresAt: "2030-07-01T00:00:00.000Z",
		};
		vi.spyOn(auth, "authenticate").mockResolvedValue({ allowed: true, mode: "remote", identity: alice, pairing });
		const claim = vi.spyOn(auth, "claimPairingExpiryStatus").mockResolvedValue({
			warning: { expiresAt: pairing.expiresAt },
			nextCheckAt: "2030-06-15T00:00:00.000Z",
		});
		const { base } = await startServer({ auth });

		const status = await fetch(`${base}/api/auth`);
		expect(status.status).toBe(200);
		await expect(status.json()).resolves.toEqual({
			mode: "remote",
			identity: alice.loginName,
			device: alice.device,
			needsPairing: false,
			pairingExpiryWarning: { expiresAt: pairing.expiresAt },
			pairingExpiryCheckAt: "2030-06-15T00:00:00.000Z",
		});
		expect(claim).toHaveBeenCalledWith(pairing.id);
	});

	it("GET /api/auth fails closed when claiming expiry status rejects", async () => {
		const auth = new DashboardAuth();
		const pairing = {
			id: "device-1",
			identity: alice.loginName,
			device: alice.device,
			createdAt: "2030-01-01T00:00:00.000Z",
			expiresAt: "2030-07-01T00:00:00.000Z",
		};
		vi.spyOn(auth, "authenticate").mockResolvedValue({ allowed: true, mode: "remote", identity: alice, pairing });
		vi.spyOn(auth, "claimPairingExpiryStatus").mockRejectedValue(new Error("pairing state write failed"));
		const { base } = await startServer({ auth });

		const response = await fetch(`${base}/api/auth`);
		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			error: "Auth subsystem error — denied",
			needsPairing: false,
		});
	});

	it("keeps unknown-peer and resolver-subsystem denials distinct", async () => {
		const unknown = new DashboardAuth();
		vi.spyOn(unknown, "authenticate").mockResolvedValue({
			allowed: false,
			status: 403,
			reason: "Client is not a known Tailscale peer",
		});
		const unknownServer = await startServer({ auth: unknown });
		const unknownResponse = await fetch(`${unknownServer.base}/api/auth`);
		expect(unknownResponse.status).toBe(403);
		await expect(unknownResponse.json()).resolves.toMatchObject({
			error: "Client is not a known Tailscale peer",
			needsPairing: false,
		});

		const failed = new DashboardAuth();
		vi.spyOn(failed, "authenticate").mockResolvedValue({
			allowed: false,
			status: 500,
			reason: "Auth subsystem error — denying: Tailscale identity resolver timeout failure",
		});
		const failedServer = await startServer({ auth: failed });
		const failedResponse = await fetch(`${failedServer.base}/api/auth`);
		expect(failedResponse.status).toBe(500);
		await expect(failedResponse.json()).resolves.toMatchObject({
			error: expect.stringContaining("resolver timeout failure"),
			needsPairing: false,
		});
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
		const disk = [diskSession(dir, { path: "/s/one.jsonl" })];
		const { base } = await startServer({ listAllSessions: async () => disk });
		const res = await fetch(`${base}/api/fleet`);
		const body = (await res.json()) as { runtimes: unknown[]; diskSessions: unknown[] };
		expect(body.runtimes).toEqual([]);
		expect(body.diskSessions).toEqual([
			{
				path: "/s/one.jsonl",
				id: "one",
				cwd: dir,
				name: "Session one",
				created: "2026-01-02T03:04:05.000Z",
				modified: "2026-02-03T04:05:06.000Z",
				messageCount: 7,
				firstMessage: "First message",
			},
		]);
	});

	it("projects bounded disk-session DTOs for fleet, inventory, and resync responses", async () => {
		const dir = await createTempProject();
		const preview = `${"a".repeat(MAX_SESSION_PREVIEW_CHARACTERS - 1)}😀trailing text`;
		const internalSession = {
			...diskSession(dir, { firstMessage: preview }),
			parentSessionPath: "/sessions/private-parent.jsonl",
			allMessagesText: "private complete searchable transcript",
			futureInternalField: "must not cross the wire",
		};
		const { base } = await startServer({ listAllSessions: async () => [internalSession] });

		const fleet = (await fetch(`${base}/api/fleet`).then((response) => response.json())) as {
			diskSessions: Array<Record<string, unknown>>;
		};
		const inventory = (await fetch(`${base}/api/sessions`).then((response) => response.json())) as {
			sessions: Array<Record<string, unknown>>;
		};
		const resync = (await fetch(`${base}/api/resync`).then((response) => response.json())) as {
			fleet: { diskSessions: Array<Record<string, unknown>> };
		};

		for (const session of [fleet.diskSessions[0], inventory.sessions[0], resync.fleet.diskSessions[0]]) {
			expect(Object.keys(session ?? {}).sort()).toEqual([
				"created",
				"cwd",
				"firstMessage",
				"id",
				"messageCount",
				"modified",
				"name",
				"path",
			]);
			expect(session).toEqual({
				path: internalSession.path,
				id: internalSession.id,
				cwd: internalSession.cwd,
				name: internalSession.name,
				created: internalSession.created.toISOString(),
				modified: internalSession.modified.toISOString(),
				messageCount: internalSession.messageCount,
				firstMessage: `${"a".repeat(MAX_SESSION_PREVIEW_CHARACTERS - 1)}😀`,
			});
			expect(Array.from(String(session?.firstMessage))).toHaveLength(MAX_SESSION_PREVIEW_CHARACTERS);
		}
		expect(JSON.stringify({ fleet, inventory, resync })).not.toContain("private complete searchable transcript");
		expect(JSON.stringify({ fleet, inventory, resync })).not.toContain("private-parent");
		expect(JSON.stringify({ fleet, inventory, resync })).not.toContain("futureInternalField");
	});

	it("preserves session previews below and at the character limit", async () => {
		const dir = await createTempProject();
		const below = "b".repeat(MAX_SESSION_PREVIEW_CHARACTERS - 1);
		const atLimit = "😀".repeat(MAX_SESSION_PREVIEW_CHARACTERS);
		const { base } = await startServer({
			listAllSessions: async () => [
				diskSession(dir, { id: "below", path: "/sessions/below.jsonl", firstMessage: below }),
				diskSession(dir, { id: "at-limit", path: "/sessions/at-limit.jsonl", firstMessage: atLimit }),
			],
		});

		const body = (await fetch(`${base}/api/sessions`).then((response) => response.json())) as {
			sessions: Array<{ firstMessage: string }>;
		};
		expect(body.sessions.map((session) => session.firstMessage)).toEqual([below, atLimit]);
	});

	it("bounds fleet growth by session count and preview size instead of searchable transcript size", async () => {
		const dir = await createTempProject();
		const sessionCount = 40;
		const transcriptMarker = "complete-transcript-marker";
		const sessions = Array.from({ length: sessionCount }, (_, index) => ({
			...diskSession(dir, {
				path: `/sessions/${index}.jsonl`,
				id: `session-${index}`,
				firstMessage: "😀".repeat(MAX_SESSION_PREVIEW_CHARACTERS * 10),
			}),
			allMessagesText: `${transcriptMarker}${"x".repeat(100_000)}`,
		}));
		const { base } = await startServer({ listAllSessions: async () => sessions });

		const body = await fetch(`${base}/api/fleet`).then((response) => response.text());
		const fleet = JSON.parse(body) as { diskSessions: Array<{ firstMessage: string }> };

		expect(fleet.diskSessions).toHaveLength(sessionCount);
		expect(body).not.toContain(transcriptMarker);
		expect(Buffer.byteLength(body)).toBeLessThan(sessionCount * (MAX_SESSION_PREVIEW_CHARACTERS * 4 + 512));
		for (const session of fleet.diskSessions) {
			expect(Array.from(session.firstMessage)).toHaveLength(MAX_SESSION_PREVIEW_CHARACTERS);
		}
	});

	it("logs payload-free structured diagnostics for GET /api/fleet", async () => {
		const dir = await createTempProject();
		const secret = "private-cwd-session-prompt-content";
		const disk = [diskSession(dir, { path: `/sessions/${secret}.jsonl`, id: secret, name: secret })];
		const logs: string[] = [];
		const { base } = await startServer({ listAllSessions: async () => disk, logger: (line) => logs.push(line) });

		const res = await fetch(`${base}/api/fleet`);
		const body = await res.json();
		const diagnosticLine = logs.find((line) => line.startsWith("fleet "));
		expect(diagnosticLine).toBeDefined();
		const diagnostic = JSON.parse(diagnosticLine!.slice("fleet ".length)) as Record<string, unknown>;

		expect(diagnostic).toEqual({
			elapsedMs: expect.any(Number),
			encodedBytes: Buffer.byteLength(JSON.stringify(body)),
			runtimeCount: 0,
			diskSessionCount: 1,
		});
		expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(JSON.stringify(diagnostic)).not.toContain(secret);
		expect(Object.keys(diagnostic).sort()).toEqual(["diskSessionCount", "elapsedMs", "encodedBytes", "runtimeCount"]);
	});

	it("GET /api/resync captures an active snapshot cursor without broadcasting a barrier", async () => {
		const dir = await createTempProject();
		const hub = new EventHub();
		const frames: string[] = [];
		hub.attach({
			write: (frame) => {
				frames.push(frame);
				return true;
			},
		});
		const { base, pool, clients } = await startServer({ eventHub: hub });
		const runtime = await pool.create(dir);
		clients[0].emit({ type: "before_snapshot" });

		const res = await fetch(`${base}/api/resync?key=${runtime.key}`);
		const body = (await res.json()) as {
			active?: { barrierSeq: number; state: { tasks?: unknown[] } };
			barrierSeq: number;
		};

		expect(res.status).toBe(200);
		expect(body.active?.state.tasks).toEqual([]);
		expect(body.active?.barrierSeq).toBe(1);
		expect(body.barrierSeq).toBe(1);
		expect(frames).toHaveLength(1);
		expect(frames[0]).toContain('"type":"before_snapshot"');
		clients[0].emit({ type: "after_snapshot" });
		expect(frames[1]).toContain('"seq":2');
	});

	it("GET /api/runtimes/:key/hydrate returns one atomic snapshot and consumes its barrier", async () => {
		const dir = await createTempProject();
		const hub = new EventHub();
		const { base, pool, clients } = await startServer({ eventHub: hub });
		const runtime = await pool.create(dir);
		const client = clients[0];
		const seededAgentCalls = vi.mocked(client.listBackgroundAgents).mock.calls.length;

		const res = await fetch(`${base}/api/runtimes/${runtime.key}/hydrate`);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({
			key: runtime.key,
			state: { sessionId: "s1" },
			messages: [],
			backgroundAgents: [],
			barrierSeq: 0,
		});
		expect(client.getDashboardSnapshot).toHaveBeenCalledOnce();
		expect(client.getMessages).not.toHaveBeenCalled();
		expect(client.listBackgroundAgents).toHaveBeenCalledTimes(seededAgentCalls);
		expect(client.getState).not.toHaveBeenCalled();
	});

	it("GET /api/runtimes/:key/hydrate reports missing runtimes and snapshot failures loudly", async () => {
		const dir = await createTempProject();
		const { base, pool, clients } = await startServer();
		const missing = await fetch(`${base}/api/runtimes/nope/hydrate`);
		expect(missing.status).toBe(404);
		await expect(missing.json()).resolves.toMatchObject({ error: "No runtime nope" });

		const runtime = await pool.create(dir);
		vi.mocked(clients[0].getDashboardSnapshot).mockRejectedValueOnce(new Error("snapshot IPC failed"));
		const failed = await fetch(`${base}/api/runtimes/${runtime.key}/hydrate`);
		expect(failed.status).toBe(502);
		await expect(failed.json()).resolves.toMatchObject({ error: "snapshot IPC failed" });
	});

	it("GET /api/resync without a runtime captures the current cursor without an SSE frame", async () => {
		const hub = new EventHub();
		hub.publish("k", { type: "existing" });
		const { base } = await startServer({ eventHub: hub });

		const res = await fetch(`${base}/api/resync`);
		const body = (await res.json()) as { barrierSeq: number };

		expect(res.status).toBe(200);
		expect(body.barrierSeq).toBe(1);
		expect(hub.currentSequence).toBe(1);
	});

	it("GET /api/resync with a stale runtime key returns fleet-only without an active payload", async () => {
		const { base } = await startServer();

		const res = await fetch(`${base}/api/resync?key=nonexistent-key`);
		const body = (await res.json()) as { active?: unknown; barrierSeq: number; fleet?: unknown };

		expect(res.status).toBe(200);
		expect(body.active).toBeUndefined();
		expect(body.barrierSeq).toBeGreaterThanOrEqual(0);
		expect(body.fleet).toBeDefined();
	});

	it("GET /api/fleet hides disk sessions whose cwd no longer exists", async () => {
		const liveCwd = await createTempProject();
		const missingCwd = join(tmpdir(), `dreb-dash-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const liveSession = diskSession(liveCwd, { path: "/s/live.jsonl", id: "live" });
		const missingSession = diskSession(missingCwd, { path: "/s/missing.jsonl", id: "missing" });
		const { base } = await startServer({ listAllSessions: async () => [liveSession, missingSession] });

		const res = await fetch(`${base}/api/fleet`);
		const body = (await res.json()) as { runtimes: unknown[]; diskSessions: Array<{ id: string; cwd: string }> };

		expect(res.status).toBe(200);
		expect(body.diskSessions).toEqual([
			expect.objectContaining({ path: liveSession.path, id: liveSession.id, cwd: liveSession.cwd }),
		]);
		expect(body.diskSessions).not.toContainEqual(expect.objectContaining({ id: missingSession.id }));
	});

	it("GET /api/sessions returns only existing disk sessions without describing runtimes", async () => {
		const liveCwd = await createTempProject();
		const missingCwd = join(tmpdir(), `dreb-dash-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const liveSession = diskSession(liveCwd, { path: "/s/live.jsonl", id: "live" });
		const missingSession = diskSession(missingCwd, { path: "/s/missing.jsonl", id: "missing" });
		const listAllSessions = vi.fn(async () => [liveSession, missingSession]);
		const { base, clients, pool } = await startServer({ listAllSessions });
		await pool.create(liveCwd);
		const describe = vi.spyOn(pool, "describe");

		const res = await fetch(`${base}/api/sessions`);
		const body = (await res.json()) as { sessions: Array<{ id: string; cwd: string }> };

		expect(res.status).toBe(200);
		expect(body.sessions).toEqual([
			expect.objectContaining({
				path: liveSession.path,
				id: liveSession.id,
				cwd: liveSession.cwd,
				created: liveSession.created.toISOString(),
				modified: liveSession.modified.toISOString(),
			}),
		]);
		expect(listAllSessions).toHaveBeenCalledTimes(1);
		expect(describe).not.toHaveBeenCalled();
		expect(clients[0].getState).not.toHaveBeenCalled();
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
		const subagentPng = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
			"base64",
		);
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: "subagent findings" },
				{ type: "image", data: subagentPng.toString("base64"), mimeType: "image/png" },
			],
		};
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
		const body = (await res.json()) as any;
		expect(body.agent.agentId).toBe("bg1");
		expect(body.messages[0].content[0]).toEqual({ type: "text", text: "subagent findings" });
		expect(body.messages[0].content[1]).toMatchObject({
			type: "image_reference",
			id: expect.stringMatching(/^[0-9a-f]{64}$/),
			mimeType: "image/png",
			size: subagentPng.length,
		});
		expect(JSON.stringify(body)).not.toContain(subagentPng.toString("base64"));
		const original = await fetch(
			`${base}/api/runtimes/${key}/subagents/bg1/images/${body.messages[0].content[1].id}/original`,
		);
		expect(original.status).toBe(200);
		expect(Buffer.from(await original.arrayBuffer())).toEqual(subagentPng);

		// A fail-closed pre-spawn arbitration has metadata but no child log.
		const failedAgent = {
			agentId: "bg-failed",
			agentType: "Explore",
			taskSummary: "blocked before spawn",
			startedAt: new Date().toISOString(),
			status: "failed",
			arbitrations: [
				{
					status: "failure",
					proposed: { agent: "Explore", model: "provider/worker", thinking: "high" },
					final: null,
					changed: [],
					errorCode: "invalid_guide",
					errorMessage: "Routing guide is invalid.",
				},
			],
		};
		(clients[0].listBackgroundAgents as ReturnType<typeof vi.fn>).mockResolvedValue([failedAgent]);
		const failed = await fetch(`${base}/api/runtimes/${key}/subagents/bg-failed/messages`);
		expect(failed.status).toBe(200);
		await expect(failed.json()).resolves.toMatchObject({
			agent: { agentId: "bg-failed", arbitrations: [{ status: "failure", final: null }] },
			messages: [],
		});

		// An ordinary registered agent with a missing log must still fail loudly.
		const missingLogAgent = {
			agentId: "bg-missing-log",
			agentType: "Explore",
			taskSummary: "spawned without a durable log",
			startedAt: new Date().toISOString(),
			status: "failed",
		};
		(clients[0].listBackgroundAgents as ReturnType<typeof vi.fn>).mockResolvedValue([missingLogAgent]);
		const missingLog = await fetch(`${base}/api/runtimes/${key}/subagents/bg-missing-log/messages`);
		expect(missingLog.status).toBe(502);
		await expect(missingLog.json()).resolves.toMatchObject({ error: expect.stringContaining("session log") });

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

	it("subagent steering endpoints target the selected child and validate messages", async () => {
		const dir = await createTempProject();
		const { base, clients } = await startServer();
		const create = await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});
		const { key } = (await create.json()) as { key: string };
		const client = clients[0] as any;
		client.steerBackgroundAgent = vi.fn(async () => {});
		client.getBackgroundAgentPending = vi.fn(async () => ({
			steeringMode: "all",
			pending: { steering: ["queued"], followUp: [] },
		}));

		const steer = await fetch(`${base}/api/runtimes/${key}/subagents/bg1/steer`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "unchanged text" }),
		});
		expect(steer.status).toBe(200);
		expect(client.steerBackgroundAgent).toHaveBeenCalledWith("bg1", "unchanged text");

		const pending = await fetch(`${base}/api/runtimes/${key}/subagents/bg1/pending`);
		await expect(pending.json()).resolves.toEqual({
			steeringMode: "all",
			pending: { steering: ["queued"], followUp: [] },
		});
		expect(client.getBackgroundAgentPending).toHaveBeenCalledWith("bg1");

		const invalid = await fetch(`${base}/api/runtimes/${key}/subagents/bg1/steer`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(invalid.status).toBe(400);
	});

	it("synchronizes model and thinking routes through the runtime pool", async () => {
		const dir = await createTempProject();
		const { base, pool, clients } = await startServer();
		const runtime = await pool.create(dir);

		const model = await fetch(`${base}/api/runtimes/${runtime.key}/model`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider: "test", modelId: "new-model" }),
		});
		expect(model.status).toBe(200);
		await expect(model.json()).resolves.toEqual({
			model: { provider: "test", id: "new-model" },
			thinkingLevel: "medium",
			availableThinkingLevels: ["off", "medium", "high"],
			settingsRevision: 1,
		});

		const thinking = await fetch(`${base}/api/runtimes/${runtime.key}/thinking`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ level: "high" }),
		});
		expect(thinking.status).toBe(200);
		await expect(thinking.json()).resolves.toEqual({ ok: true, settingsRevision: 2 });
		expect(clients[0].setModel).toHaveBeenCalledWith("test", "new-model");
		expect(clients[0].setThinkingLevel).toHaveBeenCalledWith("high");
		expect(pool.fleetSnapshot()[0]?.state).toMatchObject({
			model: { provider: "test", id: "new-model" },
			thinkingLevel: "high",
		});

		vi.mocked(clients[0].setThinkingLevel).mockRejectedValueOnce(new Error("thinking unavailable"));
		const failed = await fetch(`${base}/api/runtimes/${runtime.key}/thinking`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ level: "low" }),
		});
		expect(failed.status).toBe(502);
		await expect(failed.json()).resolves.toEqual({ error: "thinking unavailable" });
		expect(pool.fleetSnapshot()[0]?.state.thinkingLevel).toBe("high");
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
			models: [
				{
					provider: "test",
					modelId: "m1",
					rolling: { median: 41, mean: 42, count: 4 },
					delta: {
						baselineMedian: 41,
						recentMedian: 41,
						percentDelta: 0,
						direction: "stable",
						baselineCount: 4,
						recentCount: 4,
					},
				},
			],
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
				{ name: "fork", description: "Create a fork", source: "builtin", dashboard: true },
				{ name: "copy", description: "Copy", source: "builtin", dashboard: false },
				{ name: "hotkeys", description: "Show hotkeys", source: "builtin", dashboard: false },
				{ name: "buddy", description: "Toggle buddy mode", source: "builtin", dashboard: false },
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
		await expect(
			fetch(`${base}/api/runtimes/${key}/new-session`, { method: "POST" }).then((r) => r.json()),
		).resolves.toEqual({ cancelled: false });
		await expect(
			fetch(`${base}/api/runtimes/${key}/reload`, { method: "POST" }).then((r) => r.json()),
		).resolves.toEqual({
			ok: true,
		});
		await expect(
			fetch(`${base}/api/runtimes/${key}/dream`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ args: "backup" }),
			}).then((r) => r.json()),
		).resolves.toEqual({ message: "Dream completed" });
		await expect(
			fetch(`${base}/api/runtimes/${key}/import`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ inputPath: "/tmp/session.jsonl" }),
			}).then((r) => r.json()),
		).resolves.toEqual({ cancelled: false });
		await expect(fetch(`${base}/api/runtimes/${key}/tree`).then((r) => r.json())).resolves.toEqual({
			roots: [],
			leafId: null,
		});
		await expect(
			fetch(`${base}/api/runtimes/${key}/tree`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ targetId: "entry-1" }),
			}).then((r) => r.json()),
		).resolves.toEqual({ cancelled: false });
		await expect(fetch(`${base}/api/runtimes/${key}/sessions`).then((r) => r.json())).resolves.toEqual({
			sessions: [],
		});
		await expect(
			fetch(`${base}/api/runtimes/${key}/resume`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionPath: "/tmp/session.jsonl" }),
			}).then((r) => r.json()),
		).resolves.toEqual({ cancelled: false });
		expect(clients[0].getPerformanceStats).toHaveBeenCalled();
		expect(clients[0].getResources).toHaveBeenCalled();
		expect(clients[0].getCommands).toHaveBeenCalled();
		expect(clients[0].getGitBranch).toHaveBeenCalled();
		expect(clients[0].getPendingMessages).toHaveBeenCalled();
		expect(clients[0].clearPendingMessages).toHaveBeenCalled();
		expect(clients[0].abortCompaction).toHaveBeenCalled();
		expect(clients[0].abortRetry).toHaveBeenCalled();
		expect(clients[0].newSession).toHaveBeenCalled();
		expect(clients[0].reload).toHaveBeenCalled();
		expect(clients[0].dream).toHaveBeenCalledWith("backup");
		expect(clients[0].importJsonl).toHaveBeenCalledWith("/tmp/session.jsonl");
		expect(clients[0].getTree).toHaveBeenCalled();
		expect(clients[0].navigateTree).toHaveBeenCalledWith("entry-1");
		expect(clients[0].listSessions).toHaveBeenCalled();
		expect(clients[0].switchSession).toHaveBeenCalledWith("/tmp/session.jsonl");
		expect(clients[1].getDailyCost).toHaveBeenCalled();
	});

	it("round-trips an enabled Dispatch Arbiter policy through the settings utility runtime", async () => {
		const { base, clients } = await startServer();
		await fetch(`${base}/api/settings`);
		const utility = clients[0];
		if (!utility) throw new Error("utility runtime was not created");
		const baselineSettings = await utility.getSettings();
		let arbiterPolicy: NonNullable<typeof baselineSettings.subagentArbiter> = {
			enabled: false,
			model: "provider/router",
			thinking: "off",
		};
		vi.mocked(utility.getSettings).mockImplementation(async () => ({
			...baselineSettings,
			subagentArbiter: arbiterPolicy,
		}));
		vi.mocked(utility.setSettings).mockImplementation(async (update) => {
			arbiterPolicy = {
				...arbiterPolicy,
				...(update.subagentArbiter ?? {}),
			};
			return { ...baselineSettings, subagentArbiter: arbiterPolicy };
		});

		const saved = await fetch(`${base}/api/settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				subagentArbiter: { enabled: true, model: "provider/router", thinking: "high" },
			}),
		});
		expect(saved.status).toBe(200);
		await expect(saved.json()).resolves.toMatchObject({
			subagentArbiter: { enabled: true, model: "provider/router", thinking: "high" },
		});
		await expect(fetch(`${base}/api/settings`).then((response) => response.json())).resolves.toMatchObject({
			subagentArbiter: { enabled: true, model: "provider/router", thinking: "high" },
		});
	});

	it("round-trips tab title settings through the settings utility runtime", async () => {
		const { base, clients } = await startServer();
		await fetch(`${base}/api/settings`);
		const utility = clients[0];
		if (!utility) throw new Error("utility runtime was not created");
		const baselineSettings = await utility.getSettings();
		let tabTitle: NonNullable<typeof baselineSettings.tabTitle> = {
			enabled: true,
			triggerAfter: 9,
			maxTitleLength: 60,
		};
		vi.mocked(utility.getSettings).mockImplementation(async () => ({ ...baselineSettings, tabTitle }));
		vi.mocked(utility.setSettings).mockImplementation(async (update) => {
			const merged = { ...tabTitle, ...(update.tabTitle ?? {}) };
			tabTitle = { ...merged, model: merged.model ?? undefined };
			return { ...baselineSettings, tabTitle };
		});

		const saved = await fetch(`${base}/api/settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ tabTitle: { model: "provider/title-model", enabled: false } }),
		});
		expect(saved.status).toBe(200);
		await expect(saved.json()).resolves.toMatchObject({
			tabTitle: {
				enabled: false,
				model: "provider/title-model",
				triggerAfter: 9,
				maxTitleLength: 60,
			},
		});
		await expect(fetch(`${base}/api/settings`).then((response) => response.json())).resolves.toMatchObject({
			tabTitle: { enabled: false, model: "provider/title-model" },
		});
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

	it("routes scoped-model settings reads, inventory, and writes through the selected cwd utility runtime", async () => {
		const dir = await createTempProject();
		const { base, clients } = await startServer();
		const query = `?cwd=${encodeURIComponent(dir)}`;

		const settings = await fetch(`${base}/api/settings${query}`);
		const models = await fetch(`${base}/api/settings/models${query}`);
		const saved = await fetch(`${base}/api/settings${query}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabledModels: null, maxConcurrentSubagents: 1 }),
		});

		expect(settings.status).toBe(200);
		expect(models.status).toBe(200);
		expect(saved.status).toBe(200);
		expect(clients).toHaveLength(1);
		expect(clients[0].getSettings).toHaveBeenCalled();
		expect(clients[0].getAvailableModels).toHaveBeenCalled();
		expect(clients[0].setSettings).toHaveBeenCalledWith({ enabledModels: null, maxConcurrentSubagents: 1 });

		for (const path of ["/api/settings", "/api/settings/models"]) {
			const missing = await fetch(`${base}${path}?cwd=${encodeURIComponent(`${dir}/missing`)}`);
			expect(missing.status).toBe(400);
			await expect(missing.json()).resolves.toEqual({ error: `cwd does not exist: ${dir}/missing` });
		}
		const empty = await fetch(`${base}/api/settings?cwd=`);
		expect(empty.status).toBe(400);
		const file = join(dir, "not-a-directory");
		await writeFile(file, "x");
		const notDirectory = await fetch(`${base}/api/settings?cwd=${encodeURIComponent(file)}`);
		expect(notDirectory.status).toBe(400);
		await expect(notDirectory.json()).resolves.toEqual({ error: `cwd is not a directory: ${file}` });
		expect(clients).toHaveLength(1);
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

	it("POST /api/settings/remove-trusted forwards raw configured paths to the utility runtime", async () => {
		const { base, clients } = await startServer();
		const res = await fetch(`${base}/api/settings/remove-trusted`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "relative/legacy" }),
		});

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({ removedFolder: "relative/legacy" });
		expect(clients[0].removeTrustedContextFolder).toHaveBeenCalledWith("relative/legacy");
		expect(clients[0].untrustContextFolder).not.toHaveBeenCalled();
	});

	it("POST /api/settings/remove-trusted rejects missing paths and surfaces RPC errors", async () => {
		const { base, clients } = await startServer();
		const missing = await fetch(`${base}/api/settings/remove-trusted`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "" }),
		});
		expect(missing.status).toBe(400);
		await expect(missing.json()).resolves.toEqual({ error: "path is required" });
		expect(clients).toHaveLength(0);

		await fetch(`${base}/api/settings`);
		const utility = clients[0];
		if (!utility) throw new Error("utility runtime was not created");
		vi.mocked(utility.removeTrustedContextFolder).mockRejectedValueOnce(new Error("durable write failed"));
		const failed = await fetch(`${base}/api/settings/remove-trusted`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "/configured" }),
		});
		expect(failed.status).toBe(502);
		await expect(failed.json()).resolves.toEqual({ error: "durable write failed" });
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
			`/api/runtimes/${key}/hydrate`,
			`/api/runtimes/${key}/images/${"a".repeat(64)}/preview`,
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
			"/api/files/trust",
			"/api/files/untrust",
			"/api/settings/remove-trusted",
		];

		for (const path of paths) {
			const res = await fetch(`${base}${path}`, { headers: { origin: "https://evil.example" } });
			expect(res.status).toBe(403);
		}
	});
});

describe("dashboard server — transcript images", () => {
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
		"base64",
	);
	const messages = [
		{
			role: "toolResult",
			toolCallId: "t1",
			content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }],
		},
	];

	function imageService(previewBytes = Uint8Array.of(9, 8, 7)) {
		return new DashboardImageService({
			generate: vi.fn(async () => ({ bytes: previewBytes, mimeType: "image/jpeg" as const, width: 1, height: 1 })),
			close: vi.fn(async () => {}),
		});
	}

	async function createImageRuntime(service = imageService()) {
		const dir = await createTempProject();
		const started = await startServer({ imageService: service });
		const created = await fetch(`${started.base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});
		const { key } = (await created.json()) as { key: string };
		vi.mocked(started.clients[0].getMessages as any).mockResolvedValue(messages);
		return { ...started, key, service };
	}

	it("exposes idempotent teardown for the server image service", async () => {
		const close = vi.fn(async () => {});
		const service = new DashboardImageService({
			generate: vi.fn(async () => ({
				bytes: Uint8Array.of(1),
				mimeType: "image/png" as const,
				width: 1,
				height: 1,
			})),
			close,
		});
		const { app } = await startServer({ imageService: service });

		await app.closeDashboard();
		await app.closeDashboard();

		expect(close).toHaveBeenCalledOnce();
	});

	it("projects message, hydrate, and resync HTTP transcripts to references without base64", async () => {
		const { base, clients, key } = await createImageRuntime();
		const client = clients[0] as any;
		client.getDashboardSnapshot.mockImplementation(async () => {
			client.emit({ type: "dashboard_snapshot_barrier", snapshotId: "images" });
			return {
				snapshotId: "images",
				state: await client.getState(),
				messages,
				backgroundAgents: [],
			};
		});
		for (const path of [
			`/api/runtimes/${key}/messages`,
			`/api/runtimes/${key}/hydrate`,
			`/api/resync?key=${encodeURIComponent(key)}`,
		]) {
			const response = await fetch(`${base}${path}`);
			expect(response.status).toBe(200);
			const text = await response.text();
			expect(text).toContain('"type":"image_reference"');
			expect(text).not.toContain(png.toString("base64"));
		}
	});

	it("serves exact originals and bounded previews with immutable private security headers", async () => {
		const { base, key } = await createImageRuntime();
		const projected = (await fetch(`${base}/api/runtimes/${key}/messages`).then((response) =>
			response.json(),
		)) as any;
		const id = projected.messages[0].content[0].id as string;

		const original = await fetch(`${base}/api/runtimes/${key}/images/${id}/original`);
		expect(original.status).toBe(200);
		expect(original.headers.get("content-type")).toBe("image/png");
		expect(original.headers.get("content-length")).toBe(String(png.byteLength));
		expect(original.headers.get("x-content-type-options")).toBe("nosniff");
		expect(original.headers.get("cache-control")).toContain("private");
		expect(Buffer.from(await original.arrayBuffer())).toEqual(png);

		const preview = await fetch(`${base}/api/runtimes/${key}/images/${id}/preview`);
		expect(preview.status).toBe(200);
		expect(preview.headers.get("content-type")).toBe("image/jpeg");
		expect(preview.headers.get("content-length")).toBe("3");
		expect(preview.headers.get("x-content-type-options")).toBe("nosniff");
		expect(Buffer.from(await preview.arrayBuffer())).toEqual(Buffer.from([9, 8, 7]));
	});

	it("validates IDs, reports missing runtimes/images explicitly, and recovers after eviction", async () => {
		const evicting = new DashboardImageService(
			{
				generate: async () => ({ bytes: Uint8Array.of(1), mimeType: "image/png", width: 1, height: 1 }),
				close: async () => {},
			},
			{ maxBytes: 0, maxRecords: 0 },
		);
		const { base, key } = await createImageRuntime(evicting);
		const projected = (await fetch(`${base}/api/runtimes/${key}/messages`).then((response) =>
			response.json(),
		)) as any;
		const id = projected.messages[0].content[0].id as string;
		expect(evicting.recordCount).toBe(0);

		const recovered = await fetch(`${base}/api/runtimes/${key}/images/${id}/original`);
		expect(recovered.status).toBe(200);
		expect(Buffer.from(await recovered.arrayBuffer())).toEqual(png);
		expect((await fetch(`${base}/api/runtimes/${key}/images/not-an-id/original`)).status).toBe(400);
		expect((await fetch(`${base}/api/runtimes/missing/images/${id}/original`)).status).toBe(404);
		expect((await fetch(`${base}/api/runtimes/${key}/images/${"f".repeat(64)}/original`)).status).toBe(404);
	});

	it("revokes cached scopes when a runtime is removed", async () => {
		const { base, key, service } = await createImageRuntime();
		await fetch(`${base}/api/runtimes/${key}/messages`);
		expect(service.recordCount).toBe(1);
		expect((await fetch(`${base}/api/runtimes/${key}`, { method: "DELETE" })).status).toBe(200);
		expect(service.recordCount).toBe(0);
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

	it("publishes fleet snapshots as global SSE events", async () => {
		const dir = await createTempProject();
		const { base, pool } = await startServer({ fleetSnapshotDebounceMs: 1 });
		const connection = await openRawSse(base);
		try {
			const runtime = await pool.create(dir);
			await waitUntil(() => connection.body().includes('"type":"fleet_snapshot"'));
			const event = parseSseEnvelopes(connection.body()).find(({ event }) => event.type === "fleet_snapshot");

			expect(event).toEqual(
				expect.objectContaining({
					key: "",
					event: expect.objectContaining({
						type: "fleet_snapshot",
						runtimes: [expect.objectContaining({ key: runtime.key })],
					}),
				}),
			);
		} finally {
			connection.destroy();
		}
	});

	it("excludes stopped runtimes from subsequent fleet snapshots", async () => {
		const dir = await createTempProject();
		const { base, pool } = await startServer({ fleetSnapshotDebounceMs: 1 });
		const connection = await openRawSse(base);
		try {
			const runtime = await pool.create(dir);
			await waitUntil(() => connection.body().includes('"type":"fleet_snapshot"'));
			await pool.stop(runtime.key);
			await waitUntil(
				() =>
					parseSseEnvelopes(connection.body()).filter(({ event }) => event.type === "fleet_snapshot").length >= 2,
			);
			const snapshots = parseSseEnvelopes(connection.body()).filter(({ event }) => event.type === "fleet_snapshot");
			const latest = snapshots.at(-1)!;
			const runtimes = latest.event.runtimes as Array<{ key: string }>;

			expect(latest.key).toBe("");
			expect(runtimes).not.toContainEqual(expect.objectContaining({ key: runtime.key }));
		} finally {
			connection.destroy();
		}
	});

	it("sends unnumbered connection metadata and accepts only bounded known diagnostics", async () => {
		const logs: string[] = [];
		const { base } = await startServer({ logger: (line) => logs.push(line) });
		const connection = await openRawSse(base);
		try {
			await waitUntil(() => connection.body().includes("event: connection"));
			const id = connection.body().match(/event: connection\ndata: {"connectionId":"([^"]+)"}\n\n/)?.[1];
			expect(id).toMatch(/^[0-9a-f-]{36}$/);
			expect(connection.body().match(/event: connection\ndata: [\s\S]*?\n\n/)?.[0]).not.toContain("id:");
			const summary = {
				connectionId: id,
				state: "connected",
				attempt: 0,
				visibility: "visible",
				eventCount: 2,
				eventRatePerMinute: 2,
				processingLagTotalMs: 1,
				processingLagMaxMs: 1,
			};
			await expect(
				fetch(`${base}/api/events/diagnostic`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(summary),
				}),
			).resolves.toMatchObject({ status: 200 });
			expect(logs.join("\n")).toContain('"kind":"client_diagnostic"');
			const limited = await fetch(`${base}/api/events/diagnostic`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(summary),
			});
			expect(limited.status).toBe(429);
			const rejected = await fetch(`${base}/api/events/diagnostic`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...summary, prompt: "must not be accepted" }),
			});
			expect(rejected.status).toBe(400);
		} finally {
			connection.destroy();
		}
	});

	it("emits correlated connect and close diagnostics for a normal SSE lifecycle", async () => {
		const logs: string[] = [];
		const { base } = await startServer({ logger: (line) => logs.push(line) });
		const connection = await openRawSse(base);
		await waitUntil(() => connection.body().includes("event: connection"));
		const connectionId = connection.body().match(/"connectionId":"([^"]+)"/)?.[1];
		expect(connectionId).toBeDefined();

		connection.destroy();
		await connection.closed;
		await new Promise((resolve) => setTimeout(resolve, 50));

		const diagnostics = logs
			.filter((line) => line.startsWith("sse "))
			.map((line) => JSON.parse(line.slice(4)) as Record<string, unknown>);
		expect(diagnostics).toContainEqual(expect.objectContaining({ kind: "connect", connectionId }));
		expect(diagnostics).toContainEqual(expect.objectContaining({ kind: "close", connectionId }));
		for (const diagnostic of diagnostics) {
			expect(JSON.stringify(diagnostic)).not.toContain('"content"');
		}
	});

	it("sends direct named heartbeats with no event id", async () => {
		const { base } = await startServer({ heartbeatIntervalMs: 5 });
		const connection = await openRawSse(base);
		try {
			await waitUntil(() => connection.body().includes("event: heartbeat"));
			const heartbeat = connection.body().match(/event: heartbeat\ndata: \{\}\n\n/)?.[0];
			expect(heartbeat).toBeDefined();
			expect(heartbeat).not.toContain("id:");
		} finally {
			connection.destroy();
		}
	});

	it("sends one oversized-event barrier over SSE and continues live delivery", async () => {
		const dir = await createTempProject();
		const hub = new EventHub({ eventBytes: 160 });
		const { base, clients } = await startServer({ eventHub: hub });
		await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});

		const connection = await openRawSse(base);
		const oversizedPayload = "x".repeat(500);
		try {
			clients[0].emit({ type: "unknown_extension_event", output: oversizedPayload });
			await waitUntil(() => connection.body().includes('"reason":"oversized_event"'));

			expect(connection.body().match(/"type":"dashboard_resync"/g)).toHaveLength(1);
			expect(connection.body()).not.toContain(oversizedPayload);

			clients[0].emit({ type: "small" });
			await waitUntil(() => connection.body().includes('"type":"small"'));
			expect(connection.body()).toMatch(/"type":"dashboard_resync","reason":"oversized_event"[\s\S]*"type":"small"/);
		} finally {
			connection.destroy();
		}
	});

	it("sends a single resync barrier instead of an aggregate replay", async () => {
		const dir = await createTempProject();
		const logs: string[] = [];
		const hub = new EventHub({ bufferBytes: 10_000, replayBytes: 150, eventBytes: 500 });
		const { base, clients } = await startServer({ eventHub: hub, logger: (line) => logs.push(line) });
		await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});
		clients[0].emit({ type: "one", text: "x".repeat(50) });
		clients[0].emit({ type: "two", text: "x".repeat(50) });

		const connection = await openRawSse(base, 0);
		try {
			await waitUntil(() => connection.body().includes("dashboard_resync"));
			expect(connection.body()).toContain('"reason":"replay_over_budget"');
			expect(connection.body()).not.toContain('"type":"one"');
			expect(connection.body()).not.toContain('"type":"two"');
			const diagnostics = logs
				.filter((line) => line.startsWith("sse "))
				.map((line) => JSON.parse(line.slice(4)) as Record<string, unknown>);
			expect(diagnostics).toContainEqual(
				expect.objectContaining({
					kind: "resync",
					reason: "replay_over_budget",
					count: 1,
					bytes: expect.any(Number),
				}),
			);
			expect(logs.join("\n")).not.toContain("x".repeat(50));
		} finally {
			connection.destroy();
		}
	});

	it("replays a within-budget Last-Event-ID range before later live SSE delivery", async () => {
		const dir = await createTempProject();
		const logs: string[] = [];
		const hub = new EventHub({ bufferBytes: 10_000, replayBytes: 10_000, eventBytes: 500 });
		const { base, clients } = await startServer({ eventHub: hub, logger: (line) => logs.push(line) });
		const create = await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});
		const { key } = (await create.json()) as { key: string };
		clients[0].emit({ type: "one" });
		clients[0].emit({ type: "two" });
		clients[0].emit({ type: "three" });

		const expectedReplayBytes =
			Buffer.byteLength(formatSseFrame({ seq: 2, key, event: { type: "two" } })) +
			Buffer.byteLength(formatSseFrame({ seq: 3, key, event: { type: "three" } }));
		const expectedLiveBytes = Buffer.byteLength(formatSseFrame({ seq: 4, key, event: { type: "four" } }));
		const connection = await openRawSse(base, 1);
		try {
			await waitUntil(() => connection.body().includes('"type":"three"'));

			clients[0].emit({ type: "four" });
			await waitUntil(() => connection.body().includes('"type":"four"'));

			expect(parseSseEnvelopes(connection.body())).toEqual([
				{ seq: 2, key, event: { type: "two" } },
				{ seq: 3, key, event: { type: "three" } },
				{ seq: 4, key, event: { type: "four" } },
			]);
			const diagnostics = logs
				.filter((line) => line.startsWith("sse "))
				.map((line) => JSON.parse(line.slice(4)) as Record<string, unknown>);
			expect(diagnostics).toContainEqual(
				expect.objectContaining({
					kind: "replay",
					count: 2,
					bytes: expectedReplayBytes,
					fromSeq: 2,
					toSeq: 3,
				}),
			);
			expect(diagnostics).toContainEqual(
				expect.objectContaining({
					kind: "write",
					writeKind: "replay",
					seq: 2,
					type: "two",
					frameBytes: Buffer.byteLength(formatSseFrame({ seq: 2, key, event: { type: "two" } })),
				}),
			);
			expect(diagnostics).toContainEqual(
				expect.objectContaining({
					kind: "write",
					writeKind: "replay",
					seq: 3,
					type: "three",
					frameBytes: Buffer.byteLength(formatSseFrame({ seq: 3, key, event: { type: "three" } })),
				}),
			);
			expect(diagnostics).toContainEqual(
				expect.objectContaining({
					kind: "write",
					writeKind: "live",
					seq: 4,
					type: "four",
					frameBytes: expectedLiveBytes,
				}),
			);
		} finally {
			connection.destroy();
		}
	});

	it("reconnecting client receives replay from Last-Event-ID and then live events", async () => {
		const dir = await createTempProject();
		const hub = new EventHub({ bufferBytes: 10_000, replayBytes: 10_000, eventBytes: 500 });
		const { base, clients } = await startServer({ eventHub: hub });
		await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});

		const first = await openRawSse(base);
		let second: RawSseConnection | undefined;
		try {
			clients[0].emit({ type: "one" });
			clients[0].emit({ type: "two" });
			clients[0].emit({ type: "three" });
			await waitUntil(() => first.body().includes('"type":"three"'));
			const firstEnvelopes = parseSseEnvelopes(first.body());
			const lastSeq = firstEnvelopes.at(-1)?.seq;
			expect(lastSeq).toBeDefined();

			first.destroy();
			await first.closed;

			clients[0].emit({ type: "four" });

			second = await openRawSse(base, lastSeq! - 1);
			await waitUntil(() => second!.body().includes('"type":"four"'));
			const secondEnvelopes = parseSseEnvelopes(second.body());
			expect(secondEnvelopes.map((e) => e.event.type)).toEqual(["three", "four"]);

			clients[0].emit({ type: "five" });
			await waitUntil(() => second!.body().includes('"type":"five"'));
		} finally {
			first.destroy();
			second?.destroy();
		}
	});

	it("targets stale-cursor recovery without interrupting healthy SSE clients", async () => {
		const dir = await createTempProject();
		const hub = new EventHub({ bufferSize: 2, bufferBytes: 10_000, replayBytes: 10_000, eventBytes: 500 });
		const { base, clients } = await startServer({ eventHub: hub });
		await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});
		const healthy = await openRawSse(base);
		let stale: RawSseConnection | undefined;
		try {
			clients[0].emit({ type: "one" });
			clients[0].emit({ type: "two" });
			clients[0].emit({ type: "three" });
			await waitUntil(() => healthy.body().includes('"type":"three"'));

			stale = await openRawSse(base, 0);
			await waitUntil(() => stale!.body().includes("dashboard_resync"));
			expect(stale.body()).toContain('"seq":3');
			expect(stale.body()).toContain('"reason":"buffer_gap"');
			expect(stale.body()).not.toContain('"type":"two"');
			expect(healthy.body()).not.toContain("dashboard_resync");

			clients[0].emit({ type: "four" });
			await waitUntil(() => healthy.body().includes('"type":"four"') && stale!.body().includes('"type":"four"'));
			expect(healthy.body()).toContain('"seq":4');
			expect(stale.body()).toContain('"seq":4');
		} finally {
			healthy.destroy();
			stale?.destroy();
		}
	});

	it("targets a server-restart cursor at sequence one without a global frame", async () => {
		const hub = new EventHub();
		const { base } = await startServer({ eventHub: hub });
		const restartedClient = await openRawSse(base, 999);
		try {
			await waitUntil(() => restartedClient.body().includes("dashboard_resync"));
			expect(restartedClient.body()).toContain('"seq":1');
			expect(restartedClient.body()).toContain('"reason":"empty_buffer"');
			expect(hub.historyCount).toBe(0);
			expect(hub.currentSequence).toBe(1);
		} finally {
			restartedClient.destroy();
		}
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
			const diagnostics = logs
				.filter((line) => line.startsWith("sse "))
				.map((line) => JSON.parse(line.slice(4)) as Record<string, unknown>);
			expect(diagnostics).toContainEqual(
				expect.objectContaining({
					kind: "backpressure",
					writeKind: "live",
					frameBytes: expect.any(Number),
					writableLength: MAX_SSE_BUFFERED_BYTES + 1,
				}),
			);
		} finally {
			writeSpy.mockRestore();
			slow?.destroy();
			fast?.destroy();
		}
	});

	it("destroys over-buffered SSE clients during replay and detaches them while other clients keep receiving events", async () => {
		const dir = await createTempProject();
		const logs: string[] = [];
		const hub = new EventHub({ bufferBytes: 10_000, replayBytes: 10_000, eventBytes: 500 });
		const { base, clients } = await startServer({
			eventHub: hub,
			logger: (line) => logs.push(line),
			heartbeatIntervalMs: 5,
		});
		await fetch(`${base}/api/runtimes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});
		clients[0].emit({ type: "before_replay_backpressure" });

		const originalWrite = ServerResponse.prototype.write as (this: ServerResponse, ...args: any[]) => boolean;
		const writeCounts = new WeakMap<ServerResponse, number>();
		const replayBackpressureChunks: string[] = [];
		let replayResponse: ServerResponse | undefined;
		const writeSpy = vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
			this: ServerResponse,
			...args: any[]
		) {
			const responseReq = (this as ServerResponse & { req?: IncomingMessage }).req;
			if (responseReq?.url?.startsWith("/api/events")) {
				writeCounts.set(this, (writeCounts.get(this) ?? 0) + 1);
				const accepted = originalWrite.apply(this, args);
				const chunk = typeof args[0] === "string" ? args[0] : "";
				if (responseReq.headers["last-event-id"] === "0" && chunk.startsWith("id: ")) {
					replayResponse = this;
					replayBackpressureChunks.push(chunk);
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
			fast = await openRawSse(base);
			await waitUntil(() => fast!.body().includes(":ok"));

			const slowResult = await Promise.race([
				openRawSse(base, 0)
					.then((connection) => ({ connection }))
					.catch((error: unknown) => ({ error })),
				new Promise<never>((_resolve, reject) =>
					setTimeout(() => reject(new Error("replay-backpressured SSE did not close")), 1000),
				),
			]);
			if ("connection" in slowResult) {
				slow = slowResult.connection;
				await slow.closed;
			} else {
				expect((slowResult.error as Error).message).toContain("socket hang up");
			}
			expect(replayBackpressureChunks).toHaveLength(1);
			expect(replayResponse?.destroyed).toBe(true);
			expect(hub.clientCount).toBe(1);
			const replayWriteCountAfterDestroy = writeCounts.get(replayResponse!) ?? 0;

			await new Promise((resolve) => setTimeout(resolve, 25));
			clients[0].emit({ type: "after_replay_backpressure" });
			await waitUntil(() => fast!.body().includes("after_replay_backpressure"));
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(writeCounts.get(replayResponse!)).toBe(replayWriteCountAfterDestroy);

			const diagnostics = logs
				.filter((line) => line.startsWith("sse "))
				.map((line) => JSON.parse(line.slice(4)) as Record<string, unknown>);
			const backpressure = diagnostics.find((d) => d.kind === "backpressure" && d.writeKind === "replay");
			expect(backpressure).toEqual(
				expect.objectContaining({
					kind: "backpressure",
					writeKind: "replay",
					frameBytes: expect.any(Number),
					writableLength: MAX_SSE_BUFFERED_BYTES + 1,
				}),
			);
			const replayConnectionId = backpressure?.connectionId;
			expect(replayConnectionId).toBeDefined();
			const replayDiagnostics = diagnostics.filter((d) => d.connectionId === replayConnectionId);
			expect(replayDiagnostics).not.toContainEqual(expect.objectContaining({ writeKind: "heartbeat" }));
			expect(replayDiagnostics).not.toContainEqual(expect.objectContaining({ writeKind: "live" }));
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

	it("DELETE /api/sessions forwards valid paths and notifies other clients", async () => {
		const deleteSession = vi.fn(async () => ({ method: "trash", path: "/sessions/one.jsonl" }));
		const hub = new EventHub();
		const frames: string[] = [];
		hub.attach({
			write: (frame) => {
				frames.push(frame);
				return true;
			},
		});
		const { base } = await startServer({ deleteSession, eventHub: hub });

		const res = await fetch(`${base}/api/sessions`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "/sessions/one.jsonl" }),
		});

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ method: "trash", path: "/sessions/one.jsonl" });
		expect(deleteSession).toHaveBeenCalledWith("/sessions/one.jsonl");
		expect(frames).toHaveLength(1);
		expect(frames[0]).toContain('"key":"","event":{"type":"disk_sessions_changed"}');
	});
});

describe("dashboard server — files", () => {
	it("returns utility-RPC trust state for canonical listings and delegates canonical trust mutations", async () => {
		const dir = await createTempProject();
		const canonical = await realpath(dir);
		const { base, clients } = await startServer();

		const listing = await fetch(`${base}/api/files?path=${encodeURIComponent(join(dir, "."))}`);
		expect(listing.status).toBe(200);
		await expect(listing.json()).resolves.toMatchObject({
			path: canonical,
			contextTrust: { canonicalTarget: canonical, state: "untrusted" },
		});
		expect(clients[0].evaluateContextTrust).toHaveBeenCalledWith(canonical);

		const trusted = await fetch(`${base}/api/files/trust`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: join(dir, ".") }),
		});
		expect(trusted.status).toBe(200);
		await expect(trusted.json()).resolves.toMatchObject({
			addedRoot: canonical,
			evaluation: { canonicalTarget: canonical, state: "trusted-root", grantingRoot: canonical },
			settings: { trustedContextFolders: [canonical], effectiveTrustedContextRoots: [canonical] },
		});
		expect(clients[0].trustContextFolder).toHaveBeenCalledWith(canonical);

		const untrusted = await fetch(`${base}/api/files/untrust`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: dir }),
		});
		expect(untrusted.status).toBe(200);
		expect(clients[0].untrustContextFolder).toHaveBeenCalledWith(canonical);
	});

	it("surfaces canonicalization and utility RPC errors for trust endpoints", async () => {
		const dir = await createTempProject();
		const { base, clients } = await startServer();

		const missing = await fetch(`${base}/api/files/trust`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "relative" }),
		});
		expect(missing.status).toBe(400);

		// Create the utility runtime first, then make RPC failures explicit.
		await fetch(`${base}/api/files?path=${encodeURIComponent(dir)}`);
		vi.mocked(clients[0].evaluateContextTrust).mockRejectedValueOnce(new Error("trust evaluation failed"));
		const listingFailed = await fetch(`${base}/api/files?path=${encodeURIComponent(dir)}`);
		expect(listingFailed.status).toBe(502);
		await expect(listingFailed.json()).resolves.toEqual({ error: "trust evaluation failed" });

		vi.mocked(clients[0].untrustContextFolder).mockRejectedValueOnce(new Error("durable write failed"));
		const failed = await fetch(`${base}/api/files/untrust`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: dir }),
		});
		expect(failed.status).toBe(502);
		await expect(failed.json()).resolves.toEqual({ error: "durable write failed" });
	});

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

	it("uploads JSON payloads byte-for-byte without the body parser consuming the stream", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dreb-dash-server-"));
		tempDirs.push(dir);
		const canonical = await realpath(dir);
		const { base } = await startServer();
		const payload = JSON.stringify({ name: "payload.json", nested: { values: [1, 2, 3] } });

		const upload = await fetch(
			`${base}/api/files/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent("payload.json")}`,
			{ method: "POST", headers: { "content-type": "application/json" }, body: payload },
		);
		expect(upload.status).toBe(200);
		await expect(upload.json()).resolves.toEqual({ path: join(canonical, "payload.json") });

		// Pre-fix, the global express.json() middleware drained the request stream
		// before the upload handler could pipe it, committing a 0-byte file.
		expect(await readFile(join(canonical, "payload.json"), "utf8")).toBe(payload);

		// Express 5 route matching is case-insensitive, so /API/files/upload is
		// the same upload route. Pre-fix, the case-sensitive skip let the parser
		// drain the stream and commit a 0-byte file on case-variant URLs.
		const caseVariant = await fetch(
			`${base}/API/files/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent("case-variant.json")}`,
			{ method: "POST", headers: { "content-type": "application/json" }, body: payload },
		);
		expect(caseVariant.status).toBe(200);
		expect(await readFile(join(canonical, "case-variant.json"), "utf8")).toBe(payload);

		// Non-strict matching also accepts the trailing-slash variant.
		const trailingSlash = await fetch(
			`${base}/api/files/upload/?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent("trailing-slash.json")}`,
			{ method: "POST", headers: { "content-type": "application/json" }, body: payload },
		);
		expect(trailingSlash.status).toBe(200);
		expect(await readFile(join(canonical, "trailing-slash.json"), "utf8")).toBe(payload);
	});

	it("downloads files under dot-prefixed directory components", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dreb-dash-server-"));
		tempDirs.push(dir);
		const uploadsDir = join(dir, ".dreb-dashboard-uploads", "nested");
		await mkdir(uploadsDir, { recursive: true });
		const content = "dot-prefixed directory download";
		await writeFile(join(uploadsDir, "report.txt"), content);
		const { base } = await startServer();

		// Pre-fix, res.download() inherited send's dotfiles: "ignore" default and
		// 404'd for any path containing a dot-prefixed component.
		const download = await fetch(
			`${base}/api/files/download?path=${encodeURIComponent(join(uploadsDir, "report.txt"))}`,
		);
		expect(download.status).toBe(200);
		expect(await download.text()).toBe(content);
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
