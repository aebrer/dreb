import { beforeAll, describe, expect, it } from "vitest";
import { chunkFile } from "../src/chunker.js";
import { initTreeSitter } from "../src/tree-sitter-chunker.js";
import type { Chunk, FileType } from "../src/types.js";

// ============================================================================
// Setup — tree-sitter needs one-time WASM init
// ============================================================================

beforeAll(async () => {
	await initTreeSitter();
});

// ============================================================================
// Helpers
// ============================================================================

/** Assert every chunk has the required shape. */
function assertChunkShape(chunks: Chunk[], filePath: string, fileType: FileType) {
	expect(chunks.length).toBeGreaterThanOrEqual(1);
	for (const chunk of chunks) {
		expect(chunk.filePath).toBe(filePath);
		expect(chunk.fileType).toBe(fileType);
		expect(chunk.startLine).toBeGreaterThanOrEqual(1);
		expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
		expect(typeof chunk.kind).toBe("string");
		expect(typeof chunk.content).toBe("string");
		expect(chunk.content.length).toBeGreaterThan(0);
		// name is string | null
		expect(chunk.name === null || typeof chunk.name === "string").toBe(true);
	}
}

// ============================================================================
// Tree-sitter dispatch: TypeScript
// ============================================================================

const tsSource = `
export function greet(name: string): string {
  return "hello " + name;
}

export class Greeter {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  greet(name: string): string {
    return this.prefix + name;
  }
}

export interface Config {
  verbose: boolean;
}
`.trim();

describe("chunkFile — TypeScript (tree-sitter)", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkFile(tsSource, "src/greet.ts", "typescript");
	});

	it("returns multiple chunks for code with functions, classes, interfaces", () => {
		expect(chunks.length).toBeGreaterThanOrEqual(3);
	});

	it("extracts an export chunk for the exported function", () => {
		// `export function greet(...)` is parsed as an export_statement wrapping a function_declaration
		const fn = chunks.find((c) => c.kind === "export" && c.name === "greet");
		expect(fn).toBeDefined();
		expect(fn!.content).toContain("function greet");
	});

	it("extracts an export chunk for the exported class", () => {
		const cls = chunks.find((c) => c.kind === "export" && c.name === "Greeter");
		expect(cls).toBeDefined();
		expect(cls!.content).toContain("class Greeter");
	});

	it("extracts an export chunk for the exported interface", () => {
		const iface = chunks.find((c) => c.kind === "export" && c.name === "Config");
		expect(iface).toBeDefined();
		expect(iface!.content).toContain("interface Config");
	});

	it("sets fileType to typescript on all chunks", () => {
		assertChunkShape(chunks, "src/greet.ts", "typescript");
	});
});

// ============================================================================
// Tree-sitter dispatch: Python
// ============================================================================

const pySource = `
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)

class Calculator:
    def __init__(self):
        self.history = []

    def add(self, a, b):
        result = a + b
        self.history.append(result)
        return result
`.trim();

describe("chunkFile — Python (tree-sitter)", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkFile(pySource, "calc.py", "python");
	});

	it("returns multiple chunks for Python with functions and classes", () => {
		expect(chunks.length).toBeGreaterThanOrEqual(2);
	});

	it("extracts a function chunk for fibonacci", () => {
		const fn = chunks.find((c) => c.kind === "function" && c.name === "fibonacci");
		expect(fn).toBeDefined();
		expect(fn!.content).toContain("def fibonacci");
	});

	it("extracts a class chunk for Calculator", () => {
		const cls = chunks.find((c) => c.kind === "class" && c.name === "Calculator");
		expect(cls).toBeDefined();
		expect(cls!.content).toContain("class Calculator");
	});

	it("sets fileType to python on all chunks", () => {
		assertChunkShape(chunks, "calc.py", "python");
	});
});

// ============================================================================
// Text dispatch: Markdown
// ============================================================================

const mdSource = `# Introduction

This is the introduction paragraph with enough text to exceed the minimum split size threshold.
${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(5)}

## Getting Started

Follow these steps to get started with the project.
${"Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(5)}

## Configuration

Configure the application by editing the config file.
${"Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris. ".repeat(5)}
`.trim();

describe("chunkFile — Markdown (text chunker)", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkFile(mdSource, "README.md", "markdown");
	});

	it("produces heading_section chunks", () => {
		expect(chunks.every((c) => c.kind === "heading_section")).toBe(true);
	});

	it("extracts named sections from headings", () => {
		const names = chunks.map((c) => c.name);
		expect(names).toContain("Introduction");
		expect(names).toContain("Getting Started");
		expect(names).toContain("Configuration");
	});

	it("sets fileType to markdown on all chunks", () => {
		assertChunkShape(chunks, "README.md", "markdown");
	});
});

// ============================================================================
// Text dispatch: YAML
// ============================================================================

const yamlSource = `# Config file
name: my-project
version: 1.0.0

dependencies:
  lodash: ^4.0.0
  express: ^4.18.0

scripts:
  build: tsc
  test: vitest

${"# padding line to exceed min split size\n".repeat(15)}
`;

describe("chunkFile — YAML (text chunker)", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkFile(yamlSource, "config.yaml", "yaml");
	});

	it("produces top_level_key chunks", () => {
		expect(chunks.some((c) => c.kind === "top_level_key")).toBe(true);
	});

	it("extracts named keys", () => {
		const names = chunks.map((c) => c.name);
		expect(names).toContain("name");
		expect(names).toContain("dependencies");
		expect(names).toContain("scripts");
	});

	it("sets fileType to yaml on all chunks", () => {
		assertChunkShape(chunks, "config.yaml", "yaml");
	});
});

// ============================================================================
// Text dispatch: JSON
// ============================================================================

// JSON must exceed MIN_SPLIT_SIZE (500 chars) to get per-key chunking
const jsonObj: Record<string, unknown> = {
	name: "test-project",
	version: "2.0.0",
	description: "A test project for chunker dispatch testing with enough content to exceed the minimum",
	dependencies: {
		lodash: "^4.0.0",
		express: "^4.18.0",
		react: "^18.0.0",
		"react-dom": "^18.0.0",
		typescript: "^5.0.0",
		vitest: "^1.0.0",
	},
	devDependencies: {
		"@types/node": "^20.0.0",
		"@types/react": "^18.0.0",
		biome: "^1.0.0",
		prettier: "^3.0.0",
		eslint: "^8.0.0",
	},
	scripts: {
		build: "tsc --project tsconfig.build.json",
		test: "vitest --run --coverage",
		lint: "biome check --write .",
		format: "prettier --write .",
	},
};
const jsonSource = JSON.stringify(jsonObj, null, 2);

describe("chunkFile — JSON (text chunker)", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkFile(jsonSource, "package.json", "json");
	});

	it("produces top_level_key chunks for JSON objects", () => {
		expect(chunks.some((c) => c.kind === "top_level_key")).toBe(true);
	});

	it("extracts named keys from the JSON", () => {
		const names = chunks.map((c) => c.name);
		// The JSON chunker groups keys by scanning brace depth; check it finds top-level keys
		expect(names).toContain("name");
		expect(names).toContain("dependencies");
		expect(names.length).toBeGreaterThanOrEqual(3);
	});

	it("sets fileType to json on all chunks", () => {
		assertChunkShape(chunks, "package.json", "json");
	});
});

// ============================================================================
// Text dispatch: TOML
// ============================================================================

const tomlSource = `# Project config
name = "my-app"
version = "0.1.0"

[dependencies]
serde = "1.0"
tokio = { version = "1", features = ["full"] }

[dev-dependencies]
criterion = "0.5"

${"# padding to exceed min split\n".repeat(15)}
`;

describe("chunkFile — TOML (text chunker)", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkFile(tomlSource, "Cargo.toml", "toml");
	});

	it("produces top_level_key chunks", () => {
		expect(chunks.some((c) => c.kind === "top_level_key")).toBe(true);
	});

	it("extracts section names", () => {
		const names = chunks.map((c) => c.name);
		expect(names).toContain("dependencies");
		expect(names).toContain("dev-dependencies");
	});

	it("sets fileType to toml on all chunks", () => {
		assertChunkShape(chunks, "Cargo.toml", "toml");
	});
});

// ============================================================================
// Text dispatch: Plaintext
// ============================================================================

const plaintextSource = `This is the first paragraph of a plain text document. It contains enough text to be meaningful.
${"Some filler content for the paragraph to be substantial. ".repeat(5)}

${"Another paragraph with different content to test splitting. ".repeat(5)}

${"A third paragraph covering additional material for the test. ".repeat(5)}
`;

describe("chunkFile — Plaintext (text chunker)", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkFile(plaintextSource, "notes.txt", "plaintext");
	});

	it("returns at least one chunk", () => {
		expect(chunks.length).toBeGreaterThanOrEqual(1);
	});

	it("sets fileType to plaintext on all chunks", () => {
		assertChunkShape(chunks, "notes.txt", "plaintext");
	});
});

// ============================================================================
// Tree-sitter dispatch: GDScript
// ============================================================================

const gdSource = `extends Node2D

func _ready():
    print("hello")

func take_damage(amount: int) -> void:
    hp -= amount

class Player:
    var name: String
    var hp: int = 100

enum Direction { NORTH, SOUTH, EAST, WEST }
`.trim();

describe("chunkFile — GDScript (tree-sitter)", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkFile(gdSource, "player.gd", "gdscript");
	});

	it("returns multiple chunks for GDScript with functions, classes, enums", () => {
		expect(chunks.length).toBeGreaterThanOrEqual(3);
	});

	it("extracts a function chunk for _ready", () => {
		const fn = chunks.find((c) => c.kind === "function" && c.name === "_ready");
		expect(fn).toBeDefined();
		expect(fn!.content).toContain("_ready");
	});

	it("extracts a class chunk for Player", () => {
		const cls = chunks.find((c) => c.kind === "class" && c.name === "Player");
		expect(cls).toBeDefined();
		expect(cls!.content).toContain("Player");
	});

	it("extracts an enum chunk for Direction", () => {
		const en = chunks.find((c) => c.kind === "enum" && c.name === "Direction");
		expect(en).toBeDefined();
		expect(en!.content).toContain("NORTH");
	});

	it("sets fileType to gdscript on all chunks", () => {
		assertChunkShape(chunks, "player.gd", "gdscript");
	});
});

// ============================================================================
// Text dispatch: Godot scene/resource files
// ============================================================================

const tscnSource = `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://player.gd" id="1"]

[sub_resource type="RectangleShape2D" id="1"]
size = Vector2(50, 50)

[node name="Player" type="CharacterBody2D"]
script = ExtResource("1")

[node name="CollisionShape2D" type="CollisionShape2D" parent="."]
shape = SubResource("1")

[node name="Sprite2D" type="Sprite2D" parent="."]
texture = ExtResource("2")
`.trim();

describe("chunkFile — Godot scene (.tscn)", () => {
	let chunks: Chunk[];

	beforeAll(async () => {
		chunks = await chunkFile(tscnSource, "player.tscn", "plaintext");
	});

	it("returns at least one chunk", () => {
		expect(chunks.length).toBeGreaterThanOrEqual(1);
	});

	it("sets fileType to plaintext on all chunks", () => {
		assertChunkShape(chunks, "player.tscn", "plaintext");
	});
});

describe("chunkFile — Godot resource (.tres)", () => {
	it("returns at least one chunk", async () => {
		const tresSource = `[gd_resource type="Environment" format=3]

[resource]
background_mode = 2
background_color = Color(0, 0, 0, 1)
`;
		const chunks = await chunkFile(tresSource, "env.tres", "plaintext");
		expect(chunks.length).toBeGreaterThanOrEqual(1);
		assertChunkShape(chunks, "env.tres", "plaintext");
	});
});

// ============================================================================
// Tree-sitter fallback
// ============================================================================

describe("chunkFile — tree-sitter fallback on invalid code", () => {
	it("falls back to plaintext when tree-sitter produces no meaningful chunks from garbage", async () => {
		// This is syntactically broken TypeScript — if tree-sitter fails or
		// produces no extractable chunks, the chunker should still return results
		const garbage = "@@@ {{{ >>> <<<\n".repeat(40);
		const chunks = await chunkFile(garbage, "broken.ts", "typescript");
		expect(chunks.length).toBeGreaterThanOrEqual(1);
		// Chunks should still have correct filePath
		expect(chunks[0].filePath).toBe("broken.ts");
	});
});

// ============================================================================
// Chunk shape validation
// ============================================================================

describe("chunkFile — chunk object shape", () => {
	it("every chunk has filePath, fileType, startLine, endLine, kind, name, content", async () => {
		const chunks = await chunkFile(tsSource, "shape-test.ts", "typescript");
		for (const chunk of chunks) {
			expect(chunk).toHaveProperty("filePath");
			expect(chunk).toHaveProperty("fileType");
			expect(chunk).toHaveProperty("startLine");
			expect(chunk).toHaveProperty("endLine");
			expect(chunk).toHaveProperty("kind");
			expect(chunk).toHaveProperty("name");
			expect(chunk).toHaveProperty("content");
		}
	});

	it("startLine is always >= 1 and endLine >= startLine", async () => {
		const allChunks: Chunk[] = [];
		allChunks.push(...(await chunkFile(tsSource, "a.ts", "typescript")));
		allChunks.push(...(await chunkFile(pySource, "b.py", "python")));
		allChunks.push(...(await chunkFile(mdSource, "c.md", "markdown")));
		allChunks.push(...(await chunkFile(yamlSource, "d.yaml", "yaml")));

		for (const chunk of allChunks) {
			expect(chunk.startLine).toBeGreaterThanOrEqual(1);
			expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
		}
	});
});

// ============================================================================
// Edge cases
// ============================================================================

describe("chunkFile — edge cases", () => {
	it("returns a single file chunk for empty content", async () => {
		const chunks = await chunkFile("", "empty.md", "markdown");
		expect(chunks).toHaveLength(1);
		expect(chunks[0].kind).toBe("file");
		expect(chunks[0].filePath).toBe("empty.md");
	});

	it("returns a single file chunk for very small content", async () => {
		const chunks = await chunkFile("hello world", "tiny.yaml", "yaml");
		expect(chunks).toHaveLength(1);
		expect(chunks[0].kind).toBe("file");
		expect(chunks[0].content).toBe("hello world");
	});

	it("returns at least one chunk for any file type", async () => {
		const types: Array<[string, FileType]> = [
			["function foo() {}", "typescript"],
			["def foo(): pass", "python"],
			["func _ready(): pass", "gdscript"],
			["# Heading\nContent", "markdown"],
			["key: value", "yaml"],
			['{"a": 1}', "json"],
			['name = "x"', "toml"],
			["just plain text", "plaintext"],
		];
		for (const [content, fileType] of types) {
			const chunks = await chunkFile(content, `test.${fileType}`, fileType);
			expect(chunks.length).toBeGreaterThanOrEqual(1);
		}
	});
});
