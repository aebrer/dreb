/**
 * Host-wide file API — browse, download, upload, mkdir.
 *
 * The dashboard is a trusted-operator surface: a paired device
 * already equals terminal access, so there is no project jail. Path handling
 * still canonicalizes and rejects confusion tricks so the *API* cannot be
 * abused: percent-decode checks, null-byte rejection, symlink resolution to a
 * real absolute path, and server-side logging of every operation.
 */

import { randomBytes } from "node:crypto";
import { link, mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { Writable } from "node:stream";
import type { DirListingDto, FileEntryDto } from "../shared/protocol.js";

export type FileOpLogger = (operation: string, path: string, detail?: string) => void;

function assertValidChildName(name: string, label: string): void {
	if (!name || name.includes("/") || name.includes("\\") || name.includes("\0") || name === "." || name === "..") {
		throw Object.assign(new Error(`Invalid ${label}: ${name}`), { status: 400 });
	}
}

/**
 * Canonicalize a client-supplied path. Throws (status 400) on anything
 * suspicious rather than guessing. Returns the resolved absolute path with
 * symlinks in the *parent* chain resolved (the leaf may not exist yet for
 * writes, so its parent is what gets realpath'd).
 */
export async function canonicalizePath(raw: string, opts: { mustExist: boolean }): Promise<string> {
	if (typeof raw !== "string" || raw.length === 0) {
		throw Object.assign(new Error("Path is required"), { status: 400 });
	}
	if (raw.includes("\0")) {
		throw Object.assign(new Error("Path contains a null byte"), { status: 400 });
	}
	// Reject lingering percent-encodings that survived normal URL decoding —
	// double-encoding is a classic canonicalization-confusion vector.
	if (/%2e|%2f|%5c|%00/i.test(raw)) {
		throw Object.assign(new Error("Path contains percent-encoded traversal sequences"), { status: 400 });
	}
	if (!isAbsolute(raw)) {
		throw Object.assign(new Error("Path must be absolute"), { status: 400 });
	}
	const normalized = normalize(raw);

	if (opts.mustExist) {
		try {
			return await realpath(normalized);
		} catch (err) {
			throw Object.assign(new Error(`Path does not exist or is unreadable: ${normalized}`), {
				status: 404,
				cause: err,
			});
		}
	}
	// For creation targets: resolve the parent, keep the leaf name literal.
	const parent = dirname(normalized);
	let realParent: string;
	try {
		realParent = await realpath(parent);
	} catch (err) {
		throw Object.assign(new Error(`Parent directory does not exist: ${parent}`), { status: 404, cause: err });
	}
	const leaf = normalized.slice(parent === sep ? 1 : parent.length + 1);
	if (!leaf || leaf.includes(sep) || leaf === "." || leaf === "..") {
		throw Object.assign(new Error(`Invalid file name: ${leaf || "(empty)"}`), { status: 400 });
	}
	return join(realParent, leaf);
}

export class FileApi {
	constructor(private readonly log: FileOpLogger) {}

	/** Resolve an existing directory for listing and context-trust RPC operations. */
	async resolveDirectory(rawPath: string): Promise<string> {
		const path = await canonicalizePath(rawPath, { mustExist: true });
		const info = await stat(path);
		if (!info.isDirectory()) {
			throw Object.assign(new Error(`Not a directory: ${path}`), { status: 400 });
		}
		return path;
	}

	async list(rawPath: string): Promise<Omit<DirListingDto, "contextTrust">> {
		const path = await this.resolveDirectory(rawPath);
		const names = await readdir(path, { withFileTypes: true });
		const entries: FileEntryDto[] = [];
		for (const dirent of names) {
			let type: FileEntryDto["type"] = "other";
			if (dirent.isDirectory()) type = "dir";
			else if (dirent.isFile()) type = "file";
			else if (dirent.isSymbolicLink()) type = "symlink";
			let size = 0;
			let modified = "";
			try {
				const s = await stat(join(path, dirent.name));
				size = s.size;
				modified = s.mtime.toISOString();
				if (type === "symlink") type = s.isDirectory() ? "dir" : "file";
			} catch {
				// Broken symlink or permission issue — keep the entry, mark it "other".
				type = "other";
			}
			entries.push({ name: dirent.name, type, size, modified });
		}
		entries.sort((a, b) =>
			(a.type === "dir") === (b.type === "dir") ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
		);
		this.log("list", path);
		return { path, entries };
	}

	/** Resolve a download target; returns the canonical path (must be a file). */
	async resolveDownload(rawPath: string): Promise<{ path: string; size: number }> {
		const path = await canonicalizePath(rawPath, { mustExist: true });
		const info = await stat(path);
		if (!info.isFile()) {
			throw Object.assign(new Error(`Not a file: ${path}`), { status: 400 });
		}
		this.log("download", path, `${info.size} bytes`);
		return { path, size: info.size };
	}

	/**
	 * Upload into a directory. Refuses to overwrite unless `overwrite` is set —
	 * the collision surfaces as 409 so the client can prompt.
	 */
	async prepareUpload(
		rawDir: string,
		fileName: string,
		overwrite: boolean,
	): Promise<{ path: string; stream: Writable; commit: () => Promise<void>; cleanup: () => Promise<void> }> {
		const dir = await canonicalizePath(rawDir, { mustExist: true });
		const dirInfo = await stat(dir);
		if (!dirInfo.isDirectory()) {
			throw Object.assign(new Error(`Upload target is not a directory: ${dir}`), { status: 400 });
		}
		assertValidChildName(fileName, "upload file name");
		const path = join(dir, fileName);
		let exists = false;
		try {
			await stat(path);
			exists = true;
		} catch {
			exists = false;
		}
		if (exists && !overwrite) {
			throw Object.assign(new Error(`File exists: ${path}`), { status: 409 });
		}

		const tempPath = join(dir, `.dreb-upload-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}.tmp`);
		const file = await open(tempPath, "wx");
		const stream = file.createWriteStream({ autoClose: true });
		let committed = false;
		const cleanup = async () => {
			if (committed) return;
			await unlink(tempPath).catch(() => {});
		};
		const commit = async () => {
			try {
				if (overwrite) {
					await rename(tempPath, path);
				} else {
					// Atomic no-overwrite publish: hard-link into the final name and fail
					// with EEXIST if another writer won the race after the early stat().
					await link(tempPath, path).catch((err: NodeJS.ErrnoException) => {
						if (err.code === "EEXIST") {
							throw Object.assign(new Error(`File exists: ${path}`), { status: 409, cause: err });
						}
						throw err;
					});
					await unlink(tempPath);
				}
				committed = true;
				this.log("upload", path, exists ? "overwrite" : "create");
			} catch (err) {
				await cleanup();
				throw err;
			}
		};
		return { path, stream, commit, cleanup };
	}

	async mkdir(rawDir: string, name: string): Promise<string> {
		assertValidChildName(name, "folder name");
		const parent = await canonicalizePath(rawDir, { mustExist: true });
		const path = join(parent, name);
		await mkdir(path);
		this.log("mkdir", path);
		return path;
	}
}

/** Places shown as shortcuts in the files tab. */
export function defaultPlaces(homeDir: string, projectRoots: string[]): Array<{ label: string; path: string }> {
	const places = [
		{ label: "home", path: homeDir },
		{ label: "/tmp", path: resolve("/tmp") },
	];
	for (const root of projectRoots) {
		places.push({ label: root.split(sep).filter(Boolean).pop() ?? root, path: root });
	}
	return places;
}
