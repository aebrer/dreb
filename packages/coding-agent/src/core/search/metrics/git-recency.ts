/**
 * Git recency metric — recently modified files score higher.
 *
 * Runs `git log` per unique file path to get last-modified timestamps,
 * then applies linear decay scoring.
 */

import { execSync } from "node:child_process";
import type { StoredChunk } from "../types.js";

/** Timeout for each git command in milliseconds. */
const GIT_TIMEOUT_MS = 5000;

/** Default score for files where git info is unavailable. */
const NEUTRAL_SCORE = 0.5;

/**
 * Compute git recency scores based on when files were last modified.
 * More recently modified files score higher.
 * Falls back gracefully if git is unavailable.
 */
export function computeGitRecencyScores(projectRoot: string, chunks: StoredChunk[]): Map<number, number> {
	const scores = new Map<number, number>();

	try {
		if (chunks.length === 0) return scores;

		// Collect unique file paths
		const uniquePaths = new Set<string>();
		for (const chunk of chunks) {
			uniquePaths.add(chunk.filePath);
		}

		// Get last-modified timestamp for each file
		const fileTimestamps = new Map<string, number>();

		for (const filePath of uniquePaths) {
			try {
				const output = execSync(`git log -1 --format=%at -- ${escapeShellArg(filePath)}`, {
					cwd: projectRoot,
					timeout: GIT_TIMEOUT_MS,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				}).trim();

				if (output) {
					const timestamp = Number.parseInt(output, 10);
					if (!Number.isNaN(timestamp) && timestamp > 0) {
						fileTimestamps.set(filePath, timestamp);
					}
				}
			} catch {
				// File not tracked or git error — skip
			}
		}

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
 * Escape a string for safe use in a shell command.
 */
function escapeShellArg(arg: string): string {
	return `'${arg.replace(/'/g, "'\\''")}'`;
}
