import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkSessionFile,
	loadEntriesFromFile,
	readSessionTranscript,
	SessionManager,
} from "../src/core/session-manager.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-session-rename-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Line = Record<string, unknown>;

function header(cwd = "/work/project", overrides: Line = {}): Line {
	return { type: "session", version: 3, id: "session-uuid", timestamp: "2026-01-01T00:00:00.000Z", cwd, ...overrides };
}

function userEntry(id: string, parentId: string | null, text: string): Line {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function assistantEntry(id: string, parentId: string | null, text: string): Line {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:02.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "test",
			model: "test-model",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
			stopReason: "stop",
			timestamp: 2,
		},
	};
}

function writeJsonl(path: string, lines: Line[]): void {
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

async function writeSession(name = "session.jsonl", lines?: Line[]): Promise<{ dir: string; path: string }> {
	const dir = await createTempDir();
	const path = join(dir, name);
	writeJsonl(
		path,
		lines ?? [header(), userEntry("u1", null, "Fix the login bug"), assistantEntry("a1", "u1", "On it")],
	);
	return { dir, path };
}

function sessionInfoNames(path: string): Array<string | undefined> {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.type === "session_info")
		.map((entry) => entry.name);
}

describe("checkSessionFile", () => {
	it("accepts a session file and returns its resolved path and header", async () => {
		const { dir, path } = await writeSession();

		const result = checkSessionFile(join(dir, "sub", "..", "session.jsonl"));

		expect(result).toEqual({
			ok: true,
			path,
			header: expect.objectContaining({ id: "session-uuid", cwd: "/work/project" }),
		});
	});

	it("accepts a session whose header line is longer than 512 bytes", async () => {
		const longCwd = `/work/${"deep/".repeat(200)}project`;
		const { path } = await writeSession("long.jsonl", [header(longCwd), userEntry("u1", null, "hi")]);

		const result = checkSessionFile(path);

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.header.cwd).toBe(longCwd);
	});

	it("rejects a path that does not end in .jsonl without touching it", async () => {
		const dir = await createTempDir();
		const path = join(dir, "notes.txt");
		writeFileSync(path, "keep me\n", "utf8");

		expect(checkSessionFile(path)).toEqual({ ok: false, error: `Not a session file (expected .jsonl): ${path}` });
		expect(readFileSync(path, "utf8")).toBe("keep me\n");
	});

	it("rejects a missing path without creating its directory", async () => {
		const dir = await createTempDir();
		const missingDir = join(dir, "missing");
		const path = join(missingDir, "session.jsonl");

		const result = checkSessionFile(path);

		expect(result).toEqual({ ok: false, error: `Session file does not exist: ${path}` });
		expect(existsSync(missingDir)).toBe(false);
	});

	it("rejects a directory named like a session file", async () => {
		const dir = await createTempDir();
		const path = join(dir, "folder.jsonl");
		mkdirSync(path);

		expect(checkSessionFile(path)).toEqual({ ok: false, error: `Not a session file (not a regular file): ${path}` });
	});

	it.each([
		["a .jsonl without a session header", '{"type":"message","id":"x"}\n'],
		["an empty .jsonl", ""],
		["a non-JSON .jsonl", "plain text\n"],
	])("rejects %s and leaves it byte-identical", async (_label, content) => {
		const dir = await createTempDir();
		const path = join(dir, "data.jsonl");
		writeFileSync(path, content, "utf8");

		expect(checkSessionFile(path)).toEqual({
			ok: false,
			error: `Not a session file (missing or invalid session header): ${path}`,
		});
		expect(readFileSync(path, "utf8")).toBe(content);
	});
});

describe("SessionManager.renameSession", () => {
	it("appends a session_info entry that session listings report", async () => {
		const { dir, path } = await writeSession();
		const before = readFileSync(path, "utf8");

		const result = SessionManager.renameSession(path, "  Login bug fix  ");

		expect(result).toEqual({ ok: true, name: "Login bug fix" });
		// Append-only: the original bytes are untouched.
		expect(readFileSync(path, "utf8").startsWith(before)).toBe(true);
		expect(sessionInfoNames(path)).toEqual(["Login bug fix"]);
		const [listed] = await SessionManager.listAllFromDir(dir);
		expect(listed?.name).toBe("Login bug fix");
	});

	it("lets a later rename win", async () => {
		const { dir, path } = await writeSession();

		expect(SessionManager.renameSession(path, "First").ok).toBe(true);
		expect(SessionManager.renameSession(path, "Second").ok).toBe(true);

		expect(sessionInfoNames(path)).toEqual(["First", "Second"]);
		const [listed] = await SessionManager.listAllFromDir(dir);
		expect(listed?.name).toBe("Second");
	});

	it("resolves non-canonical paths", async () => {
		const { dir, path } = await writeSession();

		const result = SessionManager.renameSession(join(dir, "sub", "..", ".", "session.jsonl"), "Renamed");

		expect(result.ok).toBe(true);
		expect(sessionInfoNames(path)).toEqual(["Renamed"]);
	});

	it.each(["", "   "])("rejects the empty name %j without writing", async (name) => {
		const { path } = await writeSession();
		const before = readFileSync(path, "utf8");

		expect(SessionManager.renameSession(path, name)).toEqual({ ok: false, error: "Session name cannot be empty" });
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("refuses a non-session file without truncating it", async () => {
		const dir = await createTempDir();
		const path = join(dir, "important.jsonl");
		const content = '{"keep":"this"}\n{"and":"this"}\n';
		writeFileSync(path, content, "utf8");

		const result = SessionManager.renameSession(path, "Nope");

		expect(result).toEqual({ ok: false, error: `Not a session file (missing or invalid session header): ${path}` });
		expect(readFileSync(path, "utf8")).toBe(content);
	});

	it("refuses a missing path without creating files or directories", async () => {
		const dir = await createTempDir();
		const missingDir = join(dir, "nowhere");
		const path = join(missingDir, "ghost.jsonl");

		const result = SessionManager.renameSession(path, "Ghost");

		expect(result).toEqual({ ok: false, error: `Session file does not exist: ${path}` });
		expect(existsSync(missingDir)).toBe(false);
	});

	it("refuses non-.jsonl paths and directories", async () => {
		const dir = await createTempDir();
		const textPath = join(dir, "notes.txt");
		writeFileSync(textPath, "keep\n", "utf8");
		const dirPath = join(dir, "folder.jsonl");
		mkdirSync(dirPath);

		expect(SessionManager.renameSession(textPath, "x").ok).toBe(false);
		expect(SessionManager.renameSession(dirPath, "x").ok).toBe(false);
		expect(readFileSync(textPath, "utf8")).toBe("keep\n");
	});

	it("fails loudly when the name cannot be persisted (no assistant reply)", async () => {
		const { path } = await writeSession("header-only.jsonl", [header()]);
		const before = readFileSync(path, "utf8");

		const result = SessionManager.renameSession(path, "Unsaved");

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Session name was not saved");
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("keeps an unterminated last record intact and readable", async () => {
		const dir = await createTempDir();
		const path = join(dir, "unterminated.jsonl");
		// Written by another JSONL tool or a hand edit: valid records, but no newline after the last.
		const before = [header(), userEntry("u1", null, "Fix the login bug"), assistantEntry("a1", "u1", "On it")]
			.map((line) => JSON.stringify(line))
			.join("\n");
		writeFileSync(path, before, "utf8");

		const result = SessionManager.renameSession(path, "Login bug fix");

		expect(result).toEqual({ ok: true, name: "Login bug fix" });
		const after = readFileSync(path, "utf8");
		expect(after.startsWith(`${before}\n`)).toBe(true);
		expect(after.endsWith("\n")).toBe(true);
		expect(loadEntriesFromFile(path).map((entry) => entry.type)).toEqual([
			"session",
			"message",
			"message",
			"session_info",
		]);
		expect(readSessionTranscript(path).messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(sessionInfoNames(path)).toEqual(["Login bug fix"]);
	});
});

describe("readSessionTranscript", () => {
	it("returns the header and current-branch messages in order", async () => {
		const { path } = await writeSession();

		const transcript = readSessionTranscript(path);

		expect(transcript.header).toEqual(expect.objectContaining({ id: "session-uuid", cwd: "/work/project" }));
		expect(transcript.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(transcript.messages[0]).toEqual(expect.objectContaining({ content: "Fix the login bug" }));
	});

	it("follows the branch that ends at the last entry", async () => {
		const { path } = await writeSession("branched.jsonl", [
			header(),
			userEntry("u1", null, "Root request"),
			assistantEntry("a1", "u1", "Root reply"),
			userEntry("u2", "a1", "Abandoned branch"),
			assistantEntry("a2", "u2", "Abandoned reply"),
			userEntry("u3", "a1", "Current branch"),
			assistantEntry("a3", "u3", "Current reply"),
			{ type: "session_info", id: "i1", parentId: "a3", timestamp: "2026-01-01T00:00:03.000Z", name: "Named" },
		]);

		const texts = readSessionTranscript(path).messages.map((message) =>
			message.role === "user" ? message.content : message.role === "assistant" ? message.content[0] : undefined,
		);

		expect(texts).toEqual([
			"Root request",
			{ type: "text", text: "Root reply" },
			"Current branch",
			{ type: "text", text: "Current reply" },
		]);
	});

	it("keeps messages that a compaction summarized, including the original request", async () => {
		const { path } = await writeSession("compacted.jsonl", [
			header(),
			userEntry("u1", null, "Original request"),
			assistantEntry("a1", "u1", "Early work"),
			userEntry("u2", "a1", "Follow-up"),
			assistantEntry("a2", "u2", "Later work"),
			{
				type: "compaction",
				id: "c1",
				parentId: "a2",
				timestamp: "2026-01-01T00:00:04.000Z",
				summary: "Summary of early work",
				firstKeptEntryId: "u2",
				tokensBefore: 1000,
			},
			userEntry("u3", "c1", "After compaction"),
			assistantEntry("a3", "u3", "Done"),
		]);

		const users = readSessionTranscript(path)
			.messages.filter((message) => message.role === "user")
			.map((message) => (message.role === "user" ? message.content : undefined));

		expect(users).toEqual(["Original request", "Follow-up", "After compaction"]);
	});

	it("migrates old-format sessions in memory without rewriting the file", async () => {
		const v1 = [
			{ type: "session", id: "old-session", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/old/project" },
			{
				type: "message",
				timestamp: "2025-01-01T00:00:01.000Z",
				message: { role: "user", content: "Old request", timestamp: 1 },
			},
			{
				type: "message",
				timestamp: "2025-01-01T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Old reply" }],
					stopReason: "stop",
					timestamp: 2,
				},
			},
		];
		const { path } = await writeSession("v1.jsonl", v1);
		const before = readFileSync(path, "utf8");

		const transcript = readSessionTranscript(path);

		expect(transcript.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("throws a specific error for invalid paths and leaves files untouched", async () => {
		const dir = await createTempDir();
		const bogus = join(dir, "bogus.jsonl");
		writeFileSync(bogus, "not a session\n", "utf8");

		expect(() => readSessionTranscript(bogus)).toThrow(
			`Not a session file (missing or invalid session header): ${bogus}`,
		);
		expect(readFileSync(bogus, "utf8")).toBe("not a session\n");
		expect(() => readSessionTranscript(join(dir, "missing.jsonl"))).toThrow("Session file does not exist");
		expect(() => readSessionTranscript(join(dir, "x.txt"))).toThrow("expected .jsonl");
	});
});
