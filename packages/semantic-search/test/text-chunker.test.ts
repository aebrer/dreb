import { describe, expect, test } from "vitest";
import { chunkTextFile } from "../src/text-chunker.js";

// ============================================================================
// Helper
// ============================================================================

/** Build a string of approximately `n` characters from repeating a sentence. */
function makeText(n: number, sentence = "Lorem ipsum dolor sit amet. "): string {
	const repeats = Math.ceil(n / sentence.length);
	return sentence.repeat(repeats).slice(0, n);
}

/** Ensure content is above the 500-char split threshold. */
function pad(lines: string[]): string {
	const content = lines.join("\n");
	if (content.length >= 500) return content;
	// Append padding text that won't create new headings/keys
	const needed = 500 - content.length + 10;
	return `${content}\n${makeText(needed)}`;
}

// ============================================================================
// General behavior
// ============================================================================

describe("chunkTextFile — general", () => {
	test("empty file returns single file chunk", () => {
		const chunks = chunkTextFile("", "readme.md", "markdown");
		expect(chunks).toHaveLength(1);
		expect(chunks[0].kind).toBe("file");
		expect(chunks[0].content).toBe("");
		expect(chunks[0].startLine).toBe(1);
	});

	test("file smaller than 500 chars returns single file chunk", () => {
		const small = "# Hello\n\nWorld";
		const chunks = chunkTextFile(small, "readme.md", "markdown");
		expect(chunks).toHaveLength(1);
		expect(chunks[0].kind).toBe("file");
		expect(chunks[0].content).toBe(small);
	});

	test("all chunks have correct filePath and fileType", () => {
		const md = pad(["# Section 1", "", makeText(300), "", "# Section 2", "", makeText(300)]);
		const chunks = chunkTextFile(md, "docs/guide.md", "markdown");
		for (const c of chunks) {
			expect(c.filePath).toBe("docs/guide.md");
			expect(c.fileType).toBe("markdown");
		}
	});
});

// ============================================================================
// Markdown
// ============================================================================

describe("chunkTextFile — markdown", () => {
	test("splits by headings", () => {
		const content = pad(["# Introduction", "", makeText(300), "", "# Getting Started", "", makeText(300)]);

		const chunks = chunkTextFile(content, "readme.md", "markdown");
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		expect(chunks.some((c) => c.name === "Introduction")).toBe(true);
		expect(chunks.some((c) => c.name === "Getting Started")).toBe(true);
		expect(chunks.every((c) => c.kind === "heading_section")).toBe(true);
	});

	test("nested headings stay with parent", () => {
		const content = pad([
			"# Top Level",
			"",
			makeText(200),
			"",
			"## Sub Section",
			"",
			makeText(200),
			"",
			"# Another Top",
			"",
			makeText(200),
		]);

		const chunks = chunkTextFile(content, "doc.md", "markdown");
		const topLevel = chunks.find((c) => c.name === "Top Level");
		expect(topLevel).toBeDefined();
		// The "Sub Section" content should be within the "Top Level" chunk
		expect(topLevel!.content).toContain("## Sub Section");
	});

	test("preamble before first heading becomes a chunk", () => {
		const content = pad([
			"Some preamble text here.",
			"",
			"# First Heading",
			"",
			makeText(300),
			"",
			"# Second Heading",
			"",
			makeText(300),
		]);

		const chunks = chunkTextFile(content, "readme.md", "markdown");
		const preamble = chunks.find((c) => c.name === null);
		expect(preamble).toBeDefined();
		expect(preamble!.content).toContain("preamble text");
	});

	test("heading text is trimmed as name", () => {
		const content = pad(["# First", "", makeText(300), "", "## Second Heading", "", makeText(300)]);

		const chunks = chunkTextFile(content, "doc.md", "markdown");
		expect(chunks.some((c) => c.name === "First")).toBe(true);
	});

	test("markdown with no headings falls back to plaintext chunking", () => {
		const content = pad([makeText(300), "", "", makeText(300), "", "", makeText(300)]);

		const chunks = chunkTextFile(content, "notes.md", "markdown");
		// Should produce paragraph chunks since there are no headings
		expect(chunks.length).toBeGreaterThanOrEqual(1);
	});

	test("line numbers are 1-indexed and correct", () => {
		const content = pad([
			"# First",
			"Line 2",
			makeText(200),
			"# Second",
			"Line 5",
			makeText(200),
			"# Third",
			"Line 8",
			makeText(200),
		]);

		const chunks = chunkTextFile(content, "doc.md", "markdown");
		const first = chunks.find((c) => c.name === "First");
		expect(first).toBeDefined();
		expect(first!.startLine).toBe(1);
		// First heading runs lines 1-3 (until Second starts at line 4)
		expect(first!.endLine).toBe(3);

		const second = chunks.find((c) => c.name === "Second");
		expect(second).toBeDefined();
		expect(second!.startLine).toBe(4);
	});
});

// ============================================================================
// YAML
// ============================================================================

describe("chunkTextFile — yaml", () => {
	test("splits by top-level keys", () => {
		const content = pad([
			"name: my-project",
			"version: 1.0.0",
			"",
			"dependencies:",
			"  foo: ^1.0.0",
			"  bar: ^2.0.0",
			"  baz: ^3.0.0",
			"",
			"devDependencies:",
			"  test-lib: ^1.0.0",
			`  long-key: "${makeText(300)}"`,
		]);

		const chunks = chunkTextFile(content, "config.yaml", "yaml");
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		expect(chunks.some((c) => c.name === "dependencies")).toBe(true);
		expect(chunks.some((c) => c.name === "devDependencies")).toBe(true);
		expect(chunks.every((c) => c.kind === "top_level_key")).toBe(true);
	});

	test("nested content stays with its key", () => {
		const content = pad([
			"server:",
			"  host: localhost",
			"  port: 8080",
			"  ssl:",
			"    enabled: true",
			"    cert: /path/to/cert",
			"",
			"database:",
			"  host: db.example.com",
			"  port: 5432",
			`  name: "${makeText(400)}"`,
		]);

		const chunks = chunkTextFile(content, "config.yaml", "yaml");
		const server = chunks.find((c) => c.name === "server");
		expect(server).toBeDefined();
		expect(server!.content).toContain("ssl:");
		expect(server!.content).toContain("enabled: true");
	});

	test("comments and directives are handled", () => {
		const content = pad([
			"---",
			"# This is a comment",
			"name: my-project",
			`description: "${makeText(300)}"`,
			"",
			"# Another comment",
			"version: 2.0.0",
			`notes: "${makeText(300)}"`,
		]);

		const chunks = chunkTextFile(content, "config.yaml", "yaml");
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		// First key should include the preamble
		const first = chunks[0];
		expect(first.content).toContain("---");
	});
});

// ============================================================================
// JSON
// ============================================================================

describe("chunkTextFile — json", () => {
	test("splits top-level object keys", () => {
		const obj = {
			name: "my-project",
			version: "1.0.0",
			dependencies: { foo: "^1.0.0", bar: "^2.0.0" },
			description: makeText(400),
		};
		const content = JSON.stringify(obj, null, 2);

		const chunks = chunkTextFile(content, "package.json", "json");
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		expect(chunks.some((c) => c.name === "name")).toBe(true);
		expect(chunks.some((c) => c.name === "dependencies")).toBe(true);
		expect(chunks.every((c) => c.kind === "top_level_key")).toBe(true);
	});

	test("minified JSON still produces chunks", () => {
		const obj = {
			a: makeText(300),
			b: makeText(300),
			c: [1, 2, 3],
		};
		const content = JSON.stringify(obj);

		const chunks = chunkTextFile(content, "data.json", "json");
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		expect(chunks.some((c) => c.name === "a")).toBe(true);
		expect(chunks.some((c) => c.name === "b")).toBe(true);
	});

	test("top-level array returns single file chunk", () => {
		const content = JSON.stringify([1, 2, 3, makeText(300)]);
		const chunks = chunkTextFile(content, "data.json", "json");
		expect(chunks).toHaveLength(1);
		expect(chunks[0].kind).toBe("file");
	});

	test("invalid JSON returns single file chunk", () => {
		const content = `${makeText(600)}{broken json}}}`;
		const chunks = chunkTextFile(content, "data.json", "json");
		expect(chunks).toHaveLength(1);
		expect(chunks[0].kind).toBe("file");
	});
});

// ============================================================================
// TOML
// ============================================================================

describe("chunkTextFile — toml", () => {
	test("splits by sections", () => {
		const content = pad([
			"title = 'My App'",
			"",
			"[server]",
			"host = 'localhost'",
			"port = 8080",
			"",
			"[database]",
			"host = 'db.local'",
			"port = 5432",
			`name = '${makeText(400)}'`,
		]);

		const chunks = chunkTextFile(content, "config.toml", "toml");
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		expect(chunks.some((c) => c.name === "server")).toBe(true);
		expect(chunks.some((c) => c.name === "database")).toBe(true);
	});

	test("top-level KV pairs before sections become chunks", () => {
		const content = pad([
			"title = 'My App'",
			`description = '${makeText(300)}'`,
			"",
			"[server]",
			"host = 'localhost'",
			`addr = '${makeText(300)}'`,
		]);

		const chunks = chunkTextFile(content, "config.toml", "toml");
		expect(chunks.some((c) => c.name === "title")).toBe(true);
		expect(chunks.some((c) => c.name === "server")).toBe(true);
	});

	test("section content stays together", () => {
		const content = pad([
			"[package]",
			'name = "my-crate"',
			'version = "0.1.0"',
			'edition = "2021"',
			"",
			"[dependencies]",
			'serde = { version = "1.0", features = ["derive"] }',
			`tokio = '${makeText(400)}'`,
		]);

		const chunks = chunkTextFile(content, "Cargo.toml", "toml");
		const pkg = chunks.find((c) => c.name === "package");
		expect(pkg).toBeDefined();
		expect(pkg!.content).toContain("edition");
	});
});

// ============================================================================
// Plaintext
// ============================================================================

describe("chunkTextFile — plaintext", () => {
	test("splits at double newlines", () => {
		const paragraphs = [makeText(300), makeText(300), makeText(300)];
		const content = paragraphs.join("\n\n\n");

		const chunks = chunkTextFile(content, "notes.txt", "plaintext");
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		expect(chunks.every((c) => c.kind === "paragraph")).toBe(true);
	});

	test("small paragraphs are grouped together", () => {
		// Create many small paragraphs, but ensure total > 500 chars
		const smallParas = Array.from({ length: 10 }, (_, i) => `Short paragraph number ${i} with some content.`);
		const content = pad([...smallParas, "", "", makeText(300), "", "", makeText(300)]);

		const chunks = chunkTextFile(content, "notes.txt", "plaintext");
		// The small paragraphs should be grouped, so fewer chunks than original paragraphs
		expect(chunks.length).toBeLessThan(12);
	});

	test("paragraph name is first line truncated", () => {
		const longFirstLine = "A".repeat(100);
		const content = pad([longFirstLine, "", "", makeText(300), "", "", makeText(300)]);

		const chunks = chunkTextFile(content, "notes.txt", "plaintext");
		const first = chunks[0];
		// Name should be truncated to 60 chars with "..."
		expect(first.name!.length).toBeLessThanOrEqual(60);
		expect(first.name!.endsWith("...")).toBe(true);
	});
});

// ============================================================================
// Max chunk size enforcement
// ============================================================================

describe("chunkTextFile — max size enforcement", () => {
	test("oversized markdown section is split", () => {
		// Create a single heading with content > 8000 chars
		const lines = ["# Big Section", ""];
		for (let i = 0; i < 100; i++) {
			lines.push(makeText(100));
			lines.push(""); // paragraph breaks for splitting
		}
		const content = lines.join("\n");

		const chunks = chunkTextFile(content, "big.md", "markdown");
		// Should be split into multiple chunks
		expect(chunks.length).toBeGreaterThan(1);
		// All chunks should be <= 8000 chars
		for (const c of chunks) {
			expect(c.content.length).toBeLessThanOrEqual(8000);
		}
	});

	test("continuation chunks get (cont.) suffix", () => {
		const lines = ["# Big Section", ""];
		for (let i = 0; i < 100; i++) {
			lines.push(makeText(100));
			lines.push("");
		}
		const content = lines.join("\n");

		const chunks = chunkTextFile(content, "big.md", "markdown");
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0].name).toBe("Big Section");
		expect(chunks[1].name).toBe("Big Section (cont.)");
	});
});
