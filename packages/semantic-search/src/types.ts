/**
 * Shared types for the semantic codebase search subsystem.
 */

// ============================================================================
// Languages
// ============================================================================

/** Languages supported by tree-sitter AST chunking. */
export type TreeSitterLanguage =
	| "typescript"
	| "tsx"
	| "javascript"
	| "python"
	| "go"
	| "rust"
	| "java"
	| "c"
	| "cpp"
	| "gdscript";

/** Non-code file types chunked by format-specific rules. */
export type TextFileType = "markdown" | "yaml" | "json" | "toml" | "plaintext";

/** Union of all recognized file types. */
export type FileType = TreeSitterLanguage | TextFileType;

// ============================================================================
// Chunks
// ============================================================================

/** The kind of code construct a chunk represents. */
export type ChunkKind =
	| "function"
	| "method"
	| "class"
	| "interface"
	| "struct"
	| "enum"
	| "impl"
	| "export"
	| "type_alias"
	| "module"
	| "heading_section"
	| "top_level_key"
	| "paragraph"
	| "file";

/** A chunk of code or text extracted from a file. */
export interface Chunk {
	/** Relative file path from project root. */
	filePath: string;
	/** 1-indexed start line in the source file. */
	startLine: number;
	/** 1-indexed end line (inclusive) in the source file. */
	endLine: number;
	/** The kind of construct this chunk represents. */
	kind: ChunkKind;
	/** Symbol name (function name, class name, heading text, etc.). Null for anonymous chunks. */
	name: string | null;
	/** The raw source text of the chunk. */
	content: string;
	/** Detected file type. */
	fileType: FileType;
}

// ============================================================================
// Index
// ============================================================================

/** Configuration for the search index. */
export interface IndexConfig {
	/** Absolute path to the project root. */
	projectRoot: string;
	/** Absolute path to the index database directory. */
	indexDir: string;
	/** Absolute path to the global memory directory (e.g. ~/.dreb/memory/). */
	globalMemoryDir?: string;
	/** Additional directories to include in scans (bypasses gitignore). */
	visibleDirs?: string[];
	/** Embedding model name (used to key the embeddings table). */
	modelName: string;
}

/** Stored metadata for a file in the index. */
export interface IndexedFile {
	id: number;
	filePath: string;
	mtime: number;
	fileType: FileType;
}

/** A stored chunk row from the database. */
export interface StoredChunk {
	id: number;
	fileId: number;
	filePath: string;
	startLine: number;
	endLine: number;
	kind: ChunkKind;
	name: string | null;
	content: string;
	fileType: FileType;
}

/** A stored embedding row. */
export interface StoredEmbedding {
	chunkId: number;
	modelName: string;
	vector: Float32Array;
}

// ============================================================================
// Search Results
// ============================================================================

/** A single search result with scores and metadata. */
export interface SearchResult {
	/** The chunk this result refers to. */
	chunk: StoredChunk;
	/** Individual metric scores (0–1, higher is better). */
	scores: MetricScores;
	/** Combined rank from POEM (lower is better, 0 = top of Pareto front). */
	rank: number;
}

/** Scores from each ranking metric. */
export interface MetricScores {
	bm25: number;
	cosine: number;
	pathMatch: number;
	symbolMatch: number;
	importGraph: number;
	gitRecency: number;
}

/** Names of the 6 ranking metrics. */
export type MetricName = keyof MetricScores;

/** All metric names as an array for iteration. */
export const METRIC_NAMES: MetricName[] = ["bm25", "cosine", "pathMatch", "symbolMatch", "importGraph", "gitRecency"];

// ============================================================================
// Callbacks
// ============================================================================

/** Progress reporting callback for index operations. */
export type IndexProgressCallback = (phase: string, current: number, total: number) => void;

// ============================================================================
// Import Graph
// ============================================================================

/** A resolved import edge: source file imports target file. */
export interface ImportEdge {
	/** Relative path of the importing file. */
	source: string;
	/** Relative path of the imported file. */
	target: string;
}
