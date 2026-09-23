import { randomUUID } from "crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DailyCostTracker,
	dailyCostSourcesForSession,
	filenameTimestampToDate,
	isSameLocalDay,
	sumCostFromFile,
} from "../src/core/daily-cost-tracker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionFilename(date: Date): string {
	const ts = date.toISOString().replace(/[:.]/g, "-");
	return `${ts}_${randomUUID()}.jsonl`;
}

function makeSessionJsonl(costs: number[]): string {
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			cwd: "/test",
		}),
	];
	for (const cost of costs) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `msg-${randomUUID().slice(0, 8)}`,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					usage: {
						input: 100,
						output: 50,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 150,
						cost: { input: cost * 0.5, output: cost * 0.5, cacheRead: 0, cacheWrite: 0, total: cost },
					},
				},
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Create a tracker and wait for the initial async scan to complete.
 * After this, getDailyCost() reflects the scanned value.
 */
async function createTracker(sessionsDir: string, subagentSessionsDir?: string): Promise<DailyCostTracker> {
	const tracker = new DailyCostTracker({
		nestedMainRoots: [sessionsDir],
		subagentRoots: subagentSessionsDir ? [subagentSessionsDir] : [],
	});
	// The constructor kicks off an async scan. refresh() queues another full scan
	// and awaits it, guaranteeing the cache is populated when it resolves.
	await tracker.refresh();
	return tracker;
}

// ---------------------------------------------------------------------------
// filenameTimestampToDate
// ---------------------------------------------------------------------------

describe("filenameTimestampToDate", () => {
	it("parses a valid filename timestamp", () => {
		const date = filenameTimestampToDate("2026-04-09T18-49-11-406Z");
		expect(date).not.toBeNull();
		expect(date!.toISOString()).toBe("2026-04-09T18:49:11.406Z");
	});

	it("returns null for empty string", () => {
		expect(filenameTimestampToDate("")).toBeNull();
	});

	it("returns null for garbage input", () => {
		expect(filenameTimestampToDate("not-a-timestamp")).toBeNull();
	});

	it("returns null for partial timestamp", () => {
		expect(filenameTimestampToDate("2026-04-09T18-49")).toBeNull();
	});

	it("returns null for timestamp without trailing Z", () => {
		expect(filenameTimestampToDate("2026-04-09T18-49-11-406")).toBeNull();
	});

	it("handles midnight exactly", () => {
		const date = filenameTimestampToDate("2026-01-15T00-00-00-000Z");
		expect(date).not.toBeNull();
		expect(date!.toISOString()).toBe("2026-01-15T00:00:00.000Z");
	});

	it("handles end of day", () => {
		const date = filenameTimestampToDate("2026-12-31T23-59-59-999Z");
		expect(date).not.toBeNull();
		expect(date!.toISOString()).toBe("2026-12-31T23:59:59.999Z");
	});
});

// ---------------------------------------------------------------------------
// isSameLocalDay
// ---------------------------------------------------------------------------

describe("isSameLocalDay", () => {
	it("returns true for the same date", () => {
		const a = new Date(2026, 3, 9, 10, 0, 0); // April 9, 2026 10:00 local
		const b = new Date(2026, 3, 9, 23, 59, 59); // April 9, 2026 23:59 local
		expect(isSameLocalDay(a, b)).toBe(true);
	});

	it("returns false for different dates", () => {
		const a = new Date(2026, 3, 9, 10, 0, 0); // April 9
		const b = new Date(2026, 3, 10, 10, 0, 0); // April 10
		expect(isSameLocalDay(a, b)).toBe(false);
	});

	it("returns false for different months", () => {
		const a = new Date(2026, 2, 9); // March 9
		const b = new Date(2026, 3, 9); // April 9
		expect(isSameLocalDay(a, b)).toBe(false);
	});

	it("returns false for different years", () => {
		const a = new Date(2025, 3, 9);
		const b = new Date(2026, 3, 9);
		expect(isSameLocalDay(a, b)).toBe(false);
	});

	it("handles UTC date that maps to a different local day", () => {
		// A UTC timestamp late in the day — when local timezone is ahead of UTC,
		// the local date could be the next day
		const utcDate = new Date("2026-04-09T23:30:00.000Z");
		const localOffset = utcDate.getTimezoneOffset(); // minutes behind UTC (negative = ahead)

		if (localOffset < 0) {
			// Timezone is ahead of UTC (e.g., UTC+2). UTC 23:30 → local April 10 01:30
			// So comparing against a "today" of April 10 local should match
			const todayLocal = new Date(2026, 3, 10, 12, 0, 0); // April 10 local
			expect(isSameLocalDay(utcDate, todayLocal)).toBe(true);
		} else {
			// Timezone is at or behind UTC. UTC 23:30 is still April 9 locally.
			const todayLocal = new Date(2026, 3, 9, 12, 0, 0); // April 9 local
			expect(isSameLocalDay(utcDate, todayLocal)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// sumCostFromFile
// ---------------------------------------------------------------------------

describe("sumCostFromFile", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "dreb-sum-cost-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("sums costs from a valid JSONL file", async () => {
		const filePath = join(tmpDir, "test.jsonl");
		writeFileSync(filePath, makeSessionJsonl([0.5, 0.25, 1.0]));
		expect(await sumCostFromFile(filePath)).toBeCloseTo(1.75, 5);
	});

	it("returns 0 for a non-existent file", async () => {
		expect(await sumCostFromFile(join(tmpDir, "nonexistent.jsonl"))).toBe(0);
	});

	it("skips corrupt lines", async () => {
		const filePath = join(tmpDir, "corrupt.jsonl");
		const content = [
			"THIS IS NOT JSON",
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					usage: { input: 10, output: 5, cost: { total: 0.42 } },
				},
			}),
		].join("\n");
		writeFileSync(filePath, content);
		expect(await sumCostFromFile(filePath)).toBeCloseTo(0.42, 5);
	});
});

// ---------------------------------------------------------------------------
// DailyCostTracker
// ---------------------------------------------------------------------------

describe("DailyCostTracker", () => {
	let tmpDir: string;
	let sessionsDir: string;
	let subagentSessionsDir: string;
	let tracker: DailyCostTracker | null;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "dreb-cost-test-"));
		sessionsDir = join(tmpDir, "sessions");
		subagentSessionsDir = join(tmpDir, "subagent-sessions");
		mkdirSync(sessionsDir);
		mkdirSync(subagentSessionsDir);
		tracker = null;
	});

	afterEach(() => {
		tracker?.dispose();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function createProjectDir(name: string): string {
		const dir = join(sessionsDir, name);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	function createSubagentSessionDir(sessionId: string): string {
		const dir = join(subagentSessionsDir, sessionId);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	function createSubagentStepDir(sessionId: string, step: number): string {
		const dir = join(subagentSessionsDir, sessionId, `step-${step}`);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	// Happy path ---------------------------------------------------------------

	it("aggregates costs from today's sessions across multiple projects", async () => {
		const projectA = createProjectDir("--home-user-projectA--");
		const projectB = createProjectDir("--home-user-projectB--");

		const now = new Date();
		const yesterday = new Date(now);
		yesterday.setDate(yesterday.getDate() - 1);

		// Today's sessions
		writeFileSync(join(projectA, makeSessionFilename(now)), makeSessionJsonl([0.5, 0.25]));
		writeFileSync(join(projectB, makeSessionFilename(now)), makeSessionJsonl([1.0]));

		// Yesterday's session — should NOT be included
		writeFileSync(join(projectA, makeSessionFilename(yesterday)), makeSessionJsonl([10.0]));

		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		expect(tracker.getDailyCost()).toBeCloseTo(1.75, 5);
	});

	// Constructor returns 0 before initial scan completes ----------------------

	it("getDailyCost() returns 0 immediately after construction (before scan)", () => {
		const projectDir = createProjectDir("--project--");
		const now = new Date();
		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([1.0]));

		// Construct without awaiting — cache should be 0
		tracker = new DailyCostTracker({
			nestedMainRoots: [sessionsDir],
			subagentRoots: subagentSessionsDir ? [subagentSessionsDir] : [],
		});
		expect(tracker.getDailyCost()).toBe(0);
	});

	// Empty sessions dir -------------------------------------------------------

	it("returns 0 for an empty sessions directory", async () => {
		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		expect(tracker.getDailyCost()).toBe(0);
	});

	// Non-existent sessions dir ------------------------------------------------

	it("returns 0 for a non-existent sessions directory", async () => {
		const nonExistent = join(tmpDir, "does-not-exist");
		tracker = await createTracker(nonExistent, join(tmpDir, "also-does-not-exist"));
		expect(tracker.getDailyCost()).toBe(0);
	});

	// Corrupt JSONL lines ------------------------------------------------------

	it("skips corrupt JSONL lines gracefully", async () => {
		const projectDir = createProjectDir("--project--");
		const now = new Date();

		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: now.toISOString(), cwd: "/test" }),
			"THIS IS NOT JSON",
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: now.toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					usage: { input: 10, output: 5, cost: { total: 0.42 } },
				},
			}),
			"{ also broken",
		].join("\n");

		writeFileSync(join(projectDir, makeSessionFilename(now)), content);

		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		expect(tracker.getDailyCost()).toBeCloseTo(0.42, 5);
	});

	// Refresh updates cached value --------------------------------------------

	it("refresh() picks up newly added session files", async () => {
		const projectDir = createProjectDir("--project--");
		const now = new Date();

		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([1.0]));
		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		expect(tracker.getDailyCost()).toBeCloseTo(1.0, 5);

		// Add another file
		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([0.5]));
		await tracker.refresh();
		expect(tracker.getDailyCost()).toBeCloseTo(1.5, 5);
	});

	// Dispose ------------------------------------------------------------------

	it("dispose prevents refresh from updating", async () => {
		const projectDir = createProjectDir("--project--");
		const now = new Date();

		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([1.0]));
		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		expect(tracker.getDailyCost()).toBeCloseTo(1.0, 5);

		tracker.dispose();

		// Add another file and try to refresh — should be a no-op
		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([2.0]));
		await tracker.refresh();
		expect(tracker.getDailyCost()).toBeCloseTo(1.0, 5);
	});

	// Sessions with zero cost --------------------------------------------------

	it("handles sessions with zero cost correctly", async () => {
		const projectDir = createProjectDir("--project--");
		const now = new Date();

		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([0, 0, 0]));
		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([0.75]));

		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		expect(tracker.getDailyCost()).toBeCloseTo(0.75, 5);
	});

	// Messages without cost field --------------------------------------------

	it("handles messages without usage.cost.total", async () => {
		const projectDir = createProjectDir("--project--");
		const now = new Date();

		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: now.toISOString(), cwd: "/test" }),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: now.toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					// No usage field at all
				},
			}),
			JSON.stringify({
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: now.toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					usage: { input: 10, output: 5 },
					// usage exists but no cost
				},
			}),
		].join("\n");

		writeFileSync(join(projectDir, makeSessionFilename(now)), content);

		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		expect(tracker.getDailyCost()).toBe(0);
	});

	// User messages are not counted -------------------------------------------

	it("ignores user messages (only counts assistant)", async () => {
		const projectDir = createProjectDir("--project--");
		const now = new Date();

		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: now.toISOString(), cwd: "/test" }),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: now.toISOString(),
				message: {
					role: "user",
					content: [{ type: "text", text: "hi" }],
					usage: { cost: { total: 999.99 } },
				},
			}),
			JSON.stringify({
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: now.toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					usage: { cost: { total: 0.1 } },
				},
			}),
		].join("\n");

		writeFileSync(join(projectDir, makeSessionFilename(now)), content);

		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		expect(tracker.getDailyCost()).toBeCloseTo(0.1, 5);
	});

	// Non-message entries are skipped -----------------------------------------

	it("skips non-message session entries (compaction, model_change, etc.)", async () => {
		const projectDir = createProjectDir("--project--");
		const now = new Date();

		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: now.toISOString(), cwd: "/test" }),
			JSON.stringify({
				type: "compaction",
				id: "c1",
				parentId: null,
				timestamp: now.toISOString(),
				summary: "test",
			}),
			JSON.stringify({
				type: "model_change",
				id: "mc1",
				parentId: "c1",
				timestamp: now.toISOString(),
				provider: "anthropic",
				modelId: "test",
			}),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: "mc1",
				timestamp: now.toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					usage: { cost: { total: 0.33 } },
				},
			}),
		].join("\n");

		writeFileSync(join(projectDir, makeSessionFilename(now)), content);

		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		expect(tracker.getDailyCost()).toBeCloseTo(0.33, 5);
	});

	// Filenames without expected format are skipped ---------------------------

	it("ignores files with non-standard names", async () => {
		const projectDir = createProjectDir("--project--");
		const now = new Date();

		// Valid session
		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([1.0]));
		// File with weird name — should be skipped
		writeFileSync(join(projectDir, "notes.jsonl"), makeSessionJsonl([50.0]));
		writeFileSync(join(projectDir, "random-name.jsonl"), makeSessionJsonl([50.0]));

		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		expect(tracker.getDailyCost()).toBeCloseTo(1.0, 5);
	});

	// =========================================================================
	// Sub-agent session scanning
	// =========================================================================

	it("scans direct JSONL files in subagent session-id directories", async () => {
		const now = new Date();

		// Main session cost
		const projectDir = createProjectDir("--project--");
		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([1.0]));

		// Subagent session (direct JSONL in session-id dir)
		const subDir = createSubagentSessionDir("session-abc");
		writeFileSync(join(subDir, makeSessionFilename(now)), makeSessionJsonl([0.5]));

		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		expect(tracker.getDailyCost()).toBeCloseTo(1.5, 5);
	});

	it("scans JSONL files in subagent step-N subdirectories (chain agents)", async () => {
		const now = new Date();

		// Chain agent session with step subdirs
		const sessionId = "chain-session-123";
		const step0 = createSubagentStepDir(sessionId, 0);
		const step1 = createSubagentStepDir(sessionId, 1);
		writeFileSync(join(step0, makeSessionFilename(now)), makeSessionJsonl([0.3]));
		writeFileSync(join(step1, makeSessionFilename(now)), makeSessionJsonl([0.7]));

		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		expect(tracker.getDailyCost()).toBeCloseTo(1.0, 5);
	});

	it("handles mix of direct and step-N subagent sessions", async () => {
		const now = new Date();

		// Direct subagent session
		const directDir = createSubagentSessionDir("direct-agent");
		writeFileSync(join(directDir, makeSessionFilename(now)), makeSessionJsonl([0.2]));

		// Chain subagent session with steps
		const chainDir = createSubagentSessionDir("chain-agent");
		const step0 = createSubagentStepDir("chain-agent", 0);
		writeFileSync(join(step0, makeSessionFilename(now)), makeSessionJsonl([0.4]));
		// Also a direct file in the chain session dir (mixed layout)
		writeFileSync(join(chainDir, makeSessionFilename(now)), makeSessionJsonl([0.1]));

		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		expect(tracker.getDailyCost()).toBeCloseTo(0.7, 5);
	});

	it("excludes yesterday's subagent sessions", async () => {
		const now = new Date();
		const yesterday = new Date(now);
		yesterday.setDate(yesterday.getDate() - 1);

		const subDir = createSubagentSessionDir("old-agent");
		writeFileSync(join(subDir, makeSessionFilename(yesterday)), makeSessionJsonl([10.0]));
		writeFileSync(join(subDir, makeSessionFilename(now)), makeSessionJsonl([0.5]));

		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		expect(tracker.getDailyCost()).toBeCloseTo(0.5, 5);
	});

	// =========================================================================
	// Daily cost breakdown
	// =========================================================================

	it("getDailyCostBreakdown() separates main and subagent costs", async () => {
		const now = new Date();

		// Main session
		const projectDir = createProjectDir("--project--");
		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([2.0]));

		// Subagent session
		const subDir = createSubagentSessionDir("sub-1");
		writeFileSync(join(subDir, makeSessionFilename(now)), makeSessionJsonl([0.8]));

		tracker = await createTracker(sessionsDir, subagentSessionsDir);

		const breakdown = tracker.getDailyCostBreakdown();
		expect(breakdown.main).toBeCloseTo(2.0, 5);
		expect(breakdown.subagent).toBeCloseTo(0.8, 5);
		expect(breakdown.total).toBeCloseTo(2.8, 5);
		expect(breakdown.total).toBeCloseTo(breakdown.main + breakdown.subagent, 10);
	});

	it("getDailyCostBreakdown() returns zeros when no sessions exist", async () => {
		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		const breakdown = tracker.getDailyCostBreakdown();
		expect(breakdown.main).toBe(0);
		expect(breakdown.subagent).toBe(0);
		expect(breakdown.total).toBe(0);
	});

	it("getDailyCost() equals getDailyCostBreakdown().total", async () => {
		const now = new Date();

		const projectDir = createProjectDir("--project--");
		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([1.5]));

		const subDir = createSubagentSessionDir("sub-2");
		writeFileSync(join(subDir, makeSessionFilename(now)), makeSessionJsonl([0.3]));

		tracker = await createTracker(sessionsDir, subagentSessionsDir);
		expect(tracker.getDailyCost()).toBeCloseTo(tracker.getDailyCostBreakdown().total, 10);
	});

	// Non-existent subagent sessions dir should not break main scanning -------

	it("handles non-existent subagent sessions directory gracefully", async () => {
		const now = new Date();
		const projectDir = createProjectDir("--project--");
		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([1.0]));

		// Use non-existent subagent dir
		tracker = await createTracker(sessionsDir, join(tmpDir, "nonexistent-subagent-dir"));
		expect(tracker.getDailyCost()).toBeCloseTo(1.0, 5);
		expect(tracker.getDailyCostBreakdown().subagent).toBe(0);
	});

	// Custom session storage roots ---------------------------------------------

	it("includes a custom flat main-session root and custom plus legacy subagent roots", async () => {
		const now = new Date();
		const projectDir = createProjectDir("--project--");
		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([1.0]));

		const flatMain = join(tmpDir, "custom-main");
		mkdirSync(flatMain, { recursive: true });
		writeFileSync(join(flatMain, makeSessionFilename(now)), makeSessionJsonl([2.0]));

		const customSub = join(tmpDir, "custom-subagents", "sess-1");
		mkdirSync(join(customSub, "step-1"), { recursive: true });
		writeFileSync(join(customSub, makeSessionFilename(now)), makeSessionJsonl([0.25]));
		writeFileSync(join(customSub, "step-1", makeSessionFilename(now)), makeSessionJsonl([0.5]));

		const legacyDir = createSubagentSessionDir("legacy-1");
		writeFileSync(join(legacyDir, makeSessionFilename(now)), makeSessionJsonl([0.125]));

		tracker = new DailyCostTracker({
			nestedMainRoots: [sessionsDir],
			flatMainRoots: [flatMain],
			subagentRoots: [join(tmpDir, "custom-subagents"), subagentSessionsDir],
		});
		await tracker.refresh();

		const breakdown = tracker.getDailyCostBreakdown();
		expect(breakdown.main).toBeCloseTo(3.0, 5);
		expect(breakdown.subagent).toBeCloseTo(0.875, 5);
		expect(breakdown.total).toBeCloseTo(3.875, 5);
	});

	it("counts files reachable from overlapping or duplicate roots once", async () => {
		const now = new Date();
		const projectDir = createProjectDir("--project--");
		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([1.0]));
		const subDir = createSubagentSessionDir("sub");
		writeFileSync(join(subDir, makeSessionFilename(now)), makeSessionJsonl([0.5]));

		tracker = new DailyCostTracker({
			nestedMainRoots: [sessionsDir, `${sessionsDir}/`],
			// Flat root that is also a nested project dir, and a subagent root that overlaps a main root
			flatMainRoots: [projectDir, subDir],
			subagentRoots: [subagentSessionsDir, subagentSessionsDir],
		});
		await tracker.refresh();

		const breakdown = tracker.getDailyCostBreakdown();
		expect(breakdown.total).toBeCloseTo(1.5, 5);
		expect(breakdown.main).toBeCloseTo(1.5, 5);
		expect(breakdown.subagent).toBe(0);
	});

	it("refresh() picks up sub-agent files in custom roots written after construction", async () => {
		const now = new Date();
		const customSubRoot = join(tmpDir, "custom-subagents");
		tracker = new DailyCostTracker({ nestedMainRoots: [sessionsDir], subagentRoots: [customSubRoot] });
		await tracker.refresh();
		expect(tracker.getDailyCost()).toBe(0);

		mkdirSync(join(customSubRoot, "late"), { recursive: true });
		writeFileSync(join(customSubRoot, "late", makeSessionFilename(now)), makeSessionJsonl([0.75]));
		await tracker.refresh();
		expect(tracker.getDailyCostBreakdown().subagent).toBeCloseTo(0.75, 5);
	});
});

describe("dailyCostSourcesForSession", () => {
	it("derives flat main roots from the session, global, and effective sessionDir, and all subagent roots", () => {
		const sources = dailyCostSourcesForSession({
			cwd: "/work/project",
			sessionManager: { getCustomSessionInventoryRoot: () => "/cli/sessions" },
			settingsManager: {
				getGlobalSettings: () => ({ sessionDir: "~/global-sessions" }),
				getSessionDir: () => "./project-sessions",
			},
			subagentSessionDiscoveryRoots: ["/custom/subagents", "/legacy/subagents"],
		});

		expect(sources.flatMainRoots).toEqual([
			"/cli/sessions",
			join(homedir(), "global-sessions"),
			"/work/project/project-sessions",
		]);
		expect(sources.subagentRoots).toEqual(["/custom/subagents", "/legacy/subagents"]);
		expect(sources.nestedMainRoots).toHaveLength(1);
	});

	it("has no flat main roots for default storage", () => {
		const sources = dailyCostSourcesForSession({
			cwd: "/work/project",
			sessionManager: { getCustomSessionInventoryRoot: () => undefined },
			settingsManager: { getGlobalSettings: () => ({}), getSessionDir: () => undefined },
			subagentSessionDiscoveryRoots: ["/legacy/subagents"],
		});
		expect(sources.flatMainRoots).toEqual([]);
	});
});
