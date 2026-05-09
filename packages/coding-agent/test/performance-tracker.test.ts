import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PerformanceEntry, PerformanceTracker } from "../src/core/performance-tracker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<PerformanceEntry> = {}): PerformanceEntry {
	return {
		timestamp: new Date().toISOString(),
		sessionId: "session-1",
		provider: "anthropic",
		modelId: "claude-3-sonnet",
		outputTokens: 100,
		durationMs: 1000,
		tps: 10,
		...overrides,
	};
}

function makeEntryAtOffsetMs(offsetMs: number, overrides: Partial<PerformanceEntry> = {}): PerformanceEntry {
	return makeEntry({
		timestamp: new Date(Date.now() - offsetMs).toISOString(),
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// PerformanceTracker
// ---------------------------------------------------------------------------

describe("PerformanceTracker", () => {
	let tmpDir: string;
	let logPath: string;
	let tracker: PerformanceTracker;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "dreb-perf-test-"));
		logPath = join(tmpDir, "performance.jsonl");
	});

	afterEach(() => {
		tracker?.dispose();
		vi.useRealTimers();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// record() -----------------------------------------------------------------

	it("record() appends valid JSONL", () => {
		tracker = new PerformanceTracker(logPath);
		const entry = makeEntry({ tps: 42 });
		tracker.record(entry);

		const content = readFileSync(logPath, "utf8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(1);

		const parsed = JSON.parse(lines[0]);
		expect(parsed).toEqual(entry);
	});

	it("record() appends multiple lines", () => {
		tracker = new PerformanceTracker(logPath);
		tracker.record(makeEntry({ tps: 10 }));
		tracker.record(makeEntry({ tps: 20 }));

		const content = readFileSync(logPath, "utf8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).tps).toBe(10);
		expect(JSON.parse(lines[1]).tps).toBe(20);
	});

	// getRollingAverage() ------------------------------------------------------

	it("getRollingAverage() returns correct stats for entries within window", () => {
		tracker = new PerformanceTracker(logPath);
		tracker.record(makeEntryAtOffsetMs(60_000, { tps: 10 }));
		tracker.record(makeEntryAtOffsetMs(120_000, { tps: 20 }));
		tracker.record(makeEntryAtOffsetMs(180_000, { tps: 30 }));

		const result = tracker.getRollingAverage("anthropic", "claude-3-sonnet");
		expect(result.count).toBe(3);
		expect(result.mean).toBe(20);
		expect(result.median).toBe(20);
	});

	it("getRollingAverage() ignores entries outside the window", () => {
		tracker = new PerformanceTracker(logPath);
		// Entry 25 hours ago — outside default 24h window
		tracker.record(makeEntryAtOffsetMs(25 * 60 * 60 * 1000, { tps: 999 }));
		// Entry 1 hour ago — inside window
		tracker.record(makeEntryAtOffsetMs(60 * 60 * 1000, { tps: 15 }));

		const result = tracker.getRollingAverage("anthropic", "claude-3-sonnet");
		expect(result.count).toBe(1);
		expect(result.mean).toBe(15);
		expect(result.median).toBe(15);
	});

	it("getRollingAverage() returns zeroes when no entries match", () => {
		tracker = new PerformanceTracker(logPath);
		const result = tracker.getRollingAverage("openai", "gpt-4");
		expect(result).toEqual({ median: 0, mean: 0, count: 0 });
	});

	it("getRollingAverage() filters by provider and modelId", () => {
		tracker = new PerformanceTracker(logPath);
		tracker.record(makeEntry({ provider: "anthropic", modelId: "claude-3-sonnet", tps: 10 }));
		tracker.record(makeEntry({ provider: "anthropic", modelId: "claude-3-opus", tps: 20 }));
		tracker.record(makeEntry({ provider: "openai", modelId: "gpt-4", tps: 30 }));

		const result = tracker.getRollingAverage("anthropic", "claude-3-opus");
		expect(result.count).toBe(1);
		expect(result.mean).toBe(20);
	});

	// getTrend() ---------------------------------------------------------------

	it("getTrend() returns 'increasing' when recent median is higher", () => {
		tracker = new PerformanceTracker(logPath);
		// Previous window (15 min ago): tps = 5, 5, 6  → median 5
		tracker.record(makeEntryAtOffsetMs(15 * 60 * 1000, { tps: 5 }));
		tracker.record(makeEntryAtOffsetMs(14 * 60 * 1000, { tps: 5 }));
		tracker.record(makeEntryAtOffsetMs(13 * 60 * 1000, { tps: 6 }));
		// Recent window (5 min ago): tps = 15, 15, 16  → median 15
		tracker.record(makeEntryAtOffsetMs(5 * 60 * 1000, { tps: 15 }));
		tracker.record(makeEntryAtOffsetMs(4 * 60 * 1000, { tps: 15 }));
		tracker.record(makeEntryAtOffsetMs(3 * 60 * 1000, { tps: 16 }));

		const trend = tracker.getTrend("anthropic", "claude-3-sonnet");
		expect(trend).toBe("increasing");
	});

	it("getTrend() returns 'decreasing' when recent median is lower", () => {
		tracker = new PerformanceTracker(logPath);
		// Previous window: tps = 15, 15, 16  → median 15
		tracker.record(makeEntryAtOffsetMs(15 * 60 * 1000, { tps: 15 }));
		tracker.record(makeEntryAtOffsetMs(14 * 60 * 1000, { tps: 15 }));
		tracker.record(makeEntryAtOffsetMs(13 * 60 * 1000, { tps: 16 }));
		// Recent window: tps = 5, 5, 6  → median 5
		tracker.record(makeEntryAtOffsetMs(5 * 60 * 1000, { tps: 5 }));
		tracker.record(makeEntryAtOffsetMs(4 * 60 * 1000, { tps: 5 }));
		tracker.record(makeEntryAtOffsetMs(3 * 60 * 1000, { tps: 6 }));

		const trend = tracker.getTrend("anthropic", "claude-3-sonnet");
		expect(trend).toBe("decreasing");
	});

	it("getTrend() returns 'stable' when change is small by both thresholds", () => {
		tracker = new PerformanceTracker(logPath);
		// Previous window: tps = 10, 10, 10  → median 10
		tracker.record(makeEntryAtOffsetMs(15 * 60 * 1000, { tps: 10 }));
		tracker.record(makeEntryAtOffsetMs(14 * 60 * 1000, { tps: 10 }));
		tracker.record(makeEntryAtOffsetMs(13 * 60 * 1000, { tps: 10 }));
		// Recent window: tps = 10.5, 10.5, 10.5  → median 10.5
		tracker.record(makeEntryAtOffsetMs(5 * 60 * 1000, { tps: 10.5 }));
		tracker.record(makeEntryAtOffsetMs(4 * 60 * 1000, { tps: 10.5 }));
		tracker.record(makeEntryAtOffsetMs(3 * 60 * 1000, { tps: 10.5 }));

		const trend = tracker.getTrend("anthropic", "claude-3-sonnet");
		expect(trend).toBe("stable");
	});

	it("getTrend() returns 'stable' when percentage change is small even if absolute change is >= 3 tok/s", () => {
		tracker = new PerformanceTracker(logPath);
		// Previous median 100, recent median 105: 5% change, 5 tok/s absolute difference
		tracker.record(makeEntryAtOffsetMs(15 * 60 * 1000, { tps: 100 }));
		tracker.record(makeEntryAtOffsetMs(14 * 60 * 1000, { tps: 100 }));
		tracker.record(makeEntryAtOffsetMs(13 * 60 * 1000, { tps: 100 }));
		tracker.record(makeEntryAtOffsetMs(5 * 60 * 1000, { tps: 105 }));
		tracker.record(makeEntryAtOffsetMs(4 * 60 * 1000, { tps: 105 }));
		tracker.record(makeEntryAtOffsetMs(3 * 60 * 1000, { tps: 105 }));

		const trend = tracker.getTrend("anthropic", "claude-3-sonnet");
		expect(trend).toBe("stable");
	});

	it("getTrend() returns 'stable' when absolute change is small even if percentage change is >= 10%", () => {
		tracker = new PerformanceTracker(logPath);
		// Previous median 5, recent median 6: 20% change, 1 tok/s absolute difference
		tracker.record(makeEntryAtOffsetMs(15 * 60 * 1000, { tps: 5 }));
		tracker.record(makeEntryAtOffsetMs(14 * 60 * 1000, { tps: 5 }));
		tracker.record(makeEntryAtOffsetMs(13 * 60 * 1000, { tps: 5 }));
		tracker.record(makeEntryAtOffsetMs(5 * 60 * 1000, { tps: 6 }));
		tracker.record(makeEntryAtOffsetMs(4 * 60 * 1000, { tps: 6 }));
		tracker.record(makeEntryAtOffsetMs(3 * 60 * 1000, { tps: 6 }));

		const trend = tracker.getTrend("anthropic", "claude-3-sonnet");
		expect(trend).toBe("stable");
	});

	it("getTrend() returns 'stable' when count < 3 in either window", () => {
		tracker = new PerformanceTracker(logPath);
		// Previous window: only 2 entries
		tracker.record(makeEntryAtOffsetMs(15 * 60 * 1000, { tps: 5 }));
		tracker.record(makeEntryAtOffsetMs(14 * 60 * 1000, { tps: 5 }));
		// Recent window: 3 entries with big jump
		tracker.record(makeEntryAtOffsetMs(5 * 60 * 1000, { tps: 100 }));
		tracker.record(makeEntryAtOffsetMs(4 * 60 * 1000, { tps: 100 }));
		tracker.record(makeEntryAtOffsetMs(3 * 60 * 1000, { tps: 100 }));

		const trend = tracker.getTrend("anthropic", "claude-3-sonnet");
		expect(trend).toBe("stable");
	});

	// getPerformanceDelta() ----------------------------------------------------

	it("getPerformanceDelta() compares recent performance to the 24h baseline", () => {
		tracker = new PerformanceTracker(logPath);
		// Baseline values include recent samples: 30, 30, 30, 36, 36, 36 → baseline median 33, recent median 36
		tracker.record(makeEntryAtOffsetMs(60 * 60 * 1000, { tps: 30 }));
		tracker.record(makeEntryAtOffsetMs(50 * 60 * 1000, { tps: 30 }));
		tracker.record(makeEntryAtOffsetMs(40 * 60 * 1000, { tps: 30 }));
		tracker.record(makeEntryAtOffsetMs(5 * 60 * 1000, { tps: 36 }));
		tracker.record(makeEntryAtOffsetMs(4 * 60 * 1000, { tps: 36 }));
		tracker.record(makeEntryAtOffsetMs(3 * 60 * 1000, { tps: 36 }));

		const delta = tracker.getPerformanceDelta("anthropic", "claude-3-sonnet");
		expect(delta.direction).toBe("above");
		expect(delta.recentMedian).toBe(36);
		expect(delta.percentDelta).toBeCloseTo(9.09, 2);
	});

	it("getPerformanceDelta() returns stable when recent sample count is too low", () => {
		tracker = new PerformanceTracker(logPath);
		tracker.record(makeEntryAtOffsetMs(60 * 60 * 1000, { tps: 30 }));
		tracker.record(makeEntryAtOffsetMs(50 * 60 * 1000, { tps: 30 }));
		tracker.record(makeEntryAtOffsetMs(40 * 60 * 1000, { tps: 30 }));
		tracker.record(makeEntryAtOffsetMs(5 * 60 * 1000, { tps: 36 }));
		tracker.record(makeEntryAtOffsetMs(4 * 60 * 1000, { tps: 36 }));

		const delta = tracker.getPerformanceDelta("anthropic", "claude-3-sonnet");
		expect(delta.direction).toBe("stable");
		expect(delta.recentCount).toBe(2);
	});

	// getAllRollingAverages() --------------------------------------------------

	it("getAllRollingAverages() returns all provider/model combinations", () => {
		tracker = new PerformanceTracker(logPath);
		tracker.record(makeEntry({ provider: "anthropic", modelId: "claude-3-sonnet", tps: 10 }));
		tracker.record(makeEntry({ provider: "anthropic", modelId: "claude-3-sonnet", tps: 20 }));
		tracker.record(makeEntry({ provider: "anthropic", modelId: "claude-3-opus", tps: 30 }));
		tracker.record(makeEntry({ provider: "openai", modelId: "gpt-4", tps: 40 }));

		const results = tracker.getAllRollingAverages();
		expect(results).toHaveLength(3);

		const sonnet = results.find((r) => r.provider === "anthropic" && r.modelId === "claude-3-sonnet");
		expect(sonnet).toBeDefined();
		expect(sonnet!.count).toBe(2);
		expect(sonnet!.mean).toBe(15);
		expect(sonnet!.median).toBe(15);

		const opus = results.find((r) => r.provider === "anthropic" && r.modelId === "claude-3-opus");
		expect(opus).toBeDefined();
		expect(opus!.count).toBe(1);
		expect(opus!.mean).toBe(30);

		const gpt4 = results.find((r) => r.provider === "openai" && r.modelId === "gpt-4");
		expect(gpt4).toBeDefined();
		expect(gpt4!.count).toBe(1);
		expect(gpt4!.mean).toBe(40);
	});

	it("getAllRollingAverages() respects the window", () => {
		tracker = new PerformanceTracker(logPath);
		tracker.record(
			makeEntryAtOffsetMs(25 * 60 * 60 * 1000, { provider: "anthropic", modelId: "claude-3-sonnet", tps: 999 }),
		);
		tracker.record(makeEntryAtOffsetMs(60 * 60 * 1000, { provider: "openai", modelId: "gpt-4", tps: 40 }));

		const results = tracker.getAllRollingAverages();
		expect(results).toHaveLength(1);
		expect(results[0].provider).toBe("openai");
		expect(results[0].modelId).toBe("gpt-4");
	});

	// prune() ------------------------------------------------------------------

	it("prune() removes old entries", () => {
		tracker = new PerformanceTracker(logPath);
		// Entry 31 days ago
		tracker.record(makeEntryAtOffsetMs(31 * 24 * 60 * 60 * 1000, { tps: 1 }));
		// Entry 1 day ago
		tracker.record(makeEntryAtOffsetMs(24 * 60 * 60 * 1000, { tps: 2 }));
		// Entry now
		tracker.record(makeEntry({ tps: 3 }));

		tracker.prune();

		const content = readFileSync(logPath, "utf8");
		const lines = content
			.trim()
			.split("\n")
			.filter((l) => l.trim());
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).tps).toBe(2);
		expect(JSON.parse(lines[1]).tps).toBe(3);
	});

	it("prune() with custom ageMs removes only older entries", () => {
		tracker = new PerformanceTracker(logPath);
		tracker.record(makeEntryAtOffsetMs(2 * 60 * 60 * 1000, { tps: 1 }));
		tracker.record(makeEntryAtOffsetMs(30 * 60 * 1000, { tps: 2 }));
		tracker.record(makeEntry({ tps: 3 }));

		tracker.prune(60 * 60 * 1000); // 1 hour

		const content = readFileSync(logPath, "utf8");
		const lines = content
			.trim()
			.split("\n")
			.filter((l) => l.trim());
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).tps).toBe(2);
		expect(JSON.parse(lines[1]).tps).toBe(3);
	});

	it("prune() keeps entries appended by another tracker after construction", () => {
		tracker = new PerformanceTracker(logPath);
		tracker.record(makeEntry({ tps: 10 }));

		const otherTracker = new PerformanceTracker(logPath);
		try {
			otherTracker.record(makeEntry({ tps: 20 }));
			tracker.prune();

			const content = readFileSync(logPath, "utf8");
			const tpsValues = content
				.trim()
				.split("\n")
				.filter((l) => l.trim())
				.map((line) => JSON.parse(line).tps);
			expect(tpsValues).toEqual([10, 20]);
		} finally {
			otherTracker.dispose();
		}
	});

	// malformed lines ----------------------------------------------------------

	it("skips malformed JSONL lines gracefully", () => {
		const content = [
			JSON.stringify(makeEntry({ tps: 10 })),
			"THIS IS NOT JSON",
			JSON.stringify(makeEntry({ tps: 20 })),
			"{ also broken",
		].join("\n");
		writeFileSync(logPath, content, "utf8");

		tracker = new PerformanceTracker(logPath);
		const result = tracker.getRollingAverage("anthropic", "claude-3-sonnet");
		expect(result.count).toBe(2);
		expect(result.mean).toBe(15);
		expect(result.median).toBe(15);
	});

	it("handles missing log file gracefully", () => {
		tracker = new PerformanceTracker(logPath);
		const result = tracker.getRollingAverage("anthropic", "claude-3-sonnet");
		expect(result).toEqual({ median: 0, mean: 0, count: 0 });
	});

	// median with even count ---------------------------------------------------

	it("computes median correctly with an even number of values", () => {
		tracker = new PerformanceTracker(logPath);
		tracker.record(makeEntry({ tps: 10 }));
		tracker.record(makeEntry({ tps: 20 }));
		tracker.record(makeEntry({ tps: 30 }));
		tracker.record(makeEntry({ tps: 40 }));

		const result = tracker.getRollingAverage("anthropic", "claude-3-sonnet");
		expect(result.count).toBe(4);
		expect(result.median).toBe(25); // (20 + 30) / 2
		expect(result.mean).toBe(25);
	});

	// dispose() ----------------------------------------------------------------

	it("dispose() prevents further record writes", () => {
		tracker = new PerformanceTracker(logPath);
		tracker.record(makeEntry({ tps: 10 }));
		tracker.dispose();
		tracker.record(makeEntry({ tps: 20 }));

		const content = readFileSync(logPath, "utf8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).tps).toBe(10);
	});

	// getTrend() Infinity branch ------------------------------------------------

	it("getTrend() returns 'increasing' when previous median is 0 and recent is >0", () => {
		tracker = new PerformanceTracker(logPath);
		// Previous window: all tps = 0  → median 0
		tracker.record(makeEntryAtOffsetMs(15 * 60 * 1000, { tps: 0 }));
		tracker.record(makeEntryAtOffsetMs(14 * 60 * 1000, { tps: 0 }));
		tracker.record(makeEntryAtOffsetMs(13 * 60 * 1000, { tps: 0 }));
		// Recent window: tps > 0  → median 10
		tracker.record(makeEntryAtOffsetMs(5 * 60 * 1000, { tps: 10 }));
		tracker.record(makeEntryAtOffsetMs(4 * 60 * 1000, { tps: 10 }));
		tracker.record(makeEntryAtOffsetMs(3 * 60 * 1000, { tps: 10 }));

		const trend = tracker.getTrend("anthropic", "claude-3-sonnet");
		expect(trend).toBe("increasing");
	});

	// auto-prune timer ----------------------------------------------------------

	it("auto-prune timer removes old entries when it fires", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-09T12:00:00.000Z"));
		tracker = new PerformanceTracker(logPath);
		tracker.record(makeEntryAtOffsetMs(31 * 24 * 60 * 60 * 1000, { tps: 1 }));
		tracker.record(makeEntry({ tps: 2 }));

		await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

		const content = readFileSync(logPath, "utf8");
		const lines = content
			.trim()
			.split("\n")
			.filter((l) => l.trim());
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).tps).toBe(2);
	});

	it("schedules auto-prune and clears it on dispose", () => {
		tracker = new PerformanceTracker(logPath);
		tracker.record(makeEntry({ tps: 10 }));
		// Timer is scheduled internally; dispose should clear it without throwing
		tracker.dispose();
		// After dispose, record should not write
		tracker.record(makeEntry({ tps: 99 }));
		const content = readFileSync(logPath, "utf8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).tps).toBe(10);
	});
});
