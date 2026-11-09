import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR, getCloudWorkspaceRegistryPath } from "../src/config.js";
import {
	type CloudSessionDirectories,
	CloudSessionStorage,
	type CloudSessionStorageStatus,
} from "../src/core/cloud-workspaces/index.js";
import { FileSettingsStorage, SettingsManager, type SettingsScope } from "../src/core/settings-manager.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));

const EMPTY: CloudSessionDirectories = { sessionDir: null, subagentSessionDir: null };
const SUBDIRECTORIES = {
	sessionDir: `${CONFIG_DIR_NAME}/sessions`,
	subagentSessionDir: `${CONFIG_DIR_NAME}/subagent-sessions`,
};
const MAX_BYTES = 4 * 1024 * 1024;
let root: string;
let agentDir: string;
let storage: CloudSessionStorage;

function ioError(message: string, code = "EIO"): Error {
	return Object.assign(new Error(message), { code });
}

async function folder(name: string): Promise<string> {
	const path = join(root, name);
	await fs.mkdir(path, { recursive: true });
	return path;
}

async function seed(value: unknown): Promise<Buffer> {
	await fs.mkdir(agentDir, { recursive: true });
	const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
	await fs.writeFile(storage.path, bytes);
	return bytes;
}

function pair(path: string): CloudSessionDirectories {
	return {
		sessionDir: join(path, CONFIG_DIR_NAME, "sessions"),
		subagentSessionDir: join(path, CONFIG_DIR_NAME, "subagent-sessions"),
	};
}

async function expectClean(): Promise<void> {
	expect(await fs.readdir(agentDir)).toEqual(["settings.json"]);
}

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "dreb-cloud-session-storage-")));
	agentDir = join(root, "profile");
	vi.stubEnv("HOME", join(root, "home"));
	vi.stubEnv("USERPROFILE", join(root, "home"));
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	storage = new CloudSessionStorage({ agentDir, baseCwd: root });
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await fs.rm(root, { recursive: true, force: true });
});

describe("metadata-only global session settings", () => {
	it("reads missing defaults without creating a profile or any files", async () => {
		vi.stubEnv(ENV_AGENT_DIR, undefined);
		const selected = new CloudSessionStorage();
		expect(selected.path).toBe(join(root, "home", CONFIG_DIR_NAME, "agent", "settings.json"));
		const mkdir = vi.spyOn(fs, "mkdir");
		const open = vi.spyOn(fs, "open");
		expect(await selected.read()).toEqual({ ...EMPTY, subdirectories: SUBDIRECTORIES, restartRequired: false });
		expect(mkdir).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
		expect(await fs.readdir(root)).toEqual([]);
	});

	it("selects the environment profile or explicit profile, beside the registry", async () => {
		await seed({ sessionDir: "legacy main", subagentSessionDir: null });
		const environment = new CloudSessionStorage({ baseCwd: root });
		expect(environment.path).toBe(join(dirname(getCloudWorkspaceRegistryPath()), "settings.json"));
		expect((await environment.read()).sessionDir).toBe("legacy main");
		const explicit = new CloudSessionStorage({ agentDir: join(root, "explicit") });
		expect(explicit.path).toBe(join(root, "explicit/settings.json"));
		expect((await explicit.read()).sessionDir).toBeNull();
		await expect(fs.lstat(dirname(explicit.path))).rejects.toMatchObject({ code: "ENOENT" });
		const homeProfile = new CloudSessionStorage({ agentDir: "~/named profile" });
		expect(homeProfile.path).toBe(join(root, "home/named profile/settings.json"));
	});

	it("saves distinct derived paths without creating logs, markers, registry or preference flags", async () => {
		const target = await folder("Cloud drive/My project");
		const result: CloudSessionStorageStatus = await storage.setRoot(target, EMPTY);
		expect(result).toEqual({ ...pair(target), subdirectories: SUBDIRECTORIES, restartRequired: true });
		expect(JSON.parse(await fs.readFile(storage.path, "utf8"))).toEqual(pair(target));
		expect(await fs.readdir(target)).toEqual([]);
		await expectClean();
	});

	it("allows the same project/workspace root and preserves all unknown settings and marker bytes", async () => {
		const target = await folder("shared-project");
		await fs.mkdir(join(target, CONFIG_DIR_NAME));
		const marker = join(target, CONFIG_DIR_NAME, "project.json");
		await fs.writeFile(marker, "existing identity\n");
		const unrelated = JSON.parse(
			'{"theme":"dark","unknown":{"future":[1,true]},"context":{"trustedFolders":["not scanned"]},"__proto__":{"keep":true},"providerSecret":"synthetic"}',
		);
		await seed(unrelated);
		const result = await storage.setRoot(target, EMPTY);
		expect(JSON.parse(await fs.readFile(storage.path, "utf8"))).toEqual({ ...unrelated, ...pair(target) });
		expect(Object.keys(result).sort()).toEqual([
			"restartRequired",
			"sessionDir",
			"subagentSessionDir",
			"subdirectories",
		]);
		expect(JSON.stringify(result)).not.toMatch(/synthetic|trustedFolders|unknown/);
		expect(await fs.readFile(marker, "utf8")).toBe("existing identity\n");
		expect(await fs.readdir(join(target, CONFIG_DIR_NAME))).toEqual(["project.json"]);
		await expectClean();
	});

	it("canonicalizes a selected root alias without creating anything in the target", async () => {
		const target = await folder("canonical");
		const alias = join(root, "alias");
		await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
		expect(await storage.setRoot(alias, EMPTY)).toMatchObject(pair(target));
		expect(await fs.readdir(target)).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("preserves literal leading and trailing pathname whitespace", async () => {
		const target = await folder(" leading and trailing ");
		expect(await storage.setRoot(target, EMPTY)).toMatchObject(pair(target));
		expect(JSON.parse(await fs.readFile(storage.path, "utf8"))).toEqual(pair(target));
		expect(await fs.readdir(target)).toEqual([]);
	});

	it("explicit null reset deletes only the two storage fields, including explicit nulls", async () => {
		await seed({ theme: "dark", sessionDir: "relative", subagentSessionDir: null, future: { enabled: true } });
		expect(await storage.setRoot(null, { sessionDir: "relative", subagentSessionDir: null })).toEqual({
			...EMPTY,
			subdirectories: SUBDIRECTORIES,
			restartRequired: false,
		});
		expect(JSON.parse(await fs.readFile(storage.path, "utf8"))).toEqual({ theme: "dark", future: { enabled: true } });
		await expectClean();
	});

	it.each(["configured", "defaults"] as const)("preserves exact bytes for already-correct %s", async (mode) => {
		const target = await folder("logs");
		const settings = mode === "configured" ? pair(target) : EMPTY;
		const bytes = await seed(
			mode === "configured"
				? `{\n "theme": "dark", "sessionDir": ${JSON.stringify(settings.sessionDir)}, "subagentSessionDir": ${JSON.stringify(settings.subagentSessionDir)} }  \n`
				: '{ "theme" : "dark" }\n\n',
		);
		const rename = vi.spyOn(fs, "rename");
		const open = vi.spyOn(fs, "open");
		await storage.setRoot(mode === "configured" ? target : null, settings);
		expect(await fs.readFile(storage.path)).toEqual(bytes);
		expect(rename).not.toHaveBeenCalled();
		expect(open.mock.calls.some(([, flags]) => flags === "wx")).toBe(false);
		await expectClean();
	});

	it("reset of absent defaults does not invent a settings file", async () => {
		await storage.setRoot(null, EMPTY);
		expect(await fs.readdir(agentDir)).toEqual([]);
	});

	it("rejects stale semantic pairs without overwriting unrelated settings", async () => {
		const target = await folder("logs");
		const bytes = await seed({ sessionDir: "received", subagentSessionDir: "old children", theme: "kept" });
		const rename = vi.spyOn(fs, "rename");
		await expect(storage.setRoot(target, EMPTY)).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(storage.setRoot(null, EMPTY)).rejects.toMatchObject({ code: "CONFLICT" });
		expect(rename).not.toHaveBeenCalled();
		expect(await fs.readFile(storage.path)).toEqual(bytes);
		await expectClean();
	});

	it("serializes concurrent setters into one success and one conflict", async () => {
		await seed({ future: 42 });
		const one = await folder("one");
		const two = await folder("two");
		const outcomes = await Promise.allSettled([
			storage.setRoot(one, EMPTY),
			new CloudSessionStorage({ agentDir }).setRoot(two, EMPTY),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toMatchObject([
			{ reason: { code: "CONFLICT" } },
		]);
		const winner = outcomes.find((outcome) => outcome.status === "fulfilled");
		expect(JSON.parse(await fs.readFile(storage.path, "utf8"))).toEqual({
			future: 42,
			sessionDir: winner?.value.sessionDir,
			subagentSessionDir: winner?.value.subagentSessionDir,
		});
		await expectClean();
	});
});

describe("strict settings and input validation", () => {
	it.each([
		"",
		"{",
		"null",
		"false",
		"1",
		'"text"',
		"[]",
		'[{"sessionDir":"x"}]',
		'{"sessionDir":false}',
		'{"subagentSessionDir":{}}',
		'{"sessionDir":0}',
		'{"sessionDir":[]}',
	])("fails closed on invalid settings %j for reads and saves", async (bytes) => {
		await seed(bytes);
		await expect(storage.read()).rejects.toMatchObject({ code: "INVALID_METADATA" });
		await expect(storage.setRoot(null, EMPTY)).rejects.toMatchObject({ code: "INVALID_METADATA" });
		expect(await fs.readFile(storage.path, "utf8")).toBe(bytes);
		await expectClean();
	});

	it("rejects oversized settings and bounds serialized output before opening a temporary file", async () => {
		const tooLarge = await seed(`{"future":"${"x".repeat(MAX_BYTES)}"}`);
		await expect(storage.read()).rejects.toMatchObject({ code: "INVALID_METADATA" });
		await expect(storage.setRoot(null, EMPTY)).rejects.toMatchObject({ code: "INVALID_METADATA" });
		expect((await fs.readFile(storage.path)).equals(tooLarge)).toBe(true);
		const nearlyFull = await seed({ future: "x".repeat(MAX_BYTES - 60) });
		const target = await folder("logs");
		const open = vi.spyOn(fs, "open");
		await expect(storage.setRoot(target, EMPTY)).rejects.toMatchObject({ code: "INVALID_METADATA" });
		expect(open.mock.calls.some(([, flags]) => flags === "wx")).toBe(false);
		expect((await fs.readFile(storage.path)).equals(nearlyFull)).toBe(true);
		await expectClean();
	});

	it("accepts an exactly 4MiB object without reformatting on no-op", async () => {
		const bytes = await seed(`{}${" ".repeat(MAX_BYTES - 2)}`);
		expect((await storage.read()).sessionDir).toBeNull();
		await storage.setRoot(null, EMPTY);
		expect((await fs.readFile(storage.path)).equals(bytes)).toBe(true);
	});

	it("rejects a directory in place of the settings file", async () => {
		await fs.mkdir(storage.path, { recursive: true });
		await expect(storage.read()).rejects.toMatchObject({ code: "INVALID_METADATA" });
		await expect(storage.setRoot(null, EMPTY)).rejects.toMatchObject({ code: "INVALID_METADATA" });
		expect(await fs.readdir(storage.path)).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("rejects settings symlinks without touching the destination", async () => {
		const other = join(root, "other.json");
		const bytes = '{"sessionDir":"external"}\n';
		await fs.writeFile(other, bytes);
		await fs.mkdir(agentDir);
		await fs.symlink(other, storage.path);
		await expect(storage.read()).rejects.toMatchObject({ code: "INVALID_METADATA" });
		await expect(storage.setRoot(null, EMPTY)).rejects.toMatchObject({ code: "INVALID_METADATA" });
		expect((await fs.lstat(storage.path)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(other, "utf8")).toBe(bytes);
	});

	it.each([
		null,
		undefined,
		[],
		{},
		{ sessionDir: null },
		{ sessionDir: null, subagentSessionDir: undefined },
		{ sessionDir: 3, subagentSessionDir: null },
		{ sessionDir: null, subagentSessionDir: false },
		{ ...EMPTY, extra: true },
		{ ...EMPTY, [Symbol("extra")]: true },
	])("rejects invalid expected pairs %# before filesystem access", async (expected) => {
		const lstat = vi.spyOn(fs, "lstat");
		const realpath = vi.spyOn(fs, "realpath");
		const mkdir = vi.spyOn(fs, "mkdir");
		await expect(storage.setRoot(root, expected as CloudSessionDirectories)).rejects.toMatchObject({
			code: "INVALID_METADATA",
		});
		expect(lstat).not.toHaveBeenCalled();
		expect(realpath).not.toHaveBeenCalled();
		expect(mkdir).not.toHaveBeenCalled();
	});

	it.each([
		undefined,
		42,
		{},
		"",
		" ",
		".",
		"../logs",
		"relative",
		"~",
		"~/logs",
		"C:relative",
		"bad\0path",
		...(process.platform === "win32" ? [] : ["C:\\Foreign\\Logs", "\\\\server\\share\\logs"]),
	])("rejects invalid or foreign-native root %j before filesystem access", async (path) => {
		const realpath = vi.spyOn(fs, "realpath");
		const mkdir = vi.spyOn(fs, "mkdir");
		await expect(storage.setRoot(path as string, EMPTY)).rejects.toMatchObject({ code: "INVALID_PATH" });
		expect(realpath).not.toHaveBeenCalled();
		expect(mkdir).not.toHaveBeenCalled();
	});

	it("reports missing/non-directory/unreadable/unwritable roots without preparing the profile", async () => {
		await expect(storage.setRoot(join(root, "missing"), EMPTY)).rejects.toMatchObject({ code: "UNAVAILABLE" });
		const file = join(root, "file");
		await fs.writeFile(file, "not a directory");
		await expect(storage.setRoot(file, EMPTY)).rejects.toMatchObject({ code: "UNAVAILABLE" });
		vi.spyOn(fs, "access").mockRejectedValueOnce(ioError("denied", "EACCES"));
		await expect(storage.setRoot(root, EMPTY)).rejects.toMatchObject({ code: "UNAVAILABLE" });
		await expect(fs.lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(
		[CONFIG_DIR_NAME, `${CONFIG_DIR_NAME}/sessions`, `${CONFIG_DIR_NAME}/subagent-sessions`].flatMap((component) =>
			["file", "symlink", "dangling symlink"].map((kind) => ({ component, kind })),
		),
	)("rejects a $kind at $component without writing settings", async ({ component, kind }) => {
		const target = await folder("selected");
		const obstruction = join(target, ...component.split("/"));
		await fs.mkdir(dirname(obstruction), { recursive: true });
		if (kind === "file") await fs.writeFile(obstruction, "obstruction");
		else {
			const other = kind === "symlink" ? await folder("elsewhere") : join(root, "missing");
			await fs.symlink(other, obstruction, process.platform === "win32" ? "junction" : "dir");
		}
		await expect(storage.setRoot(target, EMPTY)).rejects.toMatchObject({ code: "INVALID_PATH" });
		await expect(fs.lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("checks read/write/search access at each deepest existing log ancestor", async () => {
		const target = await folder("selected");
		const config = await folder(`selected/${CONFIG_DIR_NAME}`);
		const main = await folder(`selected/${CONFIG_DIR_NAME}/sessions`);
		const access = vi.spyOn(fs, "access");
		await storage.setRoot(target, EMPTY);
		expect(access).toHaveBeenCalledWith(target, constants.R_OK | constants.W_OK | constants.X_OK);
		expect(access).toHaveBeenCalledWith(config, constants.R_OK | constants.W_OK | constants.X_OK);
		expect(access).toHaveBeenCalledWith(main, constants.R_OK | constants.W_OK | constants.X_OK);
		expect(await fs.readdir(config)).toEqual(["sessions"]);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["root", "config", "main", "subagent"])(
		"rejects a real read-only %s directory without a save",
		async (shape) => {
			const target = await folder("selected");
			const blocked =
				shape === "root"
					? target
					: await folder(
							`selected/${CONFIG_DIR_NAME}${shape === "config" ? "" : shape === "main" ? "/sessions" : "/subagent-sessions"}`,
						);
			await fs.chmod(blocked, 0o500);
			try {
				await expect(storage.setRoot(target, EMPTY)).rejects.toMatchObject({ code: "UNAVAILABLE" });
				await expect(fs.lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				await fs.chmod(blocked, 0o700);
			}
		},
	);
});

describe("cooperating settings lock and atomic persistence", () => {
	it("preserves an acknowledged log save when the ordinary settings writer initially observed no file", async () => {
		const target = await folder("logs");
		await fs.mkdir(agentDir);
		let saved: CloudSessionStorageStatus | undefined;
		let interleaved = false;
		class ScheduledSettingsStorage extends FileSettingsStorage {
			override withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
				super.withLock(scope, (current) => {
					const next = fn(current);
					if (scope === "global" && current === undefined && next !== undefined && !interleaved) {
						interleaved = true;
						// Pause after the ordinary writer computes its absent-file save, before its lock.
						// A separate cooperating process completes the actual log-storage save first.
						const output = execFileSync(
							process.execPath,
							[
								"--import",
								"tsx",
								fileURLToPath(new URL("./fixtures/cloud-session-storage-writer.ts", import.meta.url)),
								agentDir,
								target,
							],
							{
								cwd: fileURLToPath(new URL("../../../", import.meta.url)),
								env: {
									PATH: process.env.PATH,
									SystemRoot: process.env.SystemRoot,
									HOME: root,
									USERPROFILE: root,
									DREB_CODING_AGENT_DIR: agentDir,
									DREB_LIVE_API: "0",
									DREB_LIVE_API_EXPENSIVE: "0",
									DREB_NO_LOCAL_LLM: "1",
								},
								encoding: "utf8",
								timeout: 15000,
								maxBuffer: 1024 * 1024,
							},
						);
						saved = JSON.parse(output) as CloudSessionStorageStatus;
					}
					return next;
				});
			}
		}
		const manager = SettingsManager.fromStorage(new ScheduledSettingsStorage(root, agentDir));
		manager.setTheme("dark");
		await manager.flush();

		expect(manager.drainErrors()).toEqual([]);
		expect(interleaved).toBe(true);
		expect(saved).toMatchObject({ ...pair(target), restartRequired: true });
		expect(JSON.parse(await fs.readFile(storage.path, "utf8"))).toEqual({ ...pair(target), theme: "dark" });
		expect(await storage.read()).toMatchObject(pair(target));
		expect(await fs.readdir(target)).toEqual([]);
		await expectClean();
	}, 20000);

	it.each(["canonical", "alias"])(
		"honors an existing FileSettingsStorage-style %s lock with bounded waiting",
		async (shape) => {
			const bytes = await seed({ theme: "original" });
			const target = await folder("logs");
			let selected = storage;
			if (shape === "alias") {
				const alias = join(root, "profile-alias");
				await fs.symlink(agentDir, alias, process.platform === "win32" ? "junction" : "dir");
				selected = new CloudSessionStorage({ agentDir: alias });
			}
			const release = lockfile.lockSync(storage.path, { realpath: false });
			const lock = vi.spyOn(lockfile, "lock");
			const start = performance.now();
			try {
				await expect(selected.setRoot(target, EMPTY)).rejects.toMatchObject({
					code: "IO_ERROR",
					message: expect.stringMatching(/Cannot acquire local settings lock.*already being held/i),
				});
				expect(performance.now() - start).toBeLessThan(5000);
				expect(lock).toHaveBeenCalledExactlyOnceWith(storage.path, {
					realpath: false,
					retries: { retries: 40, factor: 1, minTimeout: 25, maxTimeout: 25, randomize: false },
				});
				expect(await fs.readFile(storage.path)).toEqual(bytes);
			} finally {
				release();
			}
			await expectClean();
		},
		7000,
	);

	it("waits for an existing lock and freshly rereads its writer's settings before comparing", async () => {
		await seed({ theme: "old" });
		const target = await folder("logs");
		const release = lockfile.lockSync(storage.path, { realpath: false });
		const saving = storage.setRoot(target, EMPTY);
		const outcome = expect(saving).rejects.toMatchObject({ code: "CONFLICT" });
		let bytes: Buffer;
		try {
			await new Promise((resolve) => setTimeout(resolve, 60));
			bytes = await seed({ theme: "received", sessionDir: "received main", subagentSessionDir: null });
		} finally {
			release();
		}
		await outcome;
		expect(await fs.readFile(storage.path)).toEqual(bytes!);
		await expectClean();
	});

	it("writes exclusively at mode 0600, syncs and closes before a single atomic rename", async () => {
		const bytes = await seed({ future: { kept: true } });
		const target = await folder("logs");
		const originalOpen = fs.open;
		const originalRename = fs.rename;
		const events: string[] = [];
		const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const file = await originalOpen(...args);
			if (String(args[0]).endsWith(".tmp")) {
				const write = file.writeFile.bind(file);
				const sync = file.sync.bind(file);
				const close = file.close.bind(file);
				vi.spyOn(file, "writeFile").mockImplementation(async (...values) => {
					events.push("write");
					return write(...values);
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
		const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			events.push("rename");
			expect(await fs.readFile(storage.path)).toEqual(bytes);
			expect(JSON.parse(await fs.readFile(from, "utf8"))).toEqual({ future: { kept: true }, ...pair(target) });
			if (process.platform !== "win32") expect((await fs.stat(from)).mode & 0o777).toBe(0o600);
			return originalRename(from, to);
		});
		await storage.setRoot(target, EMPTY);
		expect(events).toEqual(["write", "sync", "close", "rename"]);
		expect(open).toHaveBeenCalledWith(expect.stringMatching(/settings\.json\..+\.tmp$/), "wx", 0o600);
		expect(rename).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\.tmp$/), storage.path);
		await expectClean();
	});

	it.each(["open", "write", "sync", "close", "rename"] as const)(
		"preserves original bytes and cleans its temp after an injected %s failure, without retry",
		async (failure) => {
			const bytes = await seed({ theme: "original" });
			const target = await folder("logs");
			const lock = vi.spyOn(lockfile, "lock");
			const rename = vi.spyOn(fs, "rename");
			if (failure === "rename") rename.mockRejectedValueOnce(ioError("injected rename failure"));
			else {
				const originalOpen = fs.open;
				vi.spyOn(fs, "open").mockImplementation(async (...args) => {
					if (String(args[0]).endsWith(".tmp") && failure === "open") throw ioError("injected open failure");
					const file = await originalOpen(...args);
					if (String(args[0]).endsWith(".tmp")) {
						if (failure === "write")
							vi.spyOn(file, "writeFile").mockRejectedValueOnce(ioError("injected write failure"));
						if (failure === "sync")
							vi.spyOn(file, "sync").mockRejectedValueOnce(ioError("injected sync failure"));
						if (failure === "close") {
							const close = file.close.bind(file);
							vi.spyOn(file, "close").mockImplementationOnce(async () => {
								await close();
								throw ioError("injected close failure");
							});
						}
					}
					return file;
				});
			}
			await expect(storage.setRoot(target, EMPTY)).rejects.toMatchObject({
				code: "IO_ERROR",
				message: expect.stringContaining(`injected ${failure} failure`),
			});
			expect(lock).toHaveBeenCalledTimes(1);
			expect(rename).toHaveBeenCalledTimes(failure === "rename" ? 1 : 0);
			expect(await fs.readFile(storage.path)).toEqual(bytes);
			await expectClean();
		},
	);

	it("does not clobber or unlink a temporary file it failed to create exclusively", async () => {
		const bytes = await seed({ theme: "original" });
		const target = await folder("logs");
		const originalOpen = fs.open;
		let foreignTemporary = "";
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			if (String(args[0]).endsWith(".tmp")) {
				foreignTemporary = String(args[0]);
				await fs.writeFile(foreignTemporary, "foreign bytes");
				throw ioError("temporary already exists", "EEXIST");
			}
			return originalOpen(...args);
		});
		await expect(storage.setRoot(target, EMPTY)).rejects.toMatchObject({ code: "IO_ERROR" });
		expect(await fs.readFile(storage.path)).toEqual(bytes);
		expect(await fs.readFile(foreignTemporary, "utf8")).toBe("foreign bytes");
	});

	it("reports an injected lock acquisition failure without writing or retrying a mutation", async () => {
		const bytes = await seed({ theme: "original" });
		const target = await folder("logs");
		const lock = vi.spyOn(lockfile, "lock").mockRejectedValueOnce(ioError("injected lock failure", "ELOCKED"));
		const rename = vi.spyOn(fs, "rename");
		await expect(storage.setRoot(target, EMPTY)).rejects.toMatchObject({
			code: "IO_ERROR",
			message: expect.stringContaining("injected lock failure"),
		});
		expect(lock).toHaveBeenCalledTimes(1);
		expect(rename).not.toHaveBeenCalled();
		expect(await fs.readFile(storage.path)).toEqual(bytes);
		await expectClean();
	});

	it.each([false, true])("honestly composes cleanup failure (rename failed: %s)", async (renameFails) => {
		const bytes = await seed({ theme: "original" });
		const target = await folder("logs");
		if (renameFails) vi.spyOn(fs, "rename").mockRejectedValueOnce(ioError("injected rename failure"));
		const originalUnlink = fs.unlink;
		vi.spyOn(fs, "unlink").mockImplementation(async (path) => {
			if (String(path).endsWith(".tmp")) throw ioError("injected cleanup failure");
			return originalUnlink(path);
		});
		await expect(storage.setRoot(target, EMPTY)).rejects.toMatchObject({
			code: "IO_ERROR",
			message: renameFails
				? expect.stringMatching(/injected rename failure.*injected cleanup failure/)
				: expect.stringMatching(/Settings may already have changed.*injected cleanup failure/),
			cause: renameFails ? expect.any(AggregateError) : expect.any(Error),
		});
		if (renameFails) {
			expect(await fs.readFile(storage.path)).toEqual(bytes);
			expect((await fs.readdir(agentDir)).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
		} else expect(await storage.read()).toMatchObject(pair(target));
		expect((await fs.readdir(agentDir)).some((name) => name.endsWith(".lock"))).toBe(false);
	});

	it.each([false, true])("honestly composes lock-release failure (rename failed: %s)", async (renameFails) => {
		const bytes = await seed({ theme: "original" });
		const target = await folder("logs");
		const acquire = lockfile.lock;
		vi.spyOn(lockfile, "lock").mockImplementationOnce(async (...args) => {
			const release = await acquire(...args);
			return async () => {
				await release();
				throw ioError("injected release failure");
			};
		});
		if (renameFails) vi.spyOn(fs, "rename").mockRejectedValueOnce(ioError("injected rename failure"));
		await expect(storage.setRoot(target, EMPTY)).rejects.toMatchObject({
			code: "IO_ERROR",
			message: renameFails
				? expect.stringMatching(/injected rename failure.*lock release also failed/)
				: expect.stringContaining("Settings may already have changed"),
			cause: renameFails ? expect.any(AggregateError) : expect.any(Error),
		});
		if (renameFails) expect(await fs.readFile(storage.path)).toEqual(bytes);
		else expect(await storage.read()).toMatchObject(pair(target));
		await expectClean();
	});
});

describe("startup inventory comparison without runtime or transcript access", () => {
	it.each([
		{ configured: undefined, active: undefined, restart: false },
		{ configured: null, active: undefined, restart: false },
		{ configured: "", active: undefined, restart: false },
		{ configured: "  \t ", active: undefined, restart: false },
		{ configured: "relative-logs", active: "relative-logs", restart: false },
		{ configured: " relative-logs ", active: "relative-logs", restart: false },
		{ configured: "relative-logs", active: undefined, restart: true },
		{ configured: undefined, active: "old-logs", restart: true },
		{ configured: "~/home-logs", active: "home", restart: false },
		{ configured: "~\\home-logs", active: "home", restart: false },
	])(
		"compares legacy setting $configured to active $active (restart $restart)",
		async ({ configured, active, restart }) => {
			await seed({
				...(configured === undefined ? {} : { sessionDir: configured }),
				subagentSessionDir: "never read",
			});
			const activeSessionDir =
				active === "home" ? join(root, "home/home-logs") : active === undefined ? undefined : join(root, active);
			const selected = new CloudSessionStorage({ agentDir, baseCwd: root, activeSessionDir });
			const access = vi.spyOn(fs, "access");
			const realpath = vi.spyOn(fs, "realpath");
			expect(await selected.read()).toEqual({
				sessionDir: configured ?? null,
				subagentSessionDir: "never read",
				subdirectories: SUBDIRECTORIES,
				restartRequired: restart,
			});
			expect(access).not.toHaveBeenCalled();
			expect(realpath).not.toHaveBeenCalled();
		},
	);

	it("defaults relative resolution to process.cwd and compares absolute startup paths", async () => {
		await seed({ sessionDir: "legacy" });
		expect(
			(await new CloudSessionStorage({ agentDir, activeSessionDir: join(process.cwd(), "legacy") }).read())
				.restartRequired,
		).toBe(false);
		const absolute = join(root, "not-required-to-exist");
		await seed({ sessionDir: absolute });
		expect((await new CloudSessionStorage({ agentDir, activeSessionDir: absolute }).read()).restartRequired).toBe(
			false,
		);
	});

	it.skipIf(process.platform !== "win32")("compares Windows inventory paths case-insensitively", async () => {
		const absolute = join(root, "Inventory");
		await seed({ sessionDir: absolute.toLowerCase() });
		expect(
			(await new CloudSessionStorage({ agentDir, activeSessionDir: absolute.toUpperCase() }).read()).restartRequired,
		).toBe(false);
	});

	it("reports post-change restart status without changing the startup snapshot", async () => {
		const target = await folder("logs");
		const configured = pair(target);
		const active = new CloudSessionStorage({ agentDir, activeSessionDir: configured.sessionDir! });
		await seed(configured);
		expect((await active.read()).restartRequired).toBe(false);
		expect((await active.setRoot(null, configured)).restartRequired).toBe(true);
		expect((await active.read()).restartRequired).toBe(true);
	});

	it("reads only selected global metadata, never project/provider/context/session content or folder inventories", async () => {
		const target = await folder("project");
		const config = await folder(`project/${CONFIG_DIR_NAME}`);
		const logs = await folder(`project/${CONFIG_DIR_NAME}/sessions`);
		const children = await folder(`project/${CONFIG_DIR_NAME}/subagent-sessions`);
		const sentinels = [
			join(target, "AGENTS.md"),
			join(config, "settings.json"),
			join(config, "project.json"),
			join(logs, "main.jsonl"),
			join(children, "child.jsonl"),
		];
		await seed({ context: { trustedFolders: [target] }, auth: "synthetic" });
		sentinels.push(join(agentDir, "auth.json"), join(agentDir, "models.json"));
		for (const path of sentinels) await fs.writeFile(path, `Never read: ${path}\n`);
		const bytes = await Promise.all(sentinels.map((path) => fs.readFile(path)));
		const readFile = vi.spyOn(fs, "readFile");
		const readdir = vi.spyOn(fs, "readdir");
		const stat = vi.spyOn(fs, "stat");
		const lstat = vi.spyOn(fs, "lstat");
		const open = vi.spyOn(fs, "open");
		const realpath = vi.spyOn(fs, "realpath");
		const access = vi.spyOn(fs, "access");
		await storage.read();
		await storage.setRoot(target, EMPTY);
		await storage.read();
		expect(readFile).not.toHaveBeenCalled();
		expect(readdir).not.toHaveBeenCalled();
		expect(stat).not.toHaveBeenCalled();
		for (const [path] of lstat.mock.calls) expect([storage.path, target, config, logs, children]).toContain(path);
		for (const [path] of realpath.mock.calls) expect([target, agentDir]).toContain(path);
		for (const [path] of access.mock.calls) expect([target, logs, children]).toContain(path);
		for (const [path] of open.mock.calls)
			expect(path === storage.path || String(path).startsWith(`${storage.path}.`)).toBe(true);
		vi.restoreAllMocks();
		expect(await Promise.all(sentinels.map((path) => fs.readFile(path)))).toEqual(bytes);
	});
});
