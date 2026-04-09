/**
 * Shared utility for .dreb/ directory visibility in tools.
 *
 * When .dreb/ is in .gitignore, tools (rg, fd, scanner) skip it entirely.
 * This module provides a blocklist-based approach: dynamically discover all
 * .dreb/ subdirectories and exclude only known-sensitive or binary-heavy ones.
 * Everything else is automatically tool-visible.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** .dreb/ subdirectories that tools must NOT expose. */
const DREB_HIDDEN_SUBDIRS = new Set([
	"index", // SQLite search DB (binary, large)
	"agent", // session logs, model cache, auth tokens, downloaded binaries
	"secrets", // API keys
]);

export const DREB_DIR = ".dreb";

/**
 * Get tool-visible .dreb/ subdirectory paths for a project root.
 *
 * Dynamically lists .dreb/ entries, excludes blocklisted ones.
 * Returns absolute paths. Returns empty array if .dreb/ doesn't exist.
 */
export function getDrebToolVisibleDirs(projectRoot: string): string[] {
	const drebDir = path.join(projectRoot, DREB_DIR);
	if (!existsSync(drebDir)) return [];

	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(drebDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const paths: string[] = [];
	for (const entry of entries) {
		if (entry.isDirectory() && !DREB_HIDDEN_SUBDIRS.has(entry.name)) {
			paths.push(path.join(drebDir, entry.name));
		}
	}
	return paths;
}
