import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-session-delete-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionManager.deleteSession", () => {
	it("deletes an existing .jsonl file", async () => {
		const dir = await createTempDir();
		const sessionPath = join(dir, "session.jsonl");
		writeFileSync(sessionPath, "{}\n", "utf8");

		const result = await SessionManager.deleteSession(sessionPath);

		expect(result.ok).toBe(true);
		expect(existsSync(sessionPath)).toBe(false);
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
});
