/**
 * Cosine similarity metric — vector-space semantic similarity.
 */

/**
 * Compute cosine similarity scores between a query vector and all stored vectors.
 * Returns a Map of chunkId → score (0-1, higher = more similar).
 *
 * Vectors are assumed to be pre-normalized (unit length), so cosine similarity
 * reduces to the dot product.
 */
export function computeCosineScores(
	queryVector: Float32Array,
	storedVectors: Map<number, Float32Array>,
	limit: number,
): Map<number, number> {
	const scores = new Map<number, number>();

	try {
		// Compute dot products (= cosine similarity for unit vectors)
		const allScores: Array<[number, number]> = [];
		for (const [chunkId, vector] of storedVectors) {
			let dot = 0;
			const len = Math.min(queryVector.length, vector.length);
			for (let i = 0; i < len; i++) {
				dot += queryVector[i] * vector[i];
			}
			// Clamp negative similarities to 0
			const score = Math.max(0, dot);
			if (score > 0) {
				allScores.push([chunkId, score]);
			}
		}

		// Sort by score descending and take top-K
		allScores.sort((a, b) => b[1] - a[1]);
		const topK = Math.min(limit, allScores.length);
		for (let i = 0; i < topK; i++) {
			scores.set(allScores[i][0], allScores[i][1]);
		}
	} catch {
		// If anything fails, return empty map
	}

	return scores;
}
