/**
 * Text file chunker for the semantic search subsystem.
 *
 * Splits non-code files (markdown, YAML, JSON, TOML, plaintext) into
 * semantically meaningful chunks using format-specific boundary detection.
 */

import type { Chunk, TextFileType } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/** Files smaller than this are returned as a single chunk. */
const MIN_SPLIT_SIZE = 500;

/** Maximum characters per chunk — oversized sections are split at paragraph boundaries. */
const MAX_CHUNK_SIZE = 8000;

/** Minimum characters for a plaintext paragraph chunk (small ones get merged). */
const MIN_PARAGRAPH_SIZE = 200;

// ============================================================================
// Public API
// ============================================================================

/**
 * Chunk a non-code text file by format-specific boundaries.
 *
 * Returns at least one chunk for any non-empty input. Empty files produce
 * a single chunk of kind 'file'.
 */
export function chunkTextFile(content: string, filePath: string, fileType: TextFileType): Chunk[] {
	// Empty or trivially small files → single chunk
	if (content.length < MIN_SPLIT_SIZE) {
		return [wholeFileChunk(content, filePath, fileType)];
	}

	let chunks: Chunk[];
	switch (fileType) {
		case "markdown":
			chunks = chunkMarkdown(content, filePath);
			break;
		case "yaml":
			chunks = chunkYaml(content, filePath);
			break;
		case "json":
			chunks = chunkJson(content, filePath);
			break;
		case "toml":
			chunks = chunkToml(content, filePath);
			break;
		case "plaintext":
			chunks = chunkPlaintext(content, filePath);
			break;
		default:
			chunks = [];
	}

	// Fallback: if format-specific parsing produced nothing, return whole file
	if (chunks.length === 0) {
		return [wholeFileChunk(content, filePath, fileType)];
	}

	// Enforce max chunk size — split oversized chunks at paragraph boundaries
	return chunks.flatMap((chunk) => enforceMaxSize(chunk));
}

// ============================================================================
// Markdown
// ============================================================================

/** Heading regex: lines starting with 1–6 # characters followed by a space. */
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

function chunkMarkdown(content: string, filePath: string): Chunk[] {
	const lines = content.split("\n");

	// Identify heading positions and levels
	const headings: Array<{ line: number; level: number; text: string }> = [];
	for (let i = 0; i < lines.length; i++) {
		const match = HEADING_RE.exec(lines[i]);
		if (match) {
			headings.push({ line: i, level: match[1].length, text: match[2].trim() });
		}
	}

	// No headings → treat as plaintext
	if (headings.length === 0) {
		return chunkPlaintext(content, filePath);
	}

	const chunks: Chunk[] = [];

	// Content before the first heading (preamble)
	if (headings[0].line > 0) {
		const preambleLines = lines.slice(0, headings[0].line);
		const preambleContent = preambleLines.join("\n");
		if (preambleContent.trim().length > 0) {
			chunks.push({
				filePath,
				startLine: 1,
				endLine: headings[0].line, // 1-indexed, line before the first heading
				kind: "heading_section",
				name: null,
				content: preambleContent,
				fileType: "markdown",
			});
		}
	}

	// Each heading owns all lines until the next heading of same or higher level
	for (let i = 0; i < headings.length; i++) {
		const start = headings[i].line;
		let end: number;

		// Find the next heading at the same or higher (lower number) level
		let nextSameOrHigher = -1;
		for (let j = i + 1; j < headings.length; j++) {
			if (headings[j].level <= headings[i].level) {
				nextSameOrHigher = j;
				break;
			}
		}

		if (nextSameOrHigher !== -1) {
			end = headings[nextSameOrHigher].line - 1;
		} else {
			end = lines.length - 1;
		}

		const sectionLines = lines.slice(start, end + 1);
		const sectionContent = sectionLines.join("\n");

		chunks.push({
			filePath,
			startLine: start + 1, // 1-indexed
			endLine: end + 1, // 1-indexed, inclusive
			kind: "heading_section",
			name: headings[i].text,
			content: sectionContent,
			fileType: "markdown",
		});
	}

	return chunks;
}

// ============================================================================
// YAML
// ============================================================================

/**
 * Top-level YAML key: a line that starts with a non-space, non-comment
 * character and contains a colon. Excludes YAML directives (---/...).
 */
const YAML_TOP_KEY_RE = /^([a-zA-Z_][a-zA-Z0-9_.-]*)\s*:/;

function chunkYaml(content: string, filePath: string): Chunk[] {
	const lines = content.split("\n");

	// Find top-level key positions
	const keys: Array<{ line: number; name: string }> = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Skip comments, blank lines, YAML directives
		if (line.startsWith("#") || line.startsWith("---") || line.startsWith("...") || line.trim() === "") {
			continue;
		}
		const match = YAML_TOP_KEY_RE.exec(line);
		if (match) {
			keys.push({ line: i, name: match[1] });
		}
	}

	if (keys.length === 0) {
		return [];
	}

	const chunks: Chunk[] = [];

	// Content before the first key (comments, directives)
	if (keys[0].line > 0) {
		const preambleLines = lines.slice(0, keys[0].line);
		const preambleContent = preambleLines.join("\n");
		if (preambleContent.trim().length > 0) {
			// Attach preamble to the first key's chunk by adjusting its start
			// (handled below by starting from line 0 for the first key)
		}
	}

	for (let i = 0; i < keys.length; i++) {
		// Include any preceding comments/blank lines that belong to this key
		// by looking backwards from the key to find attached comments
		let start = keys[i].line;
		if (i === 0) {
			// First key includes any preamble (comments, directives)
			start = 0;
		} else {
			// Look back for comment lines directly above
			let scan = keys[i].line - 1;
			while (scan > keys[i - 1].line) {
				const trimmed = lines[scan].trim();
				if (trimmed.startsWith("#") || trimmed === "") {
					scan--;
				} else {
					break;
				}
			}
			start = scan + 1;
		}

		const end = i < keys.length - 1 ? keys[i + 1].line - 1 : lines.length - 1;

		// Trim trailing blank lines to find the real end
		let realEnd = end;
		while (realEnd > start && lines[realEnd].trim() === "") {
			realEnd--;
		}
		// But keep at least the key line
		if (realEnd < keys[i].line) realEnd = keys[i].line;

		// Include trailing blank lines within the range for line counting,
		// but use them as separators
		const sectionLines = lines.slice(start, end + 1);
		const sectionContent = sectionLines.join("\n");

		chunks.push({
			filePath,
			startLine: start + 1,
			endLine: end + 1,
			kind: "top_level_key",
			name: keys[i].name,
			content: sectionContent,
			fileType: "yaml",
		});
	}

	return chunks;
}

// ============================================================================
// JSON
// ============================================================================

function chunkJson(content: string, filePath: string): Chunk[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		// Invalid JSON → return as whole file
		return [];
	}

	// Only split top-level objects. Arrays and primitives → single chunk.
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return [];
	}

	const topKeys = Object.keys(parsed);
	if (topKeys.length === 0) {
		return [];
	}

	// For JSON we can't rely on simple line scanning because values can span
	// multiple lines with arbitrary nesting. Instead, re-serialize each
	// top-level key and locate its position in the original content.
	const lines = content.split("\n");
	const chunks: Chunk[] = [];

	// Strategy: scan the original text to find each top-level key's line range.
	// A top-level key in formatted JSON appears as `  "key":` at indent level 1.
	// In minified JSON with a single line, we fall back to serialized slicing.
	if (lines.length === 1) {
		// Minified JSON — produce one chunk per top-level key using re-serialized content
		const obj = parsed as Record<string, unknown>;
		for (const key of topKeys) {
			const serialized = JSON.stringify({ [key]: obj[key] }, null, 2);
			chunks.push({
				filePath,
				startLine: 1,
				endLine: 1,
				kind: "top_level_key",
				name: key,
				content: serialized,
				fileType: "json",
			});
		}
		return chunks;
	}

	// Multi-line JSON: find each top-level key by scanning for `"key":` at
	// brace depth 1.
	const keyPositions: Array<{ key: string; startLine: number }> = [];
	let depth = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (let c = 0; c < line.length; c++) {
			const ch = line[c];
			if (ch === '"') {
				// Skip string content
				c++;
				while (c < line.length && line[c] !== '"') {
					if (line[c] === "\\") c++; // skip escaped char
					c++;
				}
				// Check if this string at depth 1 is a key (followed by :)
				if (depth === 1) {
					// Extract the key name
					const keyMatch = /^\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*:/.exec(line);
					if (keyMatch) {
						const foundKey = keyMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
						if (topKeys.includes(foundKey) && !keyPositions.some((kp) => kp.key === foundKey)) {
							keyPositions.push({ key: foundKey, startLine: i });
						}
						break; // Move to next line — we found the key on this line
					}
				}
			} else if (ch === "{" || ch === "[") {
				depth++;
			} else if (ch === "}" || ch === "]") {
				depth--;
			}
		}
	}

	// Build chunks from key positions
	for (let i = 0; i < keyPositions.length; i++) {
		const start = keyPositions[i].startLine;
		const end = i < keyPositions.length - 1 ? keyPositions[i + 1].startLine - 1 : lines.length - 1;

		// Trim the trailing closing brace of the root object from the last chunk
		let realEnd = end;
		if (i === keyPositions.length - 1) {
			// Walk back from end to skip the root closing brace and trailing whitespace
			while (realEnd > start && lines[realEnd].trim() === "") realEnd--;
			if (realEnd > start && lines[realEnd].trim() === "}") realEnd--;
		}

		// Trim trailing commas and blank lines from non-last chunks too
		while (realEnd > start && lines[realEnd].trim() === "") realEnd--;

		const sectionContent = lines.slice(start, realEnd + 1).join("\n");

		chunks.push({
			filePath,
			startLine: start + 1,
			endLine: realEnd + 1,
			kind: "top_level_key",
			name: keyPositions[i].key,
			content: sectionContent,
			fileType: "json",
		});
	}

	return chunks;
}

// ============================================================================
// TOML
// ============================================================================

/** TOML section header: [section] or [[array-of-tables]]. */
const TOML_SECTION_RE = /^\[{1,2}([^\]]+)\]{1,2}\s*$/;

/** TOML top-level key-value pair (not indented, before any section). */
const TOML_KV_RE = /^([a-zA-Z_][a-zA-Z0-9_.-]*)\s*=/;

function chunkToml(content: string, filePath: string): Chunk[] {
	const lines = content.split("\n");

	// Phase 1: Identify all top-level boundaries (sections and top-level KV pairs before sections)
	const boundaries: Array<{
		line: number;
		kind: "section" | "kv";
		name: string;
	}> = [];

	let firstSectionLine = lines.length;

	// Find section headers first
	for (let i = 0; i < lines.length; i++) {
		const match = TOML_SECTION_RE.exec(lines[i]);
		if (match) {
			if (i < firstSectionLine) firstSectionLine = i;
			boundaries.push({ line: i, kind: "section", name: match[1].trim() });
		}
	}

	// Find top-level key-value pairs (lines before the first section)
	const kvGroups: Array<{ startLine: number; name: string }> = [];
	for (let i = 0; i < firstSectionLine; i++) {
		const line = lines[i];
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		const match = TOML_KV_RE.exec(line);
		if (match) {
			kvGroups.push({ startLine: i, name: match[1] });
		}
	}

	// Merge KV pairs into boundaries
	for (const kv of kvGroups) {
		boundaries.push({ line: kv.startLine, kind: "kv", name: kv.name });
	}

	// Sort boundaries by line number
	boundaries.sort((a, b) => a.line - b.line);

	if (boundaries.length === 0) {
		return [];
	}

	const chunks: Chunk[] = [];

	for (let i = 0; i < boundaries.length; i++) {
		const boundary = boundaries[i];
		let start = boundary.line;
		const end = i < boundaries.length - 1 ? boundaries[i + 1].line - 1 : lines.length - 1;

		// For sections, look back for attached comments
		if (boundary.kind === "section" && i > 0) {
			let scan = boundary.line - 1;
			const prevEnd = boundaries[i - 1].line;
			while (scan > prevEnd) {
				const trimmed = lines[scan].trim();
				if (trimmed.startsWith("#") || trimmed === "") {
					scan--;
				} else {
					break;
				}
			}
			start = scan + 1;
		} else if (boundary.kind === "kv" && i === 0) {
			// First KV — include any leading comments
			start = 0;
		} else if (boundary.kind === "kv" && i > 0) {
			// Look back for comments attached to this KV
			let scan = boundary.line - 1;
			const prevEnd = boundaries[i - 1].line;
			while (scan > prevEnd) {
				const trimmed = lines[scan].trim();
				if (trimmed.startsWith("#") || trimmed === "") {
					scan--;
				} else {
					break;
				}
			}
			start = scan + 1;
		}

		const sectionContent = lines.slice(start, end + 1).join("\n");

		chunks.push({
			filePath,
			startLine: start + 1,
			endLine: end + 1,
			kind: "top_level_key",
			name: boundary.name,
			content: sectionContent,
			fileType: "toml",
		});
	}

	return chunks;
}

// ============================================================================
// Plaintext
// ============================================================================

function chunkPlaintext(content: string, filePath: string): Chunk[] {
	const lines = content.split("\n");

	// Split into paragraphs at double-newline boundaries
	const paragraphs: Array<{ startLine: number; endLine: number; content: string }> = [];
	let paraStart = -1;
	let consecutiveBlanks = 0;

	for (let i = 0; i < lines.length; i++) {
		const isBlank = lines[i].trim() === "";

		if (isBlank) {
			consecutiveBlanks++;
			if (consecutiveBlanks >= 2 && paraStart !== -1) {
				// End current paragraph at the last non-blank line
				let paraEnd = i - consecutiveBlanks;
				if (paraEnd < paraStart) paraEnd = paraStart;
				paragraphs.push({
					startLine: paraStart,
					endLine: paraEnd,
					content: lines.slice(paraStart, paraEnd + 1).join("\n"),
				});
				paraStart = -1;
			}
		} else {
			if (paraStart === -1) {
				paraStart = i;
			}
			consecutiveBlanks = 0;
		}
	}

	// Don't forget the last paragraph
	if (paraStart !== -1) {
		let paraEnd = lines.length - 1;
		while (paraEnd > paraStart && lines[paraEnd].trim() === "") paraEnd--;
		paragraphs.push({
			startLine: paraStart,
			endLine: paraEnd,
			content: lines.slice(paraStart, paraEnd + 1).join("\n"),
		});
	}

	if (paragraphs.length === 0) {
		return [];
	}

	// Group small paragraphs together to meet the minimum size
	const chunks: Chunk[] = [];
	let groupStart = paragraphs[0].startLine;
	let groupEnd = paragraphs[0].endLine;
	let groupContent = paragraphs[0].content;

	for (let i = 1; i < paragraphs.length; i++) {
		const para = paragraphs[i];

		if (groupContent.length < MIN_PARAGRAPH_SIZE) {
			// Merge with current group
			groupEnd = para.endLine;
			groupContent += `\n\n${para.content}`;
		} else {
			// Emit current group, start new one
			chunks.push({
				filePath,
				startLine: groupStart + 1,
				endLine: groupEnd + 1,
				kind: "paragraph",
				name: extractParagraphName(groupContent),
				content: groupContent,
				fileType: "plaintext",
			});
			groupStart = para.startLine;
			groupEnd = para.endLine;
			groupContent = para.content;
		}
	}

	// Emit final group
	// If the final group is too small and there are existing chunks, merge with the last one
	if (groupContent.length < MIN_PARAGRAPH_SIZE && chunks.length > 0) {
		const last = chunks[chunks.length - 1];
		last.endLine = groupEnd + 1;
		last.content += `\n\n${groupContent}`;
	} else {
		chunks.push({
			filePath,
			startLine: groupStart + 1,
			endLine: groupEnd + 1,
			kind: "paragraph",
			name: extractParagraphName(groupContent),
			content: groupContent,
			fileType: "plaintext",
		});
	}

	return chunks;
}

/** Extract a short name from the first line of a paragraph, truncated. */
function extractParagraphName(content: string): string | null {
	const firstLine = content.split("\n")[0].trim();
	if (firstLine.length === 0) return null;
	if (firstLine.length <= 60) return firstLine;
	return `${firstLine.slice(0, 57)}...`;
}

// ============================================================================
// Chunk Size Enforcement
// ============================================================================

/**
 * If a chunk exceeds MAX_CHUNK_SIZE, split it at paragraph boundaries
 * (double newlines). If no paragraph boundaries exist, split at line
 * boundaries near the limit.
 */
function enforceMaxSize(chunk: Chunk): Chunk[] {
	if (chunk.content.length <= MAX_CHUNK_SIZE) {
		return [chunk];
	}

	const lines = chunk.content.split("\n");
	const subChunks: Chunk[] = [];
	let currentLines: string[] = [];
	let currentSize = 0;
	let chunkStartLine = chunk.startLine;
	let partIndex = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineSize = line.length + 1; // +1 for newline

		// Check if adding this line would exceed the limit
		if (currentSize + lineSize > MAX_CHUNK_SIZE && currentLines.length > 0) {
			// Try to find a paragraph boundary (blank line) to split at
			let splitAt = currentLines.length;
			for (let j = currentLines.length - 1; j > 0; j--) {
				if (currentLines[j].trim() === "") {
					splitAt = j;
					break;
				}
			}

			// Emit the sub-chunk up to the split point
			const emitLines = currentLines.slice(0, splitAt);
			const emitContent = emitLines.join("\n");
			const emitEndLine = chunkStartLine + splitAt - 1;

			subChunks.push({
				filePath: chunk.filePath,
				startLine: chunkStartLine,
				endLine: emitEndLine,
				kind: chunk.kind,
				name: partIndex === 0 ? chunk.name : chunk.name ? `${chunk.name} (cont.)` : null,
				content: emitContent,
				fileType: chunk.fileType,
			});
			partIndex++;

			// Keep remaining lines from the split
			const remaining = currentLines.slice(splitAt);
			currentLines = [...remaining, line];
			chunkStartLine = emitEndLine + 1;
			currentSize = currentLines.join("\n").length;
		} else {
			currentLines.push(line);
			currentSize += lineSize;
		}
	}

	// Emit remaining lines
	if (currentLines.length > 0) {
		const emitContent = currentLines.join("\n");
		subChunks.push({
			filePath: chunk.filePath,
			startLine: chunkStartLine,
			endLine: chunk.endLine,
			kind: chunk.kind,
			name: partIndex === 0 ? chunk.name : chunk.name ? `${chunk.name} (cont.)` : null,
			content: emitContent,
			fileType: chunk.fileType,
		});
	}

	return subChunks.length > 0 ? subChunks : [chunk];
}

// ============================================================================
// Helpers
// ============================================================================

function wholeFileChunk(content: string, filePath: string, fileType: TextFileType): Chunk {
	const lineCount = content.split("\n").length;
	return {
		filePath,
		startLine: 1,
		endLine: lineCount,
		kind: "file",
		name: null,
		content,
		fileType,
	};
}
