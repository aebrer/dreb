/**
 * Semantic codebase search tool.
 *
 * Uses embeddings + FTS5 to support natural language queries over the codebase.
 * Feature-gated on `node:sqlite` availability (Node 22+).
 */

import type { AgentTool } from "@dreb/agent-core";
import { Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { IndexManager } from "../search/index-manager.js";
import { SearchEngine } from "../search/search.js";
import { shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

// ============================================================================
// Schema
// ============================================================================

const searchSchema = Type.Object({
	query: Type.String({ description: "The search query (natural language, identifier, or path)" }),
	path: Type.Optional(Type.String({ description: "Restrict search to files under this path (relative to cwd)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 20)" })),
});

export type SearchToolInput = Static<typeof searchSchema>;

// ============================================================================
// Details
// ============================================================================

export interface SearchToolDetails {
	resultCount: number;
	indexBuilt: boolean;
	indexStats?: { files: number; chunks: number };
}

// ============================================================================
// Rendering
// ============================================================================

function formatSearchCall(
	args: { query?: string; path?: string; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const query = str(args?.query);
	const searchPath = str(args?.path);
	let text = `${theme.fg("toolTitle", theme.bold("search"))} ${theme.fg("accent", `"${query ?? ""}"`)}`;
	if (searchPath) {
		text += theme.fg("toolOutput", ` in ${shortenPath(searchPath)}`);
	}
	if (args?.limit !== undefined) {
		text += theme.fg("toolOutput", ` limit ${args.limit}`);
	}
	return text;
}

function formatSearchResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: SearchToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const output = result.content[0]?.text?.trim() ?? "";
	if (!output) return "";

	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 20;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;

	let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
	if (remaining > 0) {
		text += `\n${theme.fg("muted", `... (${remaining} more lines)`)}`;
	}

	if (result.details?.indexStats) {
		const { files, chunks } = result.details.indexStats;
		text += `\n${theme.fg("muted", `[Index: ${files} files, ${chunks} chunks]`)}`;
	}

	return text;
}

// ============================================================================
// Tool Definition
// ============================================================================

/** Check if the search tool is available (requires node:sqlite). */
export function isSearchAvailable(): boolean {
	return IndexManager.isAvailable();
}

// Cache search engines per cwd to reuse index across calls within a session
const engineCache = new Map<string, SearchEngine>();

function getSearchEngine(cwd: string): SearchEngine {
	let engine = engineCache.get(cwd);
	if (!engine) {
		engine = new SearchEngine(cwd);
		engineCache.set(cwd, engine);
	}
	return engine;
}

export function createSearchToolDefinition(cwd: string): ToolDefinition<typeof searchSchema, SearchToolDetails> {
	return {
		name: "search",
		label: "search",
		description:
			"Search the codebase using natural language queries. Returns ranked code/doc results using semantic similarity and keyword matching. First query builds the index (may take a moment); subsequent queries are fast. Supports identifier queries (e.g. 'AuthMiddleware'), natural language (e.g. 'where is rate limiting handled'), and path queries (e.g. 'src/auth/').",
		promptSnippet: "Semantic codebase search — natural language queries over code and docs",
		promptGuidelines: [
			'Use `search` for broad/conceptual queries ("where is auth handled", "rate limiting logic"). Use `grep` for exact text/regex matches.',
			"The first search query builds an index (may take 10-60s). Subsequent queries are fast.",
		],
		parameters: searchSchema,

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			if (signal?.aborted) throw new Error("Operation aborted");

			if (!isSearchAvailable()) {
				return {
					content: [
						{
							type: "text",
							text: "Semantic search requires Node.js 22+ (for built-in SQLite). Current Node.js version does not support node:sqlite.",
						},
					],
					details: { resultCount: 0, indexBuilt: false },
				};
			}

			const { query, path: searchPath, limit } = params;

			if (!query || query.trim().length === 0) {
				return {
					content: [{ type: "text", text: "Search query cannot be empty." }],
					details: { resultCount: 0, indexBuilt: false },
				};
			}

			const engine = getSearchEngine(cwd);

			let indexBuilt = false;
			const results = await engine.search(query, {
				limit: limit ?? 20,
				pathFilter: searchPath,
				onProgress: (phase, current, total) => {
					if (phase === "indexing" || phase === "scanning" || phase === "loading model" || phase === "embedding") {
						indexBuilt = true;
					}
					if (onUpdate) {
						onUpdate({
							content: [
								{
									type: "text",
									text: `${phase}: ${current}/${total}`,
								},
							],
							details: { resultCount: 0, indexBuilt: true } as SearchToolDetails,
						});
					}
				},
			});

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: "No results found." }],
					details: { resultCount: 0, indexBuilt },
				};
			}

			// Format results
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
					.slice(0, 3)
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

			// Get index stats
			const indexManager = new IndexManager({
				projectRoot: cwd,
				indexDir: `${cwd}/.dreb/index`,
				modelName: "nomic-ai/nomic-embed-text-v1.5",
			});
			const stats = indexManager.getStats();

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					resultCount: results.length,
					indexBuilt,
					indexStats: stats ?? undefined,
				},
			};
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSearchCall(args, theme));
			return text;
		},

		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSearchResult(result as any, options, theme));
			return text;
		},
	};
}

export function createSearchTool(cwd: string): AgentTool<typeof searchSchema> {
	return wrapToolDefinition(createSearchToolDefinition(cwd));
}
