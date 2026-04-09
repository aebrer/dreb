// Core API

// Chunking
export { chunkFile } from "./chunker.js";

// Database
export { isSqliteAvailable, SearchDatabase } from "./db.js";
export type { EmbedderOptions } from "./embedder.js";

// Embedder
export { Embedder } from "./embedder.js";
// Result formatting
export { formatResults } from "./format.js";
// Index management
export { IndexManager } from "./index-manager.js";
export type { RankedCandidate } from "./poem.js";
// Ranking
export { poemRank } from "./poem.js";
export type { QueryType } from "./query-classifier.js";
export { classifyQuery } from "./query-classifier.js";
export type { ScannedFile } from "./scanner.js";
// Scanner
export { detectFileType, scanProject } from "./scanner.js";
export type { SearchEngineOptions, SearchOptions } from "./search.js";
export { SearchEngine } from "./search.js";
// Types
export type {
	Chunk,
	ChunkKind,
	FileType,
	ImportEdge,
	IndexConfig,
	IndexedFile,
	IndexProgressCallback,
	MetricName,
	MetricScores,
	SearchResult,
	StoredChunk,
	StoredEmbedding,
	TextFileType,
	TreeSitterLanguage,
} from "./types.js";
export { METRIC_NAMES } from "./types.js";
// Vector operations
export { cosineSimilarity, packVector, topKSimilar, unpackVector } from "./vector-store.js";
