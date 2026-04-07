/**
 * Import graph proximity metric.
 *
 * Files that import or are imported by high-scoring files get a boost.
 * Uses a simple 1-hop propagation from seed scores.
 */

import type { SearchDatabase } from "../db.js";

/** Fraction of seed score propagated to neighbors. */
const PROPAGATION_FACTOR = 0.5;

/**
 * Compute import graph proximity scores.
 * Files that import/are imported by high-scoring files get a boost.
 * Uses a simple 1-hop propagation from seed scores.
 */
export function computeImportGraphScores(
	db: SearchDatabase,
	seedScores: Map<number, number>,
	fileIdToChunkIds: Map<number, number[]>,
): Map<number, number> {
	const scores = new Map<number, number>();

	try {
		if (seedScores.size === 0) return scores;

		// Build fileId → filePath lookup
		const allFiles = db.getAllFiles();
		const fileIdToPath = new Map<number, string>();
		const pathToFileId = new Map<string, number>();
		for (const f of allFiles) {
			fileIdToPath.set(f.id, f.filePath);
			pathToFileId.set(f.filePath, f.id);
		}

		// Propagate scores to neighbors
		const propagated = new Map<number, number>(); // fileId → accumulated propagated score

		for (const [fileId, seedScore] of seedScores) {
			const propagatedScore = seedScore * PROPAGATION_FACTOR;
			if (propagatedScore <= 0) continue;

			// Files this file imports
			const importedPaths = db.getImportsFrom(fileId);
			for (const targetPath of importedPaths) {
				const targetFileId = pathToFileId.get(targetPath);
				if (targetFileId !== undefined && !seedScores.has(targetFileId)) {
					propagated.set(targetFileId, (propagated.get(targetFileId) ?? 0) + propagatedScore);
				}
			}

			// Files that import this file
			const filePath = fileIdToPath.get(fileId);
			if (filePath) {
				const importerIds = db.getImportersOf(filePath);
				for (const importerFileId of importerIds) {
					if (!seedScores.has(importerFileId)) {
						propagated.set(importerFileId, (propagated.get(importerFileId) ?? 0) + propagatedScore);
					}
				}
			}
		}

		if (propagated.size === 0) return scores;

		// Find max for normalization
		let maxScore = 0;
		for (const score of propagated.values()) {
			if (score > maxScore) maxScore = score;
		}

		if (maxScore <= 0) return scores;

		// Distribute to chunks and normalize
		for (const [fileId, fileScore] of propagated) {
			const chunkIds = fileIdToChunkIds.get(fileId);
			if (!chunkIds || chunkIds.length === 0) continue;

			// Distribute equally among chunks in this file
			const perChunkScore = fileScore / maxScore / chunkIds.length;
			for (const chunkId of chunkIds) {
				scores.set(chunkId, perChunkScore);
			}
		}
	} catch {
		// If anything fails, return empty map
	}

	return scores;
}
