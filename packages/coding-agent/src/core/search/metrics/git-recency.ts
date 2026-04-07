/**
 * Git recency metric — recently modified files score higher.
 *
 * Runs a single `git log` command to get last-modified timestamps for all
 * files, then applies linear decay scoring.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { StoredChunk } from "../types.js";

const execFile = promisify(execFileCb);

/** Timeout for the git command in milliseconds. */
const GIT_TIMEOUT_MS = 15000;

/** Max buffer for git output (10 MB — sufficient for large repos). */
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

/** Default score for files where git info is unavailable. */
const NEUTRAL_SCORE = 0.5;

/**
 * Compute git recency scores based on when files were last modified.
 * More recently modified files score higher.
 * Falls back gracefully if git is unavailable.
 */
export async function computeGitRecencyScores(
	projectRoot: string,
	chunks: StoredChunk[],
): Promise<Map<number, number>> {
	const scores = new Map<number, number>();

	try {
		if (chunks.length === 0) return scores;

		// Collect unique file paths
		const uniquePaths = new Set<string>();
		for (const chunk of chunks) {
			uniquePaths.add(chunk.filePath);
		}

		// Get last-modified timestamps in a single git call.
		// Output format: "COMMIT <timestamp>" lines followed by changed file names.
		// We take the first (most recent) timestamp seen for each file.
		const fileTimestamps = await getFileTimestamps(projectRoot, uniquePaths);

		// If no timestamps found, assign neutral scores
		if (fileTimestamps.size === 0) {
			for (const chunk of chunks) {
				scores.set(chunk.id, NEUTRAL_SCORE);
			}
			return scores;
		}

		// Find oldest and newest timestamps
		let oldest = Infinity;
		let newest = -Infinity;
		for (const ts of fileTimestamps.values()) {
			if (ts < oldest) oldest = ts;
			if (ts > newest) newest = ts;
		}

		const range = newest - oldest;

		// Assign scores to chunks
		for (const chunk of chunks) {
			const ts = fileTimestamps.get(chunk.filePath);
			if (ts === undefined) {
				// Not tracked by git → neutral score
				scores.set(chunk.id, NEUTRAL_SCORE);
			} else if (range === 0) {
				// All files have the same timestamp
				scores.set(chunk.id, 1);
			} else {
				// Linear decay: newest → 1.0, oldest → 0.0
				scores.set(chunk.id, (ts - oldest) / range);
			}
		}
	} catch {
		// Git unavailable entirely — assign neutral scores
		for (const chunk of chunks) {
			scores.set(chunk.id, NEUTRAL_SCORE);
		}
	}

	return scores;
}

/**
 * Get last-modified timestamps for files using a single `git log` invocation.
 * Returns a Map of filePath → unix timestamp (seconds).
 */
async function getFileTimestamps(projectRoot: string, targetPaths: Set<string>): Promise<Map<string, number>> {
	const fileTimestamps = new Map<string, number>();

	try {
		// Single git call: list all commits with their timestamps and changed files.
		// --diff-filter=AMCR: only additions, modifications, copies, renames.
		// --name-only: list file names after each commit.
		// --format="COMMIT %at": prefix each commit with its unix timestamp.
		const { stdout: output } = await execFile(
			"git",
			["log", "--max-count=10000", "--format=COMMIT %at", "--name-only", "--diff-filter=AMCR"],
			{
				cwd: projectRoot,
				timeout: GIT_TIMEOUT_MS,
				encoding: "utf-8",
				maxBuffer: GIT_MAX_BUFFER,
			},
		);

		let currentTimestamp = 0;
		let foundAll = false;

		for (const line of output.split("\n")) {
			if (foundAll) break;

			if (line.startsWith("COMMIT ")) {
				currentTimestamp = Number.parseInt(line.slice(7), 10);
				if (Number.isNaN(currentTimestamp) || currentTimestamp <= 0) {
					currentTimestamp = 0;
				}
			} else if (line.trim() && currentTimestamp > 0) {
				const filePath = line.trim();
				// Only record the first (most recent) timestamp per file
				if (targetPaths.has(filePath) && !fileTimestamps.has(filePath)) {
					fileTimestamps.set(filePath, currentTimestamp);
					// Early exit once we've found all target files
					if (fileTimestamps.size === targetPaths.size) {
						foundAll = true;
					}
				}
			}
		}
	} catch {
		// Git unavailable or failed — return empty map
	}

	return fileTimestamps;
}
