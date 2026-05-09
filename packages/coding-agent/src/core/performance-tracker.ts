import {
	appendFileSync,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { dirname, join } from "path";
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

export type PerformanceDeltaDirection = "above" | "below" | "stable";

export interface PerformanceDelta {
	baselineMedian: number;
	recentMedian: number;
	percentDelta: number;
	direction: PerformanceDeltaDirection;
	baselineCount: number;
	recentCount: number;
}

export class PerformanceTracker {
	private static readonly PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
	private static readonly LOCK_TIMEOUT_MS = 1000;
	private static readonly PRUNE_LOCK_TIMEOUT_MS = 5000;
	private static readonly STALE_LOCK_MS = 5 * 60 * 1000;

	private logPath: string;
	private lockPath: string;
	private entries: PerformanceEntry[];
	private pruneTimer: ReturnType<typeof setInterval> | null = null;
	private disposed = false;

	constructor(logPath?: string) {
		this.logPath = logPath ?? getPerformanceLogPath();
		this.lockPath = `${this.logPath}.lock`;
		try {
			this.entries = this.readEntries();
		} catch {
			this.entries = [];
		}
		this.ensureDir();
		this.schedulePrune();
	}

	record(entry: PerformanceEntry): void {
		if (this.disposed) return;
		try {
			const wrote = this.withLogLock(() => {
				appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, "utf8");
				return true;
			});
			if (!wrote) {
				console.warn("[PerformanceTracker] Failed to write performance entry: could not acquire log lock");
				return;
			}
			this.entries.push(entry);
		} catch (error) {
			console.warn(`[PerformanceTracker] Failed to write performance entry: ${error}`);
		}
	}

	getRollingAverage(provider: string, modelId: string, count = 100): RollingAverage {
		const values = this.entries
			.filter((e) => e.provider === provider && e.modelId === modelId)
			.sort((a, b) => entryTime(b) - entryTime(a))
			.slice(0, count)
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

	getPerformanceDelta(
		provider: string,
		modelId: string,
		recentCount = 10,
		baselineCount = 10_000,
		stablePercent = 1,
	): PerformanceDelta {
		const modelEntries = this.entries
			.filter((e) => e.provider === provider && e.modelId === modelId)
			.sort((a, b) => entryTime(b) - entryTime(a));

		const baselineSlice = baselineCount > 0 ? baselineCount : modelEntries.length;
		const baselineValues = modelEntries.slice(0, baselineSlice).map((e) => e.tps);
		const recentValues = modelEntries.slice(0, recentCount).map((e) => e.tps);

		const baselineMedian = computeMedian(baselineValues);
		const recentMedian = computeMedian(recentValues);
		if (baselineValues.length < 3 || recentValues.length < 3 || baselineMedian <= 0) {
			return {
				baselineMedian,
				recentMedian,
				percentDelta: 0,
				direction: "stable",
				baselineCount: baselineValues.length,
				recentCount: recentValues.length,
			};
		}

		const percentDelta = ((recentMedian - baselineMedian) / baselineMedian) * 100;
		const direction = Math.abs(percentDelta) < stablePercent ? "stable" : percentDelta > 0 ? "above" : "below";

		return {
			baselineMedian,
			recentMedian,
			percentDelta,
			direction,
			baselineCount: baselineValues.length,
			recentCount: recentValues.length,
		};
	}

	getAllRollingAverages(
		windowMs = 24 * 60 * 60 * 1000,
	): Array<{ provider: string; modelId: string; median: number; mean: number; count: number }> {
		const cutoff = Date.now() - windowMs;
		const filtered = this.entries.filter((e) => entryTime(e) >= cutoff);

		const groups = new Map<string, number[]>();
		for (const entry of filtered) {
			const key = `${entry.provider}\0${entry.modelId}`;
			const arr = groups.get(key) ?? [];
			arr.push(entry.tps);
			groups.set(key, arr);
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
		let tempPath: string | undefined;
		try {
			const pruned = this.withLogLock(() => {
				const cutoff = Date.now() - ageMs;
				const sourceEntries = this.readEntries();
				const kept: PerformanceEntry[] = [];
				const lines: string[] = [];

				for (const entry of sourceEntries) {
					if (entryTime(entry) >= cutoff) {
						kept.push(entry);
						lines.push(JSON.stringify(entry));
					}
				}

				tempPath = join(dirname(this.logPath), `.performance-prune-${process.pid}-${Date.now()}.jsonl`);
				writeFileSync(tempPath, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
				renameSync(tempPath, this.logPath);
				tempPath = undefined;
				this.entries = kept;
				return true;
			}, PerformanceTracker.PRUNE_LOCK_TIMEOUT_MS);
			if (!pruned) {
				console.warn("[PerformanceTracker] Failed to prune performance log: could not acquire log lock");
			}
		} catch (error) {
			console.warn(`[PerformanceTracker] Failed to prune performance log: ${error}`);
		} finally {
			if (tempPath) {
				try {
					rmSync(tempPath, { force: true });
				} catch {
					// Best-effort cleanup only
				}
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.pruneTimer) {
			clearInterval(this.pruneTimer);
			this.pruneTimer = null;
		}
	}

	private ensureDir(): void {
		try {
			mkdirSync(dirname(this.logPath), { recursive: true });
		} catch (error) {
			if (isFileExistsError(error)) {
				return;
			}
			console.warn(`[PerformanceTracker] Failed to create log directory: ${error}`);
		}
	}

	private schedulePrune(): void {
		if (this.disposed) return;
		this.pruneTimer = setInterval(() => {
			this.prune();
		}, PerformanceTracker.PRUNE_INTERVAL_MS);
		this.pruneTimer?.unref?.();
	}

	private readEntries(): PerformanceEntry[] {
		try {
			const content = readFileSync(this.logPath, "utf8");
			const entries: PerformanceEntry[] = [];
			for (const line of content.split("\n")) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line) as unknown;
					if (!isValidPerformanceEntry(parsed)) {
						console.warn(`[PerformanceTracker] Skipping invalid performance entry line: ${line}`);
						continue;
					}
					const time = entryTime(parsed);
					if (!Number.isFinite(time)) {
						console.warn(`[PerformanceTracker] Skipping entry with invalid timestamp: ${line}`);
						continue;
					}
					entries.push(parsed);
				} catch {
					// Skip malformed lines
				}
			}
			return entries;
		} catch (error) {
			if (isENOENT(error)) {
				return [];
			}
			throw error;
		}
	}

	private withLogLock<T>(operation: () => T, timeoutMs = PerformanceTracker.LOCK_TIMEOUT_MS): T | undefined {
		const fd = this.acquireLock(timeoutMs);
		if (fd === undefined) return undefined;
		try {
			return operation();
		} finally {
			try {
				closeSync(fd);
			} finally {
				rmSync(this.lockPath, { force: true });
			}
		}
	}

	private acquireLock(timeoutMs: number): number | undefined {
		const start = performance.now();
		while (performance.now() - start <= timeoutMs) {
			try {
				return openSync(this.lockPath, "wx");
			} catch (error) {
				if (!isFileExistsError(error)) {
					throw error;
				}
				this.removeStaleLock();
				sleepSync(10);
			}
		}
		return undefined;
	}

	private removeStaleLock(): void {
		try {
			const lockAgeMs = Date.now() - statSync(this.lockPath).mtimeMs;
			if (lockAgeMs > PerformanceTracker.STALE_LOCK_MS) {
				rmSync(this.lockPath, { force: true });
			}
		} catch {
			// Lock disappeared between open attempts
		}
	}
}

function entryTime(entry: PerformanceEntry): number {
	const time = new Date(entry.timestamp).getTime();
	return Number.isFinite(time) ? time : NaN;
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

function isFileExistsError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isENOENT(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isValidPerformanceEntry(entry: unknown): entry is PerformanceEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;
	return (
		typeof e.timestamp === "string" &&
		typeof e.provider === "string" &&
		typeof e.modelId === "string" &&
		typeof e.outputTokens === "number" &&
		Number.isFinite(e.outputTokens) &&
		typeof e.durationMs === "number" &&
		Number.isFinite(e.durationMs) &&
		typeof e.tps === "number" &&
		Number.isFinite(e.tps)
	);
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
