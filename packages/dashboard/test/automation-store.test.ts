import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type AutomationRecord, AutomationStore } from "../src/server/automation-store.js";

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { force: true, recursive: true });
});

const run: AutomationRecord = {
	id: "10000000-0000-4000-8000-000000000001",
	cwd: "/b",
	createdAt: "2026-01-02T03:04:05Z",
	status: "reviewing",
	instructions: "Do what I agreed to.",
	workerModel: { provider: "one", id: "work" },
	guardModel: { provider: "two", id: "review" },
	decisions: [
		{ action: "continue", at: "2026-01-02T03:05:00Z", reason: "missing evidence", report: "Check is incomplete." },
	],
};

it("recovers ordered decisions, latest summary and final report without replaying interrupted work", () => {
	root = mkdtempSync(join(tmpdir(), "dreb-automation-store-"));
	const second = {
		...run,
		id: "10000000-0000-4000-8000-000000000002",
		cwd: "/a",
		status: "stopped" as const,
		outcome: "done",
		finalReport: "Complete",
		sessionFile: "saved.jsonl",
		sessionId: "saved",
	};
	const store = new AutomationStore(root);
	store.save(run);
	store.save(second);
	const restarted = new AutomationStore(root);
	expect(restarted.list().map((item) => item.id)).toEqual([second.id, run.id]);
	expect(restarted.get(run.id)).toMatchObject({
		status: "interrupted",
		outcome: "Dashboard restarted before the run ended.",
		decisions: run.decisions,
	});
	expect(restarted.get(second.id)).toEqual(second);
	expect(restarted.list()[0]).not.toHaveProperty("sessionFile");
	expect(restarted.list()[0].latestDecision).toEqual({
		action: "continue",
		at: run.decisions[0].at,
		reason: "missing evidence",
	});
	expect(new AutomationStore(root).get(run.id)).toEqual(restarted.get(run.id));
});
