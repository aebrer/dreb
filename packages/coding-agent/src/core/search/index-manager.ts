/**
 * Index lifecycle manager.
 *
 * Orchestrates: file scanning → chunking → embedding → FTS indexing → import graph.
 * Supports incremental updates via mtime comparison.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { chunkFile } from "./chunker.js";
import type { SearchDatabase } from "./db.js";
import { isSqliteAvailable, SearchDatabase as SearchDatabaseClass } from "./db.js";
import { Embedder } from "./embedder.js";
import { type ScannedFile, scanProject } from "./scanner.js";
import type { IndexConfig, IndexedFile, IndexProgressCallback } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const DB_FILENAME = "search.db";

// ============================================================================
// Index Manager
// ============================================================================

export class IndexManager {
	private readonly config: IndexConfig;
	private db: SearchDatabase | null = null;
	private embedder: Embedder | null = null;

	constructor(config: IndexConfig) {
		this.config = config;
	}

	/** Check if node:sqlite is available. */
	static isAvailable(): boolean {
		return isSqliteAvailable();
	}

	/** Open or create the index database. */
	open(): SearchDatabase {
		if (this.db) return this.db;

		mkdirSync(this.config.indexDir, { recursive: true });
		const dbPath = path.join(this.config.indexDir, DB_FILENAME);
		this.db = new SearchDatabaseClass(dbPath);
		return this.db;
	}

	/** Close the database and dispose resources. */
	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
		if (this.embedder) {
			this.embedder.dispose();
			this.embedder = null;
		}
	}

	/** Get the database, opening if needed. */
	getDb(): SearchDatabase {
		if (!this.db) return this.open();
		return this.db;
	}

	/**
	 * Build or incrementally update the index.
	 *
	 * 1. Scan project for files
	 * 2. Compare mtimes against stored records
	 * 3. Re-chunk and re-embed only changed/new files
	 * 4. Remove deleted files
	 */
	async buildIndex(onProgress?: IndexProgressCallback): Promise<{ added: number; updated: number; removed: number }> {
		const db = this.getDb();
		const config = this.config;

		// Phase 1: Scan
		onProgress?.("scanning", 0, 1);
		const scannedFiles = await scanProject(config.projectRoot, config.globalMemoryDir);
		onProgress?.("scanning", 1, 1);

		// Phase 2: Diff against existing index
		const existingFiles = db.getAllFiles();
		const existingByPath = new Map<string, IndexedFile>();
		for (const f of existingFiles) {
			existingByPath.set(f.filePath, f);
		}

		const scannedByPath = new Map<string, ScannedFile>();
		for (const f of scannedFiles) {
			scannedByPath.set(f.filePath, f);
		}

		const toAdd: ScannedFile[] = [];
		const toUpdate: ScannedFile[] = [];
		const toRemove: IndexedFile[] = [];

		// Find new and changed files
		for (const scanned of scannedFiles) {
			const existing = existingByPath.get(scanned.filePath);
			if (!existing) {
				toAdd.push(scanned);
			} else if (existing.mtime !== scanned.mtime) {
				toUpdate.push(scanned);
			}
		}

		// Find deleted files
		for (const existing of existingFiles) {
			if (!scannedByPath.has(existing.filePath)) {
				toRemove.push(existing);
			}
		}

		const totalWork = toAdd.length + toUpdate.length + toRemove.length;
		if (totalWork === 0) {
			return { added: 0, updated: 0, removed: 0 };
		}

		// Phase 3: Remove deleted files
		for (const file of toRemove) {
			db.deleteFile(file.id);
		}

		// Phase 4: Process new and changed files
		const filesToProcess = [...toAdd, ...toUpdate];
		const allNewChunkIds: number[] = [];

		for (let i = 0; i < filesToProcess.length; i++) {
			const scanned = filesToProcess[i];
			onProgress?.("indexing", i + 1, filesToProcess.length);

			try {
				// Read file content and chunk BEFORE the transaction so that
				// failures in I/O or chunking don't leave a committed mtime
				// with zero chunks (which would make the file permanently invisible).
				const absPath = scanned.filePath.startsWith("~memory/")
					? path.join(this.config.globalMemoryDir ?? "", scanned.filePath.replace("~memory/", ""))
					: path.join(config.projectRoot, scanned.filePath);

				const content = readFileSync(absPath, "utf-8");
				const chunks = await chunkFile(content, scanned.filePath, scanned.fileType);
				const imports = extractImports(content, scanned.filePath, scanned.fileType);

				// All DB mutations in a single transaction — atomic per file
				db.transaction(() => {
					const fileId = db.upsertFile(scanned.filePath, scanned.mtime, scanned.fileType);

					// Delete old chunks (for updates)
					const existingFile = existingByPath.get(scanned.filePath);
					if (existingFile) {
						db.deleteChunksForFile(existingFile.id);
						db.deleteImportsForFile(existingFile.id);
					}

					// Insert chunks and symbols
					for (const chunk of chunks) {
						const chunkId = db.insertChunk(
							fileId,
							chunk.filePath,
							chunk.startLine,
							chunk.endLine,
							chunk.kind,
							chunk.name,
							chunk.content,
							chunk.fileType,
						);
						allNewChunkIds.push(chunkId);

						if (chunk.name) {
							db.insertSymbol(chunkId, chunk.name, chunk.kind);
						}
					}

					// Store import edges
					for (const imp of imports) {
						db.insertImport(fileId, imp);
					}
				});
			} catch {
				// Skip files that fail to process (permissions, encoding issues, etc.)
			}
		}

		// Phase 5: Embed new chunks
		if (allNewChunkIds.length > 0) {
			await this.embedChunks(db, allNewChunkIds, onProgress);
		}

		return { added: toAdd.length, updated: toUpdate.length, removed: toRemove.length };
	}

	/**
	 * Ensure all chunks have embeddings, generating any missing ones.
	 */
	async ensureEmbeddings(onProgress?: IndexProgressCallback): Promise<number> {
		const db = this.getDb();
		const missingIds = db.getChunkIdsWithoutEmbedding(this.config.modelName);
		if (missingIds.length === 0) return 0;

		await this.embedChunks(db, missingIds, onProgress);
		return missingIds.length;
	}

	/**
	 * Generate embeddings for specific chunks.
	 */
	private async embedChunks(
		db: SearchDatabase,
		chunkIds: number[],
		onProgress?: IndexProgressCallback,
	): Promise<void> {
		if (chunkIds.length === 0) return;

		// Initialize embedder if needed
		if (!this.embedder) {
			onProgress?.("loading model", 0, 1);
			this.embedder = new Embedder({
				modelCacheDir: path.join(homedir(), ".dreb", "agent", "models"),
				modelName: this.config.modelName,
			});
			await this.embedder.initialize();
			onProgress?.("loading model", 1, 1);
		}

		// Get chunk contents
		const chunks = db.getChunksById(chunkIds);
		const texts = chunks.map((c) => c.content);

		// Generate embeddings
		const vectors = await this.embedder.embedDocuments(texts, onProgress);

		// Store embeddings
		const items = chunks.map((chunk, i) => ({
			chunkId: chunk.id,
			modelName: this.config.modelName,
			vector: vectors[i],
		}));
		db.batchUpsertEmbeddings(items);
	}

	/** Check if the index exists. */
	indexExists(): boolean {
		const dbPath = path.join(this.config.indexDir, DB_FILENAME);
		return existsSync(dbPath);
	}

	/** Get index stats. */
	getStats(): { files: number; chunks: number } | null {
		if (!this.indexExists()) return null;
		const db = this.getDb();
		return {
			files: db.getFileCount(),
			chunks: db.getChunkCount(),
		};
	}
}

// ============================================================================
// Import Extraction (simple regex-based)
// ============================================================================

/**
 * Extract import targets from source code.
 * Returns resolved relative paths (without extensions for JS/TS).
 */
function extractImports(content: string, filePath: string, fileType: string): string[] {
	const imports: string[] = [];
	const dir = path.dirname(filePath);

	if (fileType === "typescript" || fileType === "tsx" || fileType === "javascript") {
		// ES6 imports: import ... from '...'
		// require(): require('...')
		const importRe = /(?:import\s+.*?\s+from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
		for (const match of content.matchAll(importRe)) {
			const target = match[1];
			if (target.startsWith(".")) {
				imports.push(resolveImportPath(dir, target));
			}
		}
	} else if (fileType === "python") {
		// from . import X, from .module import X
		const fromRe = /from\s+(\.\S*)\s+import/g;
		for (const match of content.matchAll(fromRe)) {
			const resolved = resolvePythonImport(dir, match[1]);
			if (resolved) imports.push(resolved);
		}
	} else if (fileType === "go") {
		// import "..." or import ( "..." )
		const importRe = /import\s+(?:\(\s*(?:[\s\S]*?)\s*\)|"([^"]+)")/g;
		const pathRe = /"([^"]+)"/g;
		for (const match of content.matchAll(importRe)) {
			if (match[1]) {
				imports.push(match[1]);
			} else {
				// Multi-line import block
				for (const inner of match[0].matchAll(pathRe)) {
					imports.push(inner[1]);
				}
			}
		}
	} else if (fileType === "rust") {
		// use crate::..., use super::...,
		const useRe = /use\s+((?:crate|super|self)::[\w:]+)/g;
		for (const match of content.matchAll(useRe)) {
			imports.push(match[1].replace(/::/g, "/"));
		}
	} else if (fileType === "java") {
		// import com.example.Foo;
		const importRe = /import\s+([\w.]+)\s*;/g;
		for (const match of content.matchAll(importRe)) {
			imports.push(match[1].replace(/\./g, "/"));
		}
	} else if (fileType === "c" || fileType === "cpp") {
		// #include "local.h"
		const includeRe = /#include\s+"([^"]+)"/g;
		for (const match of content.matchAll(includeRe)) {
			imports.push(path.posix.join(dir, match[1]));
		}
	}

	return imports;
}

/** Resolve a relative JS/TS import to a file path. */
function resolveImportPath(fromDir: string, importPath: string): string {
	// Strip .js/.ts extension if present (normalize)
	const cleaned = importPath.replace(/\.[jt]sx?$/, "");
	return path.posix.join(fromDir, cleaned);
}

/** Resolve a Python relative import. */
function resolvePythonImport(fromDir: string, importPath: string): string | null {
	if (importPath === ".") return fromDir;
	const dots = importPath.match(/^(\.+)/);
	if (!dots) return null;
	const levels = dots[1].length - 1;
	const remainder = importPath.slice(dots[1].length).replace(/\./g, "/");
	let base = fromDir;
	for (let i = 0; i < levels; i++) {
		base = path.posix.dirname(base);
	}
	return remainder ? path.posix.join(base, remainder) : base;
}
