import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { getSessionsDir } from "../config.js";

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
 * Tracks aggregate cost across all sessions for the current calendar day.
 * Scans session files filtered by filename timestamp, caches result for O(1) footer access.
 * Refreshes periodically (60s) and on-demand via refresh().
 */
export class DailyCostTracker {
	private static readonly REFRESH_INTERVAL_MS = 60_000;

	private cachedCost = 0;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private disposed = false;
	private sessionsDir: string;

	constructor(sessionsDir?: string) {
		this.sessionsDir = sessionsDir ?? getSessionsDir();
		// Initial scan synchronously
		this.cachedCost = this.scanDailyCost();
		// Set up periodic refresh
		this.refreshTimer = setInterval(() => {
			if (!this.disposed) {
				this.cachedCost = this.scanDailyCost();
			}
		}, DailyCostTracker.REFRESH_INTERVAL_MS);
		// Allow the timer to not keep the process alive
		if (this.refreshTimer && typeof this.refreshTimer === "object" && "unref" in this.refreshTimer) {
			this.refreshTimer.unref();
		}
	}

	/** Get cached daily cost total. O(1). */
	getDailyCost(): number {
		return this.cachedCost;
	}

	/** Force a synchronous refresh of the daily cost. */
	refresh(): void {
		if (!this.disposed) {
			this.cachedCost = this.scanDailyCost();
		}
	}

	/** Clean up timer. */
	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	private scanDailyCost(): number {
		try {
			if (!existsSync(this.sessionsDir)) return 0;

			const now = new Date();
			const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

			let total = 0;
			const projectDirs = readdirSync(this.sessionsDir, { withFileTypes: true });

			for (const dirEntry of projectDirs) {
				if (!dirEntry.isDirectory()) continue;

				const projectDir = join(this.sessionsDir, dirEntry.name);
				let files: string[];
				try {
					files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
				} catch {
					continue;
				}

				for (const filename of files) {
					// Extract timestamp part: everything before the UUID
					// Filename: 2026-04-09T18-49-11-406Z_33137d5d-d1e4-4a0e-baca-ebd08ab0e2e0.jsonl
					const underscoreIdx = filename.indexOf("_", 20);
					if (underscoreIdx === -1) continue;

					const timestampPart = filename.slice(0, underscoreIdx);
					const fileDate = filenameTimestampToDate(timestampPart);
					if (!fileDate) continue;

					// Check if the session's UTC timestamp falls on today's local date
					if (!isSameLocalDay(fileDate, now)) {
						// Quick check: if the filename date prefix doesn't even match
						// today or yesterday (UTC), skip entirely for performance
						const fileDateLocal = `${fileDate.getFullYear()}-${String(fileDate.getMonth() + 1).padStart(2, "0")}-${String(fileDate.getDate()).padStart(2, "0")}`;
						if (fileDateLocal !== todayLocal) continue;
					}

					// Read and parse the JSONL file
					total += this.sumCostFromFile(join(projectDir, filename));
				}
			}

			return total;
		} catch {
			// Never crash the app
			return 0;
		}
	}

	private sumCostFromFile(filePath: string): number {
		try {
			const content = readFileSync(filePath, "utf8");
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
			return 0;
		}
	}
}
