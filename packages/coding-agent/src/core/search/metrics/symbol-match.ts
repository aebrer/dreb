/**
 * Symbol name match metric.
 *
 * Compares query terms against symbol names (function/class/etc names)
 * using tokenized overlap with bonuses for exact substring matches.
 */

import { tokenize } from "./tokenize.js";

/**
 * Compute symbol name match scores.
 * Compares query terms against symbol names (function/class/etc names).
 */
export function computeSymbolMatchScores(query: string, symbols: Map<number, string[]>): Map<number, number> {
	const scores = new Map<number, number>();

	try {
		const queryTokens = tokenize(query);
		if (queryTokens.length === 0) return scores;

		const queryLower = query.toLowerCase();

		let maxScore = 0;

		for (const [chunkId, symbolNames] of symbols) {
			let bestScore = 0;

			for (const symbolName of symbolNames) {
				const symbolTokens = new Set(tokenize(symbolName));
				const symbolLower = symbolName.toLowerCase();

				// Token overlap: fraction of query tokens found in symbol
				let matchCount = 0;
				for (const qt of queryTokens) {
					if (symbolTokens.has(qt)) {
						matchCount++;
					}
				}

				let score = matchCount / queryTokens.length;

				// Bonus for exact substring match of query in symbol name
				if (symbolLower.includes(queryLower)) {
					score = Math.min(1, score + 0.3);
				}
				// Bonus for exact substring match of symbol in query
				else if (queryLower.includes(symbolLower) && symbolLower.length >= 3) {
					score = Math.min(1, score + 0.2);
				}

				if (score > bestScore) bestScore = score;
			}

			if (bestScore > 0) {
				scores.set(chunkId, bestScore);
				if (bestScore > maxScore) maxScore = bestScore;
			}
		}

		// Normalize to 0-1
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
