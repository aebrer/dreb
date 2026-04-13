/**
 * SQLite database abstraction for the search index.
 *
 * Uses `node:sqlite` (built-in Node 22+). Feature-gated — callers must check
 * availability via `isSqliteAvailable()` before constructing a SearchDatabase.
 */

import { createRequire } from "node:module";
import type { ChunkKind, FileType, IndexedFile, StoredChunk } from "./types.js";
import { unpackVector } from "./vector-store.js";

// ============================================================================
// Availability Check
// ============================================================================

const require = createRequire(import.meta.url);
let _sqliteAvailable: boolean | null = null;

/** Check whether `node:sqlite` is available in this Node.js runtime. */
export function isSqliteAvailable(): boolean {
	if (_sqliteAvailable !== null) return _sqliteAvailable;
	try {
		require("node:sqlite");
		_sqliteAvailable = true;
	} catch {
		/* node:sqlite not available (requires Node 22.5+) — gracefully degrade */
		_sqliteAvailable = false;
	}
	return _sqliteAvailable;
}

// ============================================================================
// Schema Version
// ============================================================================

const SCHEMA_VERSION = 1;

// ============================================================================
// Database
// ============================================================================

/** Wrapper around `node:sqlite` DatabaseSync for the search index. */
export class SearchDatabase {
	private db: any; // DatabaseSync from node:sqlite

	constructor(dbPath: string) {
		// Import synchronously — caller must have verified availability
		const { DatabaseSync } = require("node:sqlite");
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode=WAL");
		this.db.exec("PRAGMA synchronous=NORMAL");
		this.db.exec("PRAGMA foreign_keys=ON");
		this.initSchema();
	}

	/** Create or migrate the database schema. */
	private initSchema(): void {
		// Check schema version
		this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
		const versionRow = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
		const currentVersion = versionRow ? Number.parseInt(versionRow.value, 10) : 0;

		if (currentVersion >= SCHEMA_VERSION) return;

		// Files table
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS files (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				file_path TEXT NOT NULL UNIQUE,
				mtime REAL NOT NULL,
				file_type TEXT NOT NULL
			)
		`);

		// Chunks table
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS chunks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
				file_path TEXT NOT NULL,
				start_line INTEGER NOT NULL,
				end_line INTEGER NOT NULL,
				kind TEXT NOT NULL,
				name TEXT,
				content TEXT NOT NULL,
				file_type TEXT NOT NULL
			)
		`);
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id)");
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path)");

		// FTS5 virtual table (content-synced with chunks)
		this.db.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
				content,
				name,
				file_path,
				content='chunks',
				content_rowid='id',
				tokenize='porter unicode61'
			)
		`);

		// FTS triggers for incremental updates
		this.db.exec(`
			CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
				INSERT INTO chunks_fts(rowid, content, name, file_path)
				VALUES (new.id, new.content, new.name, new.file_path);
			END
		`);
		this.db.exec(`
			CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
				INSERT INTO chunks_fts(chunks_fts, rowid, content, name, file_path)
				VALUES ('delete', old.id, old.content, old.name, old.file_path);
			END
		`);
		this.db.exec(`
			CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
				INSERT INTO chunks_fts(chunks_fts, rowid, content, name, file_path)
				VALUES ('delete', old.id, old.content, old.name, old.file_path);
				INSERT INTO chunks_fts(rowid, content, name, file_path)
				VALUES (new.id, new.content, new.name, new.file_path);
			END
		`);

		// Embeddings table (keyed by model name for multi-model support)
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS embeddings (
				chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
				model_name TEXT NOT NULL,
				vector BLOB NOT NULL,
				PRIMARY KEY (chunk_id, model_name)
			)
		`);

		// Imports table (import graph edges between files)
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS imports (
				source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
				target_file_path TEXT NOT NULL,
				PRIMARY KEY (source_file_id, target_file_path)
			)
		`);
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_imports_target ON imports(target_file_path)");

		// Symbols table (symbol names extracted from chunks)
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS symbols (
				chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
				name TEXT NOT NULL,
				kind TEXT NOT NULL
			)
		`);
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)");

		// Set schema version
		this.db
			.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)")
			.run(String(SCHEMA_VERSION));
	}

	// ========================================================================
	// Files
	// ========================================================================

	/** Insert or update a file record. Returns the file ID. */
	upsertFile(filePath: string, mtime: number, fileType: FileType): number {
		const existing = this.db.prepare("SELECT id FROM files WHERE file_path = ?").get(filePath);
		if (existing) {
			this.db.prepare("UPDATE files SET mtime = ?, file_type = ? WHERE id = ?").run(mtime, fileType, existing.id);
			return existing.id;
		}
		const result = this.db
			.prepare("INSERT INTO files (file_path, mtime, file_type) VALUES (?, ?, ?)")
			.run(filePath, mtime, fileType);
		return Number(result.lastInsertRowid);
	}

	/** Get a file by path. */
	getFile(filePath: string): IndexedFile | null {
		const row = this.db
			.prepare("SELECT id, file_path, mtime, file_type FROM files WHERE file_path = ?")
			.get(filePath);
		if (!row) return null;
		return { id: row.id, filePath: row.file_path, mtime: row.mtime, fileType: row.file_type as FileType };
	}

	/** Get all indexed files. */
	getAllFiles(): IndexedFile[] {
		const rows = this.db.prepare("SELECT id, file_path, mtime, file_type FROM files").all();
		return rows.map((r: any) => ({
			id: r.id,
			filePath: r.file_path,
			mtime: r.mtime,
			fileType: r.file_type as FileType,
		}));
	}

	/** Delete a file and all its chunks/embeddings/symbols (cascading). */
	deleteFile(fileId: number): void {
		this.db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
	}

	// ========================================================================
	// Chunks
	// ========================================================================

	/** Insert a chunk. Returns the chunk ID. */
	insertChunk(
		fileId: number,
		filePath: string,
		startLine: number,
		endLine: number,
		kind: ChunkKind,
		name: string | null,
		content: string,
		fileType: FileType,
	): number {
		const result = this.db
			.prepare(
				"INSERT INTO chunks (file_id, file_path, start_line, end_line, kind, name, content, file_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(fileId, filePath, startLine, endLine, kind, name, content, fileType);
		return Number(result.lastInsertRowid);
	}

	/** Delete all chunks for a file. */
	deleteChunksForFile(fileId: number): void {
		this.db.prepare("DELETE FROM chunks WHERE file_id = ?").run(fileId);
	}

	/** Get all chunks. */
	getAllChunks(): StoredChunk[] {
		const rows = this.db
			.prepare("SELECT id, file_id, file_path, start_line, end_line, kind, name, content, file_type FROM chunks")
			.all();
		return rows.map((r: any) => this.rowToChunk(r));
	}

	/** Get chunks by file ID. */
	getChunksByFileId(fileId: number): StoredChunk[] {
		const rows = this.db
			.prepare(
				"SELECT id, file_id, file_path, start_line, end_line, kind, name, content, file_type FROM chunks WHERE file_id = ?",
			)
			.all(fileId);
		return rows.map((r: any) => this.rowToChunk(r));
	}

	/** Get a chunk by ID. */
	getChunk(chunkId: number): StoredChunk | null {
		const row = this.db
			.prepare(
				"SELECT id, file_id, file_path, start_line, end_line, kind, name, content, file_type FROM chunks WHERE id = ?",
			)
			.get(chunkId);
		if (!row) return null;
		return this.rowToChunk(row);
	}

	/** Get multiple chunks by IDs. Batches queries to avoid exceeding SQLite's bind variable limit. */
	getChunksById(chunkIds: number[]): StoredChunk[] {
		if (chunkIds.length === 0) return [];

		const BATCH_SIZE = 500;
		const results: StoredChunk[] = [];

		for (let i = 0; i < chunkIds.length; i += BATCH_SIZE) {
			const batch = chunkIds.slice(i, i + BATCH_SIZE);
			const placeholders = batch.map(() => "?").join(",");
			const rows = this.db
				.prepare(
					`SELECT id, file_id, file_path, start_line, end_line, kind, name, content, file_type FROM chunks WHERE id IN (${placeholders})`,
				)
				.all(...batch);
			for (const r of rows) {
				results.push(this.rowToChunk(r));
			}
		}

		return results;
	}

	private rowToChunk(r: any): StoredChunk {
		return {
			id: r.id,
			fileId: r.file_id,
			filePath: r.file_path,
			startLine: r.start_line,
			endLine: r.end_line,
			kind: r.kind as ChunkKind,
			name: r.name,
			content: r.content,
			fileType: r.file_type as FileType,
		};
	}

	// ========================================================================
	// Embeddings
	// ========================================================================

	/** Store an embedding vector for a chunk. */
	upsertEmbedding(chunkId: number, modelName: string, vector: Float32Array): void {
		const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
		this.db
			.prepare("INSERT OR REPLACE INTO embeddings (chunk_id, model_name, vector) VALUES (?, ?, ?)")
			.run(chunkId, modelName, blob);
	}

	/** Batch insert embeddings. Uses a transaction for performance. */
	batchUpsertEmbeddings(items: Array<{ chunkId: number; modelName: string; vector: Float32Array }>): void {
		const stmt = this.db.prepare("INSERT OR REPLACE INTO embeddings (chunk_id, model_name, vector) VALUES (?, ?, ?)");
		this.transaction(() => {
			for (const item of items) {
				const blob = Buffer.from(item.vector.buffer, item.vector.byteOffset, item.vector.byteLength);
				stmt.run(item.chunkId, item.modelName, blob);
			}
		});
	}

	/** Get the embedding for a chunk. */
	getEmbedding(chunkId: number, modelName: string): Float32Array | null {
		const row = this.db
			.prepare("SELECT vector FROM embeddings WHERE chunk_id = ? AND model_name = ?")
			.get(chunkId, modelName);
		if (!row) return null;
		return unpackVector(row.vector);
	}

	/** Get all embeddings for a model. Returns map of chunkId → vector. */
	getAllEmbeddings(modelName: string): Map<number, Float32Array> {
		const rows = this.db.prepare("SELECT chunk_id, vector FROM embeddings WHERE model_name = ?").all(modelName);
		const map = new Map<number, Float32Array>();
		for (const row of rows) {
			map.set(row.chunk_id, unpackVector(row.vector));
		}
		return map;
	}

	/** Get chunk IDs that have no embedding for a given model. */
	getChunkIdsWithoutEmbedding(modelName: string): number[] {
		const rows = this.db
			.prepare(
				`SELECT c.id FROM chunks c
				 LEFT JOIN embeddings e ON c.id = e.chunk_id AND e.model_name = ?
				 WHERE e.chunk_id IS NULL`,
			)
			.all(modelName);
		return rows.map((r: any) => r.id);
	}

	// ========================================================================
	// FTS5
	// ========================================================================

	/** Rebuild the FTS5 index (use after bulk operations). */
	rebuildFts(): void {
		this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')");
	}

	/**
	 * Search via FTS5 with BM25 ranking.
	 * Returns chunk IDs with their BM25 scores (negated so higher = better).
	 */
	ftsSearch(query: string, limit: number): Array<{ chunkId: number; score: number }> {
		try {
			const rows = this.db
				.prepare(
					`SELECT chunks_fts.rowid as chunk_id, -bm25(chunks_fts, 1.0, 10.0, 5.0) as score
					 FROM chunks_fts
					 WHERE chunks_fts MATCH ?
					 ORDER BY score DESC
					 LIMIT ?`,
				)
				.all(query, limit);
			return rows.map((r: any) => ({ chunkId: r.chunk_id, score: r.score }));
		} catch {
			// FTS5 MATCH can fail on malformed queries
			return [];
		}
	}

	// ========================================================================
	// Imports
	// ========================================================================

	/** Record an import edge. */
	insertImport(sourceFileId: number, targetFilePath: string): void {
		this.db
			.prepare("INSERT OR IGNORE INTO imports (source_file_id, target_file_path) VALUES (?, ?)")
			.run(sourceFileId, targetFilePath);
	}

	/** Delete all imports for a source file. */
	deleteImportsForFile(sourceFileId: number): void {
		this.db.prepare("DELETE FROM imports WHERE source_file_id = ?").run(sourceFileId);
	}

	/** Get files imported by a given source file. */
	getImportsFrom(sourceFileId: number): string[] {
		const rows = this.db.prepare("SELECT target_file_path FROM imports WHERE source_file_id = ?").all(sourceFileId);
		return rows.map((r: any) => r.target_file_path);
	}

	/** Get file IDs that import a given target path. */
	getImportersOf(targetFilePath: string): number[] {
		const rows = this.db.prepare("SELECT source_file_id FROM imports WHERE target_file_path = ?").all(targetFilePath);
		return rows.map((r: any) => r.source_file_id);
	}

	/** Get all import edges. */
	getAllImports(): Array<{ sourceFileId: number; targetFilePath: string }> {
		const rows = this.db.prepare("SELECT source_file_id, target_file_path FROM imports").all();
		return rows.map((r: any) => ({ sourceFileId: r.source_file_id, targetFilePath: r.target_file_path }));
	}

	// ========================================================================
	// Symbols
	// ========================================================================

	/** Insert a symbol. */
	insertSymbol(chunkId: number, name: string, kind: string): void {
		this.db.prepare("INSERT INTO symbols (chunk_id, name, kind) VALUES (?, ?, ?)").run(chunkId, name, kind);
	}

	/** Delete symbols for a chunk. */
	deleteSymbolsForChunk(chunkId: number): void {
		this.db.prepare("DELETE FROM symbols WHERE chunk_id = ?").run(chunkId);
	}

	/** Get all symbols. Returns map of chunkId → symbol names. */
	getAllSymbols(): Map<number, string[]> {
		const rows = this.db.prepare("SELECT chunk_id, name FROM symbols").all();
		const map = new Map<number, string[]>();
		for (const row of rows) {
			const existing = map.get(row.chunk_id);
			if (existing) existing.push(row.name);
			else map.set(row.chunk_id, [row.name]);
		}
		return map;
	}

	// ========================================================================
	// Transaction Helpers
	// ========================================================================

	/** Run a function inside a transaction. */
	transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	/** Get the total number of chunks. */
	getChunkCount(): number {
		const row = this.db.prepare("SELECT COUNT(*) as count FROM chunks").get();
		return row.count;
	}

	/** Get the total number of files. */
	getFileCount(): number {
		const row = this.db.prepare("SELECT COUNT(*) as count FROM files").get();
		return row.count;
	}

	/** Close the database connection. */
	close(): void {
		this.db.close();
	}
}
