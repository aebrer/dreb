import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the embedder to avoid downloading the ONNX model
vi.mock("../src/embedder.js", () => ({
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

// Mock SearchEngine to avoid needing a real SQLite database
const mockSearch = vi.fn().mockResolvedValue([]);
const mockGetStats = vi.fn().mockReturnValue({ files: 10, chunks: 200 });
const mockResetIndex = vi.fn();
const mockClose = vi.fn();

vi.mock("../src/search.js", () => ({
	SearchEngine: class MockSearchEngine {
		static isAvailable() {
			return true;
		}
		search = mockSearch;
		getStats = mockGetStats;
		resetIndex = mockResetIndex;
		close = mockClose;
	},
}));

import { formatResults } from "../src/format.js";
import { createMcpServer, startServer } from "../src/mcp-server.js";
import type { MetricScores, SearchResult, StoredChunk } from "../src/types.js";

// ============================================================================
// Helpers
// ============================================================================

function makeChunk(overrides: Partial<StoredChunk> = {}): StoredChunk {
	return {
		id: 1,
		fileId: 1,
		filePath: "src/auth/middleware.ts",
		startLine: 1,
		endLine: 10,
		kind: "function",
		name: "handleAuth",
		content:
			"export function handleAuth(req: Request) {\n  const token = req.headers.get('authorization');\n  return token != null;\n}",
		fileType: "typescript",
		...overrides,
	};
}

function makeScores(overrides: Partial<MetricScores> = {}): MetricScores {
	return {
		bm25: 0.85,
		cosine: 0.72,
		pathMatch: 0.5,
		symbolMatch: 0.6,
		importGraph: 0.0,
		gitRecency: 0.9,
		...overrides,
	};
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
	return {
		chunk: makeChunk(),
		scores: makeScores(),
		rank: 0,
		...overrides,
	};
}

// ============================================================================
// formatResults
// ============================================================================

describe("formatResults", () => {
	it("returns 'No results found.' for empty array", () => {
		expect(formatResults([])).toBe("No results found.");
	});

	it("formats a single result with path, line range, kind, and scores", () => {
		const result = makeResult();
		const output = formatResults([result]);

		expect(output).toContain("1. src/auth/middleware.ts:L1-10");
		expect(output).toContain("(function handleAuth)");
		expect(output).toContain("scores:");
		expect(output).toContain("bm25=0.85");
		expect(output).toContain("cosine=0.72");
		expect(output).toContain("gitRecency=0.90");
	});

	it("shows L<n> for single-line chunks", () => {
		const result = makeResult({ chunk: makeChunk({ startLine: 5, endLine: 5 }) });
		const output = formatResults([result]);

		expect(output).toContain(":L5 ");
	});

	it("shows kind without name for anonymous chunks", () => {
		const result = makeResult({ chunk: makeChunk({ name: null, kind: "file" }) });
		const output = formatResults([result]);

		expect(output).toContain("(file)");
		expect(output).not.toContain("(file null)");
	});

	it("omits scores below 0.01", () => {
		const result = makeResult({
			scores: makeScores({ importGraph: 0.005, bm25: 0.0 }),
		});
		const output = formatResults([result]);

		expect(output).not.toContain("importGraph");
		expect(output).not.toContain("bm25");
	});

	it("shows first 3 lines of content and truncation indicator", () => {
		const content = "line 1\nline 2\nline 3\nline 4\nline 5";
		const result = makeResult({ chunk: makeChunk({ content }) });
		const output = formatResults([result]);

		expect(output).toContain("line 1");
		expect(output).toContain("line 2");
		expect(output).toContain("line 3");
		expect(output).not.toContain("line 4");
		expect(output).toContain("... (2 more lines)");
	});

	it("truncates long content lines at 120 chars", () => {
		const longLine = "x".repeat(200);
		const result = makeResult({ chunk: makeChunk({ content: longLine }) });
		const output = formatResults([result]);

		// Should be truncated to 117 chars + "..."
		expect(output).toContain(`${"x".repeat(117)}...`);
		expect(output).not.toContain("x".repeat(200));
	});

	it("formats multiple results with blank lines between them", () => {
		const results = [
			makeResult({ chunk: makeChunk({ filePath: "a.ts" }) }),
			makeResult({ chunk: makeChunk({ filePath: "b.ts" }) }),
		];
		const output = formatResults(results);

		expect(output).toContain("1. a.ts:");
		expect(output).toContain("2. b.ts:");
		// Should have a blank line between results
		const lines = output.split("\n");
		const blankLineIndex = lines.findIndex((l, i) => l === "" && i > 0);
		expect(blankLineIndex).toBeGreaterThan(0);
	});

	it("sorts scores by value descending", () => {
		const result = makeResult({
			scores: makeScores({
				bm25: 0.3,
				cosine: 0.9,
				pathMatch: 0.1,
				symbolMatch: 0.5,
				importGraph: 0.0,
				gitRecency: 0.7,
			}),
		});
		const output = formatResults([result]);

		const scoresLine = output.split("\n").find((l) => l.includes("scores:"));
		expect(scoresLine).toBeDefined();

		// Extract scores from the line
		const scoreMatches = [...scoresLine!.matchAll(/(\w+)=(\d+\.\d+)/g)];
		const scoreValues = scoreMatches.map(([, , v]) => Number.parseFloat(v));

		// Should be in descending order
		for (let i = 1; i < scoreValues.length; i++) {
			expect(scoreValues[i]).toBeLessThanOrEqual(scoreValues[i - 1]);
		}
	});
});

// ============================================================================
// createMcpServer / startServer exports
// ============================================================================

describe("createMcpServer", () => {
	it("is an exported function", () => {
		expect(typeof createMcpServer).toBe("function");
	});

	it("returns an McpServer instance", () => {
		const server = createMcpServer("/tmp/test-project");
		expect(server).toBeDefined();
		expect(typeof server.connect).toBe("function");
		expect(typeof server.close).toBe("function");
	});
});

describe("startServer", () => {
	it("is an exported function", () => {
		expect(typeof startServer).toBe("function");
	});
});

// ============================================================================
// MCP protocol integration (InMemoryTransport)
// ============================================================================

describe("MCP protocol integration", () => {
	let client: import("@modelcontextprotocol/sdk/client/index.js").Client;
	let server: ReturnType<typeof createMcpServer>;

	beforeEach(async () => {
		mockSearch.mockReset().mockResolvedValue([]);
		mockGetStats.mockReset().mockReturnValue({ files: 10, chunks: 200 });
		mockResetIndex.mockReset();

		const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

		server = createMcpServer("/tmp/test-project");
		client = new Client({ name: "test-client", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
	});

	it("lists the search tool", async () => {
		const result = await client.listTools();

		expect(result.tools).toHaveLength(1);
		expect(result.tools[0].name).toBe("search");
		expect(result.tools[0].description).toContain("semantic");
	});

	it("returns the correct input schema", async () => {
		const result = await client.listTools();
		const tool = result.tools[0];

		expect(tool.inputSchema.type).toBe("object");
		expect(tool.inputSchema.properties).toHaveProperty("query");
		expect(tool.inputSchema.properties).toHaveProperty("restrictToDir");
		expect(tool.inputSchema.properties).toHaveProperty("limit");
		expect(tool.inputSchema.properties).toHaveProperty("rebuild");
		expect(tool.inputSchema.properties).toHaveProperty("searchDir");
		expect(tool.inputSchema.required).toContain("query");
		expect(tool.inputSchema.required).toContain("searchDir");
	});

	it("calls search and returns formatted results", async () => {
		const mockResults: SearchResult[] = [
			makeResult({
				chunk: makeChunk({ filePath: "src/server.ts", startLine: 10, endLine: 20 }),
				scores: makeScores({ bm25: 0.95 }),
			}),
		];
		mockSearch.mockResolvedValue(mockResults);

		const result = await client.callTool({
			name: "search",
			arguments: { query: "server setup", searchDir: "/tmp/test-project" },
		});

		expect(result.content).toHaveLength(1);
		const text = (result.content as Array<{ type: string; text: string }>)[0].text;
		expect(text).toContain("1. src/server.ts:L10-20");
		expect(text).toContain("bm25=0.95");
		expect(text).toContain("[Index: 10 files, 200 chunks]");
	});

	it("returns empty result message when no matches", async () => {
		mockSearch.mockResolvedValue([]);

		const result = await client.callTool({
			name: "search",
			arguments: { query: "nonexistent", searchDir: "/tmp/test-project" },
		});

		const text = (result.content as Array<{ type: string; text: string }>)[0].text;
		expect(text).toContain("No results found.");
	});

	it("passes path filter to search engine", async () => {
		mockSearch.mockResolvedValue([]);

		await client.callTool({
			name: "search",
			arguments: { query: "handler", searchDir: "/tmp/test-project", restrictToDir: "src/api" },
		});

		expect(mockSearch).toHaveBeenCalledWith("handler", expect.objectContaining({ pathFilter: "src/api" }));
	});

	it("passes limit to search engine", async () => {
		mockSearch.mockResolvedValue([]);

		await client.callTool({
			name: "search",
			arguments: { query: "handler", searchDir: "/tmp/test-project", limit: 5 },
		});

		expect(mockSearch).toHaveBeenCalledWith("handler", expect.objectContaining({ limit: 5 }));
	});

	it("calls resetIndex when rebuild is true", async () => {
		mockSearch.mockResolvedValue([]);

		await client.callTool({
			name: "search",
			arguments: { query: "test", searchDir: "/tmp/test-project", rebuild: true },
		});

		expect(mockResetIndex).toHaveBeenCalled();
	});

	it("does not call resetIndex when rebuild is false", async () => {
		mockSearch.mockResolvedValue([]);

		await client.callTool({
			name: "search",
			arguments: { query: "test", searchDir: "/tmp/test-project", rebuild: false },
		});

		expect(mockResetIndex).not.toHaveBeenCalled();
	});

	it("accepts searchDir as a per-call override", async () => {
		mockSearch.mockResolvedValue([]);

		// Should not throw — searchDir is accepted as a valid parameter
		const result = await client.callTool({
			name: "search",
			arguments: { query: "test", searchDir: "/tmp/other-project" },
		});

		const text = (result.content as Array<{ type: string; text: string }>)[0].text;
		// Should complete without error
		expect(text).toContain("No results found.");
	});

	it("returns isError for empty query", async () => {
		const result = await client.callTool({
			name: "search",
			arguments: { query: "", searchDir: "/tmp/test-project" },
		});
		expect(result.isError).toBe(true);
		const text = (result.content as Array<{ type: string; text: string }>)[0].text;
		expect(text).toContain("empty");
	});

	it("returns isError for whitespace-only query", async () => {
		const result = await client.callTool({
			name: "search",
			arguments: { query: "   ", searchDir: "/tmp/test-project" },
		});
		expect(result.isError).toBe(true);
	});

	it("returns isError when SQLite is not available", async () => {
		const { SearchEngine: MockedEngine } = await import("../src/search.js");
		const spy = vi.spyOn(MockedEngine, "isAvailable").mockReturnValue(false);

		const result = await client.callTool({
			name: "search",
			arguments: { query: "test", searchDir: "/tmp/test-project" },
		});
		expect(result.isError).toBe(true);
		const text = (result.content as Array<{ type: string; text: string }>)[0].text;
		expect(text).toContain("Node.js 22");

		spy.mockRestore();
	});

	it("omits stats footer when getStats() returns null", async () => {
		mockGetStats.mockReturnValue(null);
		mockSearch.mockResolvedValue([]);

		const result = await client.callTool({
			name: "search",
			arguments: { query: "test", searchDir: "/tmp/test-project" },
		});

		const text = (result.content as Array<{ type: string; text: string }>)[0].text;
		expect(text).not.toContain("[Index:");
		expect(text).toContain("No results found.");
	});

	it("returns isError when search throws", async () => {
		mockSearch.mockRejectedValueOnce(new Error("SQLite database is corrupted"));

		const result = await client.callTool({
			name: "search",
			arguments: { query: "test", searchDir: "/tmp/test-project" },
		});
		expect(result.isError).toBe(true);
		const text = (result.content as Array<{ type: string; text: string }>)[0].text;
		expect(text).toContain("SQLite database is corrupted");
	});
});
