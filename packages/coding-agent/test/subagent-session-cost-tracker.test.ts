import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SubagentSessionCostTracker } from "../src/core/subagent-session-cost-tracker.js";
import { pruneBackgroundAgents, rehydrateBackgroundAgentsFromDisk } from "../src/core/tools/subagent.js";

function writeSubagentSession(filePath: string, parentSession: string, id: string, cost: number): void {
	writeFileSync(
		filePath,
		`${[
			{
				type: "session",
				version: 3,
				id,
				timestamp: "2026-01-02T03:05:00.000Z",
				cwd: "/test",
				parentSession,
				agentType: "Explore",
			},
			{
				type: "message",
				id: `${id}-assistant`,
				parentId: null,
				timestamp: "2026-01-02T03:05:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
					},
				},
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
}

describe("SubagentSessionCostTracker", () => {
	let tempDir: string;
	let tracker: SubagentSessionCostTracker | undefined;

	beforeEach(() => {
		pruneBackgroundAgents(0);
		tempDir = mkdtempSync(join(tmpdir(), "dreb-subagent-cost-test-"));
	});

	afterEach(() => {
		tracker?.dispose();
		pruneBackgroundAgents(0);
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("sums every chain step together with normal sub-agent sessions", async () => {
		const parentSession = join(tempDir, "parent.jsonl");
		const sessionsDir = join(tempDir, "subagent-sessions");
		const chainStep0 = join(sessionsDir, "chain-agent", "step-0");
		const chainStep1 = join(sessionsDir, "chain-agent", "step-1");
		const normalAgent = join(sessionsDir, "normal-agent");
		mkdirSync(chainStep0, { recursive: true });
		mkdirSync(chainStep1, { recursive: true });
		mkdirSync(normalAgent, { recursive: true });
		writeSubagentSession(join(chainStep0, "step-0.jsonl"), parentSession, "chain-step-0", 0.2);
		writeSubagentSession(join(chainStep1, "step-1.jsonl"), parentSession, "chain-step-1", 0.3);
		writeSubagentSession(join(normalAgent, "normal.jsonl"), parentSession, "normal", 0.4);

		expect(rehydrateBackgroundAgentsFromDisk(parentSession, sessionsDir)).toBe(2);
		tracker = new SubagentSessionCostTracker();
		await tracker.refresh();

		expect(tracker.getCost()).toBeCloseTo(0.9, 5);
	});
});
