import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSqliteAvailable, SearchDatabase } from "../src/db.js";

describe("isSqliteAvailable", () => {
	it("returns true on Node 22+", () => {
		expect(isSqliteAvailable()).toBe(true);
	});
});

describe("SearchDatabase", () => {
	let db: SearchDatabase;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "dreb-search-test-"));
		db = new SearchDatabase(path.join(tmpDir, "index.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// ====================================================================
	// Files
	// ====================================================================

	describe("files", () => {
		it("inserts and retrieves a file", () => {
			const id = db.upsertFile("src/main.ts", 1000, "typescript");
			expect(id).toBeGreaterThan(0);

			const file = db.getFile("src/main.ts");
			expect(file).not.toBeNull();
			expect(file!.filePath).toBe("src/main.ts");
			expect(file!.mtime).toBe(1000);
			expect(file!.fileType).toBe("typescript");
			expect(file!.id).toBe(id);
		});

		it("upsertFile updates mtime on second call", () => {
			const id1 = db.upsertFile("src/main.ts", 1000, "typescript");
			const id2 = db.upsertFile("src/main.ts", 2000, "typescript");
			expect(id2).toBe(id1);

			const file = db.getFile("src/main.ts");
			expect(file!.mtime).toBe(2000);
		});

		it("getAllFiles returns all inserted files", () => {
			db.upsertFile("a.ts", 1, "typescript");
			db.upsertFile("b.py", 2, "python");
			db.upsertFile("c.md", 3, "markdown");

			const files = db.getAllFiles();
			expect(files).toHaveLength(3);
			const paths = files.map((f) => f.filePath).sort();
			expect(paths).toEqual(["a.ts", "b.py", "c.md"]);
		});

		it("getFile returns null for unknown path", () => {
			expect(db.getFile("nope.ts")).toBeNull();
		});
	});

	// ====================================================================
	// Chunks
	// ====================================================================

	describe("chunks", () => {
		it("inserts and retrieves a chunk", () => {
			const fileId = db.upsertFile("src/lib.ts", 1000, "typescript");
			const chunkId = db.insertChunk(
				fileId,
				"src/lib.ts",
				1,
				10,
				"function",
				"greet",
				"function greet() {}",
				"typescript",
			);
			expect(chunkId).toBeGreaterThan(0);

			const chunk = db.getChunk(chunkId);
			expect(chunk).not.toBeNull();
			expect(chunk!.id).toBe(chunkId);
			expect(chunk!.fileId).toBe(fileId);
			expect(chunk!.filePath).toBe("src/lib.ts");
			expect(chunk!.startLine).toBe(1);
			expect(chunk!.endLine).toBe(10);
			expect(chunk!.kind).toBe("function");
			expect(chunk!.name).toBe("greet");
			expect(chunk!.content).toBe("function greet() {}");
			expect(chunk!.fileType).toBe("typescript");
		});

		it("getChunk returns null for unknown id", () => {
			expect(db.getChunk(9999)).toBeNull();
		});

		it("getChunksByFileId returns only chunks for that file", () => {
			const f1 = db.upsertFile("a.ts", 1, "typescript");
			const f2 = db.upsertFile("b.ts", 2, "typescript");
			db.insertChunk(f1, "a.ts", 1, 5, "function", "fn1", "code1", "typescript");
			db.insertChunk(f1, "a.ts", 6, 10, "function", "fn2", "code2", "typescript");
			db.insertChunk(f2, "b.ts", 1, 3, "class", "Cls", "code3", "typescript");

			const f1Chunks = db.getChunksByFileId(f1);
			expect(f1Chunks).toHaveLength(2);
			expect(f1Chunks.every((c) => c.fileId === f1)).toBe(true);

			const f2Chunks = db.getChunksByFileId(f2);
			expect(f2Chunks).toHaveLength(1);
			expect(f2Chunks[0].name).toBe("Cls");
		});

		it("getAllChunks returns all chunks", () => {
			const f = db.upsertFile("x.ts", 1, "typescript");
			db.insertChunk(f, "x.ts", 1, 5, "function", "a", "c1", "typescript");
			db.insertChunk(f, "x.ts", 6, 10, "function", "b", "c2", "typescript");

			expect(db.getAllChunks()).toHaveLength(2);
		});
	});

	// ====================================================================
	// Cascading Delete
	// ====================================================================

	describe("cascading delete", () => {
		it("deleteFile removes associated chunks, embeddings, and symbols", () => {
			const fileId = db.upsertFile("del.ts", 1, "typescript");
			const chunkId = db.insertChunk(fileId, "del.ts", 1, 5, "function", "fn", "code", "typescript");
			db.upsertEmbedding(chunkId, "model-a", new Float32Array([1, 2, 3]));
			db.insertSymbol(chunkId, "fn", "function");
			db.insertImport(fileId, "other.ts");

			// Verify data exists
			expect(db.getChunksByFileId(fileId)).toHaveLength(1);
			expect(db.getEmbedding(chunkId, "model-a")).not.toBeNull();
			expect(db.getAllSymbols().get(chunkId)).toBeDefined();
			expect(db.getImportsFrom(fileId)).toHaveLength(1);

			// Delete
			db.deleteFile(fileId);

			// Everything gone
			expect(db.getFile("del.ts")).toBeNull();
			expect(db.getChunksByFileId(fileId)).toHaveLength(0);
			expect(db.getEmbedding(chunkId, "model-a")).toBeNull();
			expect(db.getAllSymbols().get(chunkId)).toBeUndefined();
			expect(db.getImportsFrom(fileId)).toHaveLength(0);
		});
	});

	// ====================================================================
	// FTS5 Search
	// ====================================================================

	describe("FTS5 search", () => {
		it("returns matching chunks ranked by BM25", () => {
			const fileId = db.upsertFile("search.ts", 1, "typescript");
			// Chunk 1: mentions "authenticate" heavily
			db.insertChunk(
				fileId,
				"search.ts",
				1,
				10,
				"function",
				"authenticate",
				"function authenticate(user) { authenticate the user credentials; authenticate again }",
				"typescript",
			);
			// Chunk 2: mentions "authenticate" once
			db.insertChunk(
				fileId,
				"search.ts",
				11,
				20,
				"function",
				"process",
				"function process(data) { after authenticate, process the data }",
				"typescript",
			);
			// Chunk 3: unrelated
			db.insertChunk(
				fileId,
				"search.ts",
				21,
				30,
				"function",
				"render",
				"function render(html) { output the rendered template }",
				"typescript",
			);

			const results = db.ftsSearch("authenticate", 10);
			expect(results.length).toBeGreaterThanOrEqual(2);
			// First result should be the one with more occurrences
			expect(results[0].chunkId).toBeDefined();
			expect(results[0].score).toBeGreaterThan(0);
			// Scores should be descending
			for (let i = 1; i < results.length; i++) {
				expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
			}
		});

		it("returns empty array for no match", () => {
			const fileId = db.upsertFile("empty.ts", 1, "typescript");
			db.insertChunk(fileId, "empty.ts", 1, 5, "function", "hello", "hello world", "typescript");
			expect(db.ftsSearch("zzzznotfound", 10)).toEqual([]);
		});

		it("returns empty array for malformed query", () => {
			expect(db.ftsSearch("AND OR NOT", 10)).toEqual([]);
		});
	});

	// ====================================================================
	// Embeddings
	// ====================================================================

	describe("embeddings", () => {
		it("roundtrips Float32Array through upsertEmbedding / getEmbedding", () => {
			const fileId = db.upsertFile("emb.ts", 1, "typescript");
			const chunkId = db.insertChunk(fileId, "emb.ts", 1, 5, "function", "fn", "code", "typescript");
			const vec = new Float32Array([0.1, 0.2, 0.3, -0.5, 1.0]);

			db.upsertEmbedding(chunkId, "test-model", vec);
			const retrieved = db.getEmbedding(chunkId, "test-model");

			expect(retrieved).not.toBeNull();
			expect(retrieved!.length).toBe(vec.length);
			for (let i = 0; i < vec.length; i++) {
				expect(retrieved![i]).toBeCloseTo(vec[i], 5);
			}
		});

		it("getEmbedding returns null for missing chunk", () => {
			expect(db.getEmbedding(9999, "model")).toBeNull();
		});

		it("upsertEmbedding overwrites previous vector", () => {
			const fileId = db.upsertFile("emb2.ts", 1, "typescript");
			const chunkId = db.insertChunk(fileId, "emb2.ts", 1, 5, "function", "fn", "code", "typescript");

			db.upsertEmbedding(chunkId, "m", new Float32Array([1, 2, 3]));
			db.upsertEmbedding(chunkId, "m", new Float32Array([4, 5, 6]));

			const retrieved = db.getEmbedding(chunkId, "m");
			expect(retrieved![0]).toBeCloseTo(4, 5);
		});

		it("batchUpsertEmbeddings inserts all items", () => {
			const fileId = db.upsertFile("batch.ts", 1, "typescript");
			const c1 = db.insertChunk(fileId, "batch.ts", 1, 5, "function", "a", "a", "typescript");
			const c2 = db.insertChunk(fileId, "batch.ts", 6, 10, "function", "b", "b", "typescript");
			const c3 = db.insertChunk(fileId, "batch.ts", 11, 15, "function", "c", "c", "typescript");

			db.batchUpsertEmbeddings([
				{ chunkId: c1, modelName: "m", vector: new Float32Array([1, 0, 0]) },
				{ chunkId: c2, modelName: "m", vector: new Float32Array([0, 1, 0]) },
				{ chunkId: c3, modelName: "m", vector: new Float32Array([0, 0, 1]) },
			]);

			expect(db.getEmbedding(c1, "m")).not.toBeNull();
			expect(db.getEmbedding(c2, "m")).not.toBeNull();
			expect(db.getEmbedding(c3, "m")).not.toBeNull();
		});

		it("getAllEmbeddings returns correct map", () => {
			const fileId = db.upsertFile("all.ts", 1, "typescript");
			const c1 = db.insertChunk(fileId, "all.ts", 1, 5, "function", "a", "a", "typescript");
			const c2 = db.insertChunk(fileId, "all.ts", 6, 10, "function", "b", "b", "typescript");

			db.upsertEmbedding(c1, "m", new Float32Array([1, 2]));
			db.upsertEmbedding(c2, "m", new Float32Array([3, 4]));
			// Different model — should not appear
			db.upsertEmbedding(c1, "other", new Float32Array([9, 9]));

			const map = db.getAllEmbeddings("m");
			expect(map.size).toBe(2);
			expect(map.get(c1)![0]).toBeCloseTo(1, 5);
			expect(map.get(c2)![0]).toBeCloseTo(3, 5);
		});

		it("getChunkIdsWithoutEmbedding finds unembedded chunks", () => {
			const fileId = db.upsertFile("gaps.ts", 1, "typescript");
			const c1 = db.insertChunk(fileId, "gaps.ts", 1, 5, "function", "a", "a", "typescript");
			const c2 = db.insertChunk(fileId, "gaps.ts", 6, 10, "function", "b", "b", "typescript");
			const c3 = db.insertChunk(fileId, "gaps.ts", 11, 15, "function", "c", "c", "typescript");

			db.upsertEmbedding(c1, "m", new Float32Array([1]));
			// c2 and c3 have no embedding for model "m"

			const missing = db.getChunkIdsWithoutEmbedding("m");
			expect(missing).toHaveLength(2);
			expect(missing.sort()).toEqual([c2, c3].sort());
		});
	});

	// ====================================================================
	// Imports
	// ====================================================================

	describe("imports", () => {
		it("insertImport and getImportsFrom", () => {
			const fileId = db.upsertFile("src/app.ts", 1, "typescript");
			db.insertImport(fileId, "src/utils.ts");
			db.insertImport(fileId, "src/config.ts");

			const imports = db.getImportsFrom(fileId);
			expect(imports.sort()).toEqual(["src/config.ts", "src/utils.ts"]);
		});

		it("getImportersOf returns source file IDs", () => {
			const f1 = db.upsertFile("a.ts", 1, "typescript");
			const f2 = db.upsertFile("b.ts", 2, "typescript");
			db.insertImport(f1, "shared.ts");
			db.insertImport(f2, "shared.ts");

			const importers = db.getImportersOf("shared.ts");
			expect(importers.sort()).toEqual([f1, f2].sort());
		});

		it("insertImport is idempotent (OR IGNORE)", () => {
			const fileId = db.upsertFile("dup.ts", 1, "typescript");
			db.insertImport(fileId, "target.ts");
			db.insertImport(fileId, "target.ts"); // duplicate

			expect(db.getImportsFrom(fileId)).toHaveLength(1);
		});
	});

	// ====================================================================
	// Symbols
	// ====================================================================

	describe("symbols", () => {
		it("insertSymbol and getAllSymbols", () => {
			const fileId = db.upsertFile("sym.ts", 1, "typescript");
			const c1 = db.insertChunk(fileId, "sym.ts", 1, 10, "function", "foo", "fn foo", "typescript");
			const c2 = db.insertChunk(fileId, "sym.ts", 11, 20, "class", "Bar", "class Bar", "typescript");

			db.insertSymbol(c1, "foo", "function");
			db.insertSymbol(c1, "fooHelper", "function");
			db.insertSymbol(c2, "Bar", "class");

			const symbols = db.getAllSymbols();
			expect(symbols.get(c1)).toEqual(["foo", "fooHelper"]);
			expect(symbols.get(c2)).toEqual(["Bar"]);
		});
	});

	// ====================================================================
	// Transaction Helper
	// ====================================================================

	describe("transaction", () => {
		it("commits on success", () => {
			db.transaction(() => {
				db.upsertFile("tx-ok.ts", 1, "typescript");
			});
			expect(db.getFile("tx-ok.ts")).not.toBeNull();
		});

		it("rolls back on error", () => {
			expect(() =>
				db.transaction(() => {
					db.upsertFile("tx-fail.ts", 1, "typescript");
					throw new Error("boom");
				}),
			).toThrow("boom");

			expect(db.getFile("tx-fail.ts")).toBeNull();
		});
	});

	// ====================================================================
	// Counts
	// ====================================================================

	describe("counts", () => {
		it("getChunkCount and getFileCount", () => {
			expect(db.getFileCount()).toBe(0);
			expect(db.getChunkCount()).toBe(0);

			const f1 = db.upsertFile("one.ts", 1, "typescript");
			const f2 = db.upsertFile("two.ts", 2, "typescript");
			db.insertChunk(f1, "one.ts", 1, 5, "function", "a", "a", "typescript");
			db.insertChunk(f1, "one.ts", 6, 10, "function", "b", "b", "typescript");
			db.insertChunk(f2, "two.ts", 1, 3, "class", "C", "c", "typescript");

			expect(db.getFileCount()).toBe(2);
			expect(db.getChunkCount()).toBe(3);
		});
	});

	// ====================================================================
	// getChunksById (batching)
	// ====================================================================

	describe("getChunksById", () => {
		it("returns empty array for empty input", () => {
			expect(db.getChunksById([])).toEqual([]);
		});

		it("returns matching chunks for valid IDs", () => {
			const fileId = db.upsertFile("test.ts", 1, "typescript");
			const c1 = db.insertChunk(fileId, "test.ts", 1, 5, "function", "fn1", "code1", "typescript");
			const c2 = db.insertChunk(fileId, "test.ts", 6, 10, "function", "fn2", "code2", "typescript");

			const results = db.getChunksById([c1, c2]);
			expect(results).toHaveLength(2);
			const ids = results.map((c) => c.id).sort();
			expect(ids).toEqual([c1, c2].sort());
		});

		it("returns only existing chunks (ignores invalid IDs)", () => {
			const fileId = db.upsertFile("test.ts", 1, "typescript");
			const c1 = db.insertChunk(fileId, "test.ts", 1, 5, "function", "fn1", "code1", "typescript");

			const results = db.getChunksById([c1, 99999, 88888]);
			expect(results).toHaveLength(1);
			expect(results[0].id).toBe(c1);
		});

		it("handles exactly 500 IDs (one full batch)", () => {
			const fileId = db.upsertFile("test.ts", Date.now(), "typescript");
			const ids: number[] = [];
			for (let i = 0; i < 500; i++) {
				ids.push(db.insertChunk(fileId, "test.ts", i, i + 1, "function", `fn${i}`, `content ${i}`, "typescript"));
			}

			const results = db.getChunksById(ids);
			expect(results).toHaveLength(500);
		});

		it("handles 501 IDs (crosses batch boundary)", () => {
			const fileId = db.upsertFile("test.ts", Date.now(), "typescript");
			const ids: number[] = [];
			for (let i = 0; i < 501; i++) {
				ids.push(db.insertChunk(fileId, "test.ts", i, i + 1, "function", `fn${i}`, `content ${i}`, "typescript"));
			}

			const results = db.getChunksById(ids);
			expect(results).toHaveLength(501);
		});

		it("handles 1000+ IDs (multiple batches)", () => {
			const fileId = db.upsertFile("test.ts", Date.now(), "typescript");
			const ids: number[] = [];
			for (let i = 0; i < 1001; i++) {
				ids.push(db.insertChunk(fileId, "test.ts", i, i + 1, "function", `fn${i}`, `content ${i}`, "typescript"));
			}

			const results = db.getChunksById(ids);
			expect(results).toHaveLength(1001);
			// Verify all IDs are present
			const returnedIds = new Set(results.map((c) => c.id));
			for (const id of ids) {
				expect(returnedIds.has(id)).toBe(true);
			}
		});

		it("returns results in correct shape (all StoredChunk fields present)", () => {
			const fileId = db.upsertFile("shape.ts", 1, "typescript");
			const chunkId = db.insertChunk(
				fileId,
				"shape.ts",
				5,
				15,
				"class",
				"MyClass",
				"class MyClass {}",
				"typescript",
			);

			const results = db.getChunksById([chunkId]);
			expect(results).toHaveLength(1);
			const c = results[0];
			expect(c.id).toBe(chunkId);
			expect(c.fileId).toBe(fileId);
			expect(c.filePath).toBe("shape.ts");
			expect(c.startLine).toBe(5);
			expect(c.endLine).toBe(15);
			expect(c.kind).toBe("class");
			expect(c.name).toBe("MyClass");
			expect(c.content).toBe("class MyClass {}");
			expect(c.fileType).toBe("typescript");
		});
	});
});
