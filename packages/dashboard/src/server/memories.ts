/**
 * Dashboard memory API — dreb-only global/project memory editor.
 *
 * Scope ids are derived from the server's current cwd inventory. Clients can
 * select only those ids; absolute target paths never cross the wire as
 * authority. All path handling fails closed and re-checks symlink containment
 * immediately before atomic replacement.
 */

import { createHash, randomBytes } from "node:crypto";
import { open, readdir, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { findGitRoot, parseFrontmatter } from "@dreb/coding-agent";
import type {
	MemoryDocumentDto,
	MemoryEntryMetadataDto,
	MemoryEntrySummaryDto,
	MemoryEntryTypeDto,
	MemoryListingDto,
	MemoryMutationResultDto,
	MemoryScopeDto,
} from "../shared/protocol.js";
import { canonicalizePath } from "./files.js";

export type MemoryOpLogger = (operation: string, scopeId: string, detail?: string) => void;

export const MEMORY_INDEX_FILE = "MEMORY.md";
export const MAX_MEMORY_CONTENT_BYTES = 1024 * 1024;
const VALID_ENTRY_TYPES = new Set<MemoryEntryTypeDto>(["user-preferences", "good-practices", "project", "navigation"]);

function httpError(status: number, message: string, cause?: unknown): Error & { status: number } {
	return Object.assign(new Error(message), { status, ...(cause === undefined ? {} : { cause }) });
}

function sha256Hex(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function projectScopeId(canonicalRoot: string): string {
	return `project-${sha256Hex(canonicalRoot).slice(0, 24)}`;
}

function isWithinCanonicalRoot(target: string, root: string): boolean {
	const normalizedRoot = resolve(root);
	const normalizedTarget = resolve(target);
	return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (err: any) {
		if (err?.code === "ENOENT") return false;
		throw err;
	}
}

async function canonicalExistingDirectory(path: string): Promise<string | null> {
	try {
		const canonical = await realpath(path);
		const info = await stat(canonical);
		return info.isDirectory() ? canonical : null;
	} catch {
		return null;
	}
}

function assertContentLimit(content: unknown): asserts content is string {
	if (typeof content !== "string") throw httpError(400, "content must be a string");
	if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_CONTENT_BYTES) {
		throw httpError(413, `Memory document exceeds the ${MAX_MEMORY_CONTENT_BYTES} byte limit`);
	}
}

function validateEntryFile(file: string): void {
	if (typeof file !== "string" || file.length === 0) throw httpError(400, "file is required");
	if (file.includes("\0") || file.includes("/") || file.includes("\\"))
		throw httpError(400, `Invalid memory file: ${file}`);
	if (file === "." || file === ".." || file.startsWith(".") || file.startsWith("_")) {
		throw httpError(400, `Invalid memory file: ${file}`);
	}
	if (file.toLowerCase() === MEMORY_INDEX_FILE.toLowerCase())
		throw httpError(400, "MEMORY.md is the index, not an entry");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(file))
		throw httpError(400, `Memory entries must be .md files: ${file}`);
}

function validateDocumentFile(file: string): "index" | "entry" {
	if (file === MEMORY_INDEX_FILE) return "index";
	validateEntryFile(file);
	return "entry";
}

function validateMetadata(frontmatter: Record<string, unknown>): MemoryEntryMetadataDto {
	const { name, description, type } = frontmatter;
	if (typeof name !== "string" || name.length === 0) throw new Error("frontmatter.name must be a non-empty string");
	if (typeof description !== "string" || description.length === 0) {
		throw new Error("frontmatter.description must be a non-empty string");
	}
	if (typeof type !== "string" || !VALID_ENTRY_TYPES.has(type as MemoryEntryTypeDto)) {
		throw new Error("frontmatter.type must be one of user-preferences, good-practices, project, navigation");
	}
	return { name, description, type: type as MemoryEntryTypeDto };
}

function parseEntryMetadata(content: string): { metadata?: MemoryEntryMetadataDto; metadataError?: string } {
	try {
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
		return { metadata: validateMetadata(frontmatter) };
	} catch (err) {
		return { metadataError: err instanceof Error ? err.message : String(err) };
	}
}

async function readUtf8Limited(path: string): Promise<string> {
	const info = await stat(path);
	if (!info.isFile()) throw httpError(400, `Not a file: ${path}`);
	if (info.size > MAX_MEMORY_CONTENT_BYTES)
		throw httpError(413, `Memory document exceeds the ${MAX_MEMORY_CONTENT_BYTES} byte limit`);
	return readFile(path, "utf8");
}

async function atomicReplace(path: string, content: string): Promise<void> {
	const dir = resolve(path, "..");
	const temp = join(dir, `.dreb-memory-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temp, "wx");
		await handle.writeFile(content, "utf8");
		await handle.close();
		handle = undefined;
		await rename(temp, path);
	} catch (err) {
		if (handle) await handle.close().catch(() => {});
		await unlink(temp).catch(() => {});
		throw err;
	}
}

function splitLinesPreserveEndings(content: string): string[] {
	const matches = content.match(/.*(?:\r\n|\n|\r|$)/g) ?? [];
	return matches.filter((part, index) => part.length > 0 || index < matches.length - 1);
}

function localMarkdownTargets(line: string): string[] {
	const targets: string[] = [];
	const regex = /\[[^\]]+\]\(([^)]+)\)/g;
	let match = regex.exec(line);
	while (match) {
		targets.push(match[1]);
		match = regex.exec(line);
	}
	return targets;
}

function targetMatchesFilename(target: string, filename: string): boolean {
	return target === filename || target === `./${filename}`;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeIndexLinks(indexContent: string, filename: string): { content: string; changed: boolean } {
	const lines = splitLinesPreserveEndings(indexContent);
	const escaped = escapeRegExp(filename);
	const safeLine = new RegExp(
		`^\\s*[-*+]\\s+\\[[^\\]]+\\]\\((?:\\./)?${escaped}\\)(?:\\s+(?:[-—:]|—)\\s+.*)?\\s*(?:\\r?\\n|\\r)?$`,
		"u",
	);
	let changed = false;
	const kept: string[] = [];
	for (const line of lines) {
		const matches = localMarkdownTargets(line).some((target) => targetMatchesFilename(target, filename));
		if (!matches) {
			kept.push(line);
			continue;
		}
		if (!safeLine.test(line)) {
			throw httpError(409, `Index line for ${filename} is not safe to remove automatically`);
		}
		changed = true;
	}
	return { content: kept.join(""), changed };
}

export class MemoryApi {
	constructor(
		private readonly homeDir: string,
		private readonly log: MemoryOpLogger,
	) {}

	async scopes(cwdInventory: string[]): Promise<MemoryScopeDto[]> {
		const scopes: MemoryScopeDto[] = [];
		const globalMemoryDir = resolve(this.homeDir, ".dreb", "memory");
		scopes.push({
			id: "global",
			kind: "global",
			label: "global",
			memoryDir: globalMemoryDir,
			exists: await pathExists(globalMemoryDir),
		});

		const roots = new Map<string, string>();
		for (const cwd of cwdInventory) {
			if (typeof cwd !== "string" || cwd.length === 0) continue;
			const existingCwd = await canonicalExistingDirectory(cwd);
			if (!existingCwd) continue;
			const root = findGitRoot(existingCwd) ?? existingCwd;
			const canonicalRoot = await canonicalExistingDirectory(root);
			if (!canonicalRoot) continue;
			roots.set(canonicalRoot, canonicalRoot);
		}
		for (const root of [...roots.keys()].sort((a, b) => a.localeCompare(b))) {
			const memoryDir = join(root, ".dreb", "memory");
			scopes.push({
				id: projectScopeId(root),
				kind: "project",
				label: basename(root) || root,
				projectRoot: root,
				memoryDir,
				exists: await pathExists(memoryDir),
			});
		}
		return scopes;
	}

	async listing(scopeId: string, cwdInventory: string[]): Promise<MemoryListingDto> {
		const scope = await this.requireScope(scopeId, cwdInventory);
		const memoryRoot = await this.canonicalMemoryRootIfExists(scope);
		if (!memoryRoot) {
			this.log("list", scope.id);
			return { scope, indexContent: null, indexRevision: null, indexOverLimit: false, entries: [] };
		}

		let indexContent: string | null = null;
		let indexRevision: string | null = null;
		try {
			const indexPath = await this.resolveExistingTarget(scope, MEMORY_INDEX_FILE, "index");
			indexContent = await readUtf8Limited(indexPath);
			indexRevision = sha256Hex(indexContent);
		} catch (err: any) {
			if (err?.status !== 404 && err?.code !== "ENOENT") throw err;
		}

		const dirents = await readdir(memoryRoot, { withFileTypes: true });
		const entries: MemoryEntrySummaryDto[] = [];
		for (const dirent of dirents) {
			if (!dirent.isFile()) continue;
			if (dirent.name === MEMORY_INDEX_FILE) continue;
			try {
				validateEntryFile(dirent.name);
			} catch {
				continue;
			}
			const path = await this.resolveExistingTarget(scope, dirent.name, "entry");
			const info = await stat(path);
			const content = await readUtf8Limited(path);
			entries.push({
				file: dirent.name,
				...parseEntryMetadata(content),
				modified: info.mtime.toISOString(),
				size: info.size,
			});
		}
		entries.sort((a, b) => a.file.localeCompare(b.file));
		this.log("list", scope.id);
		return {
			scope: { ...scope, exists: true, memoryDir: memoryRoot },
			indexContent,
			indexRevision,
			indexOverLimit: (indexContent?.split(/\r\n|\n|\r/).length ?? 0) > 200,
			entries,
		};
	}

	async readDocument(scopeId: string, file: string, cwdInventory: string[]): Promise<MemoryDocumentDto> {
		const kind = validateDocumentFile(file);
		const scope = await this.requireScope(scopeId, cwdInventory);
		const path = await this.resolveExistingTarget(scope, file, kind);
		const content = await readUtf8Limited(path);
		this.log("read", scope.id, file);
		return {
			kind,
			file,
			content,
			revision: sha256Hex(content),
			...(kind === "entry" ? parseEntryMetadata(content) : {}),
		};
	}

	async saveDocument(
		scopeId: string,
		file: string,
		body: unknown,
		cwdInventory: string[],
	): Promise<MemoryMutationResultDto> {
		const kind = validateDocumentFile(file);
		if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "JSON body is required");
		const { content, revision } = body as Record<string, unknown>;
		assertContentLimit(content);
		if (typeof revision !== "string" || revision.length === 0) throw httpError(400, "revision is required");
		if (kind === "entry") {
			const parsed = parseEntryMetadata(content);
			if (parsed.metadataError) throw httpError(400, parsed.metadataError);
		}
		const scope = await this.requireScope(scopeId, cwdInventory);
		const path = await this.resolveExistingTarget(scope, file, kind);
		const current = await readUtf8Limited(path);
		if (sha256Hex(current) !== revision) throw httpError(409, "Memory document is stale; refresh before saving");
		const beforeReplace = await this.resolveExistingTarget(scope, file, kind);
		await atomicReplace(beforeReplace, content);
		const document = await this.readDocument(scopeId, file, cwdInventory);
		const listing = await this.listing(scopeId, cwdInventory);
		this.log("save", scope.id, file);
		return { listing, document };
	}

	async deleteEntry(
		scopeId: string,
		file: string,
		body: unknown,
		cwdInventory: string[],
	): Promise<MemoryMutationResultDto> {
		validateEntryFile(file);
		if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "JSON body is required");
		const { revision, indexRevision } = body as Record<string, unknown>;
		if (typeof revision !== "string" || revision.length === 0) throw httpError(400, "revision is required");
		if (indexRevision !== null && typeof indexRevision !== "string")
			throw httpError(400, "indexRevision must be a string or null");
		const scope = await this.requireScope(scopeId, cwdInventory);
		const entryPath = await this.resolveExistingTarget(scope, file, "entry");
		const originalEntry = await readUtf8Limited(entryPath);
		if (sha256Hex(originalEntry) !== revision) throw httpError(409, "Memory entry is stale; refresh before deleting");

		const memoryRoot = await this.requireCanonicalMemoryRoot(scope);
		let indexPath = join(memoryRoot, MEMORY_INDEX_FILE);
		let originalIndex: string | null = null;
		try {
			indexPath = await this.resolveExistingTarget(scope, MEMORY_INDEX_FILE, "index");
			originalIndex = await readUtf8Limited(indexPath);
		} catch (err: any) {
			if (err?.code !== "ENOENT" && err?.status !== 404) throw err;
		}
		const actualIndexRevision = originalIndex === null ? null : sha256Hex(originalIndex);
		if (actualIndexRevision !== indexRevision) throw httpError(409, "Memory index is stale; refresh before deleting");

		let updatedIndex: string | null = originalIndex;
		if (originalIndex !== null) updatedIndex = removeIndexLinks(originalIndex, file).content;
		if (updatedIndex !== null && updatedIndex !== originalIndex) {
			indexPath = await this.resolveExistingTarget(scope, MEMORY_INDEX_FILE, "index");
			await atomicReplace(indexPath, updatedIndex);
		}
		try {
			const beforeUnlink = await this.resolveExistingTarget(scope, file, "entry");
			await unlink(beforeUnlink);
		} catch (err) {
			if (originalIndex !== null && updatedIndex !== originalIndex) await atomicReplace(indexPath, originalIndex);
			throw err;
		}
		const listing = await this.listing(scopeId, cwdInventory);
		if (
			listing.indexContent &&
			localMarkdownTargets(listing.indexContent).some((target) => targetMatchesFilename(target, file))
		) {
			throw httpError(500, `Delete left a dangling index link for ${file}`);
		}
		this.log("delete", scope.id, file);
		return { listing };
	}

	private async requireScope(scopeId: string, cwdInventory: string[]): Promise<MemoryScopeDto> {
		const scope = (await this.scopes(cwdInventory)).find((item) => item.id === scopeId);
		if (!scope) throw httpError(404, `Unknown memory scope: ${scopeId}`);
		return scope;
	}

	private async canonicalMemoryRootIfExists(scope: MemoryScopeDto): Promise<string | null> {
		return canonicalExistingDirectory(scope.memoryDir);
	}

	private async requireCanonicalMemoryRoot(scope: MemoryScopeDto): Promise<string> {
		const root = await this.canonicalMemoryRootIfExists(scope);
		if (!root) throw httpError(404, `Memory directory does not exist: ${scope.memoryDir}`);
		return root;
	}

	private async resolveExistingTarget(scope: MemoryScopeDto, file: string, kind: "index" | "entry"): Promise<string> {
		if (kind === "index" && file !== MEMORY_INDEX_FILE) throw httpError(400, "Invalid index file");
		if (kind === "entry") validateEntryFile(file);
		const memoryRoot = await this.requireCanonicalMemoryRoot(scope);
		const target = await canonicalizePath(join(memoryRoot, file), { mustExist: true });
		if (!isWithinCanonicalRoot(target, memoryRoot)) throw httpError(400, `Memory target escapes scope: ${file}`);
		return target;
	}
}
