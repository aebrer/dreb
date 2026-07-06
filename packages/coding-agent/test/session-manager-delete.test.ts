import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the `trash` CLI so branch selection is deterministic regardless of whether
// `trash` is installed on the machine running the tests. The default return simulates
// `trash` being absent (ENOENT), so deletion falls through to the unlink path.
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

import { spawnSync } from "node:child_process";
import { SessionManager } from "../src/core/session-manager.js";

const mockSpawnSync = vi.mocked(spawnSync);

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-session-delete-"));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	mockSpawnSync.mockReturnValue({
		status: null,
		signal: null,
		output: [],
		pid: 0,
		stdout: "",
		stderr: "",
		error: new Error("spawn trash ENOENT"),
	} as unknown as ReturnType<typeof spawnSync>);
});

afterEach(async () => {
	vi.clearAllMocks();
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionManager.deleteSession", () => {
	// deleteSession uses the same unrestricted path-based addressing as switch_session:
	// there is no sessions-directory containment guard, so a .jsonl file anywhere the process
	// can write (here, a temp dir outside the global sessions directory) is deletable. See the
	// PR #315 discussion for the rationale.
	it("deletes an existing .jsonl file via unlink and reports the method", async () => {
		const dir = await createTempDir();
		const sessionPath = join(dir, "session.jsonl");
		writeFileSync(sessionPath, "{}\n", "utf8");

		const result = await SessionManager.deleteSession(sessionPath);

		expect(result.ok).toBe(true);
		expect(result.method).toBe("unlink");
		expect(existsSync(sessionPath)).toBe(false);
	});

	it("reports method 'trash' when the trash CLI succeeds", async () => {
		const dir = await createTempDir();
		const sessionPath = join(dir, "session.jsonl");
		writeFileSync(sessionPath, "{}\n", "utf8");

		mockSpawnSync.mockReturnValue({
			status: 0,
			signal: null,
			output: [],
			pid: 0,
			stdout: "",
			stderr: "",
		} as unknown as ReturnType<typeof spawnSync>);

		const result = await SessionManager.deleteSession(sessionPath);

		expect(result.ok).toBe(true);
		expect(result.method).toBe("trash");
	});

	it("treats the file being gone after a nonzero trash exit as trash success", async () => {
		const dir = await createTempDir();
		const sessionPath = join(dir, "session.jsonl");
		writeFileSync(sessionPath, "{}\n", "utf8");

		const { unlinkSync } = await import("node:fs");
		// Simulate `trash` moving the file away but returning a nonzero status: the file
		// still exists when the existence guard runs, then is gone after spawnSync.
		mockSpawnSync.mockImplementation((() => {
			unlinkSync(sessionPath);
			return {
				status: 1,
				signal: null,
				output: [],
				pid: 0,
				stdout: "",
				stderr: "",
			} as unknown as ReturnType<typeof spawnSync>;
		}) as unknown as typeof spawnSync);

		const result = await SessionManager.deleteSession(sessionPath);

		expect(result.ok).toBe(true);
		expect(result.method).toBe("trash");
	});

	it("composes a trash error hint when unlink also fails", async () => {
		const dir = await createTempDir();
		// A directory named like a session file: exists, ends in .jsonl, but unlink() throws.
		const sessionPath = join(dir, "stubborn.jsonl");
		mkdirSync(sessionPath);

		mockSpawnSync.mockReturnValue({
			status: 1,
			signal: null,
			output: [],
			pid: 0,
			stdout: "",
			stderr: "trash: permission denied\nsecond line ignored",
		} as unknown as ReturnType<typeof spawnSync>);

		const result = await SessionManager.deleteSession(sessionPath);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("trash: ");
		expect(result.error).toContain("permission denied");
		// Only the first stderr line is included in the hint.
		expect(result.error).not.toContain("second line ignored");
	});

	it("includes both the spawn error and stderr in the hint when trash errored and unlink failed", async () => {
		const dir = await createTempDir();
		const sessionPath = join(dir, "stubborn.jsonl");
		mkdirSync(sessionPath); // unlink() throws on a directory

		mockSpawnSync.mockReturnValue({
			status: null,
			signal: null,
			output: [],
			pid: 0,
			stdout: "",
			stderr: "trash: cannot access",
			error: new Error("spawn trash EACCES"),
		} as unknown as ReturnType<typeof spawnSync>);

		const result = await SessionManager.deleteSession(sessionPath);

		expect(result.ok).toBe(false);
		// Both the spawn error message and the first stderr line are composed into the hint.
		expect(result.error).toContain("spawn trash EACCES");
		expect(result.error).toContain(" · ");
		expect(result.error).toContain("trash: cannot access");
	});

	it("fails for a nonexistent session path", async () => {
		const dir = await createTempDir();
		const sessionPath = join(dir, "missing.jsonl");

		const result = await SessionManager.deleteSession(sessionPath);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("does not exist");
	});

	it("rejects non-.jsonl paths without deleting the file", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "not-a-session.txt");
		writeFileSync(filePath, "do not delete\n", "utf8");

		const result = await SessionManager.deleteSession(filePath);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("Not a session file");
		expect(existsSync(filePath)).toBe(true);
	});

	it("refuses to delete the active session even via a non-canonical (./..) path", async () => {
		const dir = await createTempDir();
		const sessionPath = join(dir, "active.jsonl");
		writeFileSync(sessionPath, "{}\n", "utf8");

		// A non-canonical spelling of the same file must still be refused after resolve().
		const nonCanonical = join(dir, "sub", "..", ".", "active.jsonl");
		const result = await SessionManager.deleteSession(nonCanonical, {
			activeSessionPath: sessionPath,
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("Cannot delete the currently active session");
		expect(existsSync(sessionPath)).toBe(true);
	});
});
