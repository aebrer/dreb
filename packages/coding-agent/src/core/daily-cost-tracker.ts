import { readdir, readFile } from "fs/promises";
import { join, resolve } from "path";
import { getSessionsDir, getSubagentSessionsDir, resolveConfiguredDirectory } from "../config.js";

/**
 * Parse a session filename timestamp back to a Date.
 * Filename timestamps look like "2026-04-09T18-49-11-406Z" (colons and dots replaced with hyphens).
 * Returns null if the timestamp doesn't match the expected format.
 */
export function filenameTimestampToDate(fileTimestamp: string): Date | null {
	// fileTimestamp like "2026-04-09T18-49-11-406Z"
	// Reconstruct: YYYY-MM-DDThh:mm:ss.mmmZ
	const match = fileTimestamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
	if (!match) return null;
	const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Check if two dates fall on the same local calendar day.
 */
export function isSameLocalDay(date: Date, today: Date): boolean {
	return (
		date.getFullYear() === today.getFullYear() &&
		date.getMonth() === today.getMonth() &&
		date.getDate() === today.getDate()
	);
}

/**
 * Sum `usage.cost.total` from all assistant messages in a JSONL session file.
 * Works identically for both main sessions and subagent sessions.
 */
export async function sumCostFromFile(filePath: string): Promise<number> {
	try {
		const content = await readFile(filePath, "utf8");
		let total = 0;

		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type === "message" && entry.message?.role === "assistant") {
					total += entry.message.usage?.cost?.total ?? 0;
				}
			} catch {
				// Skip malformed lines
			}
		}

		return total;
	} catch {
		/* File unreadable — treat as zero cost */
		return 0;
	}
}

/** Breakdown of daily costs between main sessions and subagent sessions. */
export interface DailyCostBreakdown {
	total: number;
	main: number;
	subagent: number;
}

/**
 * Session storage roots the daily tracker scans. Every root that may hold
 * today's transcripts must be listed: the built-in nested main-session tree,
 * any custom flat `sessionDir`, and every subagent root (configured + legacy).
 * Files reachable from more than one root are counted once.
 */
export interface DailyCostSources {
	/** Nested main-session trees: root / projectDir / *.jsonl. Default: built-in sessions dir. */
	nestedMainRoots?: readonly string[];
	/** Flat main-session directories: root / *.jsonl (custom `sessionDir`). */
	flatMainRoots?: readonly string[];
	/** Subagent roots: root / sessionId / *.jsonl and root / sessionId / step-N / *.jsonl. Default: legacy dir. */
	subagentRoots?: readonly string[];
}

function uniqueRoots(roots: readonly (string | undefined)[]): string[] {
	return [...new Set(roots.filter((root): root is string => !!root).map((root) => resolve(root)))];
}

/**
 * Tracks aggregate cost across all sessions for the current calendar day.
 * Scans main session roots and subagent session roots, caches result for O(1) footer access.
 * Refreshes periodically (60s) and on-demand via refresh().
 */
export class DailyCostTracker {
	private static readonly REFRESH_INTERVAL_MS = 60_000;

	private cachedMain = 0;
	private cachedSubagent = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;
	private readonly nestedMainRoots: string[];
	private readonly flatMainRoots: string[];
	private readonly subagentRoots: string[];

	constructor(sources: DailyCostSources = {}) {
		this.nestedMainRoots = uniqueRoots(sources.nestedMainRoots ?? [getSessionsDir()]);
		this.flatMainRoots = uniqueRoots(sources.flatMainRoots ?? []);
		this.subagentRoots = uniqueRoots(sources.subagentRoots ?? [getSubagentSessionsDir()]);
		// Kick off initial async scan — getDailyCost() returns 0 until it completes
		void this.initialScan();
	}

	/** Get cached daily cost total (main + subagent). O(1). */
	getDailyCost(): number {
		return this.cachedMain + this.cachedSubagent;
	}

	/** Get cached daily cost breakdown: total, main, and subagent. O(1). */
	getDailyCostBreakdown(): DailyCostBreakdown {
		return {
			total: this.cachedMain + this.cachedSubagent,
			main: this.cachedMain,
			subagent: this.cachedSubagent,
		};
	}

	/** Force an async refresh of the daily cost. */
	async refresh(): Promise<void> {
		if (this.disposed) return;
		const [main, subagent] = await this.scanCosts();
		if (!this.disposed) {
			this.cachedMain = main;
			this.cachedSubagent = subagent;
		}
	}

	/** Clean up timer and prevent in-flight scans from updating cache. */
	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	private async initialScan(): Promise<void> {
		await this.refresh();
		this.scheduleNextRefresh();
	}

	private scheduleNextRefresh(): void {
		if (this.disposed) return;
		this.refreshTimer = setTimeout(async () => {
			this.refreshTimer = null;
			await this.refresh();
			this.scheduleNextRefresh();
		}, DailyCostTracker.REFRESH_INTERVAL_MS);
		// Allow the timer to not keep the process alive
		if (this.refreshTimer && typeof this.refreshTimer === "object" && "unref" in this.refreshTimer) {
			this.refreshTimer.unref();
		}
	}

	private async scanCosts(): Promise<[number, number]> {
		const now = new Date();
		const [mainFiles, subagentFiles] = await Promise.all([
			this.collectMainFiles(now),
			this.collectSubagentFiles(now),
		]);
		// A file reachable from both a main and a subagent root is counted as main only.
		for (const file of mainFiles) subagentFiles.delete(file);
		const [main, subagent] = await Promise.all([sumFiles(mainFiles), sumFiles(subagentFiles)]);
		return [main, subagent];
	}

	/** Main sessions: nested root / projectDir / *.jsonl, and flat root / *.jsonl. */
	private async collectMainFiles(now: Date): Promise<Set<string>> {
		const files = new Set<string>();
		for (const root of this.nestedMainRoots) {
			for (const projectDir of await listSubdirs(root)) await addTodaysJsonlFiles(files, projectDir, now);
		}
		for (const root of this.flatMainRoots) await addTodaysJsonlFiles(files, root, now);
		return files;
	}

	/** Subagent sessions: root / sessionId / *.jsonl and root / sessionId / step-N / *.jsonl. */
	private async collectSubagentFiles(now: Date): Promise<Set<string>> {
		const files = new Set<string>();
		for (const root of this.subagentRoots) {
			for (const sessionIdDir of await listSubdirs(root)) {
				await addTodaysJsonlFiles(files, sessionIdDir, now);
				for (const stepDir of await listSubdirs(sessionIdDir)) await addTodaysJsonlFiles(files, stepDir, now);
			}
		}
		return files;
	}
}

/** List child directories; a missing or unreadable directory yields none (never crash the footer). */
async function listSubdirs(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
	} catch {
		return [];
	}
}

/** Add today's JSONL session files in dirPath (by filename timestamp, local calendar day). */
async function addTodaysJsonlFiles(files: Set<string>, dirPath: string, now: Date): Promise<void> {
	let names: string[];
	try {
		names = (await readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
	} catch {
		/* Directory missing or unreadable — skip */
		return;
	}
	for (const filename of names) {
		// Filename: 2026-04-09T18-49-11-406Z_33137d5d-d1e4-4a0e-baca-ebd08ab0e2e0.jsonl
		const underscoreIdx = filename.indexOf("_", 20);
		if (underscoreIdx === -1) continue;
		const fileDate = filenameTimestampToDate(filename.slice(0, underscoreIdx));
		if (!fileDate || !isSameLocalDay(fileDate, now)) continue;
		files.add(join(dirPath, filename));
	}
}

async function sumFiles(files: Iterable<string>): Promise<number> {
	let total = 0;
	for (const file of files) total += await sumCostFromFile(file);
	return total;
}

/** Inputs needed to derive every storage root a session's process may write today's transcripts to. */
export interface DailyCostSessionContext {
	cwd: string;
	sessionManager: { getCustomSessionInventoryRoot(): string | undefined };
	settingsManager: { getGlobalSettings(): { sessionDir?: string }; getSessionDir(): string | undefined };
	subagentSessionDiscoveryRoots: readonly string[];
}

/**
 * Build daily-cost sources that honour custom session storage: the built-in nested
 * tree, the session's explicit flat root (CLI/extension/settings), the global and
 * effective `sessionDir` settings, and all subagent discovery roots (configured + legacy).
 */
export function dailyCostSourcesForSession(context: DailyCostSessionContext): DailyCostSources {
	const { cwd, sessionManager, settingsManager } = context;
	return {
		nestedMainRoots: [getSessionsDir()],
		flatMainRoots: uniqueRoots([
			sessionManager.getCustomSessionInventoryRoot(),
			resolveConfiguredDirectory(settingsManager.getGlobalSettings().sessionDir, cwd),
			resolveConfiguredDirectory(settingsManager.getSessionDir(), cwd),
		]),
		subagentRoots: [...context.subagentSessionDiscoveryRoots],
	};
}
