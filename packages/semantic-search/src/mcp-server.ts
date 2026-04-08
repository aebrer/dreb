/**
 * MCP stdio server adapter for semantic codebase search.
 *
 * Exposes the SearchEngine as a single "search" tool over the Model Context Protocol,
 * enabling any MCP-compatible client to run semantic codebase queries.
 *
 * The server defaults to using its CWD as the project directory. Claude Code
 * launches MCP servers with CWD set to the project root, so no configuration
 * is needed for typical per-project usage.
 */

import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SearchEngine } from "./search.js";
import type { SearchResult } from "./types.js";

// ============================================================================
// Tool Schema (JSON Schema for MCP)
// ============================================================================

const SEARCH_TOOL = {
	name: "search",
	description:
		"Search the codebase using natural language queries. Returns ranked code/doc results using semantic similarity and keyword matching. First query builds the index (may take a moment); subsequent queries are fast.",
	inputSchema: {
		type: "object" as const,
		properties: {
			query: { type: "string", description: "Search query (natural language, identifier, or path)" },
			path: { type: "string", description: "Restrict search to files under this path" },
			limit: { type: "number", description: "Maximum results to return (default: 20)" },
			rebuild: { type: "boolean", description: "Force index rebuild (default: false)" },
			projectDir: {
				type: "string",
				description: "Directory to search (default: server working directory)",
			},
		},
		required: ["query"],
	},
};

// ============================================================================
// Engine Cache
// ============================================================================

/** Cache search engines per project root to reuse index across calls. */
const engineCache = new Map<string, SearchEngine>();

function getSearchEngine(projectRoot: string): SearchEngine {
	let engine = engineCache.get(projectRoot);
	if (!engine) {
		engine = new SearchEngine(projectRoot);
		engineCache.set(projectRoot, engine);
	}
	return engine;
}

// ============================================================================
// Result Formatting
// ============================================================================

/** Format search results into a human-readable numbered list. */
export function formatResults(results: SearchResult[]): string {
	if (results.length === 0) return "No results found.";

	const lines: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const { chunk, scores } = r;

		// Header line with file path and line range
		const lineRange =
			chunk.startLine === chunk.endLine ? `L${chunk.startLine}` : `L${chunk.startLine}-${chunk.endLine}`;
		const kindLabel = chunk.name ? `${chunk.kind} ${chunk.name}` : chunk.kind;

		lines.push(`${i + 1}. ${chunk.filePath}:${lineRange} (${kindLabel})`);

		// Score summary — show top contributing metrics
		const topScores = Object.entries(scores)
			.filter(([, v]) => v > 0.01)
			.sort(([, a], [, b]) => b - a)
			.map(([k, v]) => `${k}=${v.toFixed(2)}`)
			.join(" ");
		if (topScores) {
			lines.push(`   scores: ${topScores}`);
		}

		// Content preview (first 3 lines)
		const contentLines = chunk.content.split("\n");
		const previewLines = contentLines.slice(0, 3);
		for (const line of previewLines) {
			const trimmed = line.length > 120 ? `${line.slice(0, 117)}...` : line;
			lines.push(`   ${trimmed}`);
		}
		if (contentLines.length > 3) {
			lines.push(`   ... (${contentLines.length - 3} more lines)`);
		}

		if (i < results.length - 1) lines.push("");
	}

	return lines.join("\n");
}

// ============================================================================
// Server Factory
// ============================================================================

/**
 * Create an MCP server instance configured with the semantic search tool.
 *
 * @param defaultProjectDir - Default project directory for searches. Used when
 *   the client doesn't specify `projectDir` in the tool call. Typically the
 *   server's CWD, which Claude Code sets to the project root.
 */
export function createMcpServer(defaultProjectDir: string): Server {
	const server = new Server(
		{ name: "semantic-search", version: "1.0.0" },
		{ capabilities: { tools: {}, logging: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [SEARCH_TOOL],
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
		if (request.params.name !== "search") {
			return {
				content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
				isError: true,
			};
		}

		const args = (request.params.arguments ?? {}) as {
			query?: string;
			path?: string;
			limit?: number;
			rebuild?: boolean;
			projectDir?: string;
		};
		const { query, path: searchPath, limit = 20, rebuild = false } = args;

		// Resolve project directory: per-call override > server default
		const projectDir = args.projectDir ? resolve(args.projectDir) : defaultProjectDir;

		if (!SearchEngine.isAvailable()) {
			return {
				content: [
					{
						type: "text",
						text: "Semantic search requires Node.js 22+ (for built-in SQLite). Current version does not support node:sqlite.",
					},
				],
				isError: true,
			};
		}

		if (!query || query.trim().length === 0) {
			return {
				content: [{ type: "text", text: "Search query cannot be empty." }],
				isError: true,
			};
		}

		const engine = getSearchEngine(projectDir);

		if (rebuild) {
			engine.resetIndex();
		}

		// Send progress via logging messages
		const results = await engine.search(query, {
			limit,
			pathFilter: searchPath,
			onProgress: (phase, current, total) => {
				server
					.sendLoggingMessage({
						level: "info",
						logger: "semantic-search",
						data: `${phase}: ${current}/${total}`,
					})
					.catch(() => {
						// Ignore errors sending progress — client may not support logging
					});
			},
		});

		const text = formatResults(results);
		const stats = engine.getStats();

		let statsLine = "";
		if (stats) {
			statsLine = `\n\n[Index: ${stats.files} files, ${stats.chunks} chunks]`;
		}

		return {
			content: [{ type: "text", text: text + statsLine }],
		};
	});

	return server;
}

// ============================================================================
// Server Startup
// ============================================================================

/**
 * Create and start an MCP server over stdio.
 * This blocks until the transport is closed.
 */
export async function startServer(projectDir: string): Promise<void> {
	const server = createMcpServer(projectDir);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
