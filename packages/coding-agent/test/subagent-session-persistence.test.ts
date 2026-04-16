import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type SessionHeader, SessionManager } from "../src/core/session-manager.js";
import { discoverSessionFile, type SubagentResult } from "../src/core/tools/subagent.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
	const dir = join(tmpdir(), `dreb-test-subagent-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeSessionFile(dir: string, name: string, ageMs = 0): string {
	const filePath = join(dir, name);
	writeFileSync(filePath, '{"type":"session","version":3}\n');
	if (ageMs > 0) {
		const past = new Date(Date.now() - ageMs);
		utimesSync(filePath, past, past);
	}
	return filePath;
}

// ---------------------------------------------------------------------------
// discoverSessionFile tests
// ---------------------------------------------------------------------------

describe("discoverSessionFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("returns undefined when directory does not exist", () => {
		const result = discoverSessionFile(join(tempDir, "nonexistent"), "test-agent");
		expect(result).toBeUndefined();
	});

	test("returns undefined when directory is empty", () => {
		const emptyDir = join(tempDir, "empty");
		mkdirSync(emptyDir);
		const result = discoverSessionFile(emptyDir, "test-agent");
		expect(result).toBeUndefined();
	});

	test("returns undefined when directory has no .jsonl files", () => {
		const dir = join(tempDir, "no-jsonl");
		mkdirSync(dir);
		writeFileSync(join(dir, "readme.txt"), "not a session file");
		const result = discoverSessionFile(dir, "test-agent");
		expect(result).toBeUndefined();
	});

	test("returns the path of a single .jsonl file", () => {
		const dir = join(tempDir, "single");
		mkdirSync(dir);
		const sessionPath = writeSessionFile(dir, "2026-04-01T12-00-00-000Z_abc123.jsonl");
		const result = discoverSessionFile(dir, "test-agent");
		expect(result).toBe(sessionPath);
	});

	test("returns the newest .jsonl file when multiple exist", () => {
		const dir = join(tempDir, "multiple");
		mkdirSync(dir);
		// Write an older file (1 hour old)
		writeSessionFile(dir, "old-session.jsonl", 60 * 60 * 1000);
		// Write a newer file (just now)
		const newestPath = writeSessionFile(dir, "new-session.jsonl");
		const result = discoverSessionFile(dir, "test-agent");
		expect(result).toBe(newestPath);
	});
});

// ---------------------------------------------------------------------------
// SubagentResult.sessionFile contract tests
// ---------------------------------------------------------------------------

describe("SubagentResult interface", () => {
	test("sessionFile field is optional and accepted", () => {
		const withoutSession: SubagentResult = {
			agent: "test",
			task: "test task",
			exitCode: 0,
			output: "output",
			stderr: "",
			errorMessage: null,
		};

		const withSession: SubagentResult = {
			...withoutSession,
			sessionFile: "/tmp/test-session.jsonl",
		};

		expect(withoutSession.sessionFile).toBeUndefined();
		expect(withSession.sessionFile).toBe("/tmp/test-session.jsonl");
	});
});

// ---------------------------------------------------------------------------
// SessionHeader agentType field tests
// ---------------------------------------------------------------------------

describe("SessionHeader agentType", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("setAgentType includes agentType in session header", () => {
		const sm = SessionManager.create("/tmp", tempDir);
		sm.setAgentType("feature-dev");

		expect(sm.getSessionId()).toBeTruthy();

		// SessionManager stores the header as fileEntries[0]
		const header = (sm as any).fileEntries[0] as SessionHeader;
		expect(header.type).toBe("session");
		expect(header.agentType).toBe("feature-dev");
	});

	test("session header omits agentType when setAgentType is not called", () => {
		const sm = SessionManager.create("/tmp", tempDir);
		const header = (sm as any).fileEntries[0] as SessionHeader;
		expect(header.type).toBe("session");
		expect(header.agentType).toBeUndefined();
	});

	test("setAgentType is safe to call on empty session manager", () => {
		const sm = SessionManager.inMemory();
		// Should not throw even though inMemory creates a session
		sm.setAgentType("test-agent");
		const header = (sm as any).fileEntries[0] as SessionHeader;
		expect(header.agentType).toBe("test-agent");
	});

	test("setAgentType persists agentType to disk in session header", () => {
		const sm = SessionManager.create("/tmp", tempDir);
		sm.setAgentType("feature-dev");

		// Add a user message then an assistant message to trigger flush to disk
		sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			model: "test-model",
			provider: "test",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		// Read back the JSONL file from disk
		const sessionFile = sm.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(true);

		const content = readFileSync(sessionFile!, "utf8");
		const firstLine = content.trim().split("\n")[0];
		const diskHeader = JSON.parse(firstLine) as SessionHeader;
		expect(diskHeader.type).toBe("session");
		expect(diskHeader.agentType).toBe("feature-dev");
	});
});
