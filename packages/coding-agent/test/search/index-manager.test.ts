import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexManager } from "../../src/core/search/index-manager.js";
import type { IndexConfig, IndexProgressCallback } from "../../src/core/search/types.js";

// Mock the embedder to avoid downloading real models during tests.
// The mock returns zero-vectors of the correct dimensionality.
vi.mock("../../src/core/search/embedder.js", () => ({
	Embedder: class MockEmbedder {
		async initialize() {}
		async embedDocuments(texts: string[]) {
			return texts.map(() => new Float32Array(384).fill(0));
		}
		dispose() {}
	},
}));

// ============================================================================
// Helpers
// ============================================================================

function createFixtureProject(dir: string, files: Record<string, string>): void {
	for (const [relPath, content] of Object.entries(files)) {
		const absPath = path.join(dir, relPath);
		mkdirSync(path.dirname(absPath), { recursive: true });
		writeFileSync(absPath, content, "utf-8");
	}
}

/** Set a file's mtime to a specific date (for incremental update testing). */
function setMtime(filePath: string, date: Date): void {
	utimesSync(filePath, date, date);
}

// ============================================================================
// Tests
// ============================================================================

describe("IndexManager", () => {
	let tmpDir: string;
	let projectDir: string;
	let indexDir: string;
	let config: IndexConfig;
	let manager: IndexManager;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "dreb-idx-mgr-"));
		projectDir = path.join(tmpDir, "project");
		indexDir = path.join(tmpDir, "index");
		mkdirSync(projectDir, { recursive: true });

		config = {
			projectRoot: projectDir,
			indexDir,
			modelName: "Xenova/all-MiniLM-L6-v2",
		};
		manager = new IndexManager(config);
	});

	afterEach(() => {
		manager.close();
		// Restore permissions on any chmod'd files so rmSync can clean up
		try {
			const badPath = path.join(projectDir, "bad.md");
			if (existsSync(badPath)) chmodSync(badPath, 0o644);
		} catch {
			/* ignore */
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// ====================================================================
	// Static: isAvailable
	// ====================================================================

	it("isAvailable() returns true on Node 22+", () => {
		expect(IndexManager.isAvailable()).toBe(true);
	});

	// ====================================================================
	// Lifecycle: open / close / getDb
	// ====================================================================

	describe("open", () => {
		it("creates the index directory and database file", () => {
			expect(existsSync(indexDir)).toBe(false);

			const db = manager.open();
			expect(db).toBeDefined();
			expect(existsSync(indexDir)).toBe(true);
			expect(existsSync(path.join(indexDir, "search.db"))).toBe(true);
		});

		it("returns the same database on repeated calls", () => {
			const db1 = manager.open();
			const db2 = manager.open();
			expect(db2).toBe(db1);
		});
	});

	describe("close", () => {
		it("succeeds after open", () => {
			manager.open();
			expect(() => manager.close()).not.toThrow();
		});

		it("does not throw on double close", () => {
			manager.open();
			manager.close();
			expect(() => manager.close()).not.toThrow();
		});

		it("does not throw if never opened", () => {
			expect(() => manager.close()).not.toThrow();
		});
	});

	describe("getDb", () => {
		it("auto-opens the database if not already open", () => {
			expect(existsSync(indexDir)).toBe(false);

			const db = manager.getDb();
			expect(db).toBeDefined();
			expect(existsSync(path.join(indexDir, "search.db"))).toBe(true);
		});
	});

	// ====================================================================
	// indexExists / getStats
	// ====================================================================

	describe("indexExists", () => {
		it("returns false when the database file does not exist", () => {
			expect(manager.indexExists()).toBe(false);
		});

		it("returns true after open()", () => {
			manager.open();
			expect(manager.indexExists()).toBe(true);
		});
	});

	describe("getStats", () => {
		it("returns null when the index does not exist", () => {
			expect(manager.getStats()).toBeNull();
		});

		it("returns zero counts on a freshly opened (empty) index", () => {
			manager.open();
			const stats = manager.getStats();
			expect(stats).toEqual({ files: 0, chunks: 0 });
		});

		it("returns correct counts after buildIndex", async () => {
			createFixtureProject(projectDir, {
				"readme.md": "# Hello\n\nSome content here.",
				"notes.md": "# Notes\n\nMore content.",
			});

			await manager.buildIndex();
			const stats = manager.getStats();

			expect(stats).not.toBeNull();
			expect(stats!.files).toBe(2);
			expect(stats!.chunks).toBeGreaterThan(0);
		});
	});

	// ====================================================================
	// buildIndex
	// ====================================================================

	describe("buildIndex", () => {
		it("returns all zeros for an empty project", async () => {
			const result = await manager.buildIndex();
			expect(result).toEqual({ added: 0, updated: 0, removed: 0 });
		});

		it("adds new files on first build", async () => {
			createFixtureProject(projectDir, {
				"alpha.md": "# Alpha\n\nFirst file.",
				"beta.md": "# Beta\n\nSecond file.",
				"gamma.md": "# Gamma\n\nThird file.",
			});

			const result = await manager.buildIndex();
			expect(result.added).toBe(3);
			expect(result.updated).toBe(0);
			expect(result.removed).toBe(0);

			// Verify the DB contains all files
			const db = manager.getDb();
			expect(db.getFileCount()).toBe(3);
			expect(db.getChunkCount()).toBeGreaterThan(0);
		});

		it("returns all zeros on second build with no changes", async () => {
			createFixtureProject(projectDir, {
				"stable.md": "# Stable\n\nUnchanging content.",
			});

			await manager.buildIndex();
			const result = await manager.buildIndex();

			expect(result).toEqual({ added: 0, updated: 0, removed: 0 });
		});

		it("detects mtime changes and reports updated count", async () => {
			createFixtureProject(projectDir, {
				"changing.md": "# Original\n\nOriginal content.",
				"static.md": "# Static\n\nStatic content.",
			});

			await manager.buildIndex();

			// Touch the file to change its mtime (set it 10 seconds in the future)
			const futureDate = new Date(Date.now() + 10_000);
			setMtime(path.join(projectDir, "changing.md"), futureDate);

			const result = await manager.buildIndex();
			expect(result.added).toBe(0);
			expect(result.updated).toBe(1);
			expect(result.removed).toBe(0);
		});

		it("detects deleted files and reports removed count", async () => {
			createFixtureProject(projectDir, {
				"keep.md": "# Keep\n\nStays around.",
				"remove.md": "# Remove\n\nGoing away.",
			});

			await manager.buildIndex();
			expect(manager.getDb().getFileCount()).toBe(2);

			// Delete the file
			unlinkSync(path.join(projectDir, "remove.md"));

			const result = await manager.buildIndex();
			expect(result.added).toBe(0);
			expect(result.updated).toBe(0);
			expect(result.removed).toBe(1);
			expect(manager.getDb().getFileCount()).toBe(1);
		});

		it("handles add + update + remove in one build", async () => {
			createFixtureProject(projectDir, {
				"a.md": "# A\n\nFile A.",
				"b.md": "# B\n\nFile B.",
				"c.md": "# C\n\nFile C.",
			});

			await manager.buildIndex();

			// a.md: update mtime
			setMtime(path.join(projectDir, "a.md"), new Date(Date.now() + 10_000));
			// b.md: delete
			unlinkSync(path.join(projectDir, "b.md"));
			// d.md: add new file
			writeFileSync(path.join(projectDir, "d.md"), "# D\n\nFile D.", "utf-8");

			const result = await manager.buildIndex();
			expect(result.updated).toBe(1); // a.md
			expect(result.removed).toBe(1); // b.md
			expect(result.added).toBe(1); // d.md
		});

		it("invokes the progress callback", async () => {
			createFixtureProject(projectDir, {
				"file.md": "# Progress\n\nTest progress callbacks.",
			});

			const phases: string[] = [];
			const onProgress: IndexProgressCallback = (phase) => {
				if (!phases.includes(phase)) phases.push(phase);
			};

			await manager.buildIndex(onProgress);

			expect(phases).toContain("scanning");
			expect(phases).toContain("indexing");
		});

		it("ignores files in SKIP_DIRS (e.g. node_modules)", async () => {
			createFixtureProject(projectDir, {
				"src/main.md": "# Main\n\nSource file.",
				"node_modules/pkg/index.md": "# Package\n\nShould be ignored.",
			});

			const result = await manager.buildIndex();
			expect(result.added).toBe(1);
			expect(manager.getDb().getFileCount()).toBe(1);
			expect(manager.getDb().getFile("src/main.md")).not.toBeNull();
		});

		it("only indexes files with recognized extensions", async () => {
			createFixtureProject(projectDir, {
				"readme.md": "# Readme\n\nIndexable.",
				"image.png": "binary data not a real png",
				"data.csv": "a,b,c\n1,2,3",
			});

			const result = await manager.buildIndex();
			// Only .md is in the extension map; .png and .csv are not
			expect(result.added).toBe(1);
		});
	});

	// ====================================================================
	// Per-file atomicity (Finding 1 validation)
	// ====================================================================

	describe("per-file atomicity", () => {
		// Skip if running as root — chmod(000) doesn't prevent root from reading
		const isRoot = process.getuid?.() === 0;

		it.skipIf(isRoot)("a file that fails to read is not stored in the DB", async () => {
			createFixtureProject(projectDir, {
				"good.md": "# Good\n\nThis file is readable.",
				"bad.md": "# Bad\n\nThis file will be unreadable.",
			});

			// Make bad.md unreadable — scanner's statSync still works,
			// but readFileSync in buildIndex will throw EACCES.
			chmodSync(path.join(projectDir, "bad.md"), 0o000);

			await manager.buildIndex();

			const db = manager.getDb();

			// good.md should be indexed normally
			const goodFile = db.getFile("good.md");
			expect(goodFile).not.toBeNull();
			expect(db.getChunksByFileId(goodFile!.id).length).toBeGreaterThan(0);

			// bad.md should NOT be in the DB — readFileSync threw,
			// so the transaction (including upsertFile) was never executed.
			const badFile = db.getFile("bad.md");
			expect(badFile).toBeNull();
		});

		it.skipIf(isRoot)("a previously failed file is retried on next build", async () => {
			createFixtureProject(projectDir, {
				"good.md": "# Good\n\nReadable.",
				"bad.md": "# Retry\n\nWill become readable.",
			});

			// First build: bad.md is unreadable
			chmodSync(path.join(projectDir, "bad.md"), 0o000);
			await manager.buildIndex();
			expect(manager.getDb().getFile("bad.md")).toBeNull();

			// Restore permissions
			chmodSync(path.join(projectDir, "bad.md"), 0o644);

			// Second build: bad.md is now readable and should be indexed
			const result = await manager.buildIndex();
			expect(result.added).toBeGreaterThanOrEqual(1);

			const badFile = manager.getDb().getFile("bad.md");
			expect(badFile).not.toBeNull();
		});
	});

	// ====================================================================
	// Close after build
	// ====================================================================

	it("close after buildIndex does not throw", async () => {
		createFixtureProject(projectDir, {
			"file.md": "# File\n\nContent.",
		});

		await manager.buildIndex();
		expect(() => manager.close()).not.toThrow();
	});
});
