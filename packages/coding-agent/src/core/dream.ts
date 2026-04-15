import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cp, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getSessionsDir } from "../config.js";
import type { SettingsManager } from "./settings-manager.js";
import { expandPath } from "./tools/path-utils.js";

// =============================================================================
// Types
// =============================================================================

export interface DreamContext {
	archivePath: string;
	lastRunTimestamp: string | null;
	globalMemoryDir: string;
	projectMemoryDirs: string[];
	claudeMemoryDirs: string[];
	sessionsDir: string;
}

export interface BackupResult {
	backupDir: string;
	timestamp: string;
	fileCount: number;
	totalSize: number;
	verified: boolean;
}

export interface LinkValidationResult {
	valid: boolean;
	brokenLinks: Array<{ memoryDir: string; indexFile: string; pointer: string; target: string }>;
}

export type DreamCommand = { type: "run" } | { type: "setBackup"; path: string } | { type: "showBackup" };

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_ARCHIVE_DIR = "~/.dreb/memory-archive/";
const DREAM_LAST_RUN_FILE = ".dream-last-run";
const DREAM_LOCK_FILE = ".dream.lock";
const DREAM_TMP_DIR = ".dream-tmp";
const BACKUP_PREFIX = "dream-backup-";
const DEFAULT_KEEP_COUNT = 10;
const LARGE_LISTING_THRESHOLD = 10_000;

// =============================================================================
// Command Parsing
// =============================================================================

export function parseDreamCommand(text: string): DreamCommand {
	const stripped = text.replace(/^\/dream\s*/, "").trim();

	if (!stripped) {
		return { type: "run" };
	}

	if (stripped === "backup") {
		return { type: "showBackup" };
	}

	const backupMatch = stripped.match(/^backup\s+(.+)$/);
	if (backupMatch) {
		return { type: "setBackup", path: backupMatch[1].trim() };
	}

	// Unknown subcommand — treat as a plain run
	return { type: "run" };
}

// =============================================================================
// Discovery
// =============================================================================

/**
 * Decode a session directory name back into a candidate filesystem path.
 *
 * The encoding replaces path separators and colons with dashes, but original
 * dash characters are preserved — making the decode lossy. We return the
 * simplest candidate (all dashes become path separators) and rely on
 * existsSync to filter false positives.
 */
function decodeSessionDirName(encoded: string): string[] {
	const simple = `/${encoded.replace(/-/g, "/")}`;
	return [simple];
}

export function discoverAllProjectMemoryDirs(): string[] {
	const sessionsDir = getSessionsDir();
	if (!existsSync(sessionsDir)) return [];

	let dirEntries: string[];
	try {
		dirEntries = readdirSync(sessionsDir);
	} catch {
		return [];
	}

	const memoryDirs: string[] = [];
	const seen = new Set<string>();

	for (const name of dirEntries) {
		if (!name.startsWith("--") || !name.endsWith("--")) continue;

		const encoded = name.slice(2, -2); // strip --..--
		if (!encoded) continue;

		const candidates = decodeSessionDirName(encoded);
		for (const candidate of candidates) {
			const memDir = join(candidate, ".dreb", "memory");
			if (!seen.has(memDir) && existsSync(memDir)) {
				seen.add(memDir);
				memoryDirs.push(memDir);
				break;
			}
		}
	}

	return memoryDirs;
}

/**
 * Discover claude compatibility memory directories (read-only imports).
 * Scans ~/.claude/projects/ for subdirectories containing a memory/ folder.
 */
function discoverClaudeMemoryDirs(): string[] {
	const claudeProjectsDir = join(homedir(), ".claude", "projects");
	if (!existsSync(claudeProjectsDir)) return [];

	let dirEntries: string[];
	try {
		dirEntries = readdirSync(claudeProjectsDir);
	} catch {
		return [];
	}

	const memoryDirs: string[] = [];
	for (const name of dirEntries) {
		const memDir = join(claudeProjectsDir, name, "memory");
		if (existsSync(memDir)) {
			memoryDirs.push(memDir);
		}
	}
	return memoryDirs;
}

// =============================================================================
// Context Resolution
// =============================================================================

export async function resolveDreamContext(settingsManager: SettingsManager): Promise<DreamContext> {
	// Archive path from settings, or default
	const rawArchivePath =
		(settingsManager as unknown as { getDreamArchivePath?: () => string | undefined }).getDreamArchivePath?.() ??
		DEFAULT_ARCHIVE_DIR;
	const archivePath = resolve(expandPath(rawArchivePath));

	// Global memory dir
	const globalMemoryDir = join(homedir(), ".dreb", "memory");

	// Last run timestamp
	let lastRunTimestamp: string | null = null;
	const markerPath = join(globalMemoryDir, DREAM_LAST_RUN_FILE);
	try {
		if (existsSync(markerPath)) {
			const content = readFileSync(markerPath, "utf-8").trim();
			if (content) {
				lastRunTimestamp = content;
			}
		}
	} catch {
		// Marker unreadable — treat as first run
	}

	// Discover memory directories
	const projectMemoryDirs = discoverAllProjectMemoryDirs();
	const claudeMemoryDirs = discoverClaudeMemoryDirs();
	const sessionsDir = getSessionsDir();

	return {
		archivePath,
		lastRunTimestamp,
		globalMemoryDir,
		projectMemoryDirs,
		claudeMemoryDirs,
		sessionsDir,
	};
}

// =============================================================================
// Validation
// =============================================================================

export function validateArchivePath(archivePath: string, memoryDirs: string[]): void {
	if (!archivePath || !archivePath.trim()) {
		throw new Error("Dream archive path cannot be empty");
	}

	if (!isAbsolute(archivePath)) {
		throw new Error(`Dream archive path must be absolute, got: ${archivePath}`);
	}

	const normalized = resolve(archivePath);

	for (const memDir of memoryDirs) {
		const normalizedMem = resolve(memDir);

		// Archive is inside a memory dir
		if (normalized.startsWith(`${normalizedMem}/`) || normalized === normalizedMem) {
			throw new Error(
				`Dream archive path "${archivePath}" overlaps with memory directory "${memDir}". ` +
					"The archive must be outside all memory directories.",
			);
		}

		// Memory dir is inside the archive
		if (normalizedMem.startsWith(`${normalized}/`) || normalizedMem === normalized) {
			throw new Error(
				`Memory directory "${memDir}" is inside the dream archive path "${archivePath}". ` +
					"The archive must be outside all memory directories.",
			);
		}
	}
}

export function validateMemoryLinks(memoryDirs: string[]): LinkValidationResult {
	const brokenLinks: LinkValidationResult["brokenLinks"] = [];
	const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;

	for (const memDir of memoryDirs) {
		const indexFile = join(memDir, "MEMORY.md");
		if (!existsSync(indexFile)) continue;

		let content: string;
		try {
			content = readFileSync(indexFile, "utf-8");
		} catch {
			continue;
		}

		for (const match of content.matchAll(linkPattern)) {
			const pointer = match[0];
			const target = match[2];

			// Skip external URLs
			if (target.startsWith("http://") || target.startsWith("https://")) continue;

			const targetPath = join(memDir, target);
			if (!existsSync(targetPath)) {
				brokenLinks.push({ memoryDir: memDir, indexFile, pointer, target });
			}
		}
	}

	return { valid: brokenLinks.length === 0, brokenLinks };
}

// =============================================================================
// Backup
// =============================================================================

/** Convert a filesystem path to a safe directory name (same encoding as session dirs). */
export function safeDirName(path: string): string {
	return path.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
}

/** Recursively count files and total size in a directory. */
async function countFilesAndSize(dir: string): Promise<{ fileCount: number; totalSize: number }> {
	let fileCount = 0;
	let totalSize = 0;

	async function walk(current: string): Promise<void> {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = join(current, entry.name as string);
			if (entry.isDirectory()) {
				await walk(fullPath);
			} else if (entry.isFile()) {
				fileCount++;
				try {
					const st = await stat(fullPath);
					totalSize += st.size;
				} catch {
					// File disappeared between readdir and stat — skip
				}
			}
		}
	}

	await walk(dir);
	return { fileCount, totalSize };
}

export async function performDreamBackup(context: DreamContext): Promise<BackupResult> {
	const timestamp = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
	const backupDir = join(context.archivePath, `${BACKUP_PREFIX}${timestamp}`);

	try {
		mkdirSync(backupDir, { recursive: true });
	} catch (error) {
		throw new Error(
			`Failed to create backup directory "${backupDir}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// Count source files before copying
	let sourceFileCount = 0;
	let sourceTotalSize = 0;

	const allSourceDirs: Array<{ dir: string; backupTarget: string }> = [];

	// Global memory
	if (existsSync(context.globalMemoryDir)) {
		allSourceDirs.push({ dir: context.globalMemoryDir, backupTarget: join(backupDir, "global") });
	}

	// Project memories
	for (const dir of context.projectMemoryDirs) {
		if (existsSync(dir)) {
			allSourceDirs.push({
				dir,
				backupTarget: join(backupDir, "projects", safeDirName(dir)),
			});
		}
	}

	// Claude compat memories
	for (const dir of context.claudeMemoryDirs) {
		if (existsSync(dir)) {
			allSourceDirs.push({
				dir,
				backupTarget: join(backupDir, "claude", safeDirName(dir)),
			});
		}
	}

	// Count source files
	for (const { dir } of allSourceDirs) {
		const counts = await countFilesAndSize(dir);
		sourceFileCount += counts.fileCount;
		sourceTotalSize += counts.totalSize;
	}

	// Copy all source directories
	for (const { dir, backupTarget } of allSourceDirs) {
		try {
			await cp(dir, backupTarget, { recursive: true });
		} catch (error) {
			throw new Error(
				`Failed to copy "${dir}" to "${backupTarget}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// Verify: count files in backup
	const backupCounts = await countFilesAndSize(backupDir);
	const verified = backupCounts.fileCount === sourceFileCount && backupCounts.totalSize === sourceTotalSize;

	return {
		backupDir,
		timestamp,
		fileCount: backupCounts.fileCount,
		totalSize: backupCounts.totalSize,
		verified,
	};
}

// =============================================================================
// Prompt Building
// =============================================================================

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildDreamPrompt(context: DreamContext, backupResult: BackupResult): string {
	const verifiedStatus = backupResult.verified ? "✓ Verified" : "⚠ Verification mismatch — check backup integrity";
	const lastRun = context.lastRunTimestamp ?? "Never (first run)";

	// Build the file listing section
	let fileListing = "";
	const allDirs = [
		{ label: "Global", dir: context.globalMemoryDir },
		...context.projectMemoryDirs.map((d) => ({ label: `Project: ${d}`, dir: d })),
		...context.claudeMemoryDirs.map((d) => ({ label: `Claude (READ-ONLY): ${d}`, dir: d })),
	];

	for (const { label, dir } of allDirs) {
		if (!existsSync(dir)) continue;
		fileListing += `\n### ${label}\n`;
		try {
			const entries = readdirSync(dir);
			for (const entry of entries) {
				if (entry === DREAM_TMP_DIR || entry === DREAM_LOCK_FILE || entry === DREAM_LAST_RUN_FILE) continue;
				fileListing += `- ${entry}\n`;
			}
		} catch {
			fileListing += `- (unreadable)\n`;
		}
	}

	// If file listing is too large, spill to a temp file
	let fileListingSection: string;
	if (fileListing.length > LARGE_LISTING_THRESHOLD) {
		const tmpDir = join(context.globalMemoryDir, DREAM_TMP_DIR);
		try {
			mkdirSync(tmpDir, { recursive: true });
		} catch {
			// Best-effort
		}
		const tmpPath = join(tmpDir, `dream-listing-${Date.now()}.md`);
		try {
			writeFileSync(tmpPath, fileListing, "utf-8");
			fileListingSection =
				`File listing too large to include inline. Full listing written to: ${tmpPath}\n` +
				"Read this file for the complete list of memory files.";
		} catch {
			// Fallback: include inline anyway
			fileListingSection = fileListing;
		}
	} else {
		fileListingSection = fileListing;
	}

	const projectDirsList =
		context.projectMemoryDirs.length > 0
			? context.projectMemoryDirs.map((d) => `  - ${d}`).join("\n")
			: "  (none discovered)";

	const claudeDirsList =
		context.claudeMemoryDirs.length > 0
			? context.claudeMemoryDirs.map((d) => `  - ${d}`).join("\n")
			: "  (none discovered)";

	const dreamTmpDirName = DREAM_TMP_DIR;
	const dreamLastRunPath = join(context.globalMemoryDir, DREAM_LAST_RUN_FILE);

	return `You are running a memory consolidation (/dream). A backup has been created at: ${backupResult.backupDir}
Backup verification: ${backupResult.fileCount} files, ${formatBytes(backupResult.totalSize)} — ${verifiedStatus}

## Context
- Global memory: ${context.globalMemoryDir}
- Project memories:
${projectDirsList}
- Claude Code memories (READ-ONLY):
${claudeDirsList}
- Last dream run: ${lastRun}
- Sessions directory: ${context.sessionsDir}

## Memory Files
${fileListingSection}

## HARD CONSTRAINTS
- The \`.claude/\` memory directories are read-only compatibility imports. Do NOT modify, delete, or rewrite any files under \`.claude/\` paths. Only \`~/.dreb/memory/\` and \`<project>/.dreb/memory/\` are writable.
- NEVER remove session JSONL data files.
- Explicitly EXCLUDE \`subagent-sessions/\` from scanning scope.

## Pipeline

### Step 1: Read All Memories
Read every MEMORY.md index and every referenced memory file from global, all project scopes, and \`.claude/\` read-only paths.

### Step 2: Analyze & Plan
Group related entries, identify duplicates, overlapping content, stale references (deleted files, resolved issues). Present the consolidation plan to the user before making any changes.

### Step 3: Consolidate
Merge related entries, deduplicate, reorganize semantically. Write changes to temp files first (\`<memory-dir>/${dreamTmpDirName}/\`), then atomic rename per file. Maintain a rollback manifest listing every original→tmp→final path.

### Step 4: Rewrite Indexes
Produce new MEMORY.md indexes organized semantically, under 200 lines. Every pointer must reference an existing file. Write to temp first, then rename.

### Step 5: Remove Dead Files
Only after indexes are rewritten and validated, delete memory files that have ZERO remaining references in any MEMORY.md index. Never delete a file that is still referenced.

### Step 6: Scan Sessions
Spawn background Explore subagents to read session JSONL logs from ${context.sessionsDir} (EXCLUDE subagent-sessions/). Only scan sessions since ${lastRun}. First-run cap: 30 days maximum.

Session JSONL format: Each line is a JSON object. Relevant entry types:
- \`{"type":"message","message":{"role":"user"|"assistant","content":...}}\` — conversation messages
- \`{"type":"tool_use","name":"...","input":{...}}\` — tool calls
- \`{"type":"tool_result","content":...}\` — tool outputs

Each subagent should return findings in structured format:
\`{"findings": [{"type": "user-preferences|good-practices|project|navigation", "name": "...", "description": "...", "content": "..."}]}\`

### Step 7: STOP AND WAIT
After spawning subagents, stop generating and wait for ALL background-agent-complete messages before proceeding. Do not continue to Step 8 until every subagent has reported back.

### Step 8: Incorporate Findings
Create new memory entries from subagent findings, update MEMORY.md indexes.

### Step 9: Report
Structured summary: X merged, Y pruned, Z added from sessions, W files removed, backup location, any warnings.

### Step 10: Mark Complete
Write the current ISO timestamp to ${dreamLastRunPath}
`;
}

// =============================================================================
// Locking
// =============================================================================

export async function acquireDreamLock(): Promise<() => void> {
	const memDir = join(homedir(), ".dreb", "memory");
	const lockPath = join(memDir, DREAM_LOCK_FILE);

	// Ensure directory and lock file exist (proper-lockfile requires the file to exist)
	try {
		mkdirSync(memDir, { recursive: true });
	} catch {
		// Directory already exists
	}

	if (!existsSync(lockPath)) {
		try {
			writeFileSync(lockPath, "", "utf-8");
		} catch (error) {
			throw new Error(
				`Failed to create dream lock file "${lockPath}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	let release: () => Promise<void>;
	try {
		release = await lockfile.lock(lockPath, {
			stale: 60000,
			retries: {
				retries: 5,
				factor: 2,
				minTimeout: 200,
				maxTimeout: 5000,
				randomize: true,
			},
		});
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { code?: unknown }).code)
				: undefined;
		if (code === "ELOCKED") {
			throw new Error(
				"Another /dream operation is already running. " +
					"If this is stale, wait 60 seconds or manually remove " +
					`the lock: ${lockPath}.lock`,
			);
		}
		throw new Error(`Failed to acquire dream lock: ${error instanceof Error ? error.message : String(error)}`);
	}

	return () => {
		release().catch(() => {
			// Best-effort unlock — if it fails the stale timeout will clean up
		});
	};
}

// =============================================================================
// Backup Pruning
// =============================================================================

export async function pruneOldBackups(archivePath: string, keepCount: number = DEFAULT_KEEP_COUNT): Promise<void> {
	if (!existsSync(archivePath)) return;

	let dirEntries: string[];
	try {
		dirEntries = readdirSync(archivePath);
	} catch {
		return;
	}

	const backupDirs = dirEntries.filter((name) => name.startsWith(BACKUP_PREFIX)).sort();

	if (backupDirs.length <= keepCount) return;

	const toRemove = backupDirs.slice(0, backupDirs.length - keepCount);
	for (const dirName of toRemove) {
		const fullPath = join(archivePath, dirName);
		try {
			rmSync(fullPath, { recursive: true, force: true });
		} catch {
			// Best-effort — log would be nice but we don't have a logger here
		}
	}
}

// =============================================================================
// Temp Dir Cleanup
// =============================================================================

export function cleanupDreamTmpDirs(memoryDirs: string[]): void {
	for (const memDir of memoryDirs) {
		const tmpDir = join(memDir, DREAM_TMP_DIR);
		if (existsSync(tmpDir)) {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup
			}
		}
	}
}
