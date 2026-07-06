import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { toRpcSessionInfo } from "../src/modes/rpc/rpc-mode.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-session-created-"));
	tempDirs.push(dir);
	return dir;
}

/** Write a session file whose header has the given (possibly invalid) timestamp value. */
function writeSessionWithTimestamp(path: string, timestamp: unknown): void {
	const header: Record<string, unknown> = {
		type: "session",
		id: "test-session",
		version: 3,
		cwd: "/tmp",
	};
	if (timestamp !== undefined) header.timestamp = timestamp;
	writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionInfo.created guard", () => {
	it("falls back to a valid Date when the header timestamp is missing", async () => {
		const dir = await createTempDir();
		writeSessionWithTimestamp(join(dir, "no-timestamp.jsonl"), undefined);

		const sessions = await SessionManager.list("/tmp", dir);

		expect(sessions).toHaveLength(1);
		// A missing header timestamp must NOT yield an Invalid Date.
		expect(Number.isNaN(sessions[0]?.created.getTime())).toBe(false);
	});

	it("falls back to a valid Date when the header timestamp is malformed", async () => {
		const dir = await createTempDir();
		writeSessionWithTimestamp(join(dir, "bad-timestamp.jsonl"), "not-a-real-date");

		const sessions = await SessionManager.list("/tmp", dir);

		expect(sessions).toHaveLength(1);
		expect(Number.isNaN(sessions[0]?.created.getTime())).toBe(false);
	});

	it("does not throw when a session with a bad timestamp is serialized to the RPC DTO", async () => {
		// Regression: an Invalid Date reaches toRpcSessionInfo's created.toISOString(), which
		// throws RangeError — and because listings map over every session, one bad file would
		// take down the entire list_all_sessions response.
		const dir = await createTempDir();
		writeSessionWithTimestamp(join(dir, "bad-timestamp.jsonl"), "garbage");

		const sessions = await SessionManager.list("/tmp", dir);
		expect(sessions).toHaveLength(1);

		const info = sessions[0];
		if (!info) throw new Error("expected a session");
		expect(() => toRpcSessionInfo(info)).not.toThrow();
		expect(typeof toRpcSessionInfo(info).created).toBe("string");
	});
});
