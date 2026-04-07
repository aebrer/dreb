import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectFileType, scanProject } from "../../src/core/search/scanner.js";

// ============================================================================
// detectFileType
// ============================================================================

describe("detectFileType", () => {
	it("maps .ts to typescript", () => {
		expect(detectFileType("src/main.ts")).toBe("typescript");
	});

	it("maps .tsx to tsx", () => {
		expect(detectFileType("component.tsx")).toBe("tsx");
	});

	it("maps .js to javascript", () => {
		expect(detectFileType("index.js")).toBe("javascript");
	});

	it("maps .mjs to javascript", () => {
		expect(detectFileType("module.mjs")).toBe("javascript");
	});

	it("maps .cjs to javascript", () => {
		expect(detectFileType("config.cjs")).toBe("javascript");
	});

	it("maps .py to python", () => {
		expect(detectFileType("script.py")).toBe("python");
	});

	it("maps .md to markdown", () => {
		expect(detectFileType("README.md")).toBe("markdown");
	});

	it("maps .mdx to markdown", () => {
		expect(detectFileType("page.mdx")).toBe("markdown");
	});

	it("maps .yaml and .yml to yaml", () => {
		expect(detectFileType("config.yaml")).toBe("yaml");
		expect(detectFileType("config.yml")).toBe("yaml");
	});

	it("maps .json to json", () => {
		expect(detectFileType("package.json")).toBe("json");
	});

	it("maps .toml to toml", () => {
		expect(detectFileType("Cargo.toml")).toBe("toml");
	});

	it("maps .go to go", () => {
		expect(detectFileType("main.go")).toBe("go");
	});

	it("maps .rs to rust", () => {
		expect(detectFileType("lib.rs")).toBe("rust");
	});

	it("maps .java to java", () => {
		expect(detectFileType("App.java")).toBe("java");
	});

	it("maps .c and .h to c", () => {
		expect(detectFileType("main.c")).toBe("c");
		expect(detectFileType("header.h")).toBe("c");
	});

	it("maps .cpp, .hpp, .cc, .cxx, .hh, .hxx to cpp", () => {
		expect(detectFileType("main.cpp")).toBe("cpp");
		expect(detectFileType("main.hpp")).toBe("cpp");
		expect(detectFileType("main.cc")).toBe("cpp");
		expect(detectFileType("main.cxx")).toBe("cpp");
		expect(detectFileType("main.hh")).toBe("cpp");
		expect(detectFileType("main.hxx")).toBe("cpp");
	});

	it("maps .txt to plaintext", () => {
		expect(detectFileType("notes.txt")).toBe("plaintext");
	});

	it("maps .cfg, .ini, .env, .conf to plaintext", () => {
		expect(detectFileType("setup.cfg")).toBe("plaintext");
		expect(detectFileType("config.ini")).toBe("plaintext");
		// Note: ".env" as a bare filename has no extension per path.extname,
		// but "local.env" does resolve to .env
		expect(detectFileType("local.env")).toBe("plaintext");
		expect(detectFileType("nginx.conf")).toBe("plaintext");
	});

	it("returns null for unknown extensions", () => {
		expect(detectFileType("image.png")).toBeNull();
		expect(detectFileType("archive.tar.gz")).toBeNull();
		expect(detectFileType("binary.exe")).toBeNull();
	});

	it("returns null for files without an extension", () => {
		expect(detectFileType("Makefile")).toBeNull();
		expect(detectFileType("Dockerfile")).toBeNull();
	});

	it("is case-insensitive for extensions", () => {
		expect(detectFileType("README.MD")).toBe("markdown");
		expect(detectFileType("Module.TS")).toBe("typescript");
		expect(detectFileType("data.JSON")).toBe("json");
	});
});

// ============================================================================
// scanProject
// ============================================================================

describe("scanProject", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "dreb-scanner-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Helper: create a file with some content inside tmpDir. */
	function createFile(relPath: string, content = "// placeholder\n"): void {
		const fullPath = path.join(tmpDir, relPath);
		mkdirSync(path.dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, content);
	}

	it("discovers files with recognized extensions", async () => {
		createFile("src/main.ts", "export const x = 1;\n");
		createFile("lib/utils.py", "def hello(): pass\n");
		createFile("docs/README.md", "# Hello\n");

		const files = await scanProject(tmpDir);
		const paths = files.map((f) => f.filePath).sort();

		expect(paths).toEqual(["docs/README.md", "lib/utils.py", "src/main.ts"]);
	});

	it("returns correct fileType for each discovered file", async () => {
		createFile("index.ts", "export {};\n");
		createFile("config.yaml", "key: value\n");
		createFile("data.json", '{"a":1}\n');

		const files = await scanProject(tmpDir);
		const byPath = Object.fromEntries(files.map((f) => [f.filePath, f.fileType]));

		expect(byPath["index.ts"]).toBe("typescript");
		expect(byPath["config.yaml"]).toBe("yaml");
		expect(byPath["data.json"]).toBe("json");
	});

	it("returns mtime as a positive number", async () => {
		createFile("file.ts", "const a = 1;\n");
		const files = await scanProject(tmpDir);
		expect(files).toHaveLength(1);
		expect(files[0].mtime).toBeGreaterThan(0);
	});

	it("skips files with unrecognized extensions", async () => {
		createFile("image.png", "fake-png-data");
		createFile("binary.exe", "fake-exe-data");
		createFile("real.ts", "export {};\n");

		const files = await scanProject(tmpDir);
		expect(files).toHaveLength(1);
		expect(files[0].filePath).toBe("real.ts");
	});

	it("skips node_modules directory", async () => {
		createFile("node_modules/lodash/index.js", "module.exports = {};\n");
		createFile("src/app.ts", "import 'lodash';\n");

		const files = await scanProject(tmpDir);
		const paths = files.map((f) => f.filePath);

		expect(paths).toEqual(["src/app.ts"]);
	});

	it("skips .git directory", async () => {
		createFile(".git/config", "[core]\n");
		createFile("src/index.ts", "export {};\n");

		const files = await scanProject(tmpDir);
		expect(files.map((f) => f.filePath)).toEqual(["src/index.ts"]);
	});

	it("skips dist and build directories", async () => {
		createFile("dist/bundle.js", "compiled code\n");
		createFile("build/output.js", "compiled code\n");
		createFile("src/entry.ts", "export {};\n");

		const files = await scanProject(tmpDir);
		expect(files.map((f) => f.filePath)).toEqual(["src/entry.ts"]);
	});

	it("skips .dreb/index directory but not other .dreb paths", async () => {
		createFile(".dreb/index/data.json", '{"index": true}\n');
		createFile(".dreb/memory/note.md", "# Note\n");
		createFile("src/main.ts", "export {};\n");

		const files = await scanProject(tmpDir);
		const paths = files.map((f) => f.filePath).sort();

		expect(paths).toContain("src/main.ts");
		expect(paths).toContain(".dreb/memory/note.md");
		expect(paths).not.toContain(".dreb/index/data.json");
	});

	it("respects .gitignore rules", async () => {
		writeFileSync(path.join(tmpDir, ".gitignore"), "*.log\nsecrets/\n");
		createFile("app.ts", "export {};\n");
		createFile("debug.log", "some log output\n");
		createFile("secrets/keys.json", '{"key":"val"}\n');

		const files = await scanProject(tmpDir);
		const paths = files.map((f) => f.filePath).sort();

		expect(paths).toEqual(["app.ts"]);
	});

	it("respects nested .gitignore files", async () => {
		createFile("src/index.ts", "export {};\n");
		createFile("src/generated/api.ts", "// generated\n");
		writeFileSync(path.join(tmpDir, "src", ".gitignore"), "generated/\n");

		const files = await scanProject(tmpDir);
		const paths = files.map((f) => f.filePath);

		expect(paths).toContain("src/index.ts");
		expect(paths).not.toContain("src/generated/api.ts");
	});

	it("skips files larger than 1MB", async () => {
		createFile("small.ts", "export const x = 1;\n");
		// Create a file slightly over 1MB
		const bigContent = "x".repeat(1024 * 1024 + 1);
		createFile("huge.ts", bigContent);

		const files = await scanProject(tmpDir);
		expect(files).toHaveLength(1);
		expect(files[0].filePath).toBe("small.ts");
	});

	it("skips empty files", async () => {
		createFile("empty.ts", "");
		createFile("valid.ts", "export {};\n");

		const files = await scanProject(tmpDir);
		expect(files).toHaveLength(1);
		expect(files[0].filePath).toBe("valid.ts");
	});

	it("returns posix-style paths on all platforms", async () => {
		createFile("src/deep/nested/file.ts", "export {};\n");

		const files = await scanProject(tmpDir);
		expect(files).toHaveLength(1);
		expect(files[0].filePath).toBe("src/deep/nested/file.ts");
		expect(files[0].filePath).not.toContain("\\");
	});

	// ========================================================================
	// Memory directory scanning
	// ========================================================================

	describe("globalMemoryDir", () => {
		let memoryDir: string;

		beforeEach(() => {
			memoryDir = mkdtempSync(path.join(tmpdir(), "dreb-scanner-memory-"));
		});

		afterEach(() => {
			rmSync(memoryDir, { recursive: true, force: true });
		});

		it("includes memory files with ~memory/ prefix when outside project root", async () => {
			createFile("src/app.ts", "export {};\n");
			writeFileSync(path.join(memoryDir, "notes.md"), "# Memory notes\n");

			const files = await scanProject(tmpDir, memoryDir);
			const paths = files.map((f) => f.filePath).sort();

			expect(paths).toContain("src/app.ts");
			expect(paths).toContain("~memory/notes.md");
		});

		it("sets correct fileType for memory files", async () => {
			writeFileSync(path.join(memoryDir, "context.md"), "# Context\n");
			writeFileSync(path.join(memoryDir, "settings.yaml"), "key: val\n");

			const files = await scanProject(tmpDir, memoryDir);
			const byPath = Object.fromEntries(files.map((f) => [f.filePath, f.fileType]));

			expect(byPath["~memory/context.md"]).toBe("markdown");
			expect(byPath["~memory/settings.yaml"]).toBe("yaml");
		});

		it("includes memory files from subdirectories", async () => {
			mkdirSync(path.join(memoryDir, "sub"), { recursive: true });
			writeFileSync(path.join(memoryDir, "sub", "deep.md"), "# Deep\n");

			const files = await scanProject(tmpDir, memoryDir);
			const paths = files.map((f) => f.filePath);

			// scanMemoryDir recurses with the subdirectory as the new root,
			// so nested files appear with just their filename under ~memory/
			expect(paths).toContain("~memory/deep.md");
		});

		it("skips unrecognized extensions in memory dir", async () => {
			writeFileSync(path.join(memoryDir, "notes.md"), "# Notes\n");
			writeFileSync(path.join(memoryDir, "photo.png"), "fake-png");

			const files = await scanProject(tmpDir, memoryDir);
			const memPaths = files.filter((f) => f.filePath.startsWith("~memory/")).map((f) => f.filePath);

			expect(memPaths).toEqual(["~memory/notes.md"]);
		});

		it("skips empty memory files", async () => {
			writeFileSync(path.join(memoryDir, "empty.md"), "");
			writeFileSync(path.join(memoryDir, "valid.md"), "# Content\n");

			const files = await scanProject(tmpDir, memoryDir);
			const memPaths = files.filter((f) => f.filePath.startsWith("~memory/")).map((f) => f.filePath);

			expect(memPaths).toEqual(["~memory/valid.md"]);
		});

		it("uses relative path (no ~memory/) when memory dir is inside project", async () => {
			const inProjectMemory = path.join(tmpDir, ".dreb", "memory");
			mkdirSync(inProjectMemory, { recursive: true });
			writeFileSync(path.join(inProjectMemory, "note.md"), "# Note\n");

			const files = await scanProject(tmpDir, inProjectMemory);
			const paths = files.map((f) => f.filePath);

			// Should be a normal relative path, not ~memory/ prefixed
			expect(paths).toContain(".dreb/memory/note.md");
			expect(paths).not.toContain("~memory/note.md");
		});

		it("handles non-existent memory dir gracefully", async () => {
			const bogusDir = path.join(tmpdir(), "does-not-exist-scanner-test");
			createFile("app.ts", "export {};\n");

			const files = await scanProject(tmpDir, bogusDir);
			expect(files.map((f) => f.filePath)).toEqual(["app.ts"]);
		});
	});

	// ========================================================================
	// Edge cases
	// ========================================================================

	it("handles an empty project directory", async () => {
		const files = await scanProject(tmpDir);
		expect(files).toEqual([]);
	});

	it("handles directory with only unrecognized files", async () => {
		createFile("image.png", "fake-png");
		createFile("movie.mp4", "fake-mp4");
		createFile("Makefile", "all:\n\techo hi\n");

		const files = await scanProject(tmpDir);
		expect(files).toEqual([]);
	});
});
