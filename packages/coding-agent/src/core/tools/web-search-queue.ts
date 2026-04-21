import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.js";

export interface WebSearchQueueOptions {
	rateLimitMs?: number;
	lockFilePath?: string;
	timeFilePath?: string;
}

interface TimestampData {
	lastSearchTime: number;
}

export class WebSearchQueue {
	private readonly rateLimitMs: number;
	private readonly lockFilePath: string;
	private readonly timeFilePath: string;

	constructor(options: WebSearchQueueOptions = {}) {
		this.rateLimitMs = options.rateLimitMs ?? 10_000;
		this.lockFilePath = options.lockFilePath ?? join(getAgentDir(), "web-search-queue.lock");
		this.timeFilePath = options.timeFilePath ?? join(getAgentDir(), "web-search-queue.time");
	}

	async enqueue<T>(fn: () => Promise<T>): Promise<T> {
		// Ensure parent directory and lock file exist (proper-lockfile requires the file to exist)
		const dir = dirname(this.lockFilePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		if (!existsSync(this.lockFilePath)) {
			writeFileSync(this.lockFilePath, "");
		}

		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(this.lockFilePath, {
				stale: 60_000,
				retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
			});

			// Read last search timestamp
			let lastSearchTime = 0;
			try {
				const raw = readFileSync(this.timeFilePath, "utf-8");
				const data = JSON.parse(raw) as TimestampData;
				if (typeof data.lastSearchTime === "number") {
					lastSearchTime = data.lastSearchTime;
				}
			} catch {
				// Missing or malformed — treat as 0
			}

			// Enforce rate limit
			const delayNeeded = Math.max(0, this.rateLimitMs - (Date.now() - lastSearchTime));
			if (delayNeeded > 0) {
				await new Promise((resolve) => setTimeout(resolve, delayNeeded));
			}

			// Execute the search operation
			try {
				return await fn();
			} finally {
				// Update timestamp even on error to prevent retry storms
				const timestampData: TimestampData = { lastSearchTime: Date.now() };
				writeFileSync(this.timeFilePath, JSON.stringify(timestampData));
			}
		} finally {
			try {
				await release?.();
			} catch {
				// Swallow unlock errors
			}
		}
	}
}
