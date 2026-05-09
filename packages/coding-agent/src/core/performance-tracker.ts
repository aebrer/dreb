import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { getPerformanceLogPath } from "../config.js";

export interface PerformanceEntry {
	timestamp: string;
	sessionId: string;
	provider: string;
	modelId: string;
	outputTokens: number;
	durationMs: number;
	tps: number;
}

export interface RollingAverage {
	median: number;
	mean: number;
	count: number;
}

export type Trend = "increasing" | "decreasing" | "stable";

export class PerformanceTracker {
	private static readonly PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

	private logPath: string;
	private pruneTimer: ReturnType<typeof setInterval> | null = null;
	private disposed = false;

	constructor(logPath?: string) {
		this.logPath = logPath ?? getPerformanceLogPath();
		this.schedulePrune();
	}

	record(entry: PerformanceEntry): void {
		if (this.disposed) return;
		try {
			mkdirSync(dirname(this.logPath), { recursive: true });
			appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, "utf8");
		} catch {
			// Silently ignore write failures
		}
	}

	getRollingAverage(
		provider: string,
		modelId: string,
		windowMs = 24 * 60 * 60 * 1000,
	): RollingAverage {
		const entries = this.readEntries();
		const cutoff = Date.now() - windowMs;
		const values = entries
			.filter(
				(e) =>
					e.provider === provider &&
					e.modelId === modelId &&
					new Date(e.timestamp).getTime() >= cutoff,
			)
			.map((e) => e.tps);

		if (values.length === 0) {
			return { median: 0, mean: 0, count: 0 };
		}

		return {
			median: computeMedian(values),
			mean: computeMean(values),
			count: values.length,
		};
	}

	getTrend(
		provider: string,
		modelId: string,
		recentWindowMs = 10 * 60 * 1000,
		previousWindowMs = 10 * 60 * 1000,
	): Trend {
		const entries = this.readEntries();
		const now = Date.now();

		const recentCutoff = now - recentWindowMs;
		const previousCutoff = now - recentWindowMs - previousWindowMs;

		const recentValues = entries
			.filter(
				(e) =>
					e.provider === provider &&
					e.modelId === modelId &&
					new Date(e.timestamp).getTime() >= recentCutoff,
			)
			.map((e) => e.tps);

		const previousValues = entries
			.filter(
				(e) =>
					e.provider === provider &&
					e.modelId === modelId &&
					new Date(e.timestamp).getTime() >= previousCutoff &&
					new Date(e.timestamp).getTime() < recentCutoff,
			)
			.map((e) => e.tps);

		if (recentValues.length < 3 || previousValues.length < 3) {
			return "stable";
		}

		const recentMedian = computeMedian(recentValues);
		const previousMedian = computeMedian(previousValues);

		const absDiff = Math.abs(recentMedian - previousMedian);
		const pctDiff =
			previousMedian === 0
				? recentMedian === 0
					? 0
					: Infinity
				: absDiff / previousMedian;

		if (pctDiff < 0.1 && absDiff < 3) {
			return "stable";
		}

		return recentMedian > previousMedian ? "increasing" : "decreasing";
	}

	getAllRollingAverages(
		windowMs = 24 * 60 * 60 * 1000,
	): Array<{ provider: string; modelId: string; median: number; mean: number; count: number }> {
		const entries = this.readEntries();
		const cutoff = Date.now() - windowMs;
		const filtered = entries.filter((e) => new Date(e.timestamp).getTime() >= cutoff);

		const groups = new Map<string, number[]>();
		for (const entry of filtered) {
			const key = `${entry.provider}\0${entry.modelId}`;
			const arr = groups.get(key);
			if (arr) {
				arr.push(entry.tps);
			} else {
				groups.set(key, [entry.tps]);
			}
		}

		const results: Array<{ provider: string; modelId: string; median: number; mean: number; count: number }> = [];
		for (const [key, values] of groups) {
			const [provider, modelId] = key.split("\0");
			results.push({
				provider,
				modelId,
				median: computeMedian(values),
				mean: computeMean(values),
				count: values.length,
			});
		}

		return results;
	}

	prune(ageMs = 30 * 24 * 60 * 60 * 1000): void {
		if (this.disposed) return;
		try {
			const content = readFileSync(this.logPath, "utf8");
			const cutoff = Date.now() - ageMs;
			const lines: string[] = [];

			for (const line of content.split("\n")) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line) as PerformanceEntry;
					if (new Date(entry.timestamp).getTime() >= cutoff) {
						lines.push(line);
					}
				} catch {
					// Skip malformed lines
				}
			}

			writeFileSync(this.logPath, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
		} catch {
			// Silently ignore read/write failures (e.g. file doesn't exist yet)
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.pruneTimer) {
			clearInterval(this.pruneTimer);
			this.pruneTimer = null;
		}
	}

	private schedulePrune(): void {
		if (this.disposed) return;
		this.pruneTimer = setInterval(() => {
			this.prune();
		}, PerformanceTracker.PRUNE_INTERVAL_MS);
		if (this.pruneTimer && typeof this.pruneTimer === "object" && "unref" in this.pruneTimer) {
			this.pruneTimer.unref();
		}
	}

	private readEntries(): PerformanceEntry[] {
		try {
			const content = readFileSync(this.logPath, "utf8");
			const entries: PerformanceEntry[] = [];
			for (const line of content.split("\n")) {
				if (!line.trim()) continue;
				try {
					entries.push(JSON.parse(line) as PerformanceEntry);
				} catch {
					// Skip malformed lines
				}
			}
			return entries;
		} catch {
			return [];
		}
	}
}

function computeMedian(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) {
		return sorted[mid];
	}
	return (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeMean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}
