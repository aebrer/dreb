/**
 * Chunking coordinator for the semantic search subsystem.
 *
 * Dispatches to the tree-sitter AST chunker for code files and the
 * text chunker for non-code files (markdown, YAML, JSON, etc.).
 */

import { chunkTextFile } from "./text-chunker.js";
import { chunkWithTreeSitter, initTreeSitter } from "./tree-sitter-chunker.js";
import type { Chunk, FileType, TextFileType, TreeSitterLanguage } from "./types.js";

// ============================================================================
// Language Sets
// ============================================================================

const TREE_SITTER_LANGUAGES: Set<string> = new Set([
	"typescript",
	"tsx",
	"javascript",
	"python",
	"go",
	"rust",
	"java",
	"c",
	"cpp",
]);

// ============================================================================
// Public API
// ============================================================================

/**
 * Chunk a file's content into semantically meaningful pieces.
 *
 * For code files, uses tree-sitter to parse the AST and extract functions,
 * classes, methods, etc. For text files, uses format-specific splitting rules.
 *
 * If tree-sitter parsing fails for a code file, falls back to plaintext chunking.
 *
 * @param content - Raw file content
 * @param filePath - Relative file path (stored in chunk metadata)
 * @param fileType - Detected file type
 */
export async function chunkFile(content: string, filePath: string, fileType: FileType): Promise<Chunk[]> {
	if (TREE_SITTER_LANGUAGES.has(fileType)) {
		try {
			await initTreeSitter();
			return await chunkWithTreeSitter(content, filePath, fileType as TreeSitterLanguage);
		} catch {
			// Tree-sitter failed — fall back to plaintext chunking
			return chunkTextFile(content, filePath, "plaintext");
		}
	}

	return chunkTextFile(content, filePath, fileType as TextFileType);
}
