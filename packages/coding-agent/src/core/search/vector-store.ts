/**
 * Vector operations for semantic search.
 *
 * Pure JS implementations — no native dependencies or SQLite UDFs needed.
 * Vectors are computed and compared in JS, stored as BLOBs in SQLite.
 */

// ============================================================================
// Similarity
// ============================================================================

/**
 * Compute cosine similarity between two normalized vectors.
 *
 * For normalized vectors, cosine similarity is simply the dot product:
 *   cos(a, b) = Σ a[i] * b[i]
 *
 * Returns a value in [-1, 1] where 1 = identical, 0 = orthogonal, -1 = opposite.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	const len = a.length;
	let dot = 0;
	for (let i = 0; i < len; i++) {
		dot += a[i] * b[i];
	}
	return dot;
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Pack a Float32Array into a Buffer for SQLite BLOB storage.
 *
 * Creates a copy to ensure the buffer isn't shared with other typed arrays.
 */
export function packVector(vector: Float32Array): Buffer {
	return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * Unpack a BLOB (Uint8Array from node:sqlite) back to a Float32Array.
 *
 * The returned array shares the underlying buffer with the input for
 * zero-copy performance. Callers should not mutate the input after calling.
 */
export function unpackVector(blob: Uint8Array): Float32Array {
	return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

// ============================================================================
// Top-K Search
// ============================================================================

/**
 * Find the top-K most similar vectors from a set.
 *
 * Computes cosine similarity between the query vector and every candidate,
 * then returns the K highest-scoring results sorted by descending score.
 *
 * Uses a simple full scan — suitable for the index sizes we expect in a
 * single-project codebase (typically <100K chunks). For millions of vectors,
 * an approximate nearest neighbor index (HNSW, IVF) would be needed.
 */
export function topKSimilar(
	query: Float32Array,
	vectors: Map<number, Float32Array>,
	k: number,
): Array<{ id: number; score: number }> {
	if (k <= 0 || vectors.size === 0) return [];

	// For small k relative to n, a min-heap would be more efficient.
	// For typical codebase sizes (<100K vectors) the difference is negligible,
	// and a sorted array is simpler and correct.
	const scored: Array<{ id: number; score: number }> = [];

	for (const [id, vector] of vectors) {
		scored.push({ id, score: cosineSimilarity(query, vector) });
	}

	// Partial sort: only need top-k, but full sort is fine for expected sizes
	scored.sort((a, b) => b.score - a.score);

	return scored.slice(0, k);
}
