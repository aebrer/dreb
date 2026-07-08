import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	getBackgroundAgents,
	pruneBackgroundAgents,
	rehydrateBackgroundAgentsFromDisk,
} from "../src/core/tools/subagent.js";

function createTempDir(): string {
	const dir = join(tmpdir(), `dreb-test-subagent-rehydrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeJsonl(filePath: string, entries: unknown[]): void {
	writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

describe("rehydrateBackgroundAgentsFromDisk", () => {
	let tempDir: string;
	let subagentSessionsBase: string;
	let parentSessionFile: string;

	beforeEach(() => {
		tempDir = createTempDir();
		subagentSessionsBase = join(tempDir, "subagent-sessions");
		mkdirSync(subagentSessionsBase, { recursive: true });
		parentSessionFile = join(tempDir, "2026-01-02T03-04-05-000Z_parent-session.jsonl");
	});

	afterEach(() => {
		pruneBackgroundAgents(0);
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("registers a matching child session with disk log paths and completed status", () => {
		const childDir = join(subagentSessionsBase, "child-completed");
		mkdirSync(childDir, { recursive: true });
		const childSessionFile = join(childDir, "child.jsonl");
		writeJsonl(childSessionFile, [
			{
				type: "session",
				version: 3,
				id: "child-completed",
				timestamp: "2026-01-02T03:05:00.000Z",
				cwd: tempDir,
				parentSession: parentSessionFile,
				agentType: "Review",
			},
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: "2026-01-02T03:05:01.000Z",
				message: { role: "user", content: "Investigate the resumed dashboard subagent chip" },
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: "2026-01-02T03:05:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Done" }],
					stopReason: "stop",
				},
			},
		]);

		const count = rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase);

		expect(count).toBe(1);
		const agent = getBackgroundAgents().find((candidate) => candidate.sessionFile === childSessionFile);
		expect(agent).toBeDefined();
		expect(agent).toMatchObject({
			agentId: "rehydrated-child-completed",
			agentType: "Review",
			taskSummary: "Investigate the resumed dashboard subagent chip",
			status: "completed",
			sessionDir: childDir,
			sessionFile: childSessionFile,
			cwd: tempDir,
		});
	});

	test("ignores child sessions whose parentSession does not match", () => {
		const childDir = join(subagentSessionsBase, "child-other-parent");
		mkdirSync(childDir, { recursive: true });
		const childSessionFile = join(childDir, "child.jsonl");
		writeJsonl(childSessionFile, [
			{
				type: "session",
				version: 3,
				id: "child-other-parent",
				timestamp: "2026-01-02T03:05:00.000Z",
				cwd: tempDir,
				parentSession: join(tempDir, "different-parent.jsonl"),
				agentType: "Review",
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: null,
				timestamp: "2026-01-02T03:05:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
			},
		]);

		const count = rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase);

		expect(count).toBe(0);
		expect(getBackgroundAgents().some((candidate) => candidate.sessionFile === childSessionFile)).toBe(false);
	});

	test("is idempotent and exposes the rehydrated entry through getBackgroundAgents", () => {
		const childDir = join(subagentSessionsBase, "child-idempotent");
		mkdirSync(childDir, { recursive: true });
		const childSessionFile = join(childDir, "child.jsonl");
		writeJsonl(childSessionFile, [
			{
				type: "session",
				version: 3,
				id: "child-idempotent",
				timestamp: "2026-01-02T03:05:00.000Z",
				cwd: tempDir,
				parentSession: parentSessionFile,
				agentType: "Explore",
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: null,
				timestamp: "2026-01-02T03:05:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
			},
		]);

		expect(rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase)).toBe(1);
		expect(rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase)).toBe(0);

		const matchingAgents = getBackgroundAgents().filter((candidate) => candidate.sessionFile === childSessionFile);
		expect(matchingAgents).toHaveLength(1);
		expect(matchingAgents[0]).toMatchObject({
			agentId: "rehydrated-child-idempotent",
			agentType: "Explore",
			status: "completed",
			sessionDir: childDir,
			sessionFile: childSessionFile,
		});
	});
});
