/**
 * Import graph proximity metric.
 *
 * Files that import or are imported by high-scoring files get a boost.
 * Uses a simple 1-hop propagation from seed scores.
 */

import type { SearchDatabase } from "../db.js";

/** Fraction of seed score propagated to neighbors. */
const PROPAGATION_FACTOR = 0.5;

/** Fraction of propagated score given back to seed files with many connections. */
const SELF_BOOST_FACTOR = 0.25;

/**
 * Compute import graph proximity scores.
 * Files that import/are imported by high-scoring files get a boost.
 * Seed files also get a connectivity bonus based on how many of their
 * neighbors are in the seed set.
 */
export function computeImportGraphScores(
	db: SearchDatabase,
	seedScores: Map<number, number>,
	fileIdToChunkIds: Map<number, number[]>,
): Map<number, number> {
	const scores = new Map<number, number>();

	try {
		if (seedScores.size === 0) return scores;

		// Build fileId → filePath lookup and extension-stripped path index
		const allFiles = db.getAllFiles();
		const fileIdToPath = new Map<number, string>();
		const pathToFileId = new Map<string, number>();
		const strippedToFileId = new Map<string, number>();

		for (const f of allFiles) {
			fileIdToPath.set(f.id, f.filePath);
			pathToFileId.set(f.filePath, f.id);
			// Also index without extension so import paths (which strip .js/.ts)
			// can match stored file paths (which keep the extension)
			const stripped = stripExtension(f.filePath);
			if (!strippedToFileId.has(stripped)) {
				strippedToFileId.set(stripped, f.id);
			}
		}

		/** Resolve an import target path to a fileId. Tries exact match first, then extension-stripped. */
		function resolveTarget(targetPath: string): number | undefined {
			return pathToFileId.get(targetPath) ?? strippedToFileId.get(targetPath);
		}

		// Propagate scores to neighbors
		const propagated = new Map<number, number>(); // fileId → accumulated propagated score

		for (const [fileId, seedScore] of seedScores) {
			const propagatedScore = seedScore * PROPAGATION_FACTOR;
			if (propagatedScore <= 0) continue;

			let connectedSeedCount = 0;

			// Files this file imports
			const importedPaths = db.getImportsFrom(fileId);
			for (const targetPath of importedPaths) {
				const targetFileId = resolveTarget(targetPath);
				if (targetFileId === undefined) continue;

				if (seedScores.has(targetFileId)) {
					connectedSeedCount++;
				} else {
					propagated.set(targetFileId, (propagated.get(targetFileId) ?? 0) + propagatedScore);
				}
			}

			// Files that import this file
			const filePath = fileIdToPath.get(fileId);
			if (filePath) {
				const importerIds = db.getImportersOf(filePath);
				// Also check extension-stripped variant
				const stripped = stripExtension(filePath);
				const strippedImporterIds = stripped !== filePath ? db.getImportersOf(stripped) : [];
				const allImporterIds = new Set([...importerIds, ...strippedImporterIds]);

				for (const importerFileId of allImporterIds) {
					if (seedScores.has(importerFileId)) {
						connectedSeedCount++;
					} else {
						propagated.set(importerFileId, (propagated.get(importerFileId) ?? 0) + propagatedScore);
					}
				}
			}

			// Self-boost: seed files with many connections to other seeds get a bonus
			if (connectedSeedCount > 0) {
				const selfBoost = seedScore * SELF_BOOST_FACTOR * Math.min(connectedSeedCount / 3, 1);
				propagated.set(fileId, (propagated.get(fileId) ?? 0) + selfBoost);
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

/** Strip common source file extensions for path matching. */
function stripExtension(filePath: string): string {
	return filePath.replace(/\.[jt]sx?$|\.py$|\.go$|\.rs$|\.java$|\.c$|\.h$|\.cpp$|\.hpp$|\.cc$|\.cxx$/, "");
}
