import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeGitRecencyScores } from "../../src/core/search/metrics/git-recency.js";
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
