import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSubagentSessionFile, readSubagentMessages } from "../src/server/subagent-log.js";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-subagent-log-"));
	tempDirs.push(dir);
	return dir;
}

function line(entry: unknown): string {
	return `${JSON.stringify(entry)}\n`;
}

describe("discoverSubagentSessionFile", () => {
	it("returns undefined for a missing directory", () => {
		expect(discoverSubagentSessionFile("/nonexistent/dir")).toBeUndefined();
	});

	it("returns undefined when the directory has no .jsonl files", async () => {
		const dir = await makeDir();
		await writeFile(join(dir, "notes.txt"), "not a session");
		expect(discoverSubagentSessionFile(dir)).toBeUndefined();
	});

	it("picks the most recently modified .jsonl", async () => {
		const dir = await makeDir();
		const oldFile = join(dir, "old.jsonl");
		const newFile = join(dir, "new.jsonl");
		await writeFile(oldFile, "{}");
		await writeFile(newFile, "{}");
		const past = new Date(Date.now() - 60_000);
		await utimes(oldFile, past, past);
		expect(discoverSubagentSessionFile(dir)).toBe(newFile);
	});
});

describe("readSubagentMessages", () => {
	it("throws loudly when no session file exists", () => {
		expect(() => readSubagentMessages({})).toThrow(/No session log found/);
		expect(() => readSubagentMessages({ sessionFile: "/nope.jsonl" })).toThrow(/No session log found/);
		expect(() => readSubagentMessages({ sessionDir: "/nonexistent" })).toThrow(/No session log found/);
	});

	it("extracts message payloads from a session log, skipping non-message and malformed lines", async () => {
		const dir = await makeDir();
		const file = join(dir, "session.jsonl");
		const user = { role: "user", content: "do the thing" };
		const assistant = { role: "assistant", content: [{ type: "text", text: "done" }] };
		await writeFile(
			file,
			line({ type: "session", cwd: "/repo" }) +
				line({ type: "message", id: "1", message: user }) +
				line({ type: "model_change", provider: "p", modelId: "m" }) +
				line({ type: "message", id: "2", message: assistant }) +
				"{ malformed tail",
		);

		expect(readSubagentMessages({ sessionFile: file })).toEqual([user, assistant]);
	});

	it("falls back to sessionDir discovery when sessionFile is absent (running agent)", async () => {
		const dir = await makeDir();
		const message = { role: "assistant", content: [{ type: "text", text: "mid-run" }] };
		await writeFile(join(dir, "live.jsonl"), line({ type: "message", id: "1", message }));

		expect(readSubagentMessages({ sessionDir: dir })).toEqual([message]);
	});
});
