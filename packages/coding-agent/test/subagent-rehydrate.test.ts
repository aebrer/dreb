import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { log } from "../src/core/logger.js";
import {
	discoverSessionFile,
	getBackgroundAgents,
	pruneBackgroundAgents,
	rehydrateBackgroundAgentsFromDisk,
	SUBAGENT_CANCELLED_MARKER_FILE,
} from "../src/core/tools/subagent.js";

function createTempDir(): string {
	const dir = join(tmpdir(), `dreb-test-subagent-rehydrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeJsonl(filePath: string, entries: unknown[]): void {
	writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function writeChildSession(
	baseDir: string,
	name: string,
	parentSessionFile: string,
	task: string,
	stopReason = "stop",
): { childDir: string; sessionFile: string } {
	const childDir = join(baseDir, name);
	mkdirSync(childDir, { recursive: true });
	const sessionFile = join(childDir, `${name}.jsonl`);
	writeJsonl(sessionFile, [
		{
			type: "session",
			version: 3,
			id: name,
			timestamp: "2026-01-02T03:05:00.000Z",
			cwd: baseDir,
			parentSession: parentSessionFile,
			agentType: "Explore",
		},
		{
			type: "message",
			id: `${name}-user`,
			parentId: null,
			timestamp: "2026-01-02T03:05:01.000Z",
			message: { role: "user", content: task },
		},
		{
			type: "message",
			id: `${name}-assistant`,
			parentId: `${name}-user`,
			timestamp: "2026-01-02T03:05:02.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason },
		},
	]);
	return { childDir, sessionFile };
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
		vi.restoreAllMocks();
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

	test("registers a chain session from step subdirectories and uses the last step status", () => {
		const chainDir = join(subagentSessionsBase, "chain-abc123");
		const step1Dir = join(chainDir, "step-1");
		const step2Dir = join(chainDir, "step-2");
		mkdirSync(step1Dir, { recursive: true });
		mkdirSync(step2Dir, { recursive: true });
		const step1SessionFile = join(step1Dir, "step-1.jsonl");
		const step2SessionFile = join(step2Dir, "step-2.jsonl");
		writeJsonl(step1SessionFile, [
			{
				type: "session",
				version: 3,
				id: "chain-abc123-step-1",
				timestamp: "2026-01-02T03:05:00.000Z",
				cwd: tempDir,
				parentSession: parentSessionFile,
				agentType: "Explore",
			},
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: "2026-01-02T03:05:01.000Z",
				message: { role: "user", content: "Run chain step one" },
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: "2026-01-02T03:05:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "Step one done" }], stopReason: "stop" },
			},
		]);
		writeJsonl(step2SessionFile, [
			{
				type: "session",
				version: 3,
				id: "chain-abc123-step-2",
				timestamp: "2026-01-02T03:06:00.000Z",
				cwd: tempDir,
				parentSession: parentSessionFile,
				agentType: "Review",
			},
			{
				type: "message",
				id: "assistant-2",
				parentId: null,
				timestamp: "2026-01-02T03:06:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "Step two failed" }], stopReason: "error" },
			},
		]);

		expect(discoverSessionFile(chainDir, "chain-abc123")).toBeDefined();

		const count = rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase);

		expect(count).toBe(1);
		const agent = getBackgroundAgents().find((candidate) => candidate.sessionDir === chainDir);
		expect(agent).toBeDefined();
		expect(agent).toMatchObject({
			agentId: "rehydrated-chain-abc123",
			agentType: "Explore",
			taskSummary: "Run chain step one",
			status: "failed",
			sessionDir: chainDir,
			sessionFile: step1SessionFile,
			cwd: tempDir,
		});
	});

	test("infers status from the child's final stop reason: aborted → cancelled, error → failed", () => {
		const cancelled = writeChildSession(subagentSessionsBase, "stopped-child", parentSessionFile, "t1", "aborted");
		const failed = writeChildSession(subagentSessionsBase, "errored-child", parentSessionFile, "t2", "error");
		const completed = writeChildSession(subagentSessionsBase, "finished-child", parentSessionFile, "t3", "stop");

		expect(rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase)).toBe(3);
		const statusFor = (sessionFile: string) =>
			getBackgroundAgents().find((agent) => agent.sessionFile === sessionFile)?.status;
		expect(statusFor(cancelled.sessionFile)).toBe("cancelled");
		expect(statusFor(failed.sessionFile)).toBe("failed");
		expect(statusFor(completed.sessionFile)).toBe("completed");
	});

	function writeCancellationMarker(sessionDir: string, overrides: Record<string, unknown> = {}): void {
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(sessionDir, SUBAGENT_CANCELLED_MARKER_FILE),
			`${JSON.stringify({
				type: "subagent_cancelled",
				version: 1,
				cancelledAt: "2026-01-02T03:07:00.000Z",
				parentSession: parentSessionFile,
				agentType: "worker",
				taskSummary: "worker task",
				startedAt: "2026-01-02T03:05:00.000Z",
				cwd: tempDir,
				...overrides,
			})}\n`,
		);
	}

	test("a cancellation marker overrides a log tail that doesn't show the stop", () => {
		// Child terminated after the grace period: its last saved message is a normal tool-use turn.
		const killed = writeChildSession(subagentSessionsBase, "killed-child", parentSessionFile, "t1", "toolUse");
		writeCancellationMarker(killed.childDir);
		// Untouched sibling without a marker keeps its inferred status.
		const finished = writeChildSession(subagentSessionsBase, "finished-child", parentSessionFile, "t2", "stop");

		expect(rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase)).toBe(2);
		const statusFor = (sessionFile: string) =>
			getBackgroundAgents().find((agent) => agent.sessionFile === sessionFile)?.status;
		expect(statusFor(killed.sessionFile)).toBe("cancelled");
		expect(statusFor(finished.sessionFile)).toBe("completed");
	});

	test("a chain stopped between steps rehydrates as cancelled, not as its last completed step", () => {
		const chainDir = join(subagentSessionsBase, "chain-stopped");
		const step1Dir = join(chainDir, "step-1");
		mkdirSync(step1Dir, { recursive: true });
		writeJsonl(join(step1Dir, "step-1.jsonl"), [
			{
				type: "session",
				version: 3,
				id: "chain-stopped-step-1",
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
				message: { role: "assistant", content: [{ type: "text", text: "Step one done" }], stopReason: "stop" },
			},
		]);
		writeCancellationMarker(chainDir, { agentType: "Explore", taskSummary: "2-step chain" });

		expect(rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase)).toBe(1);
		expect(getBackgroundAgents().find((agent) => agent.sessionDir === chainDir)?.status).toBe("cancelled");
	});

	test("recovers an agent stopped before it spawned from its marker alone", () => {
		const queuedDir = join(subagentSessionsBase, "queued-agent");
		writeCancellationMarker(queuedDir);

		expect(rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase)).toBe(1);
		const agent = getBackgroundAgents().find((candidate) => candidate.sessionDir === queuedDir);
		expect(agent).toEqual({
			agentId: "rehydrated-queued-agent",
			agentType: "worker",
			taskSummary: "worker task",
			startedAt: Date.parse("2026-01-02T03:05:00.000Z"),
			status: "cancelled",
			sessionDir: queuedDir,
			cwd: tempDir,
		});
		// Idempotent: the directory is already registered.
		expect(rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase)).toBe(0);
	});

	test("ignores a marker-only agent of another parent session", () => {
		writeCancellationMarker(join(subagentSessionsBase, "other-parent-agent"), {
			parentSession: join(tempDir, "different-parent.jsonl"),
		});

		expect(rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase)).toBe(0);
	});

	test("a malformed marker still marks a logged agent cancelled but can't recover a marker-only one", () => {
		const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
		const logged = writeChildSession(subagentSessionsBase, "logged-child", parentSessionFile, "t1", "stop");
		writeFileSync(join(logged.childDir, SUBAGENT_CANCELLED_MARKER_FILE), "{not json");
		const markerOnlyDir = join(subagentSessionsBase, "marker-only");
		writeCancellationMarker(markerOnlyDir, { startedAt: "not a date" });

		expect(rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase)).toBe(1);
		expect(getBackgroundAgents().find((agent) => agent.sessionFile === logged.sessionFile)?.status).toBe("cancelled");
		expect(getBackgroundAgents().some((agent) => agent.sessionDir === markerOnlyDir)).toBe(false);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed cancellation marker"));
	});

	test("discovers matching sessions from configured and legacy roots in order", () => {
		const configuredRoot = join(tempDir, "configured-subagents");
		mkdirSync(configuredRoot, { recursive: true });
		const configured = writeChildSession(configuredRoot, "configured-child", parentSessionFile, "configured task");
		const legacy = writeChildSession(subagentSessionsBase, "legacy-child", parentSessionFile, "legacy task");

		expect(rehydrateBackgroundAgentsFromDisk(parentSessionFile, [configuredRoot, subagentSessionsBase])).toBe(2);
		const matching = getBackgroundAgents().filter(
			(agent) => agent.sessionFile === configured.sessionFile || agent.sessionFile === legacy.sessionFile,
		);
		expect(matching.map((agent) => agent.sessionDir)).toEqual([configured.childDir, legacy.childDir]);
	});

	test("continues to later roots when the configured root is missing", () => {
		const legacy = writeChildSession(subagentSessionsBase, "legacy-after-missing", parentSessionFile, "legacy task");

		expect(
			rehydrateBackgroundAgentsFromDisk(parentSessionFile, [
				join(tempDir, "missing-configured"),
				subagentSessionsBase,
			]),
		).toBe(1);
		expect(getBackgroundAgents().some((agent) => agent.sessionFile === legacy.sessionFile)).toBe(true);
	});

	test("fails loudly instead of returning a normal legacy-only registry when the configured root is invalid", () => {
		const invalidConfiguredRoot = join(tempDir, "configured-root-is-a-file");
		writeFileSync(invalidConfiguredRoot, "not a directory\n");
		const legacy = writeChildSession(
			subagentSessionsBase,
			"legacy-hidden-by-error",
			parentSessionFile,
			"legacy task",
		);

		expect(() =>
			rehydrateBackgroundAgentsFromDisk(parentSessionFile, [invalidConfiguredRoot, subagentSessionsBase]),
		).toThrow();
		expect(getBackgroundAgents().some((agent) => agent.sessionFile === legacy.sessionFile)).toBe(false);
	});

	test("warns and skips an invalid compatibility root after recovering the configured root", () => {
		const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
		const configuredRoot = join(tempDir, "configured-subagents");
		mkdirSync(configuredRoot, { recursive: true });
		const configured = writeChildSession(configuredRoot, "configured-child", parentSessionFile, "configured task");
		rmSync(subagentSessionsBase, { recursive: true, force: true });
		writeFileSync(subagentSessionsBase, "not a directory\n");

		expect(rehydrateBackgroundAgentsFromDisk(parentSessionFile, [configuredRoot, subagentSessionsBase])).toBe(1);
		expect(getBackgroundAgents().some((agent) => agent.sessionFile === configured.sessionFile)).toBe(true);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipped compatibility-root recovery"));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(subagentSessionsBase));
	});

	test("warns and skips broken compatibility entries while recovering valid siblings", () => {
		const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
		const configuredRoot = join(tempDir, "configured-subagents");
		mkdirSync(configuredRoot, { recursive: true });
		const brokenChildDir = join(subagentSessionsBase, "broken-child");
		symlinkSync("broken-child", brokenChildDir, "dir");
		const legacy = writeChildSession(subagentSessionsBase, "legacy-child", parentSessionFile, "legacy task");

		expect(rehydrateBackgroundAgentsFromDisk(parentSessionFile, [configuredRoot, subagentSessionsBase])).toBe(1);
		expect(getBackgroundAgents().some((agent) => agent.sessionFile === legacy.sessionFile)).toBe(true);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(`entry ${brokenChildDir}`));
	});

	test("propagates operational failures from entries in the primary root", () => {
		const brokenChildDir = join(subagentSessionsBase, "broken-primary-child");
		symlinkSync("broken-primary-child", brokenChildDir, "dir");

		expect(() => rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase)).toThrow();
	});

	test("prefers the configured path spelling and deduplicates symlinked or repeated roots", () => {
		writeChildSession(subagentSessionsBase, "shared-child", parentSessionFile, "shared task");
		const configuredAlias = join(tempDir, "configured-alias");
		symlinkSync(subagentSessionsBase, configuredAlias, "dir");

		expect(
			rehydrateBackgroundAgentsFromDisk(parentSessionFile, [configuredAlias, subagentSessionsBase, configuredAlias]),
		).toBe(1);
		const matching = getBackgroundAgents().filter((agent) => agent.taskSummary === "shared task");
		expect(matching).toHaveLength(1);
		expect(matching[0]?.sessionDir).toBe(join(configuredAlias, "shared-child"));
		expect(matching[0]?.sessionFile).toBe(join(configuredAlias, "shared-child", "shared-child.jsonl"));
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
