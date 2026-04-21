import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSearchQueue } from "../src/core/tools/web-search-queue.js";

describe("WebSearchQueue", () => {
	let tempDir: string;
	let lockFilePath: string;
	let timeFilePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "dreb-web-search-queue-"));
		lockFilePath = join(tempDir, "queue.lock");
		timeFilePath = join(tempDir, "queue.time");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("serializes concurrent calls", async () => {
		const queue = new WebSearchQueue({
			rateLimitMs: 0,
			lockFilePath,
			timeFilePath,
		});

		let running = 0;
		let maxConcurrent = 0;

		const track = async () => {
			running++;
			maxConcurrent = Math.max(maxConcurrent, running);
			// Hold for a bit to let other enqueues pile up
			await new Promise((r) => setTimeout(r, 50));
			running--;
			return "done";
		};

		await Promise.all([queue.enqueue(track), queue.enqueue(track), queue.enqueue(track)]);

		expect(maxConcurrent).toBe(1);
	});

	it("enforces minimum spacing", async () => {
		const queue = new WebSearchQueue({
			rateLimitMs: 200,
			lockFilePath,
			timeFilePath,
		});

		const startTimes: number[] = [];

		const record = async () => {
			startTimes.push(Date.now());
		};

		await queue.enqueue(record);
		await queue.enqueue(record);

		expect(startTimes.length).toBe(2);
		const gap = startTimes[1] - startTimes[0];
		expect(gap).toBeGreaterThanOrEqual(190); // small tolerance for timer imprecision
	});

	it("custom rate limit respects constructor option", async () => {
		const queue = new WebSearchQueue({
			rateLimitMs: 50,
			lockFilePath,
			timeFilePath,
		});

		const startTimes: number[] = [];

		const record = async () => {
			startTimes.push(Date.now());
		};

		await queue.enqueue(record);
		await queue.enqueue(record);

		expect(startTimes.length).toBe(2);
		const gap = startTimes[1] - startTimes[0];
		expect(gap).toBeGreaterThanOrEqual(45); // small tolerance
	});

	it("error during search still updates timestamp", async () => {
		const queue = new WebSearchQueue({
			rateLimitMs: 100,
			lockFilePath,
			timeFilePath,
		});

		// First call throws
		await expect(
			queue.enqueue(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		// Timestamp file should exist and have a recent timestamp
		expect(existsSync(timeFilePath)).toBe(true);
		const data = JSON.parse(readFileSync(timeFilePath, "utf-8"));
		expect(typeof data.lastSearchTime).toBe("number");
		expect(data.lastSearchTime).toBeGreaterThan(0);

		// Second call should be delayed (proving timestamp was written by the failed call)
		const start = Date.now();
		await queue.enqueue(async () => "ok");
		const elapsed = Date.now() - start;
		// Should have waited ~100ms minus whatever already elapsed
		expect(elapsed).toBeGreaterThanOrEqual(80);
	});

	it("uses custom lock and time file paths", async () => {
		const customDir = join(tempDir, "custom");
		mkdirSync(customDir, { recursive: true });
		const customLock = join(customDir, "my.lock");
		const customTime = join(customDir, "my.time");

		const queue = new WebSearchQueue({
			rateLimitMs: 0,
			lockFilePath: customLock,
			timeFilePath: customTime,
		});

		await queue.enqueue(async () => "hello");

		expect(existsSync(customLock)).toBe(true);
		expect(existsSync(customTime)).toBe(true);
		const data = JSON.parse(readFileSync(customTime, "utf-8"));
		expect(typeof data.lastSearchTime).toBe("number");
	});

	it("handles missing time file gracefully (no delay on first call)", async () => {
		const queue = new WebSearchQueue({
			rateLimitMs: 5000, // high limit — should NOT cause delay on first call
			lockFilePath,
			timeFilePath,
		});

		expect(existsSync(timeFilePath)).toBe(false);

		const start = Date.now();
		await queue.enqueue(async () => "first");
		const elapsed = Date.now() - start;

		// Should complete very quickly — no 5-second delay
		expect(elapsed).toBeLessThan(500);
	});
});
