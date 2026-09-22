import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { SessionManager } from "../src/core/session-manager.js";

// listAll() scans getSessionsDir() = <agentDir>/sessions. We point the agent dir at a temp
// directory via the ENV_AGENT_DIR override so these tests never touch the real store.

const tempDirs: string[] = [];
const savedEnv = process.env[ENV_AGENT_DIR];

async function createAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-listall-"));
	tempDirs.push(dir);
	process.env[ENV_AGENT_DIR] = dir;
	return dir;
}

function writeSession(path: string, id = "s", timestamp = new Date().toISOString()): void {
	const header = { type: "session", id, version: 3, cwd: "/tmp", timestamp };
	writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");
}

afterEach(async () => {
	if (savedEnv === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedEnv;
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionManager.listAllFromDir", () => {
	it("lists only flat sessions newest-first and reports progress for every JSONL file", async () => {
		const root = await createAgentDir();
		const customDir = join(root, "custom-main-sessions");
		mkdirSync(join(customDir, "nested"), { recursive: true });
		writeSession(join(customDir, "older.jsonl"), "older", "2026-01-01T00:00:00.000Z");
		writeSession(join(customDir, "newer.jsonl"), "newer", "2026-01-02T00:00:00.000Z");
		writeFileSync(join(customDir, "malformed.jsonl"), "not json\n", "utf8");
		writeSession(join(customDir, "nested", "ignored.jsonl"), "ignored", "2026-01-03T00:00:00.000Z");
		const progress: Array<[number, number]> = [];

		const sessions = await SessionManager.listAllFromDir(customDir, (loaded, total) => {
			progress.push([loaded, total]);
		});

		expect(sessions.map((session) => session.id)).toEqual(["newer", "older"]);
		expect(sessions.every((session) => session.path.startsWith(customDir))).toBe(true);
		expect(progress).toHaveLength(3);
		expect(progress.at(-1)).toEqual([3, 3]);
	});

	it("returns an empty list for a missing custom directory", async () => {
		const root = await createAgentDir();
		await expect(SessionManager.listAllFromDir(join(root, "missing"))).resolves.toEqual([]);
	});

	it("fails loudly when an existing custom inventory path cannot be listed", async () => {
		const root = await createAgentDir();
		const notADirectory = join(root, "not-a-directory");
		writeFileSync(notADirectory, "file instead of directory\n", "utf8");

		await expect(SessionManager.listAllFromDir(notADirectory)).rejects.toThrow();
	});

	it("propagates per-entry filesystem failures instead of returning a partial custom inventory", async () => {
		const root = await createAgentDir();
		const customDir = join(root, "custom-main-sessions");
		mkdirSync(customDir, { recursive: true });
		writeSession(join(customDir, "valid.jsonl"), "valid");
		mkdirSync(join(customDir, "not-a-file.jsonl"));

		await expect(SessionManager.listAllFromDir(customDir)).rejects.toThrow();
	});

	it("tracks explicit custom inventory roots without marking defaults or in-memory sessions custom", async () => {
		const root = await createAgentDir();
		const customDir = join(root, "flat");
		const custom = SessionManager.create("/tmp/project", customDir);
		const builtIn = SessionManager.create("/tmp/project");
		const inMemory = SessionManager.inMemory("/tmp/project");
		const inMemoryWithInventory = SessionManager.inMemory("/tmp/project", customDir);

		expect(custom.getCustomSessionInventoryRoot()).toBe(customDir);
		expect(builtIn.getCustomSessionInventoryRoot()).toBeUndefined();
		expect(inMemory.getCustomSessionInventoryRoot()).toBeUndefined();
		expect(inMemoryWithInventory.getCustomSessionInventoryRoot()).toBe(customDir);
	});
});

describe("SessionManager.listAll", () => {
	it("lists sessions across project directories", async () => {
		const agentDir = await createAgentDir();
		const projectDir = join(agentDir, "sessions", "project-a");
		mkdirSync(projectDir, { recursive: true });
		writeSession(join(projectDir, "one.jsonl"));

		const sessions = await SessionManager.listAll();

		expect(sessions.map((s) => s.path)).toContain(join(projectDir, "one.jsonl"));
	});

	it("returns an empty list when the sessions directory does not exist yet (fresh install)", async () => {
		await createAgentDir(); // agent dir exists, but no sessions/ subdirectory

		await expect(SessionManager.listAll()).resolves.toEqual([]);
	});

	it("fails loudly instead of returning [] when the sessions listing errors", async () => {
		// A missing directory is a legitimate empty state; an actual I/O failure is not. Here the
		// sessions path exists but is a FILE, so readdir throws (ENOTDIR). The old outer
		// catch { return [] } masked this as "no sessions" — regression guard for that behavior.
		const agentDir = await createAgentDir();
		writeFileSync(join(agentDir, "sessions"), "not a directory\n", "utf8");

		await expect(SessionManager.listAll()).rejects.toThrow();
	});
});
