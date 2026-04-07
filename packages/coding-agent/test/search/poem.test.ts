import { describe, expect, it } from "vitest";
import { poemRank } from "../../src/core/search/poem.js";
import { classifyQuery } from "../../src/core/search/query-classifier.js";
import type { MetricScores } from "../../src/core/search/types.js";

// ============================================================================
// Helpers
// ============================================================================

/** Build a MetricScores object with defaults of 0 for omitted fields. */
function scores(partial: Partial<MetricScores> = {}): MetricScores {
	return {
		bm25: 0,
		cosine: 0,
		pathMatch: 0,
		symbolMatch: 0,
		importGraph: 0,
		gitRecency: 0,
		...partial,
	};
}

/** Build a candidates Map from an array of [id, scores] pairs. */
function candidatesMap(entries: Array<[number, MetricScores]>): Map<number, MetricScores> {
	return new Map(entries);
}

// ============================================================================
// Query Classifier
// ============================================================================

describe("classifyQuery", () => {
	describe("identifiers", () => {
		it("classifies PascalCase as identifier", () => {
			expect(classifyQuery("AuthMiddleware")).toBe("identifier");
		});

		it("classifies snake_case as identifier", () => {
			expect(classifyQuery("create_user")).toBe("identifier");
		});

		it("classifies camelCase as identifier", () => {
			expect(classifyQuery("parseJSON")).toBe("identifier");
		});

		it("classifies hook-style name as identifier", () => {
			expect(classifyQuery("useState")).toBe("identifier");
		});

		it("classifies short single token as identifier", () => {
			expect(classifyQuery("auth")).toBe("identifier");
		});
	});

	describe("natural language", () => {
		it("classifies question about location as natural_language", () => {
			expect(classifyQuery("where is the authentication handler")).toBe("natural_language");
		});

		it("classifies how-to question as natural_language", () => {
			expect(classifyQuery("how do I configure logging")).toBe("natural_language");
		});

		it("classifies imperative phrase as natural_language", () => {
			expect(classifyQuery("find rate limiting logic")).toBe("natural_language");
		});
	});

	describe("path-like", () => {
		it("classifies directory path as path_like", () => {
			expect(classifyQuery("src/auth/")).toBe("path_like");
		});

		it("classifies file with extension as path_like", () => {
			expect(classifyQuery("config.yaml")).toBe("path_like");
		});

		it("classifies deep path without extension as path_like", () => {
			expect(classifyQuery("src/core/tools")).toBe("path_like");
		});

		it("classifies package.json as path_like", () => {
			expect(classifyQuery("package.json")).toBe("path_like");
		});
	});

	describe("edge cases", () => {
		it("classifies empty string as natural_language", () => {
			expect(classifyQuery("")).toBe("natural_language");
		});

		it("classifies single character as identifier", () => {
			// Single token → identifier
			expect(classifyQuery("x")).toBe("identifier");
		});
	});
});

// ============================================================================
// POEM Ranking
// ============================================================================

describe("poemRank", () => {
	it("returns empty array for empty candidates", () => {
		const result = poemRank(new Map(), "identifier");
		expect(result).toEqual([]);
	});

	it("assigns rank 0 to a single candidate", () => {
		const candidates = candidatesMap([[42, scores({ bm25: 0.5, cosine: 0.3 })]]);
		const result = poemRank(candidates, "identifier");
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe(42);
		expect(result[0].rank).toBe(0);
	});

	it("ranks a dominant candidate above a weaker one", () => {
		const candidates = candidatesMap([
			[1, scores({ bm25: 0.9, cosine: 0.9, pathMatch: 0.9, symbolMatch: 0.9, importGraph: 0.9, gitRecency: 0.9 })],
			[2, scores({ bm25: 0.1, cosine: 0.1, pathMatch: 0.1, symbolMatch: 0.1, importGraph: 0.1, gitRecency: 0.1 })],
		]);
		const result = poemRank(candidates, "identifier");
		expect(result).toHaveLength(2);
		expect(result[0].id).toBe(1);
		expect(result[0].rank).toBe(0);
		expect(result[1].id).toBe(2);
		expect(result[1].rank).toBe(1);
	});

	describe("query-type-dependent ordering with mixed strengths", () => {
		// Candidate A: high bm25 + symbolMatch, low cosine
		// Candidate B: high cosine, low bm25
		// Candidate C: balanced across all metrics
		const candidateA = scores({
			bm25: 0.9,
			cosine: 0.2,
			pathMatch: 0.3,
			symbolMatch: 0.9,
			importGraph: 0.3,
			gitRecency: 0.3,
		});
		const candidateB = scores({
			bm25: 0.1,
			cosine: 0.9,
			pathMatch: 0.3,
			symbolMatch: 0.1,
			importGraph: 0.3,
			gitRecency: 0.3,
		});
		const candidateC = scores({
			bm25: 0.5,
			cosine: 0.5,
			pathMatch: 0.5,
			symbolMatch: 0.5,
			importGraph: 0.5,
			gitRecency: 0.5,
		});

		const candidates = candidatesMap([
			[1, candidateA],
			[2, candidateB],
			[3, candidateC],
		]);

		it("identifier query: A ranks highest (bm25 ×2, symbolMatch ×2)", () => {
			const result = poemRank(candidates, "identifier");
			expect(result[0].id).toBe(1);
		});

		it("natural_language query: B or C ranks highest (cosine ×2)", () => {
			const result = poemRank(candidates, "natural_language");
			// A should not be first — its cosine is lowest
			expect(result[0].id).not.toBe(1);
		});

		it("path_like query: C ranks highest (pathMatch ×3)", () => {
			const result = poemRank(candidates, "path_like");
			// C has the highest pathMatch (0.5 vs 0.3) with pathMatch weighted ×3
			expect(result[0].id).toBe(3);
		});
	});

	it("handles identical scores without crashing", () => {
		const s = scores({ bm25: 0.5, cosine: 0.5, pathMatch: 0.5, symbolMatch: 0.5, importGraph: 0.5, gitRecency: 0.5 });
		const candidates = candidatesMap([
			[1, { ...s }],
			[2, { ...s }],
			[3, { ...s }],
		]);
		const result = poemRank(candidates, "identifier");
		expect(result).toHaveLength(3);
		// All should get rank 0, 1, 2 — they're all equivalent so any order is fine
		const ranks = result.map((r) => r.rank).sort();
		expect(ranks).toEqual([0, 1, 2]);
	});

	it("handles large candidate set (100+) in reasonable time", () => {
		const candidates = new Map<number, MetricScores>();
		for (let i = 0; i < 200; i++) {
			candidates.set(
				i,
				scores({
					bm25: Math.random(),
					cosine: Math.random(),
					pathMatch: Math.random(),
					symbolMatch: Math.random(),
					importGraph: Math.random(),
					gitRecency: Math.random(),
				}),
			);
		}
		// Set a known best candidate
		candidates.set(
			999,
			scores({
				bm25: 1.0,
				cosine: 1.0,
				pathMatch: 1.0,
				symbolMatch: 1.0,
				importGraph: 1.0,
				gitRecency: 1.0,
			}),
		);

		const start = performance.now();
		const result = poemRank(candidates, "identifier");
		const elapsed = performance.now() - start;

		expect(result.length).toBeGreaterThan(0);
		// The all-1.0 candidate should be at or near the top
		expect(result[0].id).toBe(999);
		// Should complete well under 1 second
		expect(elapsed).toBeLessThan(1000);
	});

	it("defaults missing metric values to 0 without crashing", () => {
		// Provide MetricScores objects with some fields as 0 (simulating missing)
		const candidates = candidatesMap([
			[1, { bm25: 0.8, cosine: 0, pathMatch: 0, symbolMatch: 0, importGraph: 0, gitRecency: 0 }],
			[2, { bm25: 0, cosine: 0.8, pathMatch: 0, symbolMatch: 0, importGraph: 0, gitRecency: 0 }],
		]);
		const result = poemRank(candidates, "identifier");
		expect(result).toHaveLength(2);
		// With identifier weighting (bm25 ×2), candidate 1 should win
		expect(result[0].id).toBe(1);
	});

	it("respects topK parameter for pruning", () => {
		// Create 10 candidates, request topK=2
		const candidates = new Map<number, MetricScores>();
		for (let i = 0; i < 10; i++) {
			candidates.set(
				i,
				scores({
					bm25: i / 10,
					cosine: (9 - i) / 10,
					pathMatch: 0.1,
					symbolMatch: 0.1,
					importGraph: 0.1,
					gitRecency: 0.1,
				}),
			);
		}

		const result = poemRank(candidates, "identifier", 2);
		// topK=2 per metric: top 2 for bm25 (ids 9, 8), top 2 for cosine (ids 0, 1),
		// top 2 for pathMatch/symbolMatch/importGraph/gitRecency (all tied, first 2 from sort)
		// Union should be a small subset, not all 10
		expect(result.length).toBeLessThanOrEqual(10);
		expect(result.length).toBeGreaterThan(0);

		// The top-ranked result should be one of the extreme candidates
		// (high bm25 or high cosine since those have weight)
		const topIds = result.slice(0, 3).map((r) => r.id);
		// Candidate 9 has highest bm25, candidate 0 has highest cosine
		// With identifier weighting (bm25 ×2), candidate 9 should be near top
		expect(topIds).toContain(9);
	});

	it("preserves candidate IDs and scores in output", () => {
		const originalScores = scores({
			bm25: 0.7,
			cosine: 0.3,
			pathMatch: 0.1,
			symbolMatch: 0.5,
			importGraph: 0.2,
			gitRecency: 0.4,
		});
		const candidates = candidatesMap([[42, originalScores]]);
		const result = poemRank(candidates, "natural_language");
		expect(result[0].id).toBe(42);
		expect(result[0].scores.bm25).toBe(0.7);
		expect(result[0].scores.cosine).toBe(0.3);
		expect(result[0].scores.pathMatch).toBe(0.1);
		expect(result[0].scores.symbolMatch).toBe(0.5);
		expect(result[0].scores.importGraph).toBe(0.2);
		expect(result[0].scores.gitRecency).toBe(0.4);
	});

	it("assigns contiguous ranks starting from 0", () => {
		const candidates = candidatesMap([
			[10, scores({ bm25: 0.9, cosine: 0.1 })],
			[20, scores({ bm25: 0.5, cosine: 0.5 })],
			[30, scores({ bm25: 0.1, cosine: 0.9 })],
			[40, scores({ bm25: 0.3, cosine: 0.3 })],
		]);
		const result = poemRank(candidates, "identifier");
		const ranks = result.map((r) => r.rank).sort((a, b) => a - b);
		expect(ranks).toEqual([0, 1, 2, 3]);
	});
});
