import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSearchToolDefinition, formatSearchCall, isSearchAvailable } from "../../src/core/tools/search.js";

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

		it("has projectDir as an optional property", () => {
			expect(schema.properties.projectDir).toBeDefined();
			expect(schema.properties.projectDir.type).toBe("string");
			expect(schema.required ?? []).not.toContain("projectDir");
		});

		it("has rebuild as an optional property", () => {
			expect(schema.properties.rebuild).toBeDefined();
			expect(schema.properties.rebuild.type).toBe("boolean");
			expect(schema.required ?? []).not.toContain("rebuild");
		});
	});

	// ============================================================================
	// formatSearchCall rendering
	// ============================================================================

	describe("formatSearchCall", () => {
		// Stub theme that passes through text without ANSI codes
		const stubTheme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as any;

		it("renders basic query", () => {
			const result = formatSearchCall({ query: "AuthMiddleware" }, stubTheme);
			expect(result).toContain("search");
			expect(result).toContain('"AuthMiddleware"');
		});

		it("renders projectDir when provided", () => {
			const result = formatSearchCall({ query: "test", projectDir: "/home/user/project" }, stubTheme);
			expect(result).toContain("project");
			expect(result).toContain("project"); // shortenPath output
		});

		it("renders searchPath when provided", () => {
			const result = formatSearchCall({ query: "test", path: "src/auth" }, stubTheme);
			expect(result).toContain("in");
			expect(result).toContain("src/auth");
		});

		it("renders rebuild indicator when true", () => {
			const result = formatSearchCall({ query: "test", rebuild: true }, stubTheme);
			expect(result).toContain("[rebuild]");
		});

		it("does not render rebuild indicator when false", () => {
			const result = formatSearchCall({ query: "test", rebuild: false }, stubTheme);
			expect(result).not.toContain("[rebuild]");
		});

		it("renders limit when provided", () => {
			const result = formatSearchCall({ query: "test", limit: 5 }, stubTheme);
			expect(result).toContain("limit 5");
		});

		it("renders all options together", () => {
			const result = formatSearchCall(
				{ query: "auth", projectDir: "/proj", path: "src", rebuild: true, limit: 10 },
				stubTheme,
			);
			expect(result).toContain('"auth"');
			expect(result).toContain("[rebuild]");
			expect(result).toContain("limit 10");
			expect(result).toContain("in");
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

		// ============================================================================
		// Execute — projectDir parameter
		// ============================================================================

		describe("projectDir parameter", () => {
			let projectDirFixture: string;
			let differentCwdTool: ReturnType<typeof createSearchToolDefinition>;

			beforeAll(() => {
				// Create a fixture project in a separate directory
				projectDirFixture = mkdtempSync(path.join(tmpdir(), "search-projectdir-"));
				createFixtureProject(projectDirFixture);
				// Create the tool with a DIFFERENT cwd (empty temp dir)
				const emptyCwd = mkdtempSync(path.join(tmpdir(), "search-empty-cwd-"));
				differentCwdTool = createSearchToolDefinition(emptyCwd);
			});

			afterAll(() => {
				rmSync(projectDirFixture, { recursive: true, force: true });
			});

			it("searches the projectDir instead of cwd when provided", async () => {
				const result = await differentCwdTool.execute(
					"t-projdir",
					{ query: "AuthMiddleware", projectDir: projectDirFixture },
					undefined,
					undefined,
					undefined as any,
				);
				const text = (result.content[0] as { type: "text"; text: string }).text;

				// Should find results from the projectDir fixture
				expect(text).toContain("AuthMiddleware");
				expect(result.details!.resultCount).toBeGreaterThan(0);
			});

			it("returns error when projectDir does not exist", async () => {
				const result = await differentCwdTool.execute(
					"t-projdir-noexist",
					{ query: "AuthMiddleware", projectDir: "/tmp/this-path-definitely-does-not-exist-abc123" },
					undefined,
					undefined,
					undefined as any,
				);
				const text = (result.content[0] as { type: "text"; text: string }).text;

				expect(text).toContain("does not exist or is not a directory");
				expect(result.details!.resultCount).toBe(0);
				expect(result.details!.indexBuilt).toBe(false);
			});

			it("returns error when projectDir is a file, not a directory", async () => {
				const tmpFile = path.join(mkdtempSync(path.join(tmpdir(), "search-file-")), "not-a-dir.txt");
				writeFileSync(tmpFile, "hello", "utf-8");
				try {
					const result = await differentCwdTool.execute(
						"t-projdir-file",
						{ query: "AuthMiddleware", projectDir: tmpFile },
						undefined,
						undefined,
						undefined as any,
					);
					const text = (result.content[0] as { type: "text"; text: string }).text;

					expect(text).toContain("does not exist or is not a directory");
					expect(result.details!.resultCount).toBe(0);
				} finally {
					rmSync(path.dirname(tmpFile), { recursive: true, force: true });
				}
			});

			it("does not find project-specific content when projectDir points elsewhere", async () => {
				const emptyProject = mkdtempSync(path.join(tmpdir(), "search-empty-proj-"));
				try {
					const result = await differentCwdTool.execute(
						"t-projdir-empty",
						{ query: "AuthMiddleware", projectDir: emptyProject },
						undefined,
						undefined,
						undefined as any,
					);
					const text = (result.content[0] as { type: "text"; text: string }).text;
					// AuthMiddleware is only in the fixture project, not in an empty dir
					// (global memory may still return results, but not for AuthMiddleware)
					expect(text).not.toContain("src/auth/middleware.ts");
				} finally {
					rmSync(emptyProject, { recursive: true, force: true });
				}
			});
		});

		// ============================================================================
		// Execute — rebuild parameter
		// ============================================================================

		describe("rebuild parameter", () => {
			let rebuildFixture: string;
			let rebuildTool: ReturnType<typeof createSearchToolDefinition>;

			beforeAll(() => {
				rebuildFixture = mkdtempSync(path.join(tmpdir(), "search-rebuild-"));
				createFixtureProject(rebuildFixture);
				rebuildTool = createSearchToolDefinition(rebuildFixture);
			});

			afterAll(() => {
				rmSync(rebuildFixture, { recursive: true, force: true });
			});

			it("rebuild: true works as the very first call (no prior index)", async () => {
				// Create a completely fresh fixture and tool — no prior search
				const coldFixture = mkdtempSync(path.join(tmpdir(), "search-cold-rebuild-"));
				createFixtureProject(coldFixture);
				const coldTool = createSearchToolDefinition(coldFixture);

				try {
					const result = await coldTool.execute(
						"t-cold-rebuild",
						{ query: "AuthMiddleware", rebuild: true },
						undefined,
						undefined,
						undefined as any,
					);
					const text = (result.content[0] as { type: "text"; text: string }).text;

					expect(text).toContain("AuthMiddleware");
					expect(result.details!.resultCount).toBeGreaterThan(0);
					expect(result.details!.indexBuilt).toBe(true);
				} finally {
					rmSync(coldFixture, { recursive: true, force: true });
				}
			});

			it("rebuild: true produces valid results after fresh index", async () => {
				// First search to build the index
				await rebuildTool.execute(
					"t-rebuild-setup",
					{ query: "AuthMiddleware" },
					undefined,
					undefined,
					undefined as any,
				);

				// Verify the index DB exists
				const dbPath = path.join(rebuildFixture, ".dreb", "index", "search.db");
				expect(existsSync(dbPath)).toBe(true);

				// Now search with rebuild: true
				const result = await rebuildTool.execute(
					"t-rebuild",
					{ query: "AuthMiddleware", rebuild: true },
					undefined,
					undefined,
					undefined as any,
				);
				const text = (result.content[0] as { type: "text"; text: string }).text;

				expect(text).toContain("AuthMiddleware");
				expect(result.details!.resultCount).toBeGreaterThan(0);
				// Index should have been rebuilt
				expect(result.details!.indexBuilt).toBe(true);
			});

			it("normal search after rebuild still works", async () => {
				// rebuild was done in previous test, now a normal search should work fine
				const result = await rebuildTool.execute(
					"t-after-rebuild",
					{ query: "formatDate" },
					undefined,
					undefined,
					undefined as any,
				);
				const text = (result.content[0] as { type: "text"; text: string }).text;

				expect(text).toContain("formatDate");
				expect(result.details!.resultCount).toBeGreaterThan(0);
			});
		});

		// ============================================================================
		// Execute — projectDir + rebuild isolation
		// ============================================================================

		describe("projectDir + rebuild isolation", () => {
			let projectA: string;
			let projectB: string;
			let isolationTool: ReturnType<typeof createSearchToolDefinition>;

			beforeAll(() => {
				const toolCwd = mkdtempSync(path.join(tmpdir(), "search-isolation-cwd-"));
				isolationTool = createSearchToolDefinition(toolCwd);

				// Project A has the standard fixtures
				projectA = mkdtempSync(path.join(tmpdir(), "search-iso-a-"));
				createFixtureProject(projectA);

				// Project B has different content
				projectB = mkdtempSync(path.join(tmpdir(), "search-iso-b-"));
				const bFile = path.join(projectB, "src", "payments.ts");
				mkdirSync(path.dirname(bFile), { recursive: true });
				writeFileSync(bFile, "export class PaymentProcessor { charge() {} }", "utf-8");
			});

			afterAll(() => {
				rmSync(projectA, { recursive: true, force: true });
				rmSync(projectB, { recursive: true, force: true });
			});

			it("each projectDir gets its own index", async () => {
				const resultA = await isolationTool.execute(
					"t-iso-a",
					{ query: "AuthMiddleware", projectDir: projectA },
					undefined,
					undefined,
					undefined as any,
				);
				expect(resultA.details!.resultCount).toBeGreaterThan(0);

				const resultB = await isolationTool.execute(
					"t-iso-b",
					{ query: "PaymentProcessor", projectDir: projectB },
					undefined,
					undefined,
					undefined as any,
				);
				expect(resultB.details!.resultCount).toBeGreaterThan(0);

				// Verify separate index DBs exist
				expect(existsSync(path.join(projectA, ".dreb", "index", "search.db"))).toBe(true);
				expect(existsSync(path.join(projectB, ".dreb", "index", "search.db"))).toBe(true);
			});

			it("rebuild on one project does not affect the other", async () => {
				// Rebuild project A
				await isolationTool.execute(
					"t-iso-rebuild-a",
					{ query: "AuthMiddleware", projectDir: projectA, rebuild: true },
					undefined,
					undefined,
					undefined as any,
				);

				// Project B index should still exist and work
				expect(existsSync(path.join(projectB, ".dreb", "index", "search.db"))).toBe(true);

				const resultB = await isolationTool.execute(
					"t-iso-b-after",
					{ query: "PaymentProcessor", projectDir: projectB },
					undefined,
					undefined,
					undefined as any,
				);
				expect(resultB.details!.resultCount).toBeGreaterThan(0);
			});
		});
	});
});
