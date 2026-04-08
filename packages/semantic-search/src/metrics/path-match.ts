/**
 * Path/filename similarity metric.
 *
 * Tokenizes query and file paths, computes a recall-oriented overlap score
 * (what fraction of query tokens appear in the path).
 */

import type { StoredChunk } from "../types.js";
import { tokenize } from "./tokenize.js";

/**
 * Compute path/filename similarity scores.
 * Tokenizes query and file paths, returns Jaccard-like overlap score.
 */
export function computePathMatchScores(query: string, chunks: StoredChunk[]): Map<number, number> {
	const scores = new Map<number, number>();

	try {
		const queryTokens = tokenize(query);
		if (queryTokens.length === 0) return scores;

		const querySet = new Set(queryTokens);

		// Cache path tokens per file path (many chunks share the same file)
		const pathTokenCache = new Map<string, Set<string>>();

		let maxScore = 0;

		for (const chunk of chunks) {
			let pathTokenSet = pathTokenCache.get(chunk.filePath);
			if (!pathTokenSet) {
				pathTokenSet = new Set(tokenize(chunk.filePath));
				pathTokenCache.set(chunk.filePath, pathTokenSet);
			}

			// Score = |intersection| / |query tokens| (recall-oriented)
			let intersection = 0;
			for (const qt of querySet) {
				if (pathTokenSet.has(qt)) {
					intersection++;
				}
			}

			const score = intersection / queryTokens.length;
			if (score > 0) {
				scores.set(chunk.id, score);
				if (score > maxScore) maxScore = score;
			}
		}

		// Normalize to 0-1 (divide by max if not already bounded)
		if (maxScore > 0 && maxScore !== 1) {
			for (const [id, score] of scores) {
				scores.set(id, score / maxScore);
			}
		}
	} catch {
		// If anything fails, return empty map
	}

	return scores;
}
