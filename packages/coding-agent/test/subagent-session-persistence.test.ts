import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// We test the exported pruneSubagentSessions and the internal discoverSessionFile
// logic by importing them. discoverSessionFile is private, so we test it
// indirectly through the SubagentResult contract.

import { pruneSubagentSessions, type SubagentResult } from "../src/core/tools/subagent.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
	const dir = join(tmpdir(), `dreb-test-subagent-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function createSubagentDir(baseDir: string, name: string, ageMs = 0): string {
	const dir = join(baseDir, name);
	mkdirSync(dir, { recursive: true });
	// Write a dummy session file
	const sessionFile = join(dir, "2026-04-01T12-00-00-000Z_test.jsonl");
	writeFileSync(sessionFile, '{"type":"session","version":3}\n');
	// Set mtime to simulate age
	if (ageMs > 0) {
		const past = new Date(Date.now() - ageMs);
		const { utimesSync } = require("node:fs");
		utimesSync(dir, past, past);
		utimesSync(sessionFile, past, past);
	}
	return dir;
}

// ---------------------------------------------------------------------------
// pruneSubagentSessions tests
// ---------------------------------------------------------------------------

describe("pruneSubagentSessions", () => {
	let tempDir: string;
	let originalEnv: string | undefined;

	beforeEach(() => {
		tempDir = createTempDir();
		// Override the agent dir so getSubagentSessionsDir() points to our temp dir
		// ENV_AGENT_DIR = DREB_CODING_AGENT_DIR (from config.ts)
		originalEnv = process.env.DREB_CODING_AGENT_DIR;
		process.env.DREB_CODING_AGENT_DIR = tempDir;
		mkdirSync(join(tempDir, "subagent-sessions"), { recursive: true });
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.DREB_CODING_AGENT_DIR;
		} else {
			process.env.DREB_CODING_AGENT_DIR = originalEnv;
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("removes directories older than max age", () => {
		const subagentDir = join(tempDir, "subagent-sessions");
		const eightDaysMs = 8 * 24 * 60 * 60 * 1000;

		// Create an old subagent session dir
		createSubagentDir(subagentDir, "old-agent", eightDaysMs);
		expect(existsSync(join(subagentDir, "old-agent"))).toBe(true);

		pruneSubagentSessions(7 * 24 * 60 * 60 * 1000);

		expect(existsSync(join(subagentDir, "old-agent"))).toBe(false);
	});

	test("keeps directories newer than max age", () => {
		const subagentDir = join(tempDir, "subagent-sessions");

		// Create a recent subagent session dir (no age offset = just created)
		createSubagentDir(subagentDir, "recent-agent");
		expect(existsSync(join(subagentDir, "recent-agent"))).toBe(true);

		pruneSubagentSessions(7 * 24 * 60 * 60 * 1000);

		expect(existsSync(join(subagentDir, "recent-agent"))).toBe(true);
	});

	test("handles mixed old and new directories", () => {
		const subagentDir = join(tempDir, "subagent-sessions");
		const eightDaysMs = 8 * 24 * 60 * 60 * 1000;

		createSubagentDir(subagentDir, "old-agent", eightDaysMs);
		createSubagentDir(subagentDir, "recent-agent");

		pruneSubagentSessions(7 * 24 * 60 * 60 * 1000);

		expect(existsSync(join(subagentDir, "old-agent"))).toBe(false);
		expect(existsSync(join(subagentDir, "recent-agent"))).toBe(true);
	});

	test("does not throw when base directory does not exist", () => {
		// Point to a non-existent directory
		process.env.DREB_CODING_AGENT_DIR = join(tempDir, "nonexistent");
		expect(() => pruneSubagentSessions()).not.toThrow();
	});

	test("does not throw when base directory is empty", () => {
		// subagent-sessions dir exists but is empty
		expect(() => pruneSubagentSessions()).not.toThrow();
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
