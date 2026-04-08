import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SearchEngine } from "../src/search.js";
import type { MetricScores } from "../src/types.js";

// Mock the embedder to avoid downloading the ONNX model (~23MB).
// Returns zero-vectors so cosine scores are 0, but all other 5 metrics still work.
// Tracks initialize() calls so concurrency tests can verify single-initialization.
let mockInitializeCallCount = 0;
let mockInitializeFailNext = false;

function resetMockEmbedder(): void {
	mockInitializeCallCount = 0;
	mockInitializeFailNext = false;
}

vi.mock("../src/embedder.js", () => ({
	Embedder: class MockEmbedder {
		async initialize() {
			mockInitializeCallCount++;
			if (mockInitializeFailNext) {
				mockInitializeFailNext = false;
				throw new Error("Mock initialization failure");
			}
		}
		async embedQuery(_query: string) {
			return new Float32Array(384);
		}
		async embedDocuments(texts: string[]) {
			return texts.map(() => new Float32Array(384));
		}
		dispose() {}
	},
}));

// ============================================================================
// Fixture project
// ============================================================================

const FIXTURE_FILES: Record<string, string> = {
	"src/auth/middleware.ts": `
export class AuthMiddleware {
  async handle(req: Request): Promise<Response> {
    const token = req.headers.get('authorization');
    if (!token) return new Response('Unauthorized', { status: 401 });
    return this.next(req);
  }
  private next(req: Request): Promise<Response> {
    return fetch(req);
  }
}
`,
	"src/auth/handler.ts": `
import { AuthMiddleware } from './middleware';

export function createAuthHandler() {
  const middleware = new AuthMiddleware();
  return middleware;
}
`,
	"src/utils/helpers.ts": `
export function formatDate(date: Date): string {
  return date.toISOString();
}

export function parseJSON(text: string): unknown {
  return JSON.parse(text);
}
`,
	"src/utils/logger.ts": `
export class Logger {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  info(message: string): void {
    console.log(\`[\${this.prefix}] \${message}\`);
  }

  error(message: string): void {
    console.error(\`[\${this.prefix}] ERROR: \${message}\`);
  }
}
`,
	"src/index.ts": `
import { AuthMiddleware } from './auth/middleware';
import { Logger } from './utils/logger';

export { AuthMiddleware, Logger };
`,
};

function createFixtureProject(dir: string): void {
	for (const [relPath, content] of Object.entries(FIXTURE_FILES)) {
		const absPath = path.join(dir, relPath);
		mkdirSync(path.dirname(absPath), { recursive: true });
		writeFileSync(absPath, content, "utf-8");
	}
}

// ============================================================================
// Tests
// ============================================================================

describe("SearchEngine.search()", () => {
	let tmpDir: string;
	let engine: SearchEngine;

	beforeAll(() => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "dreb-search-engine-test-"));
		createFixtureProject(tmpDir);
		engine = new SearchEngine(tmpDir);
	});

	afterAll(() => {
		engine.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// ================================================================
	// 1. Identifier query
	// ================================================================

	it("returns results for an identifier query", async () => {
		const results = await engine.search("AuthMiddleware");

		expect(results.length).toBeGreaterThan(0);

		const filePaths = results.map((r) => r.chunk.filePath);
		expect(filePaths).toContain("src/auth/middleware.ts");
	});

	// ================================================================
	// 2. Natural language query
	// ================================================================

	it("returns results for a natural language query", async () => {
		const results = await engine.search("where is authentication handled");

		expect(results.length).toBeGreaterThan(0);

		// Auth files should appear in results — at least one should be near the top
		const topFilePaths = results.slice(0, 5).map((r) => r.chunk.filePath);
		const hasAuthFile = topFilePaths.some((fp) => fp.startsWith("src/auth/"));
		expect(hasAuthFile).toBe(true);
	});

	// ================================================================
	// 3. Path-like query
	// ================================================================

	it("returns results for a path-like query", async () => {
		const results = await engine.search("src/auth/");

		expect(results.length).toBeGreaterThan(0);

		// Results should include files from the auth directory
		const filePaths = results.map((r) => r.chunk.filePath);
		const authFiles = filePaths.filter((fp) => fp.startsWith("src/auth/"));
		expect(authFiles.length).toBeGreaterThan(0);
	});

	// ================================================================
	// 4. Respects limit option
	// ================================================================

	it("respects the limit option", async () => {
		const results = await engine.search("AuthMiddleware", { limit: 1 });

		expect(results.length).toBe(1);
	});

	// ================================================================
	// 5. pathFilter restricts to a subdirectory
	// ================================================================

	it("pathFilter restricts results to matching paths", async () => {
		const results = await engine.search("function", { pathFilter: "src/utils" });

		expect(results.length).toBeGreaterThan(0);

		// Every result must be under src/utils
		for (const r of results) {
			expect(r.chunk.filePath).toMatch(/^src\/utils\//);
		}
	});

	// ================================================================
	// 6. Gibberish query returns empty or low-scoring results
	// ================================================================

	it("returns empty or low-scoring results for a gibberish query", async () => {
		const results = await engine.search("zxqwkjfds");

		// Either no results, or all results have very low combined scores
		if (results.length > 0) {
			for (const r of results) {
				const { bm25, pathMatch, symbolMatch } = r.scores;
				// BM25, path-match, and symbol-match should all be 0 for gibberish
				expect(bm25 + pathMatch + symbolMatch).toBeLessThanOrEqual(0.1);
			}
		}
	});

	// ================================================================
	// 7. Results have the correct shape
	// ================================================================

	it("returns results with the correct shape", async () => {
		const results = await engine.search("Logger");

		expect(results.length).toBeGreaterThan(0);

		for (const result of results) {
			// chunk
			expect(result.chunk).toBeDefined();
			expect(typeof result.chunk.id).toBe("number");
			expect(typeof result.chunk.fileId).toBe("number");
			expect(typeof result.chunk.filePath).toBe("string");
			expect(typeof result.chunk.startLine).toBe("number");
			expect(typeof result.chunk.endLine).toBe("number");
			expect(typeof result.chunk.kind).toBe("string");
			expect(typeof result.chunk.content).toBe("string");
			expect(typeof result.chunk.fileType).toBe("string");

			// scores — all 6 metrics present and numeric
			expect(result.scores).toBeDefined();
			const metricNames: (keyof MetricScores)[] = [
				"bm25",
				"cosine",
				"pathMatch",
				"symbolMatch",
				"importGraph",
				"gitRecency",
			];
			for (const metric of metricNames) {
				expect(typeof result.scores[metric]).toBe("number");
				expect(result.scores[metric]).toBeGreaterThanOrEqual(0);
				expect(result.scores[metric]).toBeLessThanOrEqual(1);
			}

			// rank
			expect(typeof result.rank).toBe("number");
			expect(result.rank).toBeGreaterThanOrEqual(0);
		}
	});

	// ================================================================
	// 8. Subsequent searches reuse the index (no crash, fast)
	// ================================================================

	it("subsequent searches reuse the cached index", async () => {
		// First search already built the index in prior tests.
		// This just verifies the second search doesn't fail or re-build from scratch.
		const t0 = performance.now();
		const results = await engine.search("formatDate");
		const elapsed = performance.now() - t0;

		expect(results.length).toBeGreaterThan(0);

		const filePaths = results.map((r) => r.chunk.filePath);
		expect(filePaths).toContain("src/utils/helpers.ts");

		// Cached search on a tiny project should be fast (well under 5s).
		// The initial build is already done by previous tests.
		expect(elapsed).toBeLessThan(5000);
	});

	// ================================================================
	// 9. pathFilter works for auth subdirectory
	// ================================================================

	it("pathFilter limits results to the auth directory", async () => {
		const results = await engine.search("handler", { pathFilter: "src/auth" });

		expect(results.length).toBeGreaterThan(0);

		for (const r of results) {
			expect(r.chunk.filePath).toMatch(/^src\/auth\//);
		}
	});

	// ================================================================
	// 10. Empty pathFilter returns no results if no files match
	// ================================================================

	it("returns empty results when pathFilter matches no files", async () => {
		const results = await engine.search("AuthMiddleware", { pathFilter: "nonexistent/dir" });

		expect(results).toEqual([]);
	});

	// ================================================================
	// 11. close() is safe to call and engine is unusable after
	// ================================================================

	it("close() disposes resources without throwing", () => {
		// Create a separate engine to avoid breaking subsequent tests
		const separateEngine = new SearchEngine(tmpDir);
		expect(() => separateEngine.close()).not.toThrow();
	});

	// ================================================================
	// 12. Concurrent search calls
	// ================================================================

	describe("concurrent search calls", () => {
		let concurrentDir: string;
		let concurrentEngine: SearchEngine;

		beforeAll(() => {
			concurrentDir = mkdtempSync(path.join(tmpdir(), "dreb-search-concurrent-"));
			createFixtureProject(concurrentDir);
			resetMockEmbedder();
			concurrentEngine = new SearchEngine(concurrentDir);
		});

		afterAll(() => {
			concurrentEngine.close();
			rmSync(concurrentDir, { recursive: true, force: true });
		});

		it("multiple concurrent search calls all succeed", async () => {
			// Fire 5 concurrent searches on the same engine
			const queries = ["AuthMiddleware", "Logger", "formatDate", "handler", "src/auth/"];
			const promises = queries.map((q) => concurrentEngine.search(q));
			const results = await Promise.all(promises);

			// Every search should return results
			for (let i = 0; i < queries.length; i++) {
				expect(results[i].length).toBeGreaterThan(0);
			}
		});

		it("embedder is initialized exactly once across concurrent searches", () => {
			// After the 5 concurrent searches above, the embedder should have been
			// initialized exactly once — the promise coalescing ensures all callers
			// share the same initialization.
			expect(mockInitializeCallCount).toBe(1);
		});

		it("concurrent searches produce valid result shapes", async () => {
			const promises = ["AuthMiddleware", "Logger"].map((q) => concurrentEngine.search(q));
			const results = await Promise.all(promises);

			for (const resultSet of results) {
				for (const result of resultSet) {
					expect(result.chunk).toBeDefined();
					expect(typeof result.chunk.filePath).toBe("string");
					expect(typeof result.rank).toBe("number");
					expect(result.scores).toBeDefined();
				}
			}
		});
	});

	// ================================================================
	// 13. Failure retry — embedder initialization
	// ================================================================

	describe("embedder initialization failure retry", () => {
		let retryDir: string;
		let retryEngine: SearchEngine;

		beforeAll(() => {
			retryDir = mkdtempSync(path.join(tmpdir(), "dreb-search-retry-"));
			createFixtureProject(retryDir);
		});

		afterAll(() => {
			retryEngine?.close();
			rmSync(retryDir, { recursive: true, force: true });
		});

		it("retries successfully after initialization failure", async () => {
			resetMockEmbedder();
			retryEngine = new SearchEngine(retryDir);

			// First search — embedder init will fail
			mockInitializeFailNext = true;
			await expect(retryEngine.search("AuthMiddleware")).rejects.toThrow("Mock initialization failure");

			// Second search — should retry and succeed (promise was reset)
			const results = await retryEngine.search("AuthMiddleware");
			expect(results.length).toBeGreaterThan(0);

			// initialize() was called twice: once failed, once succeeded
			expect(mockInitializeCallCount).toBe(2);
		});
	});
});
