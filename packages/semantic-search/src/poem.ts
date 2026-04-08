/**
 * POEM — Pareto-Optimal Embedded Modeling, multi-metric ranking.
 *
 * Ranks search candidates across multiple relevance metrics without requiring
 * hand-tuned weights. Uses the TFPR (Top-Fraction Pareto Ranker) approach:
 * vectorized dominance matrix computation with column duplication for
 * query-type-dependent metric weighting.
 *
 * Algorithm:
 *  1. Prune: per-metric top-K → union of survivors
 *  2. Build objectives matrix with column duplication for query-type weighting
 *  3. For each objective column, sort candidates and accumulate pairwise
 *     dominance counts (duplicate columns contribute via weight multiplier)
 *  4. Compute fitness: meanDominance × (numDominating + ε) / (numSubmitting + ε)
 *  5. Sort by fitness, assign ranks
 *
 * References:
 *  - POEM paper: https://iopscience.iop.org/article/10.1088/2632-2153/ab891b
 *  - TFPR: https://github.com/merckgroup/aidd_tfpr
 *  - colourdle: https://github.com/aebrer/colourdle
 */

import type { QueryType } from "./query-classifier.js";
import { METRIC_NAMES, type MetricName, type MetricScores } from "./types.js";

// ============================================================================
// Public types
// ============================================================================

export interface RankedCandidate {
	id: number;
	scores: MetricScores;
	rank: number;
}

// ============================================================================
// Column duplication config per query type
// ============================================================================

/** How many times each metric column appears in the objectives matrix. */
type ColumnWeights = Record<MetricName, number>;

const COLUMN_WEIGHTS: Record<QueryType, ColumnWeights> = {
	identifier: {
		bm25: 2,
		cosine: 1,
		pathMatch: 1,
		symbolMatch: 2,
		importGraph: 1,
		gitRecency: 1,
	},
	natural_language: {
		bm25: 1,
		cosine: 2,
		pathMatch: 1,
		symbolMatch: 1,
		importGraph: 1,
		gitRecency: 1,
	},
	path_like: {
		bm25: 1,
		cosine: 1,
		pathMatch: 3,
		symbolMatch: 1,
		importGraph: 1,
		gitRecency: 1,
	},
};

// ============================================================================
// Fitness smoothing constant (avoids division by zero)
// ============================================================================

const EPSILON = 0.05;

// ============================================================================
// Pruning
// ============================================================================

/**
 * Per-metric top-K pruning → union of surviving candidate IDs.
 */
function pruneTopK(candidates: Map<number, MetricScores>, topK: number): Set<number> {
	if (candidates.size <= topK) {
		return new Set(candidates.keys());
	}

	const union = new Set<number>();

	for (const metric of METRIC_NAMES) {
		const pairs: Array<[number, number]> = [];
		for (const [id, scores] of candidates) {
			pairs.push([id, scores[metric] ?? 0]);
		}
		pairs.sort((a, b) => b[1] - a[1]);
		const limit = Math.min(topK, pairs.length);
		for (let i = 0; i < limit; i++) {
			union.add(pairs[i][0]);
		}
	}

	return union;
}

// ============================================================================
// Dominance matrix computation
// ============================================================================

/**
 * Build the dominance count matrix using the TFPR approach.
 *
 * For each objective (metric), sorts candidates and accumulates pairwise
 * dominance: if candidate i ranks above candidate j on an objective,
 * dominanceCounts[i][j] increases by the column weight.
 *
 * Duplicate columns (from column duplication) are handled by multiplying
 * the contribution by the weight rather than re-sorting — same result,
 * no redundant work.
 *
 * Uses Uint16Array to keep memory compact (max possible value per cell
 * is the sum of all weights, which is ≤ 10).
 *
 * @param scores  Dense array of MetricScores, indexed 0..n-1
 * @param weights Column weights from query type
 * @param topK    Only top-K per objective contribute to pairwise dominance
 * @returns Flat dominance count matrix [n × n] and the total weight sum
 */
function buildDominanceCounts(
	scores: MetricScores[],
	weights: ColumnWeights,
	topK: number,
): [counts: Uint16Array, totalWeight: number] {
	const n = scores.length;
	const counts = new Uint16Array(n * n);
	let totalWeight = 0;

	// Reusable index array for sorting
	const indices = new Array<number>(n);
	for (let i = 0; i < n; i++) indices[i] = i;

	for (const metric of METRIC_NAMES) {
		const weight = weights[metric];
		if (weight === 0) continue;
		totalWeight += weight;

		// Sort candidates by this metric (descending)
		const sorted = indices.slice();
		sorted.sort((a, b) => (scores[b][metric] ?? 0) - (scores[a][metric] ?? 0));

		// Only consider top-K for pairwise dominance
		const k = Math.min(topK, n);

		// For each pair in the top-K where i ranks above j:
		// i dominates j on this objective → add weight to counts[i, j]
		for (let ri = 0; ri < k; ri++) {
			const i = sorted[ri];
			const iBase = i * n;
			for (let rj = ri + 1; rj < k; rj++) {
				counts[iBase + sorted[rj]] += weight;
			}
		}
	}

	return [counts, totalWeight];
}

/**
 * Compute fitness scores from the dominance count matrix.
 *
 * Fitness = meanDominance × (numDominating + ε) / (numSubmitting + ε)
 *
 * Where:
 *  - meanDominance = average normalized dominance across all other candidates
 *  - numDominating = count of candidates this one dominates (>50% of objectives)
 *  - numSubmitting = count of candidates this one fails to dominate (<50%)
 */
function computeFitness(counts: Uint16Array, n: number, totalWeight: number): Float64Array {
	const fitness = new Float64Array(n);
	const threshold = totalWeight * 0.5;

	for (let i = 0; i < n; i++) {
		let sumDom = 0;
		let numDominating = 0;
		let numSubmitting = 0;
		const iBase = i * n;

		for (let j = 0; j < n; j++) {
			if (i === j) continue;
			const count = counts[iBase + j];
			sumDom += count;
			if (count > threshold) numDominating++;
			if (count < threshold) numSubmitting++;
		}

		const meanDom = n > 1 ? sumDom / ((n - 1) * totalWeight) : 0;
		fitness[i] = (meanDom * (numDominating + EPSILON)) / (numSubmitting + EPSILON);
	}

	return fitness;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Rank candidates using POEM / TFPR.
 *
 * @param candidates Map of candidateId → MetricScores (all values 0–1)
 * @param queryType  Query type for column duplication weighting
 * @param topK       Per-metric pruning limit (default: 1000)
 * @returns Candidates ordered best-first with assigned ranks (0 = best)
 */
export function poemRank(candidates: Map<number, MetricScores>, queryType: QueryType, topK = 1000): RankedCandidate[] {
	if (candidates.size === 0) return [];

	// 1. Prune: per-metric top-K → union
	const surviving = pruneTopK(candidates, topK);

	// 2. Build dense arrays
	const ids: number[] = [];
	const scores: MetricScores[] = [];

	for (const id of surviving) {
		const s = candidates.get(id)!;
		ids.push(id);
		scores.push({
			bm25: s.bm25 ?? 0,
			cosine: s.cosine ?? 0,
			pathMatch: s.pathMatch ?? 0,
			symbolMatch: s.symbolMatch ?? 0,
			importGraph: s.importGraph ?? 0,
			gitRecency: s.gitRecency ?? 0,
		});
	}

	const n = ids.length;

	// Single candidate → rank 0
	if (n === 1) {
		return [{ id: ids[0], scores: scores[0], rank: 0 }];
	}

	// 3. Compute dominance matrix with column duplication
	const weights = COLUMN_WEIGHTS[queryType];
	const [counts, totalWeight] = buildDominanceCounts(scores, weights, topK);

	// 4. Compute fitness scores
	const fitness = computeFitness(counts, n, totalWeight);

	// 5. Sort by fitness (descending) and assign ranks
	const order = new Array<number>(n);
	for (let i = 0; i < n; i++) order[i] = i;
	order.sort((a, b) => fitness[b] - fitness[a]);

	return order.map((idx, rank) => ({
		id: ids[idx],
		scores: scores[idx],
		rank,
	}));
}
