/**
 * File scanner for the semantic search subsystem.
 *
 * Discovers project files for indexing by walking the directory tree,
 * respecting .gitignore rules, and classifying files by type.
 */

import { existsSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import ignore from "ignore";
import type { FileType } from "./types.js";

// ============================================================================
// Public types
// ============================================================================

/** A file discovered by the scanner, ready for indexing. */
export interface ScannedFile {
	/** Path relative to the project root (posix separators). */
	filePath: string;
	/** Detected file type. */
	fileType: FileType;
	/** File modification time in milliseconds since epoch. */
	mtime: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum file size to index (1 MB). */
const MAX_FILE_SIZE = 1024 * 1024;

/** Directories unconditionally skipped during traversal. */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".dreb/index",
	".hg",
	".svn",
	"__pycache__",
	".tox",
	".venv",
	"dist",
	"build",
	".next",
	".nuxt",
	"coverage",
	".cache",
]);

/** Extension → FileType mapping. */
const EXTENSION_MAP: ReadonlyMap<string, FileType> = new Map<string, FileType>([
	// Tree-sitter languages
	[".ts", "typescript"],
	[".tsx", "tsx"],
	[".js", "javascript"],
	[".mjs", "javascript"],
	[".cjs", "javascript"],
	[".py", "python"],
	[".go", "go"],
	[".rs", "rust"],
	[".java", "java"],
	[".c", "c"],
	[".h", "c"],
	[".cpp", "cpp"],
	[".hpp", "cpp"],
	[".cc", "cpp"],
	[".cxx", "cpp"],
	[".hh", "cpp"],
	[".hxx", "cpp"],
	// Text file types
	[".md", "markdown"],
	[".mdx", "markdown"],
	[".yml", "yaml"],
	[".yaml", "yaml"],
	[".json", "json"],
	[".toml", "toml"],
	[".txt", "plaintext"],
	[".cfg", "plaintext"],
	[".ini", "plaintext"],
	[".env", "plaintext"],
	[".conf", "plaintext"],
]);

// ============================================================================
// Public API
// ============================================================================

/**
 * Detect the {@link FileType} for a file path based on its extension.
 * Returns `null` for unrecognized extensions or files without an extension.
 */
export function detectFileType(filePath: string): FileType | null {
	const ext = extname(filePath).toLowerCase();
	if (!ext) return null;
	return EXTENSION_MAP.get(ext) ?? null;
}

/**
 * Scan a project directory and return all indexable files.
 *
 * Walks the tree rooted at {@link projectRoot}, respects `.gitignore` rules,
 * skips binary / oversized files, and optionally includes memory files from
 * a global memory directory.
 */
export async function scanProject(projectRoot: string, globalMemoryDir?: string): Promise<ScannedFile[]> {
	const results: ScannedFile[] = [];

	// Detect if projectRoot is the home directory — use shallow scan mode
	// to avoid recursing into the entire home dir (which would be catastrophic).
	const isHomeDir = isHomeDirPath(projectRoot);

	if (isHomeDir) {
		// Shallow mode: only scan top-level files and ~/.dreb/memory/
		scanShallow(projectRoot, results);
	} else {
		// Normal mode: full recursive walk with .gitignore
		const ig = ignore();
		loadGitignore(ig, projectRoot, projectRoot);
		walkDirectory(projectRoot, projectRoot, ig, results);
	}

	// Include global memory files if the directory exists
	if (globalMemoryDir && existsSync(globalMemoryDir)) {
		scanMemoryDir(globalMemoryDir, projectRoot, results);
	}

	return results;
}

/** Check if a path is the user's home directory. */
function isHomeDirPath(dir: string): boolean {
	try {
		const home = homedir();
		// Normalize trailing slashes for comparison
		const normalizedDir = dir.replace(/[/\\]+$/, "");
		const normalizedHome = home.replace(/[/\\]+$/, "");
		return normalizedDir === normalizedHome;
	} catch {
		return false;
	}
}

/**
 * Shallow scan mode for home directory: only index top-level files
 * (no directory recursion) to avoid scanning the entire home directory.
 * Memory files are handled separately via scanMemoryDir.
 */
function scanShallow(dir: string, results: ScannedFile[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}

	for (const entry of entries) {
		// Skip dotfiles/dotdirs in home dir (except specific ones we want)
		if (entry.startsWith(".")) continue;

		const fullPath = join(dir, entry);

		let stats: Stats;
		try {
			stats = statSync(fullPath);
		} catch {
			continue;
		}

		// Only index files, not directories (shallow mode)
		if (!stats.isFile()) continue;
		if (stats.size > MAX_FILE_SIZE) continue;
		if (stats.size === 0) continue;

		const fileType = detectFileType(entry);
		if (!fileType) continue;

		results.push({
			filePath: entry,
			fileType,
			mtime: stats.mtimeMs,
		});
	}
}

// ============================================================================
// Internal helpers
// ============================================================================

type IgnoreMatcher = ReturnType<typeof ignore>;

/** Convert an OS path to posix separators for ignore matching. */
function toPosix(p: string): string {
	return p.split(sep).join("/");
}

/** Load .gitignore rules from a directory into the ignore matcher. */
function loadGitignore(ig: IgnoreMatcher, dir: string, root: string): void {
	const gitignorePath = join(dir, ".gitignore");
	if (!existsSync(gitignorePath)) return;

	try {
		const content = readFileSync(gitignorePath, "utf-8");
		const relDir = relative(root, dir);
		const prefix = relDir ? `${toPosix(relDir)}/` : "";

		const patterns = content
			.split(/\r?\n/)
			.map((line) => prefixPattern(line, prefix))
			.filter((line): line is string => line !== null);

		if (patterns.length > 0) {
			ig.add(patterns);
		}
	} catch {
		// Unreadable .gitignore — skip silently
	}
}

/**
 * Prefix a .gitignore pattern with a directory path so it applies
 * correctly when matching against root-relative paths.
 */
function prefixPattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

/**
 * Check if a directory component (relative to root) should be unconditionally skipped.
 * Handles both top-level names ("node_modules") and nested paths (".dreb/index").
 */
function shouldSkipDir(relPath: string): boolean {
	const posix = toPosix(relPath);

	// Check the directory name itself
	const parts = posix.split("/");
	const name = parts[parts.length - 1];
	if (SKIP_DIRS.has(name)) return true;

	// Check multi-segment skip patterns (e.g. ".dreb/index")
	for (const skip of SKIP_DIRS) {
		if (skip.includes("/") && (posix === skip || posix.endsWith(`/${skip}`))) {
			return true;
		}
	}

	return false;
}

/** Recursively walk a directory, collecting indexable files. */
function walkDirectory(dir: string, root: string, ig: IgnoreMatcher, results: ScannedFile[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return; // Permission denied, etc.
	}

	for (const entry of entries) {
		const fullPath = join(dir, entry);
		const relPath = relative(root, fullPath);
		const posixRel = toPosix(relPath);

		let stats: Stats;
		try {
			stats = statSync(fullPath);
		} catch {
			continue; // Broken symlink, etc.
		}

		if (stats.isDirectory()) {
			// Hard-coded skip list
			if (shouldSkipDir(relPath)) continue;

			// .gitignore check (directories need trailing slash)
			if (ig.ignores(`${posixRel}/`)) continue;

			// Load nested .gitignore before descending
			loadGitignore(ig, fullPath, root);

			walkDirectory(fullPath, root, ig, results);
			continue;
		}

		if (!stats.isFile()) continue;

		// .gitignore check for files
		if (ig.ignores(posixRel)) continue;

		// Size gate
		if (stats.size > MAX_FILE_SIZE) continue;
		if (stats.size === 0) continue;

		// File type detection
		const fileType = detectFileType(entry);
		if (!fileType) continue;

		results.push({
			filePath: posixRel,
			fileType,
			mtime: stats.mtimeMs,
		});
	}
}

/**
 * Scan a memory directory (project or global) for indexable files.
 *
 * Memory directories are always fully included — no .gitignore filtering —
 * because they live outside the normal project tree or in `.dreb/` which
 * is typically gitignored.
 *
 * Paths for global memory files are stored with a `~memory/` prefix
 * to distinguish them from project files.
 */
function scanMemoryDir(memoryDir: string, projectRoot: string, results: ScannedFile[]): void {
	let entries: string[];
	try {
		entries = readdirSync(memoryDir);
	} catch {
		return;
	}

	for (const entry of entries) {
		const fullPath = join(memoryDir, entry);

		let stats: Stats;
		try {
			stats = statSync(fullPath);
		} catch {
			continue;
		}

		if (stats.isDirectory()) {
			// Recurse into subdirectories
			scanMemoryDir(fullPath, projectRoot, results);
			continue;
		}

		if (!stats.isFile()) continue;
		if (stats.size > MAX_FILE_SIZE) continue;
		if (stats.size === 0) continue;

		const fileType = detectFileType(entry);
		if (!fileType) continue;

		// If the memory dir is inside the project root, use normal relative path.
		// Otherwise, use a ~memory/ prefix so paths remain unique and identifiable.
		const rel = relative(projectRoot, fullPath);
		const isOutsideProject = rel.startsWith("..") || isAbsolute(rel);
		const filePath = isOutsideProject ? `~memory/${relative(memoryDir, fullPath)}` : rel;

		results.push({
			filePath: toPosix(filePath),
			fileType,
			mtime: stats.mtimeMs,
		});
	}
}
