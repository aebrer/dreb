import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getCloudWorkspaceRegistryPath } from "../src/config.js";
import { CloudWorkspaceRegistry } from "../src/core/cloud-workspaces/registry.js";
import { CloudWorkspaceStorage } from "../src/core/cloud-workspaces/storage.js";
import { CloudWorkspaceError, type CloudWorkspaceState } from "../src/core/cloud-workspaces/types.js";

// A mutable facade permits targeted IO failures without changing Node's built-in exports.
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const EMPTY = { version: 1, workspaces: [], projects: [] };
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WRITER = fileURLToPath(new URL("./fixtures/cloud-workspace-writer.ts", import.meta.url));
const REGISTRY_LIMIT = 4 * 1024 * 1024;
const MARKER_LIMIT = 4096;

function ioError(message: string, code = "EACCES"): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

function localProject(path: string, id = PROJECT_ID) {
	return { id, location: { kind: "local" as const, path }, markerRequired: false };
}

function workspaceProject(relativePath: string) {
	return {
		id: PROJECT_ID,
		location: { kind: "workspace", workspaceId: WORKSPACE_ID, relativePath },
		markerRequired: true,
	};
}

const invalidRegistries: { name: string; bytes: (path: string) => string; code: string }[] = [
	{ name: "invalid JSON", bytes: () => "not JSON\n", code: "INVALID_METADATA" },
	{ name: "truncated JSON", bytes: () => '{"version":1,"workspaces":[', code: "INVALID_METADATA" },
	{ name: "unsupported version", bytes: () => JSON.stringify({ ...EMPTY, version: 2 }), code: "INVALID_METADATA" },
	{
		name: "unknown registry field",
		bytes: () => JSON.stringify({ ...EMPTY, trusted: true }),
		code: "INVALID_METADATA",
	},
	{ name: "missing projects", bytes: () => '{"version":1,"workspaces":[]}', code: "INVALID_METADATA" },
	{
		name: "duplicate workspace IDs",
		bytes: (path) =>
			JSON.stringify({
				...EMPTY,
				workspaces: [
					{ id: WORKSPACE_ID, path },
					{ id: WORKSPACE_ID, path },
				],
			}),
		code: "CONFLICT",
	},
	{
		name: "duplicate project IDs",
		bytes: (path) => JSON.stringify({ ...EMPTY, projects: [localProject(path), localProject(path)] }),
		code: "CONFLICT",
	},
	{
		name: "unknown workspace field",
		bytes: (path) => JSON.stringify({ ...EMPTY, workspaces: [{ id: WORKSPACE_ID, path, secret: "not-allowed" }] }),
		code: "INVALID_METADATA",
	},
	{
		name: "unknown project field",
		bytes: (path) => JSON.stringify({ ...EMPTY, projects: [{ ...localProject(path), trusted: true }] }),
		code: "INVALID_METADATA",
	},
	{
		name: "unknown location field",
		bytes: (path) =>
			JSON.stringify({
				...EMPTY,
				projects: [{ ...localProject(path), location: { kind: "local", path, token: "not-allowed" } }],
			}),
		code: "INVALID_METADATA",
	},
	{
		name: "nonboolean marker requirement",
		bytes: (path) => JSON.stringify({ ...EMPTY, projects: [{ ...localProject(path), markerRequired: "false" }] }),
		code: "INVALID_METADATA",
	},
	{
		name: "invalid registry identity",
		bytes: (path) => JSON.stringify({ ...EMPTY, projects: [localProject(path, "short-id")] }),
		code: "INVALID_METADATA",
	},
	...[
		["relative", "relative/project"],
		["NUL-containing", "/project\0invalid"],
		["foreign-native", "C:\\projects\\example"],
	].flatMap(([name, path]) => [
		{
			name: `${name} workspace path`,
			bytes: () => JSON.stringify({ ...EMPTY, workspaces: [{ id: WORKSPACE_ID, path }] }),
			code: "INVALID_PATH",
		},
		{
			name: `${name} local project path`,
			bytes: () => JSON.stringify({ ...EMPTY, projects: [localProject(path)] }),
			code: "INVALID_PATH",
		},
	]),
	...[
		"../escape",
		"project/../escape",
		"/absolute",
		"project\\escape",
		"C:/escape",
		"project//child",
		"./child",
		"",
	].map((path) => ({
		name: `nonportable/traversing workspace project location ${JSON.stringify(path)}`,
		bytes: () => JSON.stringify({ ...EMPTY, projects: [workspaceProject(path)] }),
		code: "INVALID_PATH",
	})),
];

const invalidMarkers = [
	{ name: "invalid JSON", bytes: () => "not JSON" },
	{ name: "truncated JSON", bytes: () => '{"version":1,' },
	{ name: "empty file", bytes: () => "" },
	{ name: "unsupported version", bytes: (kind: string) => JSON.stringify({ version: 2, kind, id: PROJECT_ID }) },
	{
		name: "wrong kind",
		bytes: (kind: string) =>
			JSON.stringify({ version: 1, kind: kind === "workspace" ? "project" : "workspace", id: PROJECT_ID }),
	},
	{ name: "invalid ID", bytes: (kind: string) => JSON.stringify({ version: 1, kind, id: "short-id" }) },
	{
		name: "extra secret field",
		bytes: (kind: string) => JSON.stringify({ version: 1, kind, id: PROJECT_ID, apiKey: "not-allowed" }),
	},
	{
		name: "extra trust field",
		bytes: (kind: string) => JSON.stringify({ version: 1, kind, id: PROJECT_ID, trusted: true }),
	},
	{
		name: "oversized marker",
		bytes: (kind: string) => JSON.stringify({ version: 1, kind, id: PROJECT_ID }).padEnd(MARKER_LIMIT + 1, " "),
	},
];

describe("cloud workspace durable local storage", () => {
	let root: string;
	let agentDir: string;
	let registry: CloudWorkspaceRegistry;
	let registryPath: string;
	const children = new Set<ChildProcess>();

	beforeEach(async () => {
		// Canonical temp roots avoid macOS /var versus /private/var aliases in expectations.
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "dreb-cloud-storage-")));
		agentDir = join(root, "agent");
		registry = new CloudWorkspaceRegistry({ agentDir });
		registryPath = join(agentDir, "cloud-workspaces.json");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(
			[...children].map(
				(child) =>
					new Promise<void>((resolve) => {
						child.once("close", () => resolve());
						child.kill("SIGKILL");
					}),
			),
		);
		children.clear();
		await fs.rm(root, { recursive: true, force: true });
	});

	async function directory(name: string): Promise<string> {
		const path = join(root, name);
		await fs.mkdir(path, { recursive: true });
		return path;
	}

	async function seedRegistry(): Promise<Buffer> {
		await fs.mkdir(agentDir, { recursive: true });
		const old = Buffer.from(
			`  ${JSON.stringify({ ...EMPTY, projects: [localProject(await directory("existing"))] })}\n\n`,
		);
		await fs.writeFile(registryPath, old);
		return old;
	}

	async function expectCleanRegistryDirectory() {
		expect(await fs.readdir(agentDir)).toEqual(["cloud-workspaces.json"]);
	}

	function initialize(kind: "workspace" | "project", path: string) {
		return kind === "workspace"
			? registry.connect(path, { initialize: true })
			: registry.link(path, { initialize: true });
	}

	function runWriter(
		path: string,
		id: string,
	): Promise<{ id: string; code: number | null; signal: string | null; stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			// Resolve tsx from the repository, never a user's cwd or global installation.
			const child = spawn(process.execPath, ["--import", "tsx", WRITER, agentDir, path, id], {
				cwd: REPO_ROOT,
				env: {
					PATH: process.env.PATH,
					SystemRoot: process.env.SystemRoot,
					HOME: root,
					USERPROFILE: root,
					DREB_LIVE_API: "0",
					DREB_LIVE_API_EXPENSIVE: "0",
					DREB_NO_LOCAL_LLM: "1",
					TSX_DISABLE_CACHE: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.add(child);
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			child.stdout.on("data", (bytes) => {
				stdout += bytes.toString();
			});
			child.stderr.on("data", (bytes) => {
				stderr += bytes.toString();
			});
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, 15_000);
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("close", (code, signal) => {
				clearTimeout(timer);
				children.delete(child);
				resolve({
					id,
					code,
					signal,
					stdout,
					stderr: `${timedOut ? "Writer exceeded 15s deadline.\n" : ""}${stderr}`,
				});
			});
		});
	}

	test("absent read/list/status do not create the explicit agent directory", async () => {
		expect(registry.path).toBe(registryPath);
		expect(getCloudWorkspaceRegistryPath(agentDir)).toBe(registryPath);
		expect(await new CloudWorkspaceStorage(agentDir).read()).toEqual(EMPTY);
		expect(await registry.list()).toEqual(EMPTY);
		expect(await registry.status()).toEqual(EMPTY);
		await expect(fs.lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readdir(root)).toEqual([]);
	});

	test("independent instances observe durable known-ID links and removals without markers or stale caches", async () => {
		const other = new CloudWorkspaceRegistry({ agentDir });
		const path = await directory("project");
		expect(await other.list()).toEqual(EMPTY);
		expect(await registry.link(path, { projectId: PROJECT_ID })).toEqual(localProject(path));
		expect(await fs.readdir(path)).toEqual([]);
		expect(await other.list()).toEqual({ ...EMPTY, projects: [localProject(path)] });
		expect(await other.resolve(PROJECT_ID)).toBe(path);
		expect(await other.unlink(PROJECT_ID)).toBe(true);
		expect(await registry.list()).toEqual(EMPTY);
		expect(await registry.unlink(PROJECT_ID)).toBe(false);
	});

	test("resolve requires an existing readable directory and never recreates a missing project", async () => {
		const path = await directory("project");
		await registry.link(path, { projectId: PROJECT_ID });
		await fs.rm(path, { recursive: true });
		await expect(registry.resolve(PROJECT_ID)).rejects.toMatchObject({ code: "UNAVAILABLE" });
		expect(await registry.status()).toMatchObject({
			projects: [{ id: PROJECT_ID, available: false, error: { code: "UNAVAILABLE" } }],
		});
		await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test.each(invalidRegistries)(
		"rejects $name without resetting bytes or creating any selected marker",
		async ({ bytes, code }) => {
			const path = await directory("selected-cloud-folder");
			await fs.mkdir(agentDir);
			const original = Buffer.from(bytes(path));
			await fs.writeFile(registryPath, original);
			await expect(new CloudWorkspaceStorage(agentDir).read()).rejects.toMatchObject({ code });
			await expect(registry.list()).rejects.toMatchObject({ code });
			await expect(registry.status()).rejects.toMatchObject({ code });
			// Removal exercises storage's locked re-read rather than only a registry preflight read.
			await expect(registry.unlink(PROJECT_ID)).rejects.toMatchObject({ code });
			await expect(registry.link(path, { projectId: OTHER_ID })).rejects.toMatchObject({ code });
			await expect(registry.connect(path, { initialize: true })).rejects.toMatchObject({ code });
			await expect(registry.link(path, { initialize: true })).rejects.toMatchObject({ code });
			expect(await fs.readFile(registryPath)).toEqual(original);
			expect(await fs.readdir(path)).toEqual([]);
			await expectCleanRegistryDirectory();
		},
	);

	test.each(["directory", "symlink", "empty", "oversized"] as const)(
		"rejects registry as %s and preserves the existing file/target",
		async (shape) => {
			await fs.mkdir(agentDir);
			const target = join(root, "target.json");
			const targetBytes = Buffer.from(`${JSON.stringify(EMPTY)}\n`);
			await fs.writeFile(target, targetBytes);
			if (shape === "directory") await fs.mkdir(registryPath);
			else if (shape === "symlink") await fs.symlink(target, registryPath);
			else
				await fs.writeFile(
					registryPath,
					shape === "empty" ? "" : JSON.stringify(EMPTY).padEnd(REGISTRY_LIMIT + 1, " "),
				);
			const original = shape === "directory" ? undefined : await fs.readFile(registryPath);
			await expect(registry.list()).rejects.toMatchObject({ code: "INVALID_METADATA" });
			await expect(registry.unlink(PROJECT_ID)).rejects.toMatchObject({ code: "INVALID_METADATA" });
			expect(await fs.readFile(target)).toEqual(targetBytes);
			if (shape === "directory") expect(await fs.readdir(registryPath)).toEqual([]);
			else expect((await fs.readFile(registryPath)).equals(original!)).toBe(true);
			if (shape === "symlink") expect((await fs.lstat(registryPath)).isSymbolicLink()).toBe(true);
			await expectCleanRegistryDirectory();
		},
	);

	describe.each(["workspace", "project"] as const)("%s marker protections", (kind) => {
		test.each(invalidMarkers)("rejects $name without overwriting metadata", async ({ bytes }) => {
			const path = await directory("cloud-folder");
			await fs.mkdir(join(path, ".dreb"));
			const markerPath = join(path, ".dreb", `${kind}.json`);
			const original = Buffer.from(bytes(kind));
			await fs.writeFile(markerPath, original);
			await expect(initialize(kind, path)).rejects.toMatchObject({ code: "INVALID_METADATA" });
			expect(await fs.readFile(markerPath)).toEqual(original);
			await expect(fs.lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
		});

		test.each(["marker directory symlink", "marker file symlink", "marker is a directory"] as const)(
			"rejects %s without modifying its target",
			async (shape) => {
				const path = await directory("cloud-folder");
				const targetDir = await directory("target");
				const target = join(targetDir, `${kind}.json`);
				const original = Buffer.from(`${JSON.stringify({ version: 1, kind, id: PROJECT_ID })}\n`);
				await fs.writeFile(target, original);
				const markerDir = join(path, ".dreb");
				const markerPath = join(markerDir, `${kind}.json`);
				if (shape === "marker directory symlink") await fs.symlink(targetDir, markerDir, "dir");
				else {
					await fs.mkdir(markerDir);
					if (shape === "marker file symlink") await fs.symlink(target, markerPath);
					else await fs.mkdir(markerPath);
				}
				await expect(initialize(kind, path)).rejects.toMatchObject({ code: "INVALID_METADATA" });
				expect(await fs.readFile(target)).toEqual(original);
				expect(await fs.readdir(targetDir)).toEqual([`${kind}.json`]);
				expect(
					(await fs.lstat(shape === "marker directory symlink" ? markerDir : markerPath)).isSymbolicLink(),
				).toBe(shape !== "marker is a directory");
				await expect(fs.lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
			},
		);
	});

	test("two independent instances preserve unrelated registrations in a first-write race", async () => {
		const paths = await Promise.all([directory("first"), directory("second")]);
		const other = new CloudWorkspaceRegistry({ agentDir });
		await Promise.all([
			registry.link(paths[0], { projectId: PROJECT_ID }),
			other.link(paths[1], { projectId: OTHER_ID }),
		]);
		const expected = { ...EMPTY, projects: [localProject(paths[0]), localProject(paths[1], OTHER_ID)] };
		expect(await registry.list()).toEqual(expected);
		expect(await other.list()).toEqual(expected);
		expect(JSON.parse(await fs.readFile(registryPath, "utf8"))).toEqual(expected);
		await expectCleanRegistryDirectory();
	});

	test("eight actual subprocess writers starting from a missing registry preserve every registration", async () => {
		const registrations = await Promise.all(
			Array.from({ length: 8 }, async (_, index) => ({
				id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
				path: await directory(`writer-${index}`),
			})),
		);
		await expect(fs.lstat(registryPath)).rejects.toMatchObject({ code: "ENOENT" });
		const results = await Promise.all(registrations.map(({ id, path }) => runWriter(path, id)));
		expect(
			results.filter(({ code, signal, stderr }) => code !== 0 || signal !== null || stderr.includes("deadline")),
			JSON.stringify(results, null, 2),
		).toEqual([]);
		const expected = { ...EMPTY, projects: registrations.map(({ id, path }) => localProject(path, id)) };
		expect(await registry.list()).toEqual(expected);
		expect(JSON.parse(await fs.readFile(registryPath, "utf8"))).toEqual(expected);
		for (const { path } of registrations) expect(await fs.readdir(path)).toEqual([]);
		await expectCleanRegistryDirectory();
	}, 20_000);

	test.each(["canonical", "symlink alias"] as const)(
		"a held %s local lock bounds retries and reports an actionable error",
		async (shape) => {
			await fs.mkdir(agentDir);
			const path = await directory("project");
			let selected = registry;
			if (shape === "symlink alias") {
				const alias = join(root, "agent-alias");
				await fs.symlink(agentDir, alias, "dir");
				selected = new CloudWorkspaceRegistry({ agentDir: alias });
			}
			const release = await lockfile.lock(registryPath, { realpath: false, retries: 0 });
			const lock = vi.spyOn(lockfile, "lock");
			const start = performance.now();
			try {
				await expect(selected.link(path, { projectId: PROJECT_ID })).rejects.toMatchObject({
					code: "IO_ERROR",
					message: expect.stringMatching(/Cannot acquire local cloud-registry lock.*already being held/i),
				});
				expect(performance.now() - start).toBeLessThan(5_000);
				expect(lock).toHaveBeenCalledExactlyOnceWith(registryPath, {
					realpath: false,
					retries: { retries: 40, factor: 1, minTimeout: 25, maxTimeout: 25, randomize: false },
				});
				await expect(fs.lstat(registryPath)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				await release();
			}
			expect(await fs.readdir(agentDir)).toEqual([]);
			await selected.link(path, { projectId: PROJECT_ID });
			await expectCleanRegistryDirectory();
		},
		7_000,
	);

	test("atomic persistence uses an exclusive 0600 temp file, full JSON, fsync, close, then rename", async () => {
		const old = await seedRegistry();
		const path = await directory("new-project");
		const open = fs.open;
		const rename = fs.rename;
		const events: string[] = [];
		const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const file = await open(...args);
			if (String(args[0]).endsWith(".tmp")) {
				const write = file.writeFile.bind(file);
				const sync = file.sync.bind(file);
				const close = file.close.bind(file);
				vi.spyOn(file, "writeFile").mockImplementation(async (...writeArgs) => {
					events.push("write");
					return write(...writeArgs);
				});
				vi.spyOn(file, "sync").mockImplementation(async () => {
					events.push("sync");
					return sync();
				});
				vi.spyOn(file, "close").mockImplementation(async () => {
					events.push("close");
					return close();
				});
			}
			return file;
		});
		const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			events.push("rename");
			expect(await fs.readFile(registryPath)).toEqual(old);
			const state = JSON.parse(await fs.readFile(from, "utf8"));
			expect(state.projects).toContainEqual(localProject(path, OTHER_ID));
			expect(await fs.readFile(from, "utf8")).toBe(`${JSON.stringify(state, null, 2)}\n`);
			await rename(from, to);
		});
		await registry.link(path, { projectId: OTHER_ID });
		expect(events).toEqual(["write", "sync", "close", "rename"]);
		expect(openSpy).toHaveBeenCalledWith(expect.stringMatching(/cloud-workspaces\.json\..+\.tmp$/), "wx", 0o600);
		expect(renameSpy).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\.tmp$/), registryPath);
		await expectCleanRegistryDirectory();
	});

	test.each(["temp open", "temp write", "rename"] as const)(
		"injected registry %s failure preserves bytes, releases lock and cleans temp files",
		async (failure) => {
			const old = await seedRegistry();
			const path = await directory("new-project");
			if (failure === "rename")
				vi.spyOn(fs, "rename").mockRejectedValueOnce(ioError("injected registry rename failure"));
			else {
				const open = fs.open;
				vi.spyOn(fs, "open").mockImplementation(async (...args) => {
					if (String(args[0]).endsWith(".tmp") && failure === "temp open")
						throw ioError("injected temp open failure");
					const file = await open(...args);
					if (String(args[0]).endsWith(".tmp"))
						vi.spyOn(file, "writeFile").mockRejectedValueOnce(ioError("injected temp write failure"));
					return file;
				});
			}
			await expect(registry.link(path, { projectId: OTHER_ID })).rejects.toMatchObject({
				code: "IO_ERROR",
				message: expect.stringContaining("injected"),
			});
			expect(await fs.readFile(registryPath)).toEqual(old);
			await expectCleanRegistryDirectory();
			vi.restoreAllMocks();
			await registry.link(path, { projectId: OTHER_ID });
			expect(await registry.resolve(OTHER_ID)).toBe(path);
			await expectCleanRegistryDirectory();
		},
	);

	test("a failed exclusive temp open never deletes a file it did not create", async () => {
		const original = await seedRegistry();
		const path = await directory("new-project");
		const open = fs.open;
		let collision = "";
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			if (String(args[0]).endsWith(".tmp")) {
				collision = String(args[0]);
				await fs.writeFile(collision, "another writer's file");
				throw ioError("injected exclusive-create collision", "EEXIST");
			}
			return open(...args);
		});
		await expect(registry.link(path, { projectId: OTHER_ID })).rejects.toMatchObject({ code: "IO_ERROR" });
		expect(await fs.readFile(collision, "utf8")).toBe("another writer's file");
		expect(await fs.readFile(registryPath)).toEqual(original);
		await fs.unlink(collision);
		await expectCleanRegistryDirectory();
	});

	test("concurrent no-clobber marker creation adopts the existing identity", async () => {
		const path = await directory("concurrent-init");
		const markerPath = join(path, ".dreb", "workspace.json");
		const contents = JSON.stringify({ version: 1, kind: "workspace", id: WORKSPACE_ID });
		const open = fs.open;
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			if (args[0] === markerPath && args[1] === "wx") {
				await fs.writeFile(markerPath, contents);
				throw ioError("another initializer won", "EEXIST");
			}
			return open(...args);
		});
		expect(await registry.connect(path, { initialize: true })).toEqual({ id: WORKSPACE_ID, path });
		expect(await fs.readFile(markerPath, "utf8")).toBe(contents);
	});

	test("a registry temp cleanup failure surfaces explicitly rather than claiming success", async () => {
		const old = await seedRegistry();
		const path = await directory("new-project");
		const unlink = fs.unlink;
		vi.spyOn(fs, "rename").mockRejectedValueOnce(ioError("injected rename failure"));
		vi.spyOn(fs, "unlink").mockImplementation(async (path) => {
			if (String(path).endsWith(".tmp")) throw ioError("injected cleanup failure");
			return unlink(path);
		});
		await expect(registry.link(path, { projectId: OTHER_ID })).rejects.toMatchObject({
			code: "IO_ERROR",
			message: expect.stringMatching(/Cannot clean temporary registry file.*injected cleanup failure/),
		});
		expect(await fs.readFile(registryPath)).toEqual(old);
		const entries = await fs.readdir(agentDir);
		expect(entries.filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
		expect(entries.some((name) => name.endsWith(".lock"))).toBe(false);
		vi.restoreAllMocks();
		for (const name of entries.filter((name) => name.endsWith(".tmp"))) await fs.unlink(join(agentDir, name));
		await registry.link(path, { projectId: OTHER_ID });
		await expectCleanRegistryDirectory();
	});

	test("injected registry read permission failure is not mistaken for an absent file", async () => {
		const old = await seedRegistry();
		const open = fs.open;
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			if (args[0] === registryPath) throw ioError("injected read denial");
			return open(...args);
		});
		await expect(registry.list()).rejects.toMatchObject({
			code: "IO_ERROR",
			message: expect.stringContaining("injected read denial"),
		});
		await expect(registry.unlink(PROJECT_ID)).rejects.toMatchObject({ code: "IO_ERROR" });
		expect(await fs.readFile(registryPath)).toEqual(old);
		await expectCleanRegistryDirectory();
	});

	test("injected directory access denial prevents marker initialization", async () => {
		const path = await directory("unreadable");
		vi.spyOn(fs, "access").mockRejectedValueOnce(ioError("injected directory access denial"));
		await expect(registry.connect(path, { initialize: true })).rejects.toMatchObject({ code: "UNAVAILABLE" });
		expect(await fs.readdir(path)).toEqual([]);
		await expect(fs.lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	describe.each(["workspace", "project"] as const)("%s partial initialization", (kind) => {
		test.each(["rename", "lock"] as const)(
			"preserves the new marker after registry %s failure and retries with the exact same ID",
			async (failure) => {
				const old = await seedRegistry();
				const path = await directory("cloud-folder");
				if (failure === "rename")
					vi.spyOn(fs, "rename").mockRejectedValueOnce(ioError("injected registry rename failure"));
				else vi.spyOn(lockfile, "lock").mockRejectedValueOnce(ioError("injected registry lock failure", "ELOCKED"));
				const markerPath = join(path, ".dreb", `${kind}.json`);
				const error = await initialize(kind, path).then(
					() => undefined,
					(error: unknown) => error,
				);
				expect(error).toBeInstanceOf(CloudWorkspaceError);
				expect(error).toMatchObject({
					code: "PARTIAL_INITIALIZATION",
					message: expect.stringContaining(markerPath),
				});
				expect((error as Error).message).toMatch(/marker is preserved; retry/i);
				const original = await fs.readFile(markerPath);
				const marker = JSON.parse(original.toString());
				expect(marker).toEqual({
					version: 1,
					kind,
					id: expect.stringMatching(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/),
				});
				expect(await fs.readFile(registryPath)).toEqual(old);
				await expectCleanRegistryDirectory();
				vi.restoreAllMocks();
				const binding = kind === "workspace" ? await registry.connect(path) : await registry.link(path);
				expect(binding.id).toBe(marker.id);
				expect(await fs.readFile(markerPath)).toEqual(original);
				const state = await registry.list();
				expect((kind === "workspace" ? state.workspaces : state.projects).map(({ id }) => id)).toContain(marker.id);
				await expectCleanRegistryDirectory();
			},
		);
	});

	test.each(["writeFile", "sync"] as const)(
		"failed new marker %s removes only its own incomplete marker",
		async (method) => {
			const path = await directory("cloud-folder");
			const markerPath = join(path, ".dreb", "workspace.json");
			const open = fs.open;
			vi.spyOn(fs, "open").mockImplementation(async (...args) => {
				const file = await open(...args);
				if (args[0] === markerPath && args[1] === "wx")
					vi.spyOn(file, method).mockRejectedValueOnce(ioError("injected marker write/sync failure"));
				return file;
			});
			await expect(registry.connect(path, { initialize: true })).rejects.toMatchObject({ code: "IO_ERROR" });
			await expect(fs.lstat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
			vi.restoreAllMocks();
			await registry.connect(path, { initialize: true });
			expect(JSON.parse(await fs.readFile(markerPath, "utf8"))).toMatchObject({ version: 1, kind: "workspace" });
		},
	);

	test("failed marker initialization does not unlink a replacement inode received during the write", async () => {
		const path = await directory("cloud-folder");
		const markerPath = join(path, ".dreb", "workspace.json");
		const replacement = `${JSON.stringify({ version: 1, kind: "workspace", id: WORKSPACE_ID })}\n`;
		const open = fs.open;
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const file = await open(...args);
			if (args[0] === markerPath && args[1] === "wx") {
				vi.spyOn(file, "writeFile").mockImplementationOnce(async () => {
					await fs.rename(markerPath, join(root, "original-inode"));
					await fs.writeFile(markerPath, replacement);
					throw ioError("injected marker failure after replacement");
				});
			}
			return file;
		});
		await expect(registry.connect(path, { initialize: true })).rejects.toMatchObject({ code: "IO_ERROR" });
		expect(await fs.readFile(markerPath, "utf8")).toBe(replacement);
		await expect(fs.lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
		vi.restoreAllMocks();
		expect(await registry.connect(path)).toEqual({ id: WORKSPACE_ID, path });
	});

	test.each(["connect", "marker link", "known-ID link"] as const)(
		"idempotent %s never atomically rewrites unchanged JSON",
		async (operation) => {
			const path = await directory("cloud-folder");
			if (operation === "connect") await registry.connect(path, { initialize: true });
			else if (operation === "marker link") await registry.link(path, { initialize: true });
			else await registry.link(path, { projectId: PROJECT_ID });
			const original = await fs.readFile(registryPath);
			const rename = vi.spyOn(fs, "rename");
			const open = vi.spyOn(fs, "open");
			if (operation === "connect") await registry.connect(path);
			else if (operation === "marker link") await registry.link(path);
			else await registry.link(path, { projectId: PROJECT_ID });
			expect(rename).not.toHaveBeenCalled();
			expect(open.mock.calls.some(([path]) => String(path).endsWith(".tmp"))).toBe(false);
			expect(await fs.readFile(registryPath)).toEqual(original);
			await expectCleanRegistryDirectory();
		},
	);

	test("removal preserves marker/project/transcript sentinels and disconnected dependents recover on reconnect", async () => {
		const path = await directory("workspace");
		const projectPath = await directory("workspace/project");
		const workspace = await registry.connect(path, { initialize: true });
		const project = await registry.link(projectPath, { initialize: true, workspaceId: workspace.id });
		const projectSentinel = join(projectPath, "source.txt");
		const transcript = join(agentDir, "sessions", "sentinel.jsonl");
		await fs.mkdir(join(agentDir, "sessions"));
		await fs.writeFile(projectSentinel, "project sentinel\n");
		await fs.writeFile(transcript, "transcript sentinel\n");
		const snapshots = await Promise.all(
			[
				join(path, ".dreb", "workspace.json"),
				join(projectPath, ".dreb", "project.json"),
				projectSentinel,
				transcript,
			].map(async (path) => ({ path, bytes: await fs.readFile(path) })),
		);
		expect(await registry.disconnect(workspace.id)).toBe(true);
		expect(await registry.disconnect(workspace.id)).toBe(false);
		expect(await registry.list()).toEqual({ ...EMPTY, projects: [project] });
		expect(await registry.status()).toMatchObject({
			workspaces: [],
			projects: [{ id: project.id, available: false, error: { code: "NOT_FOUND" } }],
		});
		await expect(registry.resolve(project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(await registry.connect(path)).toEqual(workspace);
		expect(await registry.resolve(project.id)).toBe(projectPath);
		expect(await registry.status()).toMatchObject({
			projects: [{ id: project.id, available: true, path: projectPath }],
		});
		expect(await registry.unlink(project.id)).toBe(true);
		expect(await registry.unlink(project.id)).toBe(false);
		expect(await registry.disconnect(workspace.id)).toBe(true);
		expect(await registry.disconnect(workspace.id)).toBe(false);
		expect(await registry.list()).toEqual(EMPTY);
		for (const { path, bytes } of snapshots) expect(await fs.readFile(path)).toEqual(bytes);
		expect((await fs.stat(projectPath)).isDirectory()).toBe(true);
	});

	test.each([false, true])(
		"lock release failure is visible and preserves the write outcome (write fails: %s)",
		async (writeFails) => {
			const original = await seedRegistry();
			const path = await directory("release-project");
			const acquire = lockfile.lock;
			vi.spyOn(lockfile, "lock").mockImplementationOnce(async (...args) => {
				const release = await acquire(...args);
				return async () => {
					await release();
					throw ioError("injected release failure");
				};
			});
			if (writeFails) vi.spyOn(fs, "rename").mockRejectedValueOnce(ioError("injected rename failure"));
			await expect(registry.link(path, { projectId: OTHER_ID })).rejects.toMatchObject({
				code: "IO_ERROR",
				message: writeFails
					? expect.stringMatching(/injected rename failure.*lock release also failed/)
					: expect.stringContaining("may have completed"),
				cause: writeFails ? expect.any(AggregateError) : expect.any(Error),
			});
			if (writeFails) expect(await fs.readFile(registryPath)).toEqual(original);
			else expect(await registry.resolve(OTHER_ID)).toBe(path);
			await expectCleanRegistryDirectory();
		},
	);

	test.each(["workspace", "project"] as const)(
		"reports a preserved %s marker and safe retry when closing initialization fails",
		async (kind) => {
			const original = await seedRegistry();
			const path = await directory("close-failure");
			const markerPath = join(path, ".dreb", `${kind}.json`);
			const open = fs.open;
			vi.spyOn(fs, "open").mockImplementation(async (...args) => {
				const file = await open(...args);
				if (args[0] === markerPath && args[1] === "wx") {
					const close = file.close.bind(file);
					vi.spyOn(file, "close").mockImplementationOnce(async () => {
						await close();
						throw ioError("injected marker close failure");
					});
				}
				return file;
			});
			await expect(initialize(kind, path)).rejects.toMatchObject({
				code: "PARTIAL_INITIALIZATION",
				message: expect.stringContaining("preserved marker and retry"),
			});
			const bytes = await fs.readFile(markerPath);
			const id = JSON.parse(bytes.toString()).id;
			expect(await fs.readFile(registryPath)).toEqual(original);
			vi.restoreAllMocks();
			const binding = kind === "workspace" ? await registry.connect(path) : await registry.link(path);
			expect(binding.id).toBe(id);
			expect(await fs.readFile(markerPath)).toEqual(bytes);
		},
	);

	test("marker-directory preparation failures are structured and do not initialize local state", async () => {
		const path = await directory("mkdir-denied");
		vi.spyOn(fs, "mkdir").mockRejectedValueOnce(ioError("injected marker directory denial"));
		await expect(registry.connect(path, { initialize: true })).rejects.toMatchObject({
			code: "IO_ERROR",
			message: expect.stringContaining("injected marker directory denial"),
		});
		await expect(fs.lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("oversized registry publication preserves the previous JSON", async () => {
		const original = await seedRegistry();
		await expect(
			new CloudWorkspaceStorage(agentDir).update((state) => {
				state.projects.push(localProject(join(root, "x".repeat(REGISTRY_LIMIT)), OTHER_ID));
			}),
		).rejects.toMatchObject({ code: "INVALID_METADATA", message: expect.stringContaining("size limit") });
		expect(await fs.readFile(registryPath)).toEqual(original);
		await expectCleanRegistryDirectory();
	});

	test("storage rejects an invalid mutation without replacing durable bytes", async () => {
		const original = await seedRegistry();
		await expect(
			new CloudWorkspaceStorage(agentDir).update((state: CloudWorkspaceState) => {
				state.projects.push(localProject("relative/path"));
			}),
		).rejects.toMatchObject({ code: "INVALID_PATH" });
		expect(await fs.readFile(registryPath)).toEqual(original);
		await expectCleanRegistryDirectory();
	});
});
