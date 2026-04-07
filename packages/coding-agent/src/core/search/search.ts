/**
 * Main search API.
 *
 * Orchestrates: check/build index → compute all 6 metrics → classify query
 * → duplicate columns → POEM rank → assemble results.
 */

import { homedir } from "node:os";
import path from "node:path";
import type { SearchDatabase } from "./db.js";
import { Embedder } from "./embedder.js";
import { IndexManager } from "./index-manager.js";
import { computeBm25Scores } from "./metrics/bm25.js";
import { computeGitRecencyScores } from "./metrics/git-recency.js";
import { computeImportGraphScores } from "./metrics/import-graph.js";
import { computePathMatchScores } from "./metrics/path-match.js";
import { computeSymbolMatchScores } from "./metrics/symbol-match.js";
import { poemRank } from "./poem.js";
import { classifyQuery } from "./query-classifier.js";
import type { IndexConfig, IndexProgressCallback, MetricScores, SearchResult, StoredChunk } from "./types.js";
import { topKSimilar } from "./vector-store.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_RESULT_LIMIT = 20;
const METRIC_CANDIDATE_LIMIT = 1000;

// ============================================================================
// Search Options
// ============================================================================

export interface SearchOptions {
	/** Maximum number of results to return. Default: 20. */
	limit?: number;
	/** Restrict search to files under this path (relative to project root). */
	pathFilter?: string;
	/** Progress callback for indexing operations. */
	onProgress?: IndexProgressCallback;
}

// ============================================================================
// Search Engine
// ============================================================================

export class SearchEngine {
	private readonly projectRoot: string;
	private indexManager: IndexManager | null = null;
	private embedder: Embedder | null = null;

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
	}

	/** Check if semantic search is available (requires node:sqlite). */
	static isAvailable(): boolean {
		return IndexManager.isAvailable();
	}

	/**
	 * Search the codebase with a natural language or identifier query.
	 *
	 * On first call, builds the index (scans, chunks, embeds). Subsequent calls
	 * incrementally update changed files before searching.
	 */
	async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
		const limit = options?.limit ?? DEFAULT_RESULT_LIMIT;
		const onProgress = options?.onProgress;

		// Ensure index is built and up to date
		const indexManager = this.getIndexManager();
		const db = indexManager.getDb();

		// Share our embedder with IndexManager so it doesn't create a second one
		const embedder = await this.getOrCreateEmbedder();
		indexManager.setEmbedder(embedder);

		await indexManager.buildIndex(onProgress);
		await indexManager.ensureEmbeddings(onProgress);

		// Get all chunks (potentially filtered by path)
		let allChunks = db.getAllChunks();
		if (options?.pathFilter) {
			const filter = options.pathFilter;
			allChunks = allChunks.filter((c) => c.filePath.startsWith(filter));
		}

		if (allChunks.length === 0) {
			return [];
		}

		// Classify query type for POEM column weighting
		const queryType = classifyQuery(query);

		// Compute all 6 metrics
		onProgress?.("searching", 0, 6);

		// 1. BM25 (FTS5)
		const bm25Scores = computeBm25Scores(db, sanitizeFtsQuery(query), METRIC_CANDIDATE_LIMIT);
		onProgress?.("searching", 1, 6);

		// 2. Cosine similarity (vector search)
		const cosineScores = await this.computeVectorScores(db, query, METRIC_CANDIDATE_LIMIT, onProgress);
		onProgress?.("searching", 2, 6);

		// 3. Path match
		const pathScores = computePathMatchScores(query, allChunks);
		onProgress?.("searching", 3, 6);

		// 4. Symbol match
		const symbols = db.getAllSymbols();
		const symbolScores = computeSymbolMatchScores(query, symbols);
		onProgress?.("searching", 4, 6);

		// 5. Import graph (use BM25 + cosine as seed scores, aggregated per file)
		// Only use files with strong scores as seeds — low-scoring files (e.g. from
		// common OR terms matching everywhere) pollute the seed set and prevent
		// meaningful propagation.
		const fileSeedScores = aggregateFileScores(allChunks, bm25Scores, cosineScores);
		const seedThreshold = computeSeedThreshold(fileSeedScores);
		const filteredSeeds = new Map<number, number>();
		for (const [fileId, score] of fileSeedScores) {
			if (score >= seedThreshold) filteredSeeds.set(fileId, score);
		}
		const fileIdToChunkIds = buildFileChunkMap(allChunks);
		const importScores = computeImportGraphScores(db, filteredSeeds, fileIdToChunkIds);
		onProgress?.("searching", 5, 6);

		// 6. Git recency
		const recencyScores = await computeGitRecencyScores(this.projectRoot, allChunks);
		onProgress?.("searching", 6, 6);

		// Build MetricScores for each candidate chunk
		const candidateIds = collectCandidateIds(
			bm25Scores,
			cosineScores,
			pathScores,
			symbolScores,
			importScores,
			recencyScores,
		);
		const candidates = new Map<number, MetricScores>();

		for (const id of candidateIds) {
			candidates.set(id, {
				bm25: bm25Scores.get(id) ?? 0,
				cosine: cosineScores.get(id) ?? 0,
				pathMatch: pathScores.get(id) ?? 0,
				symbolMatch: symbolScores.get(id) ?? 0,
				importGraph: importScores.get(id) ?? 0,
				gitRecency: recencyScores.get(id) ?? 0,
			});
		}

		if (candidates.size === 0) {
			return [];
		}

		// POEM rank
		const ranked = poemRank(candidates, queryType);

		// Assemble results
		const chunkMap = new Map<number, StoredChunk>();
		for (const chunk of allChunks) {
			chunkMap.set(chunk.id, chunk);
		}

		const results: SearchResult[] = [];
		for (const candidate of ranked.slice(0, limit)) {
			const chunk = chunkMap.get(candidate.id);
			if (chunk) {
				results.push({
					chunk,
					scores: candidate.scores,
					rank: candidate.rank,
				});
			}
		}

		return results;
	}

	/** Get index stats without opening a new connection. */
	getStats(): { files: number; chunks: number } | null {
		if (!this.indexManager) return null;
		return this.indexManager.getStats();
	}

	/** Dispose resources. */
	close(): void {
		this.indexManager?.close();
		this.indexManager = null;
		this.embedder?.dispose();
		this.embedder = null;
	}

	// ========================================================================
	// Private
	// ========================================================================

	private getIndexManager(): IndexManager {
		if (!this.indexManager) {
			const config = this.getIndexConfig();
			this.indexManager = new IndexManager(config);
			this.indexManager.open();
		}
		return this.indexManager;
	}

	private getIndexConfig(): IndexConfig {
		return {
			projectRoot: this.projectRoot,
			indexDir: path.join(this.projectRoot, ".dreb", "index"),
			globalMemoryDir: path.join(homedir(), ".dreb", "memory"),
			modelName: DEFAULT_MODEL_NAME,
		};
	}

	private async getOrCreateEmbedder(): Promise<Embedder> {
		if (!this.embedder) {
			const config = this.getIndexConfig();
			this.embedder = new Embedder({
				modelCacheDir: path.join(homedir(), ".dreb", "agent", "models"),
				modelName: config.modelName,
			});
			await this.embedder.initialize();
		}
		return this.embedder;
	}

	private async computeVectorScores(
		db: SearchDatabase,
		query: string,
		limit: number,
		_onProgress?: IndexProgressCallback,
	): Promise<Map<number, number>> {
		const config = this.getIndexConfig();
		const embedder = await this.getOrCreateEmbedder();

		// Embed the query
		const queryVector = await embedder.embedQuery(query);

		// Get all stored embeddings
		const storedVectors = db.getAllEmbeddings(config.modelName);

		if (storedVectors.size === 0) {
			return new Map();
		}

		const topK = topKSimilar(queryVector, storedVectors, limit);

		// Convert to Map, clamping negative similarities to 0
		const scores = new Map<number, number>();
		for (const { id, score } of topK) {
			scores.set(id, Math.max(0, score));
		}
		return scores;
	}
}

// ============================================================================
// Helpers
// ============================================================================

/** Collect all unique chunk IDs that appear in any metric's results. */
function collectCandidateIds(...scoreMaps: Map<number, number>[]): Set<number> {
	const ids = new Set<number>();
	for (const map of scoreMaps) {
		for (const id of map.keys()) {
			ids.add(id);
		}
	}
	return ids;
}

/** Aggregate chunk-level scores to file-level scores (max per file). */
function aggregateFileScores(chunks: StoredChunk[], ...scoreMaps: Map<number, number>[]): Map<number, number> {
	const fileScores = new Map<number, number>();

	for (const chunk of chunks) {
		let maxScore = 0;
		for (const map of scoreMaps) {
			const s = map.get(chunk.id);
			if (s !== undefined && s > maxScore) maxScore = s;
		}
		if (maxScore > 0) {
			const existing = fileScores.get(chunk.fileId);
			if (existing === undefined || maxScore > existing) {
				fileScores.set(chunk.fileId, maxScore);
			}
		}
	}

	return fileScores;
}

/**
 * Compute a dynamic threshold for import graph seeds.
 * Uses the median score — only the top half of files are strong enough seeds.
 * Falls back to 0.1 minimum to avoid accepting near-zero scores.
 */
function computeSeedThreshold(fileScores: Map<number, number>): number {
	if (fileScores.size === 0) return 0;
	const sorted = [...fileScores.values()].sort((a, b) => b - a);
	const median = sorted[Math.floor(sorted.length / 2)];
	return Math.max(median, 0.1);
}

/** Build a map of fileId → chunk IDs for that file. */
function buildFileChunkMap(chunks: StoredChunk[]): Map<number, number[]> {
	const map = new Map<number, number[]>();
	for (const chunk of chunks) {
		const existing = map.get(chunk.fileId);
		if (existing) existing.push(chunk.id);
		else map.set(chunk.fileId, [chunk.id]);
	}
	return map;
}

/** Common English stopwords to exclude from FTS queries. */
const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"for",
	"from",
	"had",
	"has",
	"have",
	"he",
	"her",
	"his",
	"how",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"me",
	"my",
	"no",
	"not",
	"of",
	"on",
	"or",
	"our",
	"she",
	"so",
	"than",
	"that",
	"the",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"this",
	"to",
	"up",
	"us",
	"was",
	"we",
	"what",
	"when",
	"where",
	"which",
	"who",
	"will",
	"with",
	"would",
	"you",
	"your",
]);

/**
 * Sanitize a query string for FTS5 MATCH syntax.
 * FTS5 chokes on certain characters — strip operators and wrap terms.
 *
 * Removes stopwords and uses OR between terms so multi-word queries return
 * partial matches (FTS5's default implicit AND is too restrictive).
 */
function sanitizeFtsQuery(query: string): string {
	// Remove FTS5 operators and special chars
	const cleaned = query
		.replace(/[*"():^{}[\]~!@#$%&=+|<>]/g, " ")
		.replace(/\bAND\b|\bOR\b|\bNOT\b|\bNEAR\b/gi, " ")
		.trim();

	// Split into tokens, remove stopwords, join with OR
	const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0 && !STOPWORDS.has(t.toLowerCase()));
	if (tokens.length === 0) return '""';
	if (tokens.length === 1) return tokens[0];
	return tokens.join(" OR ");
}
