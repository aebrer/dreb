/**
 * AST-aware code chunking using tree-sitter (WASM).
 *
 * Parses source files into syntax trees and extracts meaningful code constructs
 * (functions, classes, methods, structs, etc.) as individual chunks. Gaps between
 * extracted nodes are captured as file-level chunks when substantial.
 */

import { readFileSync } from "fs";
import { createRequire } from "module";
import type { Node as TSNode } from "web-tree-sitter";
import type { Chunk, ChunkKind, TreeSitterLanguage } from "./types.js";

// Use createRequire for resolving WASM paths in ESM context
const require = createRequire(import.meta.url);

// ============================================================================
// Types
// ============================================================================

/** Describes which AST node types to extract for a language and how to get names. */
interface NodeExtractor {
	/** The tree-sitter node type string. */
	type: string;
	/** The ChunkKind to assign to extracted chunks. */
	kind: ChunkKind;
	/** How to extract the symbol name from the node. */
	getName: (node: TSNode) => string | null;
}

/** Intermediate representation of an extracted AST region. */
interface ExtractedRegion {
	name: string | null;
	kind: ChunkKind;
	startLine: number; // 1-indexed
	endLine: number; // 1-indexed, inclusive
	content: string;
}

// ============================================================================
// Lazy Imports
// ============================================================================

// web-tree-sitter types imported dynamically to avoid top-level await
type ParserClass = typeof import("web-tree-sitter").Parser;
type LanguageClass = typeof import("web-tree-sitter").Language;

let Parser: ParserClass | null = null;
let Language: LanguageClass | null = null;

let initPromise: Promise<void> | null = null;
let initialized = false;

// ============================================================================
// Language Cache
// ============================================================================

const languageCache = new Map<TreeSitterLanguage, import("web-tree-sitter").Language>();

/** Grammar WASM paths keyed by language. */
const GRAMMAR_PATHS: Record<TreeSitterLanguage, string> = {
	typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
	tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
	javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
	python: "tree-sitter-python/tree-sitter-python.wasm",
	go: "tree-sitter-go/tree-sitter-go.wasm",
	rust: "tree-sitter-rust/tree-sitter-rust.wasm",
	java: "tree-sitter-java/tree-sitter-java.wasm",
	c: "tree-sitter-c/tree-sitter-c.wasm",
	cpp: "tree-sitter-cpp/tree-sitter-cpp.wasm",
	gdscript: "tree-sitter-gdscript/tree-sitter-gdscript.wasm",
};

// ============================================================================
// Name Extractors
// ============================================================================

/** Get name from a node's `name` field. */
function nameField(node: TSNode): string | null {
	return node.childForFieldName("name")?.text ?? null;
}

/** Get name for an arrow function assigned to a variable. */
function arrowFunctionName(node: TSNode): string | null {
	const parent = node.parent;
	if (parent?.type === "variable_declarator") {
		return parent.childForFieldName("name")?.text ?? null;
	}
	return null;
}

/** Get name for C function_definition: name is in the function_declarator child. */
function cFunctionName(node: TSNode): string | null {
	const declarator = node.childForFieldName("declarator");
	if (!declarator) return null;
	// function_declarator has a `declarator` field for the actual name
	if (declarator.type === "function_declarator") {
		return declarator.childForFieldName("declarator")?.text ?? null;
	}
	return declarator.text ?? null;
}

/** Get name from an export_statement's inner declaration. */
function exportName(node: TSNode): string | null {
	const decl = node.childForFieldName("declaration");
	if (!decl) {
		// Named export like `export { foo }` — use the full text isn't useful,
		// just return null for anonymous exports
		return null;
	}
	return decl.childForFieldName("name")?.text ?? null;
}

// ============================================================================
// Per-Language Node Extractors
// ============================================================================

const TS_EXTRACTORS: NodeExtractor[] = [
	{ type: "function_declaration", kind: "function", getName: nameField },
	{ type: "method_definition", kind: "method", getName: nameField },
	{ type: "class_declaration", kind: "class", getName: nameField },
	{ type: "interface_declaration", kind: "interface", getName: nameField },
	{ type: "type_alias_declaration", kind: "type_alias", getName: nameField },
	{ type: "export_statement", kind: "export", getName: exportName },
	{ type: "arrow_function", kind: "function", getName: arrowFunctionName },
];

const JS_EXTRACTORS: NodeExtractor[] = [
	{ type: "function_declaration", kind: "function", getName: nameField },
	{ type: "method_definition", kind: "method", getName: nameField },
	{ type: "class_declaration", kind: "class", getName: nameField },
	{ type: "export_statement", kind: "export", getName: exportName },
	{ type: "arrow_function", kind: "function", getName: arrowFunctionName },
];

const PYTHON_EXTRACTORS: NodeExtractor[] = [
	{ type: "function_definition", kind: "function", getName: nameField },
	{ type: "class_definition", kind: "class", getName: nameField },
];

const GO_EXTRACTORS: NodeExtractor[] = [
	{ type: "function_declaration", kind: "function", getName: nameField },
	{ type: "method_declaration", kind: "method", getName: nameField },
	{ type: "type_spec", kind: "struct", getName: nameField },
];

const RUST_EXTRACTORS: NodeExtractor[] = [
	{ type: "function_item", kind: "function", getName: nameField },
	{ type: "impl_item", kind: "impl", getName: (n) => n.childForFieldName("type")?.text ?? null },
	{ type: "struct_item", kind: "struct", getName: nameField },
	{ type: "enum_item", kind: "enum", getName: nameField },
	{ type: "trait_item", kind: "interface", getName: nameField },
];

const JAVA_EXTRACTORS: NodeExtractor[] = [
	{ type: "class_declaration", kind: "class", getName: nameField },
	{ type: "method_declaration", kind: "method", getName: nameField },
	{ type: "interface_declaration", kind: "interface", getName: nameField },
];

const C_EXTRACTORS: NodeExtractor[] = [
	{ type: "function_definition", kind: "function", getName: cFunctionName },
	{ type: "struct_specifier", kind: "struct", getName: nameField },
];

const CPP_EXTRACTORS: NodeExtractor[] = [
	...C_EXTRACTORS,
	{ type: "class_specifier", kind: "class", getName: nameField },
];

const GDSCRIPT_EXTRACTORS: NodeExtractor[] = [
	{ type: "function_definition", kind: "function", getName: nameField },
	{ type: "class_definition", kind: "class", getName: nameField },
	{ type: "enum_definition", kind: "enum", getName: nameField },
];

const LANGUAGE_EXTRACTORS: Record<TreeSitterLanguage, NodeExtractor[]> = {
	typescript: TS_EXTRACTORS,
	tsx: TS_EXTRACTORS,
	javascript: JS_EXTRACTORS,
	python: PYTHON_EXTRACTORS,
	go: GO_EXTRACTORS,
	rust: RUST_EXTRACTORS,
	java: JAVA_EXTRACTORS,
	c: C_EXTRACTORS,
	cpp: CPP_EXTRACTORS,
	gdscript: GDSCRIPT_EXTRACTORS,
};

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the tree-sitter WASM runtime. Must be called before parsing.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initTreeSitter(): Promise<void> {
	if (initialized) return;
	if (initPromise) return initPromise;

	initPromise = (async () => {
		try {
			const mod = await import("web-tree-sitter");
			Parser = mod.Parser;
			Language = mod.Language;

			const wasmPath = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
			const wasmBuf = readFileSync(wasmPath);
			await Parser.init({ locateFile: () => wasmPath, wasmBinary: wasmBuf });
			initialized = true;
		} catch (err) {
			// Reset so subsequent calls can retry instead of returning
			// the same rejected promise forever
			initPromise = null;
			throw err;
		}
	})();

	return initPromise;
}

// ============================================================================
// Language Loading
// ============================================================================

/** Load and cache a tree-sitter language grammar. */
async function loadLanguage(lang: TreeSitterLanguage): Promise<import("web-tree-sitter").Language> {
	const cached = languageCache.get(lang);
	if (cached) return cached;

	if (!Language) {
		throw new Error("tree-sitter not initialized — call initTreeSitter() first");
	}

	const grammarPath = require.resolve(GRAMMAR_PATHS[lang]);
	const loaded = await Language.load(grammarPath);
	languageCache.set(lang, loaded);
	return loaded;
}

// ============================================================================
// AST Extraction
// ============================================================================

/**
 * Walk the tree and collect nodes matching the target types.
 * Returns regions sorted by start position, with nested nodes skipped
 * (only outermost matches are kept).
 */
function extractRegions(rootNode: TSNode, extractors: NodeExtractor[], _sourceLines: string[]): ExtractedRegion[] {
	// Gather all target node types
	const typeToExtractors = new Map<string, NodeExtractor>();
	for (const ext of extractors) {
		typeToExtractors.set(ext.type, ext);
	}

	const targetTypes = extractors.map((e) => e.type);
	const candidates = rootNode.descendantsOfType(targetTypes);

	// Convert to regions
	const raw: ExtractedRegion[] = [];
	for (const node of candidates) {
		const ext = typeToExtractors.get(node.type);
		if (!ext) continue;

		// For struct_specifier in C, only extract if it has a body (field_declaration_list)
		if (node.type === "struct_specifier") {
			const hasBody = node.children.some((c) => c.type === "field_declaration_list");
			if (!hasBody) continue;
		}

		// For arrow_function, only extract if parent is variable_declarator (named assignment)
		if (node.type === "arrow_function") {
			if (node.parent?.type !== "variable_declarator") continue;
		}

		const startLine = node.startPosition.row + 1; // 0→1 indexed
		const endLine = node.endPosition.row + 1;

		raw.push({
			name: ext.getName(node),
			kind: ext.kind,
			startLine,
			endLine,
			content: node.text,
		});
	}

	// Sort by start line, then by end line descending (larger ranges first)
	raw.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);

	// Remove nested regions — keep only outermost
	const regions: ExtractedRegion[] = [];
	let lastEndLine = -1;

	for (const region of raw) {
		if (region.startLine > lastEndLine) {
			regions.push(region);
			lastEndLine = region.endLine;
		}
		// else: this region is nested inside the previous one — skip
	}

	return regions;
}

// ============================================================================
// Gap Collection
// ============================================================================

/** Minimum number of non-blank lines for a gap to become its own chunk. */
const MIN_GAP_LINES = 3;

/**
 * Create file-level chunks for substantial code between extracted regions.
 */
function collectGaps(
	regions: ExtractedRegion[],
	sourceLines: string[],
	filePath: string,
	fileType: TreeSitterLanguage,
): Chunk[] {
	const gaps: Chunk[] = [];
	let cursor = 1; // 1-indexed current line

	for (const region of regions) {
		if (region.startLine > cursor) {
			const gapLines = sourceLines.slice(cursor - 1, region.startLine - 1);
			const nonBlank = gapLines.filter((l) => l.trim().length > 0).length;
			if (nonBlank > MIN_GAP_LINES) {
				gaps.push({
					filePath,
					startLine: cursor,
					endLine: region.startLine - 1,
					kind: "file",
					name: null,
					content: gapLines.join("\n"),
					fileType,
				});
			}
		}
		cursor = region.endLine + 1;
	}

	// Trailing gap after last region
	if (cursor <= sourceLines.length) {
		const gapLines = sourceLines.slice(cursor - 1);
		const nonBlank = gapLines.filter((l) => l.trim().length > 0).length;
		if (nonBlank > MIN_GAP_LINES) {
			gaps.push({
				filePath,
				startLine: cursor,
				endLine: sourceLines.length,
				kind: "file",
				name: null,
				content: gapLines.join("\n"),
				fileType,
			});
		}
	}

	return gaps;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Parse a source file with tree-sitter and extract AST-aware chunks.
 *
 * Returns chunks for functions, classes, methods, and other language-specific
 * constructs, plus file-level chunks for substantial gaps between them.
 *
 * @param content - Raw source code text
 * @param filePath - Relative file path (stored in chunk metadata)
 * @param language - Tree-sitter language identifier
 */
export async function chunkWithTreeSitter(
	content: string,
	filePath: string,
	language: TreeSitterLanguage,
): Promise<Chunk[]> {
	if (!initialized || !Parser) {
		await initTreeSitter();
	}

	// After init, Parser is guaranteed to be set
	const ParserCtor = Parser!;
	const lang = await loadLanguage(language);
	const parser = new ParserCtor();
	parser.setLanguage(lang);

	const tree = parser.parse(content);
	if (!tree) {
		// Parse failed — free the parser WASM memory before returning
		parser.delete();
		const lines = content.split("\n");
		return [
			{
				filePath,
				startLine: 1,
				endLine: lines.length,
				kind: "file",
				name: null,
				content,
				fileType: language,
			},
		];
	}

	try {
		const sourceLines = content.split("\n");
		const extractors = LANGUAGE_EXTRACTORS[language];
		const regions = extractRegions(tree.rootNode, extractors, sourceLines);

		// Convert regions to Chunk objects
		const chunks: Chunk[] = regions.map((r) => ({
			filePath,
			startLine: r.startLine,
			endLine: r.endLine,
			kind: r.kind,
			name: r.name,
			content: r.content,
			fileType: language,
		}));

		// Add gap chunks
		const gaps = collectGaps(regions, sourceLines, filePath, language);

		// Merge and sort by start line
		const all = [...chunks, ...gaps];
		all.sort((a, b) => a.startLine - b.startLine);

		// If no regions were extracted, return the whole file as one chunk
		if (chunks.length === 0) {
			return [
				{
					filePath,
					startLine: 1,
					endLine: sourceLines.length,
					kind: "file",
					name: null,
					content,
					fileType: language,
				},
			];
		}

		return all;
	} finally {
		tree.delete();
		parser.delete();
	}
}
