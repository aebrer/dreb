import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SearchDatabase } from "../../src/core/search/db.js";
import { computeBm25Scores } from "../../src/core/search/metrics/bm25.js";
import { computeGitRecencyScores } from "../../src/core/search/metrics/git-recency.js";
import { computeImportGraphScores } from "../../src/core/search/metrics/import-graph.js";
import { computePathMatchScores } from "../../src/core/search/metrics/path-match.js";
import { computeSymbolMatchScores } from "../../src/core/search/metrics/symbol-match.js";
import { tokenize } from "../../src/core/search/metrics/tokenize.js";
import type { StoredChunk } from "../../src/core/search/types.js";

/** Helper to build a minimal StoredChunk for testing. */
const chunk = (id: number, filePath: string, fileId = 1): StoredChunk => ({
	id,
	fileId,
	filePath,
	startLine: 1,
	endLine: 10,
	kind: "function" as const,
	name: "test",
	content: "test content",
	fileType: "typescript" as const,
});

// ============================================================================
// tokenize
// ============================================================================

describe("tokenize", () => {
	it("splits camelCase identifiers", () => {
		expect(tokenize("getUserName")).toEqual(["get", "user", "name"]);
	});

	it("splits PascalCase identifiers", () => {
		expect(tokenize("AuthMiddleware")).toEqual(["auth", "middleware"]);
	});

	it("splits snake_case identifiers", () => {
		expect(tokenize("create_user")).toEqual(["create", "user"]);
	});

	it("splits SCREAMING_SNAKE_CASE identifiers", () => {
		expect(tokenize("MAX_RETRY_COUNT")).toEqual(["max", "retry", "count"]);
	});

	it("splits file paths on separators", () => {
		expect(tokenize("src/auth/middleware.ts")).toEqual(["src", "auth", "middleware", "ts"]);
	});

	it("splits dotted names", () => {
		expect(tokenize("com.example.Foo")).toEqual(["com", "example", "foo"]);
	});

	it("deduplicates tokens", () => {
		const result = tokenize("foo_foo_bar");
		expect(result).toEqual(["foo", "bar"]);
	});

	it("filters tokens shorter than 2 chars", () => {
		// "a" and "b" are 1 char → filtered out
		const result = tokenize("a_b_hello");
		expect(result).toEqual(["hello"]);
	});

	it("returns empty array for empty string", () => {
		expect(tokenize("")).toEqual([]);
	});

	it("handles uppercase abbreviation followed by word (XMLParser)", () => {
		expect(tokenize("XMLParser")).toEqual(["xml", "parser"]);
	});

	it("handles kebab-case", () => {
		expect(tokenize("my-component-name")).toEqual(["my", "component", "name"]);
	});

	it("handles mixed delimiters", () => {
		const result = tokenize("src/utils_stringHelpers.parse-json");
		expect(result).toEqual(["src", "utils", "string", "helpers", "parse", "json"]);
	});
});

// ============================================================================
// computePathMatchScores
// ============================================================================

describe("computePathMatchScores", () => {
	it("returns empty map for empty query", () => {
		const chunks = [chunk(1, "src/foo.ts")];
		const scores = computePathMatchScores("", chunks);
		expect(scores.size).toBe(0);
	});

	it("returns empty map for empty chunks", () => {
		const scores = computePathMatchScores("auth middleware", []);
		expect(scores.size).toBe(0);
	});

	it("scores higher for exact path token matches", () => {
		const chunks = [chunk(1, "src/auth/middleware.ts"), chunk(2, "src/utils/helpers.ts")];
		const scores = computePathMatchScores("auth middleware", chunks);
		// chunk 1 matches both "auth" and "middleware", chunk 2 matches neither
		expect(scores.get(1)).toBeDefined();
		expect(scores.has(2)).toBe(false);
	});

	it("normalizes scores to [0, 1]", () => {
		const chunks = [
			chunk(1, "src/auth/middleware.ts"),
			chunk(2, "src/auth/handler.ts"),
			chunk(3, "src/utils/helpers.ts"),
		];
		const scores = computePathMatchScores("auth middleware handler", chunks);
		for (const score of scores.values()) {
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(1);
		}
		// The chunk matching the most tokens should get score 1 after normalization
		const maxScore = Math.max(...scores.values());
		expect(maxScore).toBe(1);
	});

	it("uses path token cache — same file path gives same score for different chunks", () => {
		const chunks = [chunk(1, "src/auth/middleware.ts", 1), chunk(2, "src/auth/middleware.ts", 1)];
		const scores = computePathMatchScores("auth", chunks);
		expect(scores.get(1)).toBe(scores.get(2));
	});

	it("returns empty map when query tokens don't match any path", () => {
		const chunks = [chunk(1, "src/utils/helpers.ts")];
		const scores = computePathMatchScores("zebra", chunks);
		expect(scores.size).toBe(0);
	});
});

// ============================================================================
// computeSymbolMatchScores
// ============================================================================

describe("computeSymbolMatchScores", () => {
	it("returns empty map for empty query", () => {
		const symbols = new Map<number, string[]>([[1, ["getUser"]]]);
		const scores = computeSymbolMatchScores("", symbols);
		expect(scores.size).toBe(0);
	});

	it("returns empty map for empty symbols", () => {
		const scores = computeSymbolMatchScores("getUser", new Map());
		expect(scores.size).toBe(0);
	});

	it("gives exact substring match a bonus", () => {
		const symbols = new Map<number, string[]>([
			[1, ["getUserName"]],
			[2, ["setUserName"]],
		]);
		// "getUserName" is an exact substring of the symbol for chunk 1
		const scores = computeSymbolMatchScores("getUserName", symbols);
		const score1 = scores.get(1) ?? 0;
		const score2 = scores.get(2) ?? 0;
		// chunk 1 should score higher due to exact substring bonus
		expect(score1).toBeGreaterThan(score2);
	});

	it("scores token overlap correctly", () => {
		const symbols = new Map<number, string[]>([
			[1, ["createUser"]],
			[2, ["deleteUser"]],
		]);
		const scores = computeSymbolMatchScores("create user handler", symbols);
		const score1 = scores.get(1) ?? 0;
		const score2 = scores.get(2) ?? 0;
		// chunk 1 has 2/3 tokens matching ("create", "user"), chunk 2 has 1/3 ("user")
		expect(score1).toBeGreaterThan(score2);
	});

	it("normalizes scores to [0, 1]", () => {
		const symbols = new Map<number, string[]>([
			[1, ["parseJSON"]],
			[2, ["formatXML"]],
			[3, ["validateInput"]],
		]);
		const scores = computeSymbolMatchScores("parse json format", symbols);
		for (const score of scores.values()) {
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(1);
		}
	});

	it("picks the best score from multiple symbol names per chunk", () => {
		const symbols = new Map<number, string[]>([[1, ["unrelatedName", "getUserById"]]]);
		const scores = computeSymbolMatchScores("getUserById", symbols);
		// Should match the second symbol name, not be dragged down by the first
		expect(scores.get(1)).toBeDefined();
		expect(scores.get(1)!).toBeGreaterThan(0.5);
	});

	it("gives reverse substring bonus when symbol appears in query", () => {
		const symbols = new Map<number, string[]>([[1, ["auth"]]]);
		// "auth" (length >= 3) appears in the query → reverse substring bonus
		const scores = computeSymbolMatchScores("where is auth handled", symbols);
		expect(scores.get(1)).toBeDefined();
		expect(scores.get(1)!).toBeGreaterThan(0);
	});
});

// ============================================================================
// computeGitRecencyScores
// ============================================================================

describe("computeGitRecencyScores", () => {
	it("returns empty map for empty chunks", () => {
		const scores = computeGitRecencyScores("/tmp", []);
		expect(scores.size).toBe(0);
	});

	it("assigns neutral score (0.5) when git is unavailable", () => {
		// Create a temp dir that is NOT a git repo
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
		try {
			const chunks = [chunk(1, "nonexistent/file.ts")];
			const scores = computeGitRecencyScores(tmpDir, chunks);
			expect(scores.get(1)).toBe(0.5);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns valid scores in [0, 1] for a real git repo", () => {
		// Use the dreb repo itself as the real git repo
		const projectRoot = path.resolve(__dirname, "../../../..");
		const chunks = [chunk(1, "package.json"), chunk(2, "README.md")];
		const scores = computeGitRecencyScores(projectRoot, chunks);
		for (const score of scores.values()) {
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(1);
		}
	});

	it("assigns neutral score to files not tracked by git", () => {
		const projectRoot = path.resolve(__dirname, "../../../..");
		const chunks = [chunk(1, "package.json"), chunk(2, "this-file-definitely-does-not-exist-xyz.ts")];
		const scores = computeGitRecencyScores(projectRoot, chunks);
		// The untracked file should get the neutral score 0.5
		expect(scores.get(2)).toBe(0.5);
	});
});

// ============================================================================
// computeImportGraphScores
// ============================================================================

describe("computeImportGraphScores", () => {
	let db: SearchDatabase;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dreb-import-test-"));
		db = new SearchDatabase(path.join(tmpDir, "index.db"));
	});

	afterEach(() => {
		db.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty map when seedScores is empty", () => {
		const scores = computeImportGraphScores(db, new Map(), new Map());
		expect(scores.size).toBe(0);
	});

	it("returns empty map when no import edges exist", () => {
		const fA = db.upsertFile("a.ts", 1, "typescript");
		const cA = db.insertChunk(fA, "a.ts", 1, 10, "function", "fnA", "code a", "typescript");

		const seedScores = new Map([[fA, 1.0]]);
		const fileIdToChunkIds = new Map([[fA, [cA]]]);

		const scores = computeImportGraphScores(db, seedScores, fileIdToChunkIds);
		expect(scores.size).toBe(0);
	});

	it("propagates scores to imported files", () => {
		// A imports B — A is a seed, B should get a propagated score
		const fA = db.upsertFile("a.ts", 1, "typescript");
		const fB = db.upsertFile("b.ts", 1, "typescript");
		const cA = db.insertChunk(fA, "a.ts", 1, 10, "function", "fnA", "code a", "typescript");
		const cB = db.insertChunk(fB, "b.ts", 1, 10, "function", "fnB", "code b", "typescript");
		db.insertImport(fA, "b.ts");

		const seedScores = new Map([[fA, 1.0]]);
		const fileIdToChunkIds = new Map([
			[fA, [cA]],
			[fB, [cB]],
		]);

		const scores = computeImportGraphScores(db, seedScores, fileIdToChunkIds);
		expect(scores.has(cB)).toBe(true);
		expect(scores.get(cB)!).toBeGreaterThan(0);
	});

	it("propagates scores to importers", () => {
		// C imports A — A is a seed, C should get a propagated score
		const fA = db.upsertFile("a.ts", 1, "typescript");
		const fC = db.upsertFile("c.ts", 1, "typescript");
		const cA = db.insertChunk(fA, "a.ts", 1, 10, "function", "fnA", "code a", "typescript");
		const cC = db.insertChunk(fC, "c.ts", 1, 10, "function", "fnC", "code c", "typescript");
		db.insertImport(fC, "a.ts");

		const seedScores = new Map([[fA, 1.0]]);
		const fileIdToChunkIds = new Map([
			[fA, [cA]],
			[fC, [cC]],
		]);

		const scores = computeImportGraphScores(db, seedScores, fileIdToChunkIds);
		expect(scores.has(cC)).toBe(true);
		expect(scores.get(cC)!).toBeGreaterThan(0);
	});

	it("self-boosts seed files connected to other seeds", () => {
		// A imports B, both are seeds → A gets a self-boost
		const fA = db.upsertFile("a.ts", 1, "typescript");
		const fB = db.upsertFile("b.ts", 1, "typescript");
		const cA = db.insertChunk(fA, "a.ts", 1, 10, "function", "fnA", "code a", "typescript");
		const cB = db.insertChunk(fB, "b.ts", 1, 10, "function", "fnB", "code b", "typescript");
		db.insertImport(fA, "b.ts");

		const seedScores = new Map([
			[fA, 1.0],
			[fB, 1.0],
		]);
		const fileIdToChunkIds = new Map([
			[fA, [cA]],
			[fB, [cB]],
		]);

		const scores = computeImportGraphScores(db, seedScores, fileIdToChunkIds);
		// A should receive a self-boost score
		expect(scores.has(cA)).toBe(true);
		expect(scores.get(cA)!).toBeGreaterThan(0);
	});

	it("normalizes scores to [0, 1]", () => {
		// A imports B and C; B and C are non-seeds
		const fA = db.upsertFile("a.ts", 1, "typescript");
		const fB = db.upsertFile("b.ts", 1, "typescript");
		const fC = db.upsertFile("c.ts", 1, "typescript");
		const cA = db.insertChunk(fA, "a.ts", 1, 10, "function", "fnA", "code a", "typescript");
		const cB = db.insertChunk(fB, "b.ts", 1, 10, "function", "fnB", "code b", "typescript");
		const cC = db.insertChunk(fC, "c.ts", 1, 10, "function", "fnC", "code c", "typescript");
		db.insertImport(fA, "b.ts");
		db.insertImport(fA, "c.ts");

		const seedScores = new Map([[fA, 1.0]]);
		const fileIdToChunkIds = new Map([
			[fA, [cA]],
			[fB, [cB]],
			[fC, [cC]],
		]);

		const scores = computeImportGraphScores(db, seedScores, fileIdToChunkIds);
		for (const score of scores.values()) {
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(1);
		}
		// At least one score should be exactly 1.0 (the max after normalization)
		const maxScore = Math.max(...scores.values());
		expect(maxScore).toBeCloseTo(1.0, 5);
	});

	it("distributes scores equally among chunks of the same file", () => {
		// A imports B; B has two chunks — both should get equal scores
		const fA = db.upsertFile("a.ts", 1, "typescript");
		const fB = db.upsertFile("b.ts", 1, "typescript");
		const cA = db.insertChunk(fA, "a.ts", 1, 10, "function", "fnA", "code a", "typescript");
		const cB1 = db.insertChunk(fB, "b.ts", 1, 10, "function", "fnB1", "code b1", "typescript");
		const cB2 = db.insertChunk(fB, "b.ts", 11, 20, "function", "fnB2", "code b2", "typescript");
		db.insertImport(fA, "b.ts");

		const seedScores = new Map([[fA, 1.0]]);
		const fileIdToChunkIds = new Map([
			[fA, [cA]],
			[fB, [cB1, cB2]],
		]);

		const scores = computeImportGraphScores(db, seedScores, fileIdToChunkIds);
		expect(scores.has(cB1)).toBe(true);
		expect(scores.has(cB2)).toBe(true);
		expect(scores.get(cB1)).toBe(scores.get(cB2));
	});

	it("handles extension-stripped import paths", () => {
		// A imports "b" (no extension), file is stored as "b.ts"
		const fA = db.upsertFile("a.ts", 1, "typescript");
		const fB = db.upsertFile("b.ts", 1, "typescript");
		const cA = db.insertChunk(fA, "a.ts", 1, 10, "function", "fnA", "code a", "typescript");
		const cB = db.insertChunk(fB, "b.ts", 1, 10, "function", "fnB", "code b", "typescript");
		db.insertImport(fA, "b"); // no extension

		const seedScores = new Map([[fA, 1.0]]);
		const fileIdToChunkIds = new Map([
			[fA, [cA]],
			[fB, [cB]],
		]);

		const scores = computeImportGraphScores(db, seedScores, fileIdToChunkIds);
		expect(scores.has(cB)).toBe(true);
		expect(scores.get(cB)!).toBeGreaterThan(0);
	});
});

// ============================================================================
// computeBm25Scores
// ============================================================================

describe("computeBm25Scores", () => {
	let db: SearchDatabase;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dreb-bm25-test-"));
		db = new SearchDatabase(path.join(tmpDir, "index.db"));
	});

	afterEach(() => {
		db.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty map for query matching no chunks", () => {
		const fileId = db.upsertFile("a.ts", 1, "typescript");
		db.insertChunk(fileId, "a.ts", 1, 10, "function", "hello", "hello world", "typescript");
		db.rebuildFts();

		const scores = computeBm25Scores(db, "zzzznotfound", 10);
		expect(scores.size).toBe(0);
	});

	it("returns normalized scores — top match gets 1.0", () => {
		const fileId = db.upsertFile("search.ts", 1, "typescript");
		db.insertChunk(
			fileId,
			"search.ts",
			1,
			10,
			"function",
			"authenticate",
			"authenticate the user credentials authenticate again authenticate",
			"typescript",
		);
		db.insertChunk(
			fileId,
			"search.ts",
			11,
			20,
			"function",
			"process",
			"process data after authenticate",
			"typescript",
		);
		db.rebuildFts();

		const scores = computeBm25Scores(db, "authenticate", 10);
		expect(scores.size).toBeGreaterThanOrEqual(2);
		const maxScore = Math.max(...scores.values());
		expect(maxScore).toBeCloseTo(1.0, 5);
	});

	it("returns proportional scores for multiple matches", () => {
		const fileId = db.upsertFile("multi.ts", 1, "typescript");
		// Heavy occurrence
		const c1 = db.insertChunk(
			fileId,
			"multi.ts",
			1,
			10,
			"function",
			"heavy",
			"parse parse parse parse parse parse parse parse",
			"typescript",
		);
		// Light occurrence
		const c2 = db.insertChunk(fileId, "multi.ts", 11, 20, "function", "light", "call parse once here", "typescript");
		db.rebuildFts();

		const scores = computeBm25Scores(db, "parse", 10);
		expect(scores.has(c1)).toBe(true);
		expect(scores.has(c2)).toBe(true);
		// Heavy match should score higher
		expect(scores.get(c1)!).toBeGreaterThanOrEqual(scores.get(c2)!);
		// Top score should be 1.0
		expect(scores.get(c1)).toBeCloseTo(1.0, 5);
		// Light match should be less than 1.0
		expect(scores.get(c2)!).toBeLessThan(1.0);
	});

	it("returns empty map for empty query", () => {
		const fileId = db.upsertFile("a.ts", 1, "typescript");
		db.insertChunk(fileId, "a.ts", 1, 5, "function", "fn", "some content", "typescript");
		db.rebuildFts();

		const scores = computeBm25Scores(db, "", 10);
		expect(scores.size).toBe(0);
	});

	it("handles single match — score is 1.0", () => {
		const fileId = db.upsertFile("single.ts", 1, "typescript");
		const c1 = db.insertChunk(
			fileId,
			"single.ts",
			1,
			10,
			"function",
			"unique",
			"this is a uniquetoken for testing",
			"typescript",
		);
		db.insertChunk(fileId, "single.ts", 11, 20, "function", "other", "unrelated content here", "typescript");
		db.rebuildFts();

		const scores = computeBm25Scores(db, "uniquetoken", 10);
		expect(scores.size).toBe(1);
		expect(scores.get(c1)).toBeCloseTo(1.0, 5);
	});
});
