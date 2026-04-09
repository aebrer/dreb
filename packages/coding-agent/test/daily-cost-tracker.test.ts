import { randomUUID } from "crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DailyCostTracker, filenameTimestampToDate, isSameLocalDay } from "../src/core/daily-cost-tracker.js";

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
// DailyCostTracker
// ---------------------------------------------------------------------------

describe("DailyCostTracker", () => {
	let tmpDir: string;
	let tracker: DailyCostTracker | null;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "dreb-cost-test-"));
		tracker = null;
	});

	afterEach(() => {
		tracker?.dispose();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function createProjectDir(name: string): string {
		const dir = join(tmpDir, name);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	// Happy path ---------------------------------------------------------------

	it("aggregates costs from today's sessions across multiple projects", () => {
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

		tracker = new DailyCostTracker(tmpDir);
		expect(tracker.getDailyCost()).toBeCloseTo(1.75, 5);
	});

	// Empty sessions dir -------------------------------------------------------

	it("returns 0 for an empty sessions directory", () => {
		// tmpDir exists but has no subdirectories
		tracker = new DailyCostTracker(tmpDir);
		expect(tracker.getDailyCost()).toBe(0);
	});

	// Non-existent sessions dir ------------------------------------------------

	it("returns 0 for a non-existent sessions directory", () => {
		const nonExistent = join(tmpDir, "does-not-exist");
		tracker = new DailyCostTracker(nonExistent);
		expect(tracker.getDailyCost()).toBe(0);
	});

	// Corrupt JSONL lines ------------------------------------------------------

	it("skips corrupt JSONL lines gracefully", () => {
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

		tracker = new DailyCostTracker(tmpDir);
		expect(tracker.getDailyCost()).toBeCloseTo(0.42, 5);
	});

	// Refresh updates cached value --------------------------------------------

	it("refresh() picks up newly added session files", () => {
		const projectDir = createProjectDir("--project--");
		const now = new Date();

		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([1.0]));
		tracker = new DailyCostTracker(tmpDir);
		expect(tracker.getDailyCost()).toBeCloseTo(1.0, 5);

		// Add another file
		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([0.5]));
		tracker.refresh();
		expect(tracker.getDailyCost()).toBeCloseTo(1.5, 5);
	});

	// Dispose ------------------------------------------------------------------

	it("dispose prevents refresh from updating", () => {
		const projectDir = createProjectDir("--project--");
		const now = new Date();

		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([1.0]));
		tracker = new DailyCostTracker(tmpDir);
		expect(tracker.getDailyCost()).toBeCloseTo(1.0, 5);

		tracker.dispose();

		// Add another file and try to refresh — should be a no-op
		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([2.0]));
		tracker.refresh();
		expect(tracker.getDailyCost()).toBeCloseTo(1.0, 5);
	});

	// Sessions with zero cost --------------------------------------------------

	it("handles sessions with zero cost correctly", () => {
		const projectDir = createProjectDir("--project--");
		const now = new Date();

		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([0, 0, 0]));
		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([0.75]));

		tracker = new DailyCostTracker(tmpDir);
		expect(tracker.getDailyCost()).toBeCloseTo(0.75, 5);
	});

	// Messages without cost field --------------------------------------------

	it("handles messages without usage.cost.total", () => {
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

		tracker = new DailyCostTracker(tmpDir);
		expect(tracker.getDailyCost()).toBe(0);
	});

	// User messages are not counted -------------------------------------------

	it("ignores user messages (only counts assistant)", () => {
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

		tracker = new DailyCostTracker(tmpDir);
		expect(tracker.getDailyCost()).toBeCloseTo(0.1, 5);
	});

	// Non-message entries are skipped -----------------------------------------

	it("skips non-message session entries (compaction, model_change, etc.)", () => {
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

		tracker = new DailyCostTracker(tmpDir);
		expect(tracker.getDailyCost()).toBeCloseTo(0.33, 5);
	});

	// Filenames without expected format are skipped ---------------------------

	it("ignores files with non-standard names", () => {
		const projectDir = createProjectDir("--project--");
		const now = new Date();

		// Valid session
		writeFileSync(join(projectDir, makeSessionFilename(now)), makeSessionJsonl([1.0]));
		// File with weird name — should be skipped
		writeFileSync(join(projectDir, "notes.jsonl"), makeSessionJsonl([50.0]));
		writeFileSync(join(projectDir, "random-name.jsonl"), makeSessionJsonl([50.0]));

		tracker = new DailyCostTracker(tmpDir);
		expect(tracker.getDailyCost()).toBeCloseTo(1.0, 5);
	});
});
