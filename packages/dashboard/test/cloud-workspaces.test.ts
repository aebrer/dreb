import * as fs from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	CloudSessionStorage,
	CloudWorkspaceError,
	type CloudWorkspaceErrorCode,
	CloudWorkspaceRegistry,
} from "@dreb/coding-agent/cloud-workspaces";
import type { RpcClient } from "@dreb/coding-agent/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthRequestInfo, DashboardAuth, MemoryPairingStorage } from "../src/server/auth.js";
import { RuntimePool } from "../src/server/runtime-pool.js";
import { createDashboardServer } from "../src/server/server.js";
import type { CloudProjectDto, CloudWorkspaceDto, CloudWorkspacesDto, RuntimeInfoDto } from "../src/shared/protocol.js";

// Keep real filesystem operations, but permit narrowly targeted failure injection.
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));

const API = "/api/cloud-workspaces";
const PROJECT = "11111111-1111-4111-8111-111111111aaa";
const OTHER = "22222222-2222-4222-8222-222222222bbb";
const THIRD = "33333333-3333-4333-8333-333333333ccc";
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REGISTRY_METHODS = ["list", "status", "connect", "link", "resolve", "unlink", "disconnect"] as const;
type ErrorBody = { code: string; error: string };

let root: string;
let registry: CloudWorkspaceRegistry;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "dreb-dashboard-cloud-")));
	registry = new CloudWorkspaceRegistry({ agentDir: join(root, "profile-a") });
});

afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await fs.rm(root, { recursive: true, force: true });
	}
});

async function folder(name: string): Promise<string> {
	const path = join(root, name);
	await fs.mkdir(path, { recursive: true });
	return path;
}

function markerPath(path: string, kind: "workspace" | "project"): string {
	return join(path, ".dreb", `${kind}.json`);
}

async function marker(path: string, kind: "workspace" | "project", id: string): Promise<void> {
	await fs.mkdir(join(path, ".dreb"), { recursive: true });
	await fs.writeFile(markerPath(path, kind), `${JSON.stringify({ version: 1, kind, id })}\n`);
}

async function copyMarker(from: string, to: string, kind: "workspace" | "project"): Promise<void> {
	await fs.mkdir(join(to, ".dreb"), { recursive: true });
	await fs.copyFile(markerPath(from, kind), markerPath(to, kind));
}

async function absent(path: string): Promise<void> {
	await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

// Deliberately local: importing runtime-pool.test.ts would register its unrelated tests.
function fakeClient() {
	return {
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		onEvent: vi.fn(() => () => {}),
		onExit: vi.fn(() => () => {}),
		listBackgroundAgents: vi.fn(async () => []),
		getState: vi.fn(async () => ({ sessionId: "synthetic-session", tasks: [], thinkingLevel: "off" })),
		getSessionStats: vi.fn(async () => ({ tokens: { total: 0 }, cost: 0, subagentCost: 0 })),
		getLastAssistantText: vi.fn(async () => ""),
		prompt: vi.fn(async (_text: string) => {}),
	};
}

/** All traffic is loopback; raw HTTP also permits an explicit hostile Host header. */
async function http<T = ErrorBody>(
	base: string,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
	raw?: string,
): Promise<{ status: number; body: T }> {
	const url = new URL(path, base);
	const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
	return new Promise((resolve, reject) => {
		const req = request(
			url,
			{
				method,
				headers: {
					...(payload === undefined
						? {}
						: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }),
					...headers,
				},
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					text += chunk;
				});
				res.on("error", reject);
				res.on("end", () => {
					try {
						resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as T });
					} catch (error) {
						reject(
							new Error(
								`${method} ${path} returned HTTP ${res.statusCode} with non-JSON body: ${text.slice(0, 160)}`,
								{ cause: error },
							),
						);
					}
				});
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

async function start(
	options: {
		registry?: CloudWorkspaceRegistry;
		auth?: DashboardAuth;
		runtime?: boolean;
		defaultRegistry?: boolean;
		sessionStorage?: CloudSessionStorage;
		activeInventoryRoot?: string;
	} = {},
) {
	const shared = options.registry ?? registry;
	const registryCalls = REGISTRY_METHODS.map((name) => vi.spyOn(shared, name));
	const clients: ReturnType<typeof fakeClient>[] = [];
	const clientFactory = vi.fn((_options: { cliPath: string; cwd: string; args: string[] }) => {
		const client = fakeClient();
		clients.push(client);
		return client as unknown as RpcClient;
	});
	const pool = new RuntimePool({ cliPath: join(root, "never-executed-cli.js"), clientFactory, logger: () => {} });
	const create = vi.spyOn(pool, "create");
	if (!options.runtime) create.mockRejectedValue(new Error("Metadata must not create a runtime"));
	const utility = vi.spyOn(pool, "ensureUtilityRuntime").mockRejectedValue(new Error("No utility runtime allowed"));
	const listAllSessions = vi.fn(async () => {
		throw new Error("Cloud metadata must not inspect transcripts");
	});
	const deleteSession = vi.fn(async () => {
		throw new Error("Cloud metadata must not delete transcripts");
	});
	const log = vi.fn();
	const app = createDashboardServer({
		auth: options.auth ?? new DashboardAuth(),
		pool,
		cloudWorkspaceRegistry: options.defaultRegistry ? undefined : shared,
		cloudSessionStorage: options.sessionStorage,
		sessionInventoryRoot: options.activeInventoryRoot,
		sessionStorageBaseCwd: root,
		memoryHomeDir: join(root, "synthetic-home"),
		listAllSessions,
		deleteSession,
		logger: log,
	});
	const server = await new Promise<Server>((resolve) => {
		const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
	});
	cleanups.push(async () => {
		try {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			await pool.stopAll();
			await app.closeDashboard();
		} finally {
			expect(utility).not.toHaveBeenCalled();
			expect(listAllSessions).not.toHaveBeenCalled();
			expect(deleteSession).not.toHaveBeenCalled();
			if (!options.runtime) {
				expect(create).not.toHaveBeenCalled();
				expect(clientFactory).not.toHaveBeenCalled();
			}
		}
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test server address");
	const base = `http://127.0.0.1:${address.port}`;
	return { base, pool, create, clients, clientFactory, registryCalls, log };
}

async function list(base: string): Promise<CloudWorkspacesDto> {
	const result = await http<CloudWorkspacesDto>(base, "GET", API);
	expect(result.status).toBe(200);
	return result.body;
}

function errorResult(result: { status: number; body: ErrorBody }, status: number, code: string): void {
	expect(result.status).toBe(status);
	expect(result.body).toEqual({ code, error: expect.any(String) });
	expect(result.body.error.length).toBeGreaterThan(0);
}

function noRegistryCalls(calls: Awaited<ReturnType<typeof start>>["registryCalls"]): void {
	for (const call of calls) expect(call).not.toHaveBeenCalled();
}

function noSpawn(server: Awaited<ReturnType<typeof start>>): void {
	expect(server.create).not.toHaveBeenCalled();
	expect(server.clientFactory).not.toHaveBeenCalled();
	expect(server.pool.list()).toEqual([]);
}

describe("optional global session-log settings (no runtime or transcript access)", () => {
	const route = `${API}/session-storage`;
	const empty = { sessionDir: null, subagentSessionDir: null };

	it("reads only storage fields without creating an absent profile", async () => {
		const server = await start();
		const result = await http(server.base, "GET", route);
		expect(result).toEqual({
			status: 200,
			body: {
				...empty,
				subdirectories: { sessionDir: ".dreb/sessions", subagentSessionDir: ".dreb/subagent-sessions" },
				restartRequired: false,
			},
		});
		await absent(dirname(registry.path));
		noRegistryCalls(server.registryCalls);
	});

	it("saves and resets only global defaults, without project metadata, log migration or restart", async () => {
		const path = await folder(" cloud logs with whitespace ");
		const settingsPath = join(dirname(registry.path), "settings.json");
		await fs.mkdir(dirname(settingsPath));
		const original = { theme: "dark", unknown: { nested: ["keep"] }, authToken: "synthetic-never-share" };
		await fs.writeFile(settingsPath, JSON.stringify(original));
		const transcript = join(path, "old.jsonl");
		await fs.writeFile(transcript, "unchanged historical bytes\n");
		const server = await start();
		const result = await http(server.base, "PUT", route, { root: path, expected: empty });
		const pair = {
			sessionDir: join(path, ".dreb", "sessions"),
			subagentSessionDir: join(path, ".dreb", "subagent-sessions"),
		};
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ ...pair, restartRequired: true });
		expect(JSON.stringify(result.body)).not.toContain("synthetic-never-share");
		expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual({ ...original, ...pair });
		await absent(join(path, ".dreb"));
		await absent(registry.path);
		expect(await fs.readFile(transcript, "utf8")).toBe("unchanged historical bytes\n");
		const reset = await http(server.base, "PUT", route, { root: null, expected: pair });
		expect(reset.status).toBe(200);
		expect(reset.body).toMatchObject({ ...empty, restartRequired: false });
		expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual(original);
		noRegistryCalls(server.registryCalls);
		noSpawn(server);
	});

	it("reports inventory restart requirements against the injected startup root", async () => {
		const path = await folder("configured");
		const pair = {
			sessionDir: join(path, ".dreb", "sessions"),
			subagentSessionDir: join(path, ".dreb", "subagent-sessions"),
		};
		await fs.mkdir(dirname(registry.path));
		await fs.writeFile(join(dirname(registry.path), "settings.json"), JSON.stringify(pair));
		const { base } = await start({ activeInventoryRoot: pair.sessionDir });
		expect((await http(base, "GET", route)).body).toMatchObject({ ...pair, restartRequired: false });
		expect((await http(base, "PUT", route, { root: null, expected: pair })).body).toMatchObject({
			restartRequired: true,
		});
	});

	it("refuses stale expected locations and retains a concurrent edit", async () => {
		const path = await folder("new-storage");
		const { base } = await start();
		await fs.mkdir(dirname(registry.path));
		const settingsPath = join(dirname(registry.path), "settings.json");
		const contents = JSON.stringify({ sessionDir: "/newer-main", theme: "light" });
		await fs.writeFile(settingsPath, contents);
		errorResult(await http(base, "PUT", route, { root: path, expected: empty }), 409, "CONFLICT");
		expect(await fs.readFile(settingsPath, "utf8")).toBe(contents);
	});

	it.each([
		undefined,
		null,
		[],
		"text",
		1,
		{},
		{ root: null },
		{ root: null, expected: {} },
		{ root: null, expected: { ...empty, extra: true } },
		{ root: null, expected: { sessionDir: 1, subagentSessionDir: null } },
		{ root: 5, expected: empty },
		{ root: "relative", expected: empty },
		{ root: null, expected: empty, sessionDir: "/forbidden" },
	])("rejects invalid storage request %j before writes", async (body) => {
		const server = await start();
		errorResult(await http(server.base, "PUT", route, body), 400, "INVALID_REQUEST");
		await absent(dirname(registry.path));
		noRegistryCalls(server.registryCalls);
	});

	it.each(["null", "[]", "1", "{broken", '{"sessionDir":false}'])(
		"preserves corrupt global configuration %s",
		async (contents) => {
			await fs.mkdir(dirname(registry.path));
			const path = join(dirname(registry.path), "settings.json");
			await fs.writeFile(path, contents);
			const { base } = await start();
			errorResult(await http(base, "GET", route), 422, "INVALID_METADATA");
			errorResult(await http(base, "PUT", route, { root: null, expected: empty }), 422, "INVALID_METADATA");
			expect(await fs.readFile(path, "utf8")).toBe(contents);
		},
	);

	it("inherits bounded JSON parsing, query/body validation, and case/trailing-slash protection", async () => {
		const { base } = await start();
		errorResult(await http(base, "GET", `${route}?cwd=/unrelated`), 400, "INVALID_REQUEST");
		errorResult(await http(base, "GET", route, { root: null }), 400, "INVALID_REQUEST");
		errorResult(await http(base, "PUT", route, undefined, {}, "{broken"), 400, "INVALID_REQUEST");
		const raw = JSON.stringify({ root: null, expected: empty });
		const exact = raw + " ".repeat(16 * 1024 - Buffer.byteLength(raw));
		expect((await http(base, "PUT", route, undefined, {}, exact)).status).toBe(200);
		for (const variant of [route, `${route.toUpperCase()}/`]) {
			errorResult(await http(base, "PUT", variant, undefined, {}, `${exact} `), 413, "INVALID_REQUEST");
		}
	});

	it("sanitizes storage-service failures and keeps settings reads out of ordinary metadata GET", async () => {
		const storage = new CloudSessionStorage({ agentDir: dirname(registry.path) });
		const read = vi.spyOn(storage, "read").mockRejectedValue(new Error("private secret"));
		const { base } = await start({ sessionStorage: storage });
		expect((await http(base, "GET", API)).status).toBe(200);
		expect(read).not.toHaveBeenCalled();
		const result = await http(base, "GET", route);
		errorResult(result, 500, "IO_ERROR");
		expect(JSON.stringify(result.body)).not.toContain("private secret");
	});
});

describe("cloud metadata HTTP workflow (real isolated registry)", () => {
	it("lists absent state without creating the agent directory or any project metadata", async () => {
		const { base } = await start();
		expect(await list(base)).toEqual({
			version: 1,
			pathStyle: process.platform === "win32" ? "windows" : "posix",
			workspaces: [],
			projects: [],
		});
		await absent(dirname(registry.path));
	});

	it("initializes, connects, links, rebinds, disconnects and unlinks without touching markers or sentinel bytes on removal", async () => {
		const { base, log } = await start();
		const drive = await folder("Shared drive");
		const project = await folder("Shared drive/Projects/Résumé notes");
		const local = await folder("outside/local");
		const known = await folder("outside/markerless");
		const connected = await http<CloudWorkspaceDto>(base, "POST", `${API}/connect`, {
			path: drive,
			initialize: true,
		});
		expect(connected.status).toBe(200);
		const workspaceId = connected.body.id;
		expect(connected.body).toEqual({ id: workspaceId, path: drive });
		expect((await http(base, "POST", `${API}/connect`, { path: drive })).body).toEqual(connected.body);
		const linked = await http<CloudProjectDto>(base, "POST", `${API}/link`, {
			path: project,
			initialize: true,
			workspaceId,
		});
		expect(linked.status).toBe(200);
		expect(linked.body).toEqual({
			id: expect.any(String),
			location: { kind: "workspace", workspaceId, relativePath: "Projects/Résumé notes" },
			markerRequired: true,
		});
		expect((await http(base, "POST", `${API}/link`, { path: project, workspaceId })).body).toEqual(linked.body);
		const localLink = await http<CloudProjectDto>(base, "POST", `${API}/link`, { path: local, initialize: true });
		expect(localLink.status).toBe(200);
		expect(localLink.body.location).toEqual({ kind: "local", path: local });
		const knownLink = await http<CloudProjectDto>(base, "POST", `${API}/link`, {
			path: known,
			projectId: PROJECT.toUpperCase(),
			initialize: false,
		});
		expect(knownLink.body).toEqual({ id: PROJECT, location: { kind: "local", path: known }, markerRequired: false });
		await absent(join(known, ".dreb"));
		const state = await list(base);
		expect(state.projects).toHaveLength(3);
		expect(state.projects.map((entry) => entry.id)).toEqual(state.projects.map((entry) => entry.id).sort());
		for (const entry of [...state.projects, ...state.workspaces]) expect(entry.status.available).toBe(true);

		const nextDrive = await folder("Moved drive");
		const nextProject = await folder("Moved drive/Projects/Résumé notes");
		await copyMarker(drive, nextDrive, "workspace");
		await copyMarker(project, nextProject, "project");
		errorResult(await http(base, "POST", `${API}/connect`, { path: nextDrive }), 409, "CONFLICT");
		const rebound = await http(base, "PUT", `${API}/workspaces/${workspaceId.toUpperCase()}`, { path: nextDrive });
		expect(rebound.body).toEqual({ id: workspaceId, path: nextDrive });
		expect((await list(base)).projects.find((entry) => entry.id === linked.body.id)?.status).toEqual({
			available: true,
			path: nextProject,
		});
		const nextLocal = await folder("outside/rebound-local");
		await copyMarker(local, nextLocal, "project");
		expect((await http(base, "PUT", `${API}/projects/${localLink.body.id}`, { path: nextLocal })).status).toBe(200);
		const nextKnown = await folder("outside/rebound-markerless");
		expect((await http(base, "PUT", `${API}/projects/${PROJECT}`, { path: nextKnown })).body).toEqual({
			id: PROJECT,
			location: { kind: "local", path: nextKnown },
			markerRequired: false,
		});
		await absent(join(nextKnown, ".dreb"));
		// Also exercise row rebind into an explicit workspace, preserving the known identity.
		const knownRelative = await folder("Moved drive/known");
		expect(
			(await http(base, "PUT", `${API}/projects/${PROJECT}`, { path: knownRelative, workspaceId })).body,
		).toEqual({
			id: PROJECT,
			location: { kind: "workspace", workspaceId, relativePath: "known" },
			markerRequired: false,
		});

		const sentinels = [
			...[drive, nextDrive].map((path) => markerPath(path, "workspace")),
			...[project, nextProject, local, nextLocal].map((path) => markerPath(path, "project")),
		];
		for (const path of [project, nextProject, local, nextLocal, known, knownRelative]) {
			const transcript = join(path, "synthetic-history.jsonl");
			await fs.writeFile(transcript, Buffer.from('synthetic-only\n{"cwd":"historical"}\n\u0000'));
			sentinels.push(transcript);
		}
		const before = await Promise.all(sentinels.map((path) => fs.readFile(path)));
		expect((await http(base, "DELETE", `${API}/workspaces/${workspaceId}`)).body).toEqual({ removed: true });
		expect((await http(base, "DELETE", `${API}/workspaces/${workspaceId}`, {})).body).toEqual({ removed: false });
		const disconnected = await list(base);
		expect(disconnected.workspaces).toEqual([]);
		expect(disconnected.projects).toHaveLength(3);
		expect(disconnected.projects.find((entry) => entry.id === linked.body.id)?.status).toMatchObject({
			available: false,
			error: { code: "NOT_FOUND" },
		});
		expect((await http(base, "POST", `${API}/connect`, { path: nextDrive })).status).toBe(200);
		expect((await list(base)).projects.every((entry) => entry.status.available)).toBe(true);
		for (const id of [linked.body.id, localLink.body.id, PROJECT]) {
			expect((await http(base, "DELETE", `${API}/projects/${id}`)).body).toEqual({ removed: true });
			expect((await http(base, "DELETE", `${API}/projects/${id}`)).body).toEqual({ removed: false });
		}
		expect((await http(base, "DELETE", `${API}/workspaces/${workspaceId}`)).status).toBe(200);
		expect((await list(base)).projects).toEqual([]);
		expect(await Promise.all(sentinels.map((path) => fs.readFile(path)))).toEqual(before);
		expect(log.mock.calls.some(([line]) => String(line).includes(`cloud connect ${workspaceId}`))).toBe(true);
		expect(log.mock.calls.some(([line]) => String(line).includes("synthetic-only"))).toBe(false);
	});

	it("uses the same IDs on two synthetic profiles with different host-local and workspace paths", async () => {
		const a = await start();
		const second = new CloudWorkspaceRegistry({ agentDir: join(root, "profile-b") });
		const b = await start({ registry: second });
		const driveA = await folder("profile-a-drive");
		const driveB = await folder("different-drive");
		const pathA = await folder("profile-a-drive/p");
		const pathB = await folder("different-drive/p");
		const workspace = await http<CloudWorkspaceDto>(a.base, "POST", `${API}/connect`, {
			path: driveA,
			initialize: true,
		});
		const project = await http<CloudProjectDto>(a.base, "POST", `${API}/link`, {
			path: pathA,
			initialize: true,
			workspaceId: workspace.body.id,
		});
		await copyMarker(driveA, driveB, "workspace");
		await copyMarker(pathA, pathB, "project");
		expect((await http(b.base, "POST", `${API}/connect`, { path: driveB })).body).toEqual({
			id: workspace.body.id,
			path: driveB,
		});
		expect((await http(b.base, "POST", `${API}/link`, { path: pathB, workspaceId: workspace.body.id })).body).toEqual(
			project.body,
		);
		for (const [server, path] of [
			[a, pathA],
			[b, pathB],
		] as const) {
			expect((await list(server.base)).projects[0].status).toEqual({ available: true, path });
		}
		const localA = await folder("independent-a");
		const localB = await folder("independent-b");
		await http(a.base, "POST", `${API}/link`, { path: localA, projectId: PROJECT });
		await http(b.base, "POST", `${API}/link`, { path: localB, projectId: PROJECT });
		expect(await registry.resolve(PROJECT)).toBe(localA);
		expect(await second.resolve(PROJECT)).toBe(localB);
		expect(await fs.readFile(markerPath(pathA, "project"), "utf8")).not.toContain(root);
	});

	it("does not infer a workspace-relative project even when its local path is below a connected root", async () => {
		const drive = await folder("drive");
		const path = await folder("drive/p");
		await registry.connect(drive, { initialize: true });
		const { base } = await start();
		expect((await http(base, "POST", `${API}/link`, { path, projectId: PROJECT })).body).toEqual({
			id: PROJECT,
			location: { kind: "local", path },
			markerRequired: false,
		});
	});

	it("permits the workspace root itself as a relative project", async () => {
		const path = await folder("drive");
		const workspace = await registry.connect(path, { initialize: true });
		const { base } = await start();
		expect(
			(await http(base, "POST", `${API}/link`, { path, projectId: PROJECT, workspaceId: workspace.id })).body,
		).toEqual({
			id: PROJECT,
			location: { kind: "workspace", workspaceId: workspace.id, relativePath: "." },
			markerRequired: false,
		});
	});

	it("joins shuffled status observations by ID and treats an absent observation as unavailable", async () => {
		const { base } = await start();
		// Deliberate inter-read skew, not a claimed transactional filesystem snapshot.
		vi.spyOn(registry, "list").mockResolvedValue({
			version: 1,
			workspaces: [PROJECT, OTHER, THIRD].map((id) => ({ id, path: join(root, id) })),
			projects: [PROJECT, OTHER, THIRD].map((id) => ({
				id,
				location: { kind: "local", path: join(root, id) },
				markerRequired: false,
			})),
		});
		const observed = [
			{ id: OTHER, available: false as const, error: { code: "CONFLICT" as const, message: "Changed identity" } },
			{ id: PROJECT, available: true as const, path: join(root, "canonical") },
		];
		vi.spyOn(registry, "status").mockResolvedValue({ version: 1, workspaces: observed, projects: observed });
		const result = await list(base);
		for (const rows of [result.workspaces, result.projects]) {
			expect(rows.map((row) => row.id)).toEqual([PROJECT, OTHER, THIRD]);
			expect(rows[0].status).toEqual({ available: true, path: join(root, "canonical") });
			expect(rows[1].status).toEqual({ available: false, error: { code: "CONFLICT", message: "Changed identity" } });
			expect(rows[2].status).toEqual({
				available: false,
				error: { code: "UNAVAILABLE", message: expect.stringContaining("refresh") },
			});
		}
	});

	it("preserves unrelated records across concurrent separate registry and API writers", async () => {
		const { base } = await start();
		const cli = new CloudWorkspaceRegistry({ agentDir: dirname(registry.path) });
		const retained = await folder("retained");
		await cli.link(retained, { projectId: THIRD });
		const apiPath = await folder("api-project");
		const cliPath = await folder("cli-project");
		const apiDrive = await folder("api-drive");
		const cliDrive = await folder("cli-drive");
		const [apiLink, , apiConnect] = await Promise.all([
			http(base, "POST", `${API}/link`, { path: apiPath, projectId: PROJECT }),
			cli.link(cliPath, { projectId: OTHER }),
			http(base, "POST", `${API}/connect`, { path: apiDrive, initialize: true }),
			cli.connect(cliDrive, { initialize: true }),
		]);
		expect(apiLink.status).toBe(200);
		expect(apiConnect.status).toBe(200);
		const state = await list(base);
		expect(state.projects.map((entry) => entry.id)).toEqual([PROJECT, OTHER, THIRD]);
		expect(state.workspaces.map((entry) => entry.path).sort()).toEqual([apiDrive, cliDrive].sort());
		await Promise.all([http(base, "DELETE", `${API}/projects/${PROJECT}`), cli.unlink(OTHER)]);
		expect((await list(base)).projects.map((entry) => entry.id)).toEqual([THIRD]);
	});
});

describe("identity-targeted rebinds and filesystem failures", () => {
	it.each(["workspace", "project"] as const)(
		"rejects a %s row rebind to the wrong identity before registry or marker writes",
		async (kind) => {
			const current = await folder("current");
			const wrong = await folder("wrong");
			await marker(current, kind, PROJECT);
			await marker(wrong, kind, OTHER);
			if (kind === "workspace") await registry.connect(current);
			else await registry.link(current);
			const before = await fs.readFile(registry.path);
			const markerBytes = await Promise.all([current, wrong].map((path) => fs.readFile(markerPath(path, kind))));
			const { base } = await start();
			errorResult(
				await http(base, "PUT", `${API}/${kind === "workspace" ? "workspaces" : "projects"}/${PROJECT}`, {
					path: wrong,
				}),
				409,
				"CONFLICT",
			);
			expect(await fs.readFile(registry.path)).toEqual(before);
			expect(await Promise.all([current, wrong].map((path) => fs.readFile(markerPath(path, kind))))).toEqual(
				markerBytes,
			);
		},
	);

	it("rejects a workspace rebind without a marker without initializing a replacement", async () => {
		const path = await folder("drive");
		const blank = await folder("blank");
		const workspace = await registry.connect(path, { initialize: true });
		const before = await fs.readFile(registry.path);
		const { base } = await start();
		errorResult(await http(base, "PUT", `${API}/workspaces/${workspace.id}`, { path: blank }), 404, "NOT_FOUND");
		expect(await fs.readFile(registry.path)).toEqual(before);
		await absent(join(blank, ".dreb"));
	});

	it.each(["connect", "link"])("does not silently initialize a missing marker via %s", async (operation) => {
		const path = await folder("blank");
		const { base } = await start();
		errorResult(await http(base, "POST", `${API}/${operation}`, { path }), 404, "NOT_FOUND");
		await absent(registry.path);
		await absent(join(path, ".dreb"));
	});

	it.each(["workspace", "project"] as const)(
		"refuses initialization over a registered %s that lost its marker",
		async (kind) => {
			const path = await folder("registered");
			if (kind === "workspace") await registry.connect(path, { initialize: true });
			else await registry.link(path, { projectId: PROJECT });
			if (kind === "workspace") await fs.unlink(markerPath(path, kind));
			const before = await fs.readFile(registry.path);
			const { base } = await start();
			errorResult(
				await http(base, "POST", `${API}/${kind === "workspace" ? "connect" : "link"}`, { path, initialize: true }),
				409,
				"CONFLICT",
			);
			expect(await fs.readFile(registry.path)).toEqual(before);
			await absent(markerPath(path, kind));
		},
	);

	it.each(["malformed", "future", "symlink"])(
		"rejects %s registry storage and never resets it on initialization",
		async (kind) => {
			await fs.mkdir(dirname(registry.path), { recursive: true });
			const bytes = kind === "future" ? '{"version":99,"workspaces":[],"projects":[]}' : '{"version":';
			const target = join(root, "registry-target");
			if (kind === "symlink") {
				await fs.writeFile(target, bytes);
				await fs.symlink(target, registry.path, "file");
			} else await fs.writeFile(registry.path, bytes);
			const path = await folder("uninitialized");
			const { base } = await start();
			errorResult(await http(base, "GET", API), 422, "INVALID_METADATA");
			errorResult(await http(base, "POST", `${API}/connect`, { path, initialize: true }), 422, "INVALID_METADATA");
			expect(await fs.readFile(registry.path, "utf8")).toBe(bytes);
			if (kind === "symlink") expect((await fs.lstat(registry.path)).isSymbolicLink()).toBe(true);
			await absent(join(path, ".dreb"));
		},
	);

	it.each(["malformed", "future", "wrong-kind", "symlink-file", "symlink-directory"])(
		"rejects %s marker storage without overwriting it",
		async (kind) => {
			const path = await folder("bad-marker");
			await fs.mkdir(join(path, ".dreb"));
			const file = markerPath(path, "project");
			const bytes =
				kind === "malformed"
					? "{"
					: JSON.stringify({
							version: kind === "future" ? 99 : 1,
							kind: kind === "wrong-kind" ? "workspace" : "project",
							id: PROJECT,
						});
			if (kind === "symlink-file") {
				const target = join(root, "marker-target");
				await fs.writeFile(target, bytes);
				await fs.symlink(target, file, "file");
			} else if (kind === "symlink-directory") {
				await fs.rmdir(join(path, ".dreb"));
				const target = await folder("marker-directory");
				await fs.writeFile(join(target, "project.json"), bytes);
				await fs.symlink(target, join(path, ".dreb"), "dir");
			} else await fs.writeFile(file, bytes);
			const { base } = await start();
			errorResult(await http(base, "POST", `${API}/link`, { path, initialize: true }), 422, "INVALID_METADATA");
			expect(await fs.readFile(file, "utf8")).toBe(bytes);
			await absent(registry.path);
		},
	);

	it.each(["missing", "file"])("reports an unavailable %s path without creating metadata", async (kind) => {
		const path = join(root, "unavailable");
		if (kind === "file") await fs.writeFile(path, "synthetic non-directory");
		const { base } = await start();
		for (const operation of ["connect", "link"]) {
			errorResult(await http(base, "POST", `${API}/${operation}`, { path, initialize: true }), 409, "UNAVAILABLE");
		}
		await absent(registry.path);
	});

	it("rejects outside and symlink-escaped projects before initialization, and escaped mappings at use time", async () => {
		const drive = await folder("drive");
		const outside = await folder("outside");
		const alias = join(drive, "alias");
		await fs.symlink(outside, alias, "dir");
		const workspace = await registry.connect(drive, { initialize: true });
		const server = await start({ runtime: true });
		for (const path of [outside, alias]) {
			errorResult(
				await http(server.base, "POST", `${API}/link`, { path, initialize: true, workspaceId: workspace.id }),
				400,
				"INVALID_PATH",
			);
		}
		await absent(join(outside, ".dreb"));
		const projectPath = await folder("drive/project");
		const project = await registry.link(projectPath, { initialize: true, workspaceId: workspace.id });
		const moved = join(root, "escaped-project");
		await fs.rename(projectPath, moved);
		await fs.symlink(moved, projectPath, "dir");
		expect((await list(server.base)).projects[0].status).toMatchObject({
			available: false,
			error: { code: "INVALID_PATH" },
		});
		errorResult(await http(server.base, "POST", "/api/runtimes", { projectId: project.id }), 400, "INVALID_PATH");
		noSpawn(server);
	});

	it("projects an actual filesystem IO failure without stack or cause fields", async () => {
		await fs.writeFile(dirname(registry.path), "not a directory");
		const { base } = await start();
		errorResult(await http(base, "GET", API), 500, "IO_ERROR");
	});

	it.each(["connect", "link"])(
		"preserves the initialized marker after a controlled %s registration write failure and permits retry",
		async (operation) => {
			const path = await folder("initialize");
			const rename = fs.rename;
			// Inject only the final durable registry replacement failure; all marker creation,
			// locking, file writes and cleanup use the real filesystem (not chmod-dependent).
			const failure = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
				if (String(to) === registry.path)
					throw Object.assign(new Error("synthetic registry EACCES"), { code: "EACCES" });
				return rename(from, to);
			});
			const { base } = await start();
			const result = await http(base, "POST", `${API}/${operation}`, { path, initialize: true });
			errorResult(result, 500, "PARTIAL_INITIALIZATION");
			expect(result.body.error).toMatch(/preserved.*retry/);
			const file = markerPath(path, operation === "connect" ? "workspace" : "project");
			const bytes = await fs.readFile(file);
			const identity = JSON.parse(bytes.toString()).id;
			await absent(registry.path);
			expect(
				(await fs.readdir(dirname(registry.path))).filter(
					(name) => name.endsWith(".tmp") || name.endsWith(".lock"),
				),
			).toEqual([]);
			failure.mockRestore();
			expect((await http<{ id: string }>(base, "POST", `${API}/${operation}`, { path })).body.id).toBe(identity);
			expect(await fs.readFile(file)).toEqual(bytes);
		},
	);

	it("reports permission-denied resolution using a targeted access spy without relying on host chmod behavior", async () => {
		const path = await folder("denied");
		const access = fs.access;
		vi.spyOn(fs, "access").mockImplementation(async (target, mode) => {
			if (String(target) === path) throw Object.assign(new Error("synthetic EACCES"), { code: "EACCES" });
			return access(target, mode);
		});
		const { base } = await start();
		errorResult(await http(base, "POST", `${API}/link`, { path, projectId: PROJECT }), 409, "UNAVAILABLE");
		await absent(registry.path);
	});
});

const invalidRequests: Array<{ name: string; method: string; route: string; body?: unknown }> = [];
for (const route of ["/connect", "/link", `/workspaces/${WORKSPACE}`, `/projects/${PROJECT}`]) {
	const method = route === "/connect" || route === "/link" ? "POST" : "PUT";
	for (const [name, body] of [
		["absent", undefined],
		["null", null],
		["array", []],
		["string", "path"],
		["boolean", true],
		["number", 42],
		["missing path", {}],
		["null path", { path: null }],
		["numeric path", { path: 42 }],
		["relative path", { path: "relative/folder" }],
		["empty path", { path: "" }],
		["tilde path", { path: "~/project" }],
		["NUL path", { path: "/bad\0path" }],
		["unknown field", { path: "/unused", agentDir: "/override" }],
	] as const)
		invalidRequests.push({ name, method, route, body });
}
for (const route of ["/connect", "/link"]) {
	for (const initialize of ["true", 1, null, [], {}])
		invalidRequests.push({
			name: `invalid initialize ${JSON.stringify(initialize)}`,
			method: "POST",
			route,
			body: { path: "/unused", initialize },
		});
}
for (const key of ["projectId", "workspaceId"] as const) {
	for (const value of ["short-id", "11111111", null, 7, [], {}])
		invalidRequests.push({
			name: `invalid ${key} ${JSON.stringify(value)}`,
			method: "POST",
			route: "/link",
			body: { path: "/unused", [key]: value },
		});
}
for (const kind of ["workspaces", "projects"]) {
	for (const id of ["short-id", "11111111", "not-a-uuid"]) {
		for (const method of ["PUT", "DELETE"])
			invalidRequests.push({
				name: `invalid row ID ${id}`,
				method,
				route: `/${kind}/${id}`,
				body: method === "PUT" ? { path: "/unused" } : undefined,
			});
	}
	for (const body of [null, [], { path: "/unused" }, { initialize: true }])
		invalidRequests.push({
			name: `invalid delete body ${JSON.stringify(body)}`,
			method: "DELETE",
			route: `/${kind}/${PROJECT}`,
			body,
		});
}
invalidRequests.push(
	{
		name: "initialize and known ID",
		method: "POST",
		route: "/link",
		body: { path: "/unused", initialize: true, projectId: PROJECT },
	},
	{
		name: "connect known project ID",
		method: "POST",
		route: "/connect",
		body: { path: "/unused", projectId: PROJECT },
	},
	{ name: "client rebind flag", method: "POST", route: "/link", body: { path: "/unused", rebind: true } },
	{
		name: "workspace rebind initialize",
		method: "PUT",
		route: `/workspaces/${WORKSPACE}`,
		body: { path: "/unused", initialize: true },
	},
	{
		name: "project rebind supplied ID",
		method: "PUT",
		route: `/projects/${PROJECT}`,
		body: { path: "/unused", projectId: OTHER },
	},
	{
		name: "project rebind invalid workspace",
		method: "PUT",
		route: `/projects/${PROJECT}`,
		body: { path: "/unused", workspaceId: null },
	},
);
if (process.platform !== "win32") {
	// These are native absolute paths on Windows; never assert their rejection there.
	for (const path of ["C:\\Foreign\\Project", "\\\\server\\share\\project"])
		invalidRequests.push({
			name: `foreign Windows path ${path}`,
			method: "POST",
			route: "/link",
			body: { path, projectId: PROJECT },
		});
}

describe("strict metadata request validation", () => {
	it.each([
		["GET", `${API}?agentDir=%2Foverride`, undefined],
		["POST", `${API}/connect?initialize=true`, { path: "/unused" }],
		["GET", API, { registryPath: "/override" }],
	] as const)("rejects unsupported query/body inputs before registry access: %s %s", async (method, path, body) => {
		const server = await start();
		errorResult(await http(server.base, method, path, body), 400, "INVALID_REQUEST");
		noRegistryCalls(server.registryCalls);
	});
	it.each(invalidRequests)("$method $route: $name", async ({ method, route, body }) => {
		const { base, registryCalls } = await start();
		errorResult(await http(base, method, `${API}${route}`, body), 400, "INVALID_REQUEST");
		noRegistryCalls(registryCalls);
		await absent(dirname(registry.path));
	});

	it.each(["/connect", "/link", `/workspaces/${WORKSPACE}`, `/projects/${PROJECT}`])(
		"rejects malformed JSON before registry access on %s",
		async (route) => {
			const { base, registryCalls } = await start();
			const method = route === "/connect" || route === "/link" ? "POST" : "PUT";
			errorResult(await http(base, method, `${API}${route}`, undefined, {}, '{"path":'), 400, "INVALID_REQUEST");
			noRegistryCalls(registryCalls);
		},
	);

	it("accepts a 16 KiB JSON body and rejects a body one byte over the metadata limit", async () => {
		const path = await folder("path");
		await marker(path, "workspace", WORKSPACE);
		const json = JSON.stringify({ path });
		const { base } = await start();
		const exact = json + " ".repeat(16 * 1024 - Buffer.byteLength(json));
		expect((await http(base, "POST", `${API}/connect`, undefined, {}, exact)).status).toBe(200);
		const calls = vi.spyOn(registry, "connect");
		calls.mockClear();
		errorResult(await http(base, "POST", `${API}/connect`, undefined, {}, `${exact} `), 413, "INVALID_REQUEST");
		expect(calls).not.toHaveBeenCalled();
	});

	it.each(["POST", "PUT", "DELETE"])(
		"caps case-variant/trailing-slash %s metadata requests before registry access",
		async (method) => {
			const route = method === "POST" ? "/CONNECT/" : `/projects/${PROJECT}/`;
			const { base, registryCalls } = await start();
			errorResult(
				await http(base, method, `/API/CLOUD-WORKSPACES${route}`, { path: "x".repeat(16 * 1024) }),
				413,
				"INVALID_REQUEST",
			);
			noRegistryCalls(registryCalls);
		},
	);
});

describe("synthetic error projection (separate from actual filesystem cases)", () => {
	const statuses: Array<[CloudWorkspaceErrorCode, number]> = [
		["INVALID_METADATA", 422],
		["INVALID_PATH", 400],
		["NOT_FOUND", 404],
		["CONFLICT", 409],
		["UNAVAILABLE", 409],
		["IO_ERROR", 500],
		["PARTIAL_INITIALIZATION", 500],
	];
	it.each(statuses)("projects shared %s as HTTP %s without serializing causes/stacks", async (code, status) => {
		const { base } = await start();
		const error = new CloudWorkspaceError(code, "Synthetic actionable guidance; inspect storage and retry.", {
			cause: new Error("private cause"),
		});
		vi.spyOn(registry, "status").mockRejectedValueOnce(error);
		const result = await http(base, "GET", API);
		errorResult(result, status, code);
		expect(result.body.error).toBe(error.message);
		expect(JSON.stringify(result.body)).not.toMatch(/private cause|stack|CloudWorkspaceError/);
	});

	it("sanitizes an unexpected non-registry exception", async () => {
		const { base } = await start();
		vi.spyOn(registry, "list").mockRejectedValueOnce(
			new Error("private unexpected detail", { cause: new Error("private cause") }),
		);
		const result = await http(base, "GET", API);
		errorResult(result, 500, "IO_ERROR");
		expect(result.body.error).toContain("storage permissions");
		expect(JSON.stringify(result.body)).not.toContain("private");
	});
});

const endpoints = [
	["GET", API],
	["GET", `${API}/session-storage`],
	["PUT", `${API}/session-storage`],
	["POST", `${API}/connect`],
	["POST", `${API}/link`],
	["PUT", `${API}/workspaces/${WORKSPACE}`],
	["PUT", `${API}/projects/${PROJECT}`],
	["DELETE", `${API}/workspaces/${WORKSPACE}`],
	["DELETE", `${API}/projects/${PROJECT}`],
	["POST", "/api/runtimes"],
] as const;

/** Simulate only the peer address while retaining real DashboardAuth allowlist/pairing/error logic. */
function remoteAuth(mode: "unpaired" | "disallowed" | "resolver-error" | "paired") {
	const resolve = vi.fn(async () => {
		if (mode === "resolver-error") throw new Error("synthetic resolver failure");
		return {
			loginName: mode === "disallowed" ? "mallory@example.test" : "alice@example.test",
			device: "synthetic-phone",
		};
	});
	const auth = new DashboardAuth({
		remoteEnabled: true,
		allowedIdentities: ["alice@example.test"],
		resolver: { resolve },
		storage: new MemoryPairingStorage(),
	});
	const authenticate = auth.authenticate.bind(auth);
	vi.spyOn(auth, "authenticate").mockImplementation((info) => authenticate({ ...info, remoteAddress: "100.64.0.10" }));
	return { auth, resolve };
}

describe("cloud endpoints stay behind fail-closed Dashboard authentication", () => {
	it.each(["host", "origin", "unpaired", "disallowed", "resolver-error", "middleware-error"] as const)(
		"rejects every new endpoint for %s before body parsing or registry/runtime access",
		async (mode) => {
			let auth = new DashboardAuth();
			let headers: Record<string, string> = {};
			let status = 403;
			if (mode === "host") headers = { host: "attacker.example" };
			else if (mode === "origin") headers = { origin: "https://attacker.example" };
			else if (mode === "middleware-error") {
				vi.spyOn(auth, "authenticate").mockRejectedValue(new Error("synthetic auth subsystem exception"));
				status = 500;
			} else {
				auth = remoteAuth(mode).auth;
				status = mode === "unpaired" ? 401 : mode === "resolver-error" ? 500 : 403;
			}
			const server = await start({ auth });
			for (const [method, path] of endpoints) {
				const result = await http(
					server.base,
					method,
					path,
					undefined,
					headers,
					method === "GET" ? undefined : '{"invalid":',
				);
				expect(result.status, `${method} ${path}`).toBe(status);
				expect(result.body.error).toEqual(expect.any(String));
				if (mode === "unpaired") expect(result.body).toMatchObject({ needsPairing: true });
			}
			noRegistryCalls(server.registryCalls);
			noSpawn(server);
			await absent(dirname(registry.path));
		},
	);

	it("allows real paired remote metadata operations without an endpoint bypass", async () => {
		const { auth, resolve } = remoteAuth("paired");
		const info: AuthRequestInfo = {
			remoteAddress: "100.64.0.10",
			hostHeader: "dashboard.example.test",
			originHeader: undefined,
			deviceToken: undefined,
		};
		const paired = await auth.pair(info, auth.currentPairingCode().code);
		const headers = { cookie: `dreb_dashboard_device=${paired.token}` };
		const { base } = await start({ auth });
		const path = await folder("paired-workspace");
		const project = await folder("paired-project");
		expect((await http(base, "GET", API, undefined, headers)).status).toBe(200);
		const workspace = await http<CloudWorkspaceDto>(
			base,
			"POST",
			`${API}/connect`,
			{ path, initialize: true },
			headers,
		);
		expect(workspace.status).toBe(200);
		expect((await http(base, "POST", `${API}/link`, { path: project, projectId: PROJECT }, headers)).status).toBe(
			200,
		);
		expect((await http(base, "PUT", `${API}/workspaces/${workspace.body.id}`, { path }, headers)).status).toBe(200);
		expect((await http(base, "PUT", `${API}/projects/${PROJECT}`, { path: project }, headers)).status).toBe(200);
		for (const route of [`/projects/${PROJECT}`, `/workspaces/${workspace.body.id}`])
			expect((await http(base, "DELETE", `${API}${route}`, undefined, headers)).body).toEqual({ removed: true });
		expect(resolve).toHaveBeenCalledWith("100.64.0.10");
	});
});

const invalidRuntimeBodies: unknown[] = [
	undefined,
	null,
	[],
	"directory",
	{},
	{ cwd: "/unused", projectId: PROJECT },
	{ cwd: null },
	{ cwd: 1 },
	{ cwd: [] },
	{ projectId: null },
	{ projectId: 1 },
	{ projectId: [] },
	{ projectId: "short" },
	{ projectId: PROJECT, path: "/stale-ui-path" },
	{ projectId: PROJECT, source: "project" },
	...["sessionPath", "firstPrompt"].flatMap((key) =>
		[null, 42, false, [], {}].flatMap((value) => [
			{ cwd: "/unused", [key]: value },
			{ projectId: PROJECT, [key]: value },
		]),
	),
];

describe("explicit runtime directory selection", () => {
	it.each(invalidRuntimeBodies.map((body) => ({ name: JSON.stringify(body), body })))(
		"rejects $name without spawning or looking up a project",
		async ({ body }) => {
			const server = await start({ runtime: true });
			try {
				errorResult(await http(server.base, "POST", "/api/runtimes", body), 400, "INVALID_REQUEST");
			} finally {
				noRegistryCalls(server.registryCalls);
				noSpawn(server);
			}
		},
	);

	it("keeps legacy local canonicalization, exact transcript path and firstPrompt without registry access", async () => {
		const path = await folder("local-project");
		const alias = join(root, "local-alias");
		await fs.symlink(path, alias, "dir");
		const transcript = join(root, "synthetic exact history.jsonl");
		const bytes = Buffer.from('{"type":"session","cwd":"/historical/missing","version":3}\n');
		await fs.writeFile(transcript, bytes);
		const server = await start({ runtime: true });
		const result = await http<RuntimeInfoDto>(server.base, "POST", "/api/runtimes", {
			cwd: alias,
			sessionPath: transcript,
			firstPrompt: "  exact first prompt\n",
		});
		expect(result.status).toBe(201);
		expect(result.body.cwd).toBe(path);
		expect(result.body.state.sessionFile).toBe(transcript);
		expect(server.create).toHaveBeenCalledWith(path, transcript);
		expect(server.clientFactory).toHaveBeenCalledWith({
			cliPath: join(root, "never-executed-cli.js"),
			cwd: path,
			args: ["--ui", "dashboard", "--session", transcript],
		});
		expect(server.clients[0].prompt).toHaveBeenCalledExactlyOnceWith("  exact first prompt\n");
		noRegistryCalls(server.registryCalls);
		expect(await fs.readFile(transcript)).toEqual(bytes);
	});

	it("keeps the uninjected default registry lazy on ordinary local creation", async () => {
		vi.stubEnv("DREB_CODING_AGENT_DIR", join(root, "default-agent"));
		const methods = REGISTRY_METHODS.map((name) => vi.spyOn(CloudWorkspaceRegistry.prototype, name));
		const path = await folder("local");
		const server = await start({ runtime: true, defaultRegistry: true });
		expect((await http(server.base, "POST", "/api/runtimes", { cwd: path })).status).toBe(201);
		for (const method of methods) expect(method).not.toHaveBeenCalled();
		await absent(join(root, "default-agent"));
	});

	it("resolves the selected ID afresh after a rebind and preserves canonical cwd, exact resume path and prompt", async () => {
		const old = await folder("old");
		const next = await folder("next");
		const alias = join(root, "next-alias");
		await fs.symlink(next, alias, "dir");
		await registry.link(old, { projectId: PROJECT });
		const server = await start({ runtime: true });
		expect((await list(server.base)).projects[0].status).toEqual({ available: true, path: old });
		expect((await http(server.base, "PUT", `${API}/projects/${PROJECT}`, { path: alias })).status).toBe(200);
		const transcriptStore = await folder("transcript-store");
		const transcriptAlias = join(root, "transcript-alias");
		await fs.symlink(transcriptStore, transcriptAlias, "dir");
		const transcript = join(transcriptAlias, "parent exact transcript.jsonl");
		const bytes = Buffer.from('{"type":"session","cwd":"/historical/parent"}\n{"synthetic":"unchanged"}\n');
		await fs.writeFile(transcript, bytes);
		const result = await http<RuntimeInfoDto>(server.base, "POST", "/api/runtimes", {
			projectId: PROJECT.toUpperCase(),
			sessionPath: transcript,
			firstPrompt: "continue exactly\n",
		});
		expect(result.status).toBe(201);
		expect(result.body.cwd).toBe(next);
		expect(result.body.state.sessionFile).toBe(transcript);
		expect(registry.resolve).toHaveBeenCalledExactlyOnceWith(PROJECT);
		expect(server.create).toHaveBeenCalledExactlyOnceWith(next, transcript);
		expect(server.clientFactory.mock.calls[0][0]).toEqual({
			cliPath: join(root, "never-executed-cli.js"),
			cwd: next,
			args: ["--ui", "dashboard", "--session", transcript],
		});
		expect(server.clients[0].prompt).toHaveBeenCalledExactlyOnceWith("continue exactly\n");
		expect(await fs.readFile(transcript)).toEqual(bytes);
	});

	it.each([
		"project-changed",
		"project-missing",
		"workspace-changed",
		"workspace-missing",
		"directory-removed",
		"directory-replaced",
		"mapping-deleted",
		"workspace-disconnected",
	] as const)("revalidates a displayed project after %s and never spawns or falls back", async (change) => {
		const drive = await folder("drive");
		const path = await folder("drive/project");
		const workspace = await registry.connect(drive, { initialize: true });
		const project = await registry.link(path, { initialize: true, workspaceId: workspace.id });
		const server = await start({ runtime: true });
		expect((await list(server.base)).projects[0].status).toEqual({ available: true, path });
		if (change === "project-changed") await marker(path, "project", OTHER);
		if (change === "project-missing") await fs.unlink(markerPath(path, "project"));
		if (change === "workspace-changed") await marker(drive, "workspace", OTHER);
		if (change === "workspace-missing") await fs.unlink(markerPath(drive, "workspace"));
		if (change === "directory-removed" || change === "directory-replaced") await fs.rm(path, { recursive: true });
		if (change === "directory-replaced") await fs.writeFile(path, "synthetic replacement, not a directory");
		if (change === "mapping-deleted") await registry.unlink(project.id);
		if (change === "workspace-disconnected") await registry.disconnect(workspace.id);
		const missing = change === "mapping-deleted" || change === "workspace-disconnected";
		errorResult(
			await http(server.base, "POST", "/api/runtimes", { projectId: project.id }),
			missing ? 404 : 409,
			missing ? "NOT_FOUND" : change.startsWith("directory-") ? "UNAVAILABLE" : "CONFLICT",
		);
		noSpawn(server);
	});

	it("starts a new linked-project runtime after workspace rebind without inventing a resume path", async () => {
		const first = await folder("first-drive");
		const firstProject = await folder("first-drive/project");
		const next = await folder("next-drive");
		const nextProject = await folder("next-drive/project");
		const workspace = await registry.connect(first, { initialize: true });
		const project = await registry.link(firstProject, { initialize: true, workspaceId: workspace.id });
		await copyMarker(first, next, "workspace");
		await copyMarker(firstProject, nextProject, "project");
		const server = await start({ runtime: true });
		expect((await list(server.base)).projects[0].status).toEqual({ available: true, path: firstProject });
		expect((await http(server.base, "PUT", `${API}/workspaces/${workspace.id}`, { path: next })).status).toBe(200);
		const result = await http<RuntimeInfoDto>(server.base, "POST", "/api/runtimes", {
			projectId: project.id,
			firstPrompt: "",
		});
		expect(result.status).toBe(201);
		expect(result.body.cwd).toBe(nextProject);
		expect(result.body.state.sessionFile).toBeUndefined();
		expect(server.create).toHaveBeenCalledExactlyOnceWith(nextProject, undefined);
		expect(server.clientFactory.mock.calls[0][0].args).toEqual(["--ui", "dashboard"]);
		expect(server.clients[0].prompt).not.toHaveBeenCalled();
	});

	it("rechecks a newly added conflicting marker on a markerless binding", async () => {
		const path = await folder("markerless");
		await registry.link(path, { projectId: PROJECT });
		const server = await start({ runtime: true });
		expect((await list(server.base)).projects[0].status.available).toBe(true);
		await marker(path, "project", OTHER);
		errorResult(await http(server.base, "POST", "/api/runtimes", { projectId: PROJECT }), 409, "CONFLICT");
		noSpawn(server);
	});

	it("retains the existing final canonical-directory checks after project resolution", async () => {
		const notDirectory = join(root, "not-a-directory");
		await fs.writeFile(notDirectory, "synthetic");
		const server = await start({ runtime: true });
		// Controlled post-resolution race: the existing directory checker, not the
		// mocked resolution, must reject this before pool.create can run.
		vi.spyOn(registry, "resolve").mockResolvedValueOnce(notDirectory);
		const result = await http(server.base, "POST", "/api/runtimes", { projectId: PROJECT });
		expect(result.status).toBe(400);
		noSpawn(server);
	});

	it("rejects a missing legacy local directory without consulting the registry", async () => {
		const server = await start({ runtime: true });
		const result = await http(server.base, "POST", "/api/runtimes", { cwd: join(root, "missing") });
		expect(result.status).toBe(404);
		noRegistryCalls(server.registryCalls);
		noSpawn(server);
	});
});
