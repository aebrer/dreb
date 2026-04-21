import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSearch, getSearchConfig } from "../src/core/tools/web.js";
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

	it("returns the value from the wrapped function", async () => {
		const queue = new WebSearchQueue({
			rateLimitMs: 0,
			lockFilePath,
			timeFilePath,
		});

		const result = await queue.enqueue(async () => 42);
		expect(result).toBe(42);
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

	it("handles corrupted time file gracefully", async () => {
		const queue = new WebSearchQueue({
			rateLimitMs: 5000,
			lockFilePath,
			timeFilePath,
		});
		// Write garbage to the time file
		writeFileSync(timeFilePath, "{broken json");

		const start = Date.now();
		await queue.enqueue(async () => "ok");
		const elapsed = Date.now() - start;

		// Should complete quickly — no 5-second delay
		expect(elapsed).toBeLessThan(500);
	});
});

describe("executeSearch integration", () => {
	let tempDir: string;
	let originalAgentDir: string | undefined;
	let originalRateLimit: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "dreb-web-search-int-"));
		originalAgentDir = process.env.DREB_CODING_AGENT_DIR;
		originalRateLimit = process.env.DREB_WEB_SEARCH_RATE_LIMIT_MS;
		process.env.DREB_CODING_AGENT_DIR = tempDir;
		process.env.DREB_WEB_SEARCH_RATE_LIMIT_MS = "0";
	});

	afterEach(() => {
		if (originalAgentDir !== undefined) {
			process.env.DREB_CODING_AGENT_DIR = originalAgentDir;
		} else {
			delete process.env.DREB_CODING_AGENT_DIR;
		}
		if (originalRateLimit !== undefined) {
			process.env.DREB_WEB_SEARCH_RATE_LIMIT_MS = originalRateLimit;
		} else {
			delete process.env.DREB_WEB_SEARCH_RATE_LIMIT_MS;
		}
		rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("routes through the queue and returns search results", async () => {
		const mockHtml = `
			<div class="result results_links">
				<a class="result__a" href="https://example.com/page">Test Title</a>
				<div class="result__snippet">Test snippet content</div>
			</div>
		`;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => mockHtml,
		});

		const results = await executeSearch("test query");

		expect(results).toHaveLength(1);
		expect(results[0].title).toBe("Test Title");
		expect(results[0].url).toBe("https://example.com/page");
		expect(results[0].snippet).toBe("Test snippet content");
	});

	it("serializes concurrent executeSearch calls through the queue", async () => {
		let running = 0;
		let maxConcurrent = 0;

		globalThis.fetch = vi.fn().mockImplementation(async () => {
			running++;
			maxConcurrent = Math.max(maxConcurrent, running);
			await new Promise((r) => setTimeout(r, 50));
			running--;
			return {
				ok: true,
				status: 200,
				text: async () =>
					`<div class="result results_links"><a class="result__a" href="https://example.com">Title</a><div class="result__snippet">Snippet</div></div>`,
			};
		});

		await Promise.all([executeSearch("q1"), executeSearch("q2"), executeSearch("q3")]);

		expect(maxConcurrent).toBe(1);
	});

	it("propagates backend errors through the queue", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("network failure"));

		await expect(executeSearch("query")).rejects.toThrow("network failure");
	});
});

describe("getSearchConfig", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalRateLimit: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "dreb-search-config-"));
		originalCwd = process.cwd();
		originalRateLimit = process.env.DREB_WEB_SEARCH_RATE_LIMIT_MS;
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalRateLimit !== undefined) {
			process.env.DREB_WEB_SEARCH_RATE_LIMIT_MS = originalRateLimit;
		} else {
			delete process.env.DREB_WEB_SEARCH_RATE_LIMIT_MS;
		}
		rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("returns default rateLimitMs of 10000 when nothing is configured", () => {
		// Change to temp dir with no config file
		process.chdir(tempDir);
		delete process.env.DREB_WEB_SEARCH_RATE_LIMIT_MS;

		const config = getSearchConfig();
		expect(config.rateLimitMs).toBe(10_000);
	});

	it("reads rateLimitMs from env var", () => {
		process.chdir(tempDir);
		process.env.DREB_WEB_SEARCH_RATE_LIMIT_MS = "500";

		const config = getSearchConfig();
		expect(config.rateLimitMs).toBe(500);
	});

	it("reads rateLimitMs from config file", () => {
		process.chdir(tempDir);
		delete process.env.DREB_WEB_SEARCH_RATE_LIMIT_MS;

		// Create .dreb/config.json in the temp dir
		const configDir = join(tempDir, ".dreb");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({ search: { rate_limit_ms: 300 } }));

		const config = getSearchConfig();
		expect(config.rateLimitMs).toBe(300);
	});

	it("env var takes precedence over config file", () => {
		process.chdir(tempDir);
		process.env.DREB_WEB_SEARCH_RATE_LIMIT_MS = "500";

		// Also create a config file — env var should win
		const configDir = join(tempDir, ".dreb");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({ search: { rate_limit_ms: 300 } }));

		const config = getSearchConfig();
		expect(config.rateLimitMs).toBe(500);
	});

	it("falls back to default on invalid env var and logs warning", () => {
		process.chdir(tempDir);
		process.env.DREB_WEB_SEARCH_RATE_LIMIT_MS = "abc";

		const errorSpy = vi.spyOn(console, "error");
		const config = getSearchConfig();
		expect(config.rateLimitMs).toBe(10_000);
		expect(errorSpy).toHaveBeenCalledWith(`Warning: invalid DREB_WEB_SEARCH_RATE_LIMIT_MS "abc", using default`);
	});

	it("falls back to default on invalid config file value and logs warning", () => {
		process.chdir(tempDir);
		delete process.env.DREB_WEB_SEARCH_RATE_LIMIT_MS;

		const configDir = join(tempDir, ".dreb");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({ search: { rate_limit_ms: "invalid" } }));

		const errorSpy = vi.spyOn(console, "error");
		const config = getSearchConfig();
		expect(config.rateLimitMs).toBe(10_000);
		expect(errorSpy).toHaveBeenCalledWith(
			'Warning: invalid search.rate_limit_ms in config file "invalid", using default',
		);
	});
});
