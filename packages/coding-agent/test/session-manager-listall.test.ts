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

function writeSession(path: string): void {
	const header = { type: "session", id: "s", version: 3, cwd: "/tmp", timestamp: new Date().toISOString() };
	writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");
}

afterEach(async () => {
	if (savedEnv === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedEnv;
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
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
