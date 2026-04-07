/**
 * BM25 metric — full-text search scoring via FTS5.
 */

import type { SearchDatabase } from "../db.js";

/**
 * Compute BM25 scores for a query using FTS5.
 * Returns a Map of chunkId → normalized score (0-1, higher = more relevant).
 */
export function computeBm25Scores(db: SearchDatabase, query: string, limit: number): Map<number, number> {
	const scores = new Map<number, number>();

	try {
		const results = db.ftsSearch(query, limit);
		if (results.length === 0) return scores;

		// Find the maximum score for normalization
		let maxScore = 0;
		for (const r of results) {
			if (r.score > maxScore) maxScore = r.score;
		}

		// Normalize: top result → 1.0, others proportional
		if (maxScore > 0) {
			for (const r of results) {
				scores.set(r.chunkId, r.score / maxScore);
			}
		}
	} catch {
		// If FTS query fails, return empty map
	}

	return scores;
}
