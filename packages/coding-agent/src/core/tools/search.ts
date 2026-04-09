/**
 * Semantic codebase search tool.
 *
 * Uses embeddings + FTS5 to support natural language queries over the codebase.
 * Feature-gated on `node:sqlite` availability (Node 22+).
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentTool } from "@dreb/agent-core";
import { formatResults, SearchEngine } from "@dreb/semantic-search";
import { Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getDrebToolVisibleDirs } from "./dreb-paths.js";
import { resolveToCwd } from "./path-utils.js";
import { shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

// ============================================================================
// Schema
// ============================================================================

const searchSchema = Type.Object({
	query: Type.String({ description: "The search query (natural language, identifier, or path)" }),
	path: Type.Optional(Type.String({ description: "Restrict search to files under this path (relative to cwd)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 20)" })),
	projectDir: Type.Optional(
		Type.String({ description: "Directory to index and search instead of cwd (useful when cwd is ~/)" }),
	),
	rebuild: Type.Optional(Type.Boolean({ description: "Force a clean rebuild of the search index (default: false)" })),
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

/** @internal Exported for testing. */
export function formatSearchCall(
	args: { query?: string; path?: string; limit?: number; projectDir?: string; rebuild?: boolean } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const query = str(args?.query);
	const searchPath = str(args?.path);
	const projectDir = str(args?.projectDir);
	let text = `${theme.fg("toolTitle", theme.bold("search"))} ${theme.fg("accent", `"${query ?? ""}"`)}`;
	if (projectDir) {
		text += theme.fg("toolOutput", ` project ${shortenPath(projectDir)}`);
	}
	if (searchPath) {
		text += theme.fg("toolOutput", ` in ${shortenPath(searchPath)}`);
	}
	if (args?.rebuild) {
		text += theme.fg("toolOutput", " [rebuild]");
	}
	if (args?.limit !== undefined) {
		text += theme.fg("toolOutput", ` limit ${args.limit}`);
	}
	return text;
}

/** @internal Exported for testing. */
export function formatSearchResult(
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
	return SearchEngine.isAvailable();
}

// Cache search engines per project root to reuse index across calls within a session
const engineCache = new Map<string, SearchEngine>();

function getSearchEngine(projectRoot: string): SearchEngine {
	let engine = engineCache.get(projectRoot);
	if (!engine) {
		engine = new SearchEngine(projectRoot, {
			indexDir: path.join(projectRoot, ".dreb", "index"),
			globalMemoryDir: path.join(homedir(), ".dreb", "memory"),
			modelCacheDir: path.join(homedir(), ".dreb", "agent", "models"),
			visibleDirs: getDrebToolVisibleDirs,
		});
		engineCache.set(projectRoot, engine);
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
			"Use `search` as your default exploration tool — for understanding code, finding where things are, and answering questions about the codebase. Use `grep` when you already know the exact text or pattern you're looking for.",
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

			const { query, path: searchPath, limit, projectDir, rebuild } = params;

			if (!query || query.trim().length === 0) {
				return {
					content: [{ type: "text", text: "Search query cannot be empty." }],
					details: { resultCount: 0, indexBuilt: false },
				};
			}

			const resolvedProjectDir = projectDir ? resolveToCwd(projectDir, cwd) : cwd;

			if (projectDir && (!existsSync(resolvedProjectDir) || !statSync(resolvedProjectDir).isDirectory())) {
				return {
					content: [
						{
							type: "text",
							text: `projectDir does not exist or is not a directory: ${resolvedProjectDir}`,
						},
					],
					details: { resultCount: 0, indexBuilt: false },
				};
			}

			const engine = getSearchEngine(resolvedProjectDir);

			if (rebuild) {
				await engine.resetIndex();
			}

			let indexBuilt = false;
			const results = await engine.search(query, {
				limit: typeof limit === "number" && limit > 0 ? Math.floor(limit) : 20,
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

			const text = formatResults(results);

			// Get index stats from the existing engine (no new connection)
			const stats = engine.getStats();

			return {
				content: [{ type: "text", text }],
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
