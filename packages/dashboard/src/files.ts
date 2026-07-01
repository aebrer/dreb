import { createReadStream } from "node:fs";
import { mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Readable } from "node:stream";

export interface FileRoot {
	id: string;
	label: string;
	path: string;
}

export interface FileApiOptions {
	cwd?: string;
	homeDir?: string;
	maxUploadBytes?: number;
	maxDownloadBytes?: number;
}

export interface DirectoryEntry {
	name: string;
	path: string;
	type: "directory" | "file" | "symlink" | "other";
	size: number;
	modified: string;
}

export interface BrowseResult {
	root: FileRoot;
	path: string;
	entries: DirectoryEntry[];
}

export class FileApi {
	private readonly cwd: string;
	private readonly homeDir: string;
	private readonly maxUploadBytes: number;
	private readonly maxDownloadBytes: number;

	constructor(options: FileApiOptions = {}) {
		this.cwd = resolve(options.cwd ?? process.cwd());
		this.homeDir = resolve(options.homeDir ?? homedir());
		this.maxUploadBytes = options.maxUploadBytes ?? 10 * 1024 * 1024;
		this.maxDownloadBytes = options.maxDownloadBytes ?? 50 * 1024 * 1024;
	}

	listRoots(): FileRoot[] {
		const roots: FileRoot[] = [{ id: "cwd", label: "Current project", path: this.cwd }];
		if (this.homeDir !== this.cwd) roots.push({ id: "home", label: "Home", path: this.homeDir });
		return roots;
	}

	async browse(rootId: string, requestedPath = "."): Promise<BrowseResult> {
		const root = this.getRoot(rootId);
		const target = await this.resolveExisting(root, requestedPath);
		const info = await stat(target.absolutePath);
		if (!info.isDirectory()) throw httpError(400, "Path is not a directory");
		const entries = await readdir(target.absolutePath, { withFileTypes: true });
		const result: DirectoryEntry[] = [];
		for (const entry of entries) {
			const fullPath = join(target.absolutePath, entry.name);
			const entryStat = await stat(fullPath).catch(() => null);
			result.push({
				name: entry.name,
				path: join(target.relativePath, entry.name),
				type: entry.isDirectory()
					? "directory"
					: entry.isFile()
						? "file"
						: entry.isSymbolicLink()
							? "symlink"
							: "other",
				size: entryStat?.size ?? 0,
				modified: (entryStat?.mtime ?? new Date(0)).toISOString(),
			});
		}
		result.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
		return { root, path: target.relativePath, entries: result };
	}

	async upload(
		rootId: string,
		folderPath: string,
		filename: string,
		body: Buffer,
	): Promise<{ path: string; size: number }> {
		if (body.byteLength > this.maxUploadBytes) throw httpError(413, "Upload exceeds size limit");
		if (!filename || basename(filename) !== filename)
			throw httpError(400, "Filename must not contain path separators");
		const root = this.getRoot(rootId);
		const folder = await this.resolveExisting(root, folderPath);
		const folderStat = await stat(folder.absolutePath);
		if (!folderStat.isDirectory()) throw httpError(400, "Upload target is not a directory");
		const targetPath = resolve(folder.absolutePath, filename);
		assertWithin(folder.rootRealPath, targetPath);
		await mkdir(folder.absolutePath, { recursive: true });
		await writeFile(targetPath, body, { flag: "w" });
		const realTarget = await realpath(targetPath);
		assertWithin(folder.rootRealPath, realTarget);
		return { path: toRelative(folder.rootRealPath, realTarget), size: body.byteLength };
	}

	async download(
		rootId: string,
		requestedPath: string,
	): Promise<{ stream: Readable; size: number; filename: string; mime: string }> {
		const root = this.getRoot(rootId);
		const target = await this.resolveExisting(root, requestedPath);
		const info = await stat(target.absolutePath);
		if (!info.isFile()) throw httpError(400, "Path is not a file");
		if (info.size > this.maxDownloadBytes) throw httpError(413, "Download exceeds size limit");
		return {
			stream: createReadStream(target.absolutePath),
			size: info.size,
			filename: basename(target.absolutePath),
			mime: "application/octet-stream",
		};
	}

	private getRoot(rootId: string): FileRoot {
		const root = this.listRoots().find((candidate) => candidate.id === rootId);
		if (!root) throw httpError(404, "Unknown file root");
		return root;
	}

	private async resolveExisting(root: FileRoot, requestedPath: string): Promise<ResolvedPath> {
		const rootRealPath = await realpath(root.path);
		const lexicalPath = resolve(rootRealPath, requestedPath || ".");
		assertWithin(rootRealPath, lexicalPath);
		const absolutePath = await realpath(lexicalPath);
		assertWithin(rootRealPath, absolutePath);
		return { rootRealPath, absolutePath, relativePath: toRelative(rootRealPath, absolutePath) };
	}
}

interface ResolvedPath {
	rootRealPath: string;
	absolutePath: string;
	relativePath: string;
}

function assertWithin(root: string, target: string): void {
	const rel = relative(root, target);
	if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
	throw httpError(403, "Path escapes the selected root");
}

function toRelative(root: string, target: string): string {
	return relative(root, target) || ".";
}

export function httpError(status: number, message: string): Error & { status: number } {
	return Object.assign(new Error(message), { status });
}
