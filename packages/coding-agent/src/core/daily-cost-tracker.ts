import { type Dirent, existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { getSessionsDir, getSubagentSessionsDir } from "../config.js";

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
 * Tracks aggregate cost across all sessions for the current calendar day.
 * Scans both main session files and subagent session files, caches result for O(1) footer access.
 * Refreshes periodically (60s) and on-demand via refresh().
 */
export class DailyCostTracker {
	private static readonly REFRESH_INTERVAL_MS = 60_000;

	private cachedMain = 0;
	private cachedSubagent = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;
	private sessionsDir: string;
	private subagentSessionsDir: string;

	constructor(sessionsDir?: string, subagentSessionsDir?: string) {
		this.sessionsDir = sessionsDir ?? getSessionsDir();
		this.subagentSessionsDir = subagentSessionsDir ?? getSubagentSessionsDir();
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
		if (!this.disposed) {
			const [main, subagent] = await Promise.all([this.scanMainSessions(), this.scanSubagentSessions()]);
			if (!this.disposed) {
				this.cachedMain = main;
				this.cachedSubagent = subagent;
			}
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
		const [main, subagent] = await Promise.all([this.scanMainSessions(), this.scanSubagentSessions()]);
		if (!this.disposed) {
			this.cachedMain = main;
			this.cachedSubagent = subagent;
			this.scheduleNextRefresh();
		}
	}

	private scheduleNextRefresh(): void {
		if (this.disposed) return;
		this.refreshTimer = setTimeout(async () => {
			this.refreshTimer = null;
			if (this.disposed) return;
			const [main, subagent] = await Promise.all([this.scanMainSessions(), this.scanSubagentSessions()]);
			if (!this.disposed) {
				this.cachedMain = main;
				this.cachedSubagent = subagent;
				this.scheduleNextRefresh();
			}
		}, DailyCostTracker.REFRESH_INTERVAL_MS);
		// Allow the timer to not keep the process alive
		if (this.refreshTimer && typeof this.refreshTimer === "object" && "unref" in this.refreshTimer) {
			this.refreshTimer.unref();
		}
	}

	/**
	 * Scan main sessions directory.
	 * Structure: sessionsDir / projectDir / TIMESTAMP_UUID.jsonl
	 */
	private async scanMainSessions(): Promise<number> {
		try {
			if (!existsSync(this.sessionsDir)) return 0;

			const now = new Date();
			let total = 0;
			const projectDirs = await readdir(this.sessionsDir, { withFileTypes: true });

			for (const dirEntry of projectDirs) {
				if (!dirEntry.isDirectory()) continue;

				const projectDir = join(this.sessionsDir, dirEntry.name);
				total += await this.scanJsonlFilesInDir(projectDir, now);
			}

			return total;
		} catch {
			// Never crash the app
			return 0;
		}
	}

	/**
	 * Scan subagent sessions directory.
	 * Structure: subagentSessionsDir / sessionId / TIMESTAMP_UUID.jsonl
	 *            subagentSessionsDir / sessionId / step-N / TIMESTAMP_UUID.jsonl
	 */
	private async scanSubagentSessions(): Promise<number> {
		try {
			if (!existsSync(this.subagentSessionsDir)) return 0;

			const now = new Date();
			let total = 0;
			const sessionIdDirs = await readdir(this.subagentSessionsDir, { withFileTypes: true });

			for (const dirEntry of sessionIdDirs) {
				if (!dirEntry.isDirectory()) continue;

				const sessionIdDir = join(this.subagentSessionsDir, dirEntry.name);

				// Scan direct JSONL files in the session-id directory
				total += await this.scanJsonlFilesInDir(sessionIdDir, now);

				// Scan step-N subdirectories for chain agents
				let subEntries: Dirent[];
				try {
					subEntries = await readdir(sessionIdDir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const subEntry of subEntries) {
					if (!subEntry.isDirectory()) continue;
					const stepDir = join(sessionIdDir, subEntry.name);
					total += await this.scanJsonlFilesInDir(stepDir, now);
				}
			}

			return total;
		} catch {
			// Never crash the app
			return 0;
		}
	}

	/**
	 * Scan a directory for today's JSONL session files and sum their costs.
	 */
	private async scanJsonlFilesInDir(dirPath: string, now: Date): Promise<number> {
		let files: string[];
		try {
			files = (await readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
		} catch {
			/* Directory unreadable — skip */
			return 0;
		}

		let total = 0;
		for (const filename of files) {
			// Extract timestamp part: everything before the UUID
			// Filename: 2026-04-09T18-49-11-406Z_33137d5d-d1e4-4a0e-baca-ebd08ab0e2e0.jsonl
			const underscoreIdx = filename.indexOf("_", 20);
			if (underscoreIdx === -1) continue;

			const timestampPart = filename.slice(0, underscoreIdx);
			const fileDate = filenameTimestampToDate(timestampPart);
			if (!fileDate) continue;

			// Skip sessions not from today (compares local calendar day)
			if (!isSameLocalDay(fileDate, now)) continue;

			// Read and parse the JSONL file
			total += await sumCostFromFile(join(dirPath, filename));
		}

		return total;
	}
}
