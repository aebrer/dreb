import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSearchToolDefinition, isSearchAvailable } from "../../src/core/tools/search.js";

// Mock the embedder to avoid downloading the ONNX model (~23MB).
// Returns zero-vectors so cosine scores are 0, but BM25/path/symbol metrics still work.
vi.mock("../../src/core/search/embedder.js", () => ({
	Embedder: class MockEmbedder {
		async initialize() {}
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
// Fixture helpers
// ============================================================================

const FIXTURE_FILES: Record<string, string> = {
	"src/auth/middleware.ts": [
		"export class AuthMiddleware {",
		"  async handle(req: Request): Promise<Response> {",
		"    const token = req.headers.get('authorization');",
		"    if (!token) return new Response('Unauthorized', { status: 401 });",
		"    return this.next(req);",
		"  }",
		"  private next(req: Request): Promise<Response> {",
		"    return fetch(req);",
		"  }",
		"}",
	].join("\n"),
	"src/utils/helpers.ts": [
		"export function formatDate(date: Date): string {",
		"  return date.toISOString();",
		"}",
	].join("\n"),
};

function createFixtureProject(dir: string): void {
	for (const [relPath, content] of Object.entries(FIXTURE_FILES)) {
		const absPath = path.join(dir, relPath);
		mkdirSync(path.dirname(absPath), { recursive: true });
		writeFileSync(absPath, content, "utf-8");
	}
}

// ============================================================================
// Availability
// ============================================================================

describe("isSearchAvailable", () => {
	it("returns true on Node 22+", () => {
		// We're running on Node 22, so node:sqlite should be available
		expect(isSearchAvailable()).toBe(true);
	});
});

// ============================================================================
// Tool Definition Properties
// ============================================================================

describe("createSearchToolDefinition", () => {
	const tmpDir = mkdtempSync(path.join(tmpdir(), "search-test-"));
	const tool = createSearchToolDefinition(tmpDir);

	it("has the correct name", () => {
		expect(tool.name).toBe("search");
	});

	it("has a label", () => {
		expect(tool.label).toBeDefined();
		expect(typeof tool.label).toBe("string");
		expect(tool.label!.length).toBeGreaterThan(0);
	});

	it("has a description", () => {
		expect(tool.description).toBeDefined();
		expect(typeof tool.description).toBe("string");
		expect(tool.description.length).toBeGreaterThan(0);
	});

	it("has a promptSnippet", () => {
		expect(tool.promptSnippet).toBeDefined();
		expect(typeof tool.promptSnippet).toBe("string");
		expect(tool.promptSnippet!.length).toBeGreaterThan(0);
	});

	it("has promptGuidelines array", () => {
		expect(tool.promptGuidelines).toBeDefined();
		expect(Array.isArray(tool.promptGuidelines)).toBe(true);
		expect(tool.promptGuidelines!.length).toBeGreaterThan(0);
	});

	// ============================================================================
	// Parameters Schema
	// ============================================================================

	describe("parameters schema", () => {
		const schema = tool.parameters as any;

		it("has query as a required property", () => {
			expect(schema.properties.query).toBeDefined();
			expect(schema.properties.query.type).toBe("string");
			expect(schema.required).toContain("query");
		});

		it("has path as an optional property", () => {
			expect(schema.properties.path).toBeDefined();
			// Optional properties are not in the required array
			expect(schema.required ?? []).not.toContain("path");
		});

		it("has limit as an optional property", () => {
			expect(schema.properties.limit).toBeDefined();
			expect(schema.required ?? []).not.toContain("limit");
		});
	});

	// ============================================================================
	// Execute — empty query
	// ============================================================================

	describe("execute", () => {
		it('returns "cannot be empty" message for empty query', async () => {
			const result = await tool.execute("test-1", { query: "" }, undefined, undefined, undefined as any);
			const text = result.content[0];
			expect(text.type).toBe("text");
			expect((text as { type: "text"; text: string }).text).toContain("empty");
		});

		// ============================================================================
		// Execute — result path (with fixture project)
		// ============================================================================

		describe("with fixture project", () => {
			let fixtureDir: string;
			let fixtureTool: ReturnType<typeof createSearchToolDefinition>;

			beforeAll(() => {
				fixtureDir = mkdtempSync(path.join(tmpdir(), "search-tool-exec-"));
				createFixtureProject(fixtureDir);
				fixtureTool = createSearchToolDefinition(fixtureDir);
			});

			afterAll(() => {
				rmSync(fixtureDir, { recursive: true, force: true });
			});

			it("whitespace-only query returns error message", async () => {
				const result = await fixtureTool.execute("t-ws", { query: "   " }, undefined, undefined, undefined as any);
				const text = (result.content[0] as { type: "text"; text: string }).text;
				expect(text).toContain("empty");
				expect(result.details!.resultCount).toBe(0);
				expect(result.details!.indexBuilt).toBe(false);
			});

			it("successful search returns formatted results with file paths and content previews", async () => {
				const result = await fixtureTool.execute(
					"t-fmt",
					{ query: "AuthMiddleware" },
					undefined,
					undefined,
					undefined as any,
				);
				const text = (result.content[0] as { type: "text"; text: string }).text;

				// Should be numbered results starting with "1."
				expect(text).toMatch(/^1\./);
				// Should contain the file path
				expect(text).toContain("src/auth/middleware.ts");
				// Should contain content preview with the class name
				expect(text).toContain("AuthMiddleware");
			});

			it("result output includes score lines with metric values", async () => {
				const result = await fixtureTool.execute(
					"t-scores",
					{ query: "AuthMiddleware" },
					undefined,
					undefined,
					undefined as any,
				);
				const text = (result.content[0] as { type: "text"; text: string }).text;

				// Should contain "scores:" lines with metric=value format
				expect(text).toContain("scores:");
				expect(text).toMatch(/\w+=\d+\.\d+/);
			});

			it("content preview truncation shows '... (N more lines)' for long chunks", async () => {
				const result = await fixtureTool.execute(
					"t-trunc",
					{ query: "AuthMiddleware" },
					undefined,
					undefined,
					undefined as any,
				);
				const text = (result.content[0] as { type: "text"; text: string }).text;

				// AuthMiddleware chunk has >3 lines, so truncation indicator should appear
				expect(text).toMatch(/\.\.\. \(\d+ more lines\)/);
			});

			it("details object includes resultCount and indexBuilt fields", async () => {
				const result = await fixtureTool.execute(
					"t-details",
					{ query: "formatDate" },
					undefined,
					undefined,
					undefined as any,
				);
				const details = result.details!;

				expect(typeof details.resultCount).toBe("number");
				expect(details.resultCount).toBeGreaterThan(0);
				expect(typeof details.indexBuilt).toBe("boolean");
			});

			it("no results returns 'No results found' message", async () => {
				const result = await fixtureTool.execute(
					"t-empty",
					{ query: "anything", path: "nonexistent/dir" },
					undefined,
					undefined,
					undefined as any,
				);
				const text = (result.content[0] as { type: "text"; text: string }).text;

				expect(text).toBe("No results found.");
				expect(result.details!.resultCount).toBe(0);
			});
		});
	});
});
