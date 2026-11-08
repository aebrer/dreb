import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getCloudWorkspaceRegistryPath } from "../../config.js";
import {
	type CloudIdentityMarker,
	CloudWorkspaceError,
	type CloudWorkspaceState,
	emptyCloudWorkspaceState,
	parseCloudMarker,
	parseCloudWorkspaceState,
} from "./types.js";

const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_MARKER_BYTES = 4096;

export function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function cloudError(error: unknown, context: string): CloudWorkspaceError {
	return error instanceof CloudWorkspaceError
		? error
		: new CloudWorkspaceError("IO_ERROR", `${context}: ${error instanceof Error ? error.message : String(error)}`, {
				cause: error,
			});
}

/** Bounded regular-file reads; never treat a corrupt/partial file as an absent file. */
export async function readJson(path: string, limit: number): Promise<unknown | undefined> {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink()) {
			throw new CloudWorkspaceError("INVALID_METADATA", `Expected a regular metadata file: ${path}`);
		}
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			if (!(await file.stat()).isFile()) {
				throw new CloudWorkspaceError("INVALID_METADATA", `Expected a regular metadata file: ${path}`);
			}
			const bytes = Buffer.alloc(limit + 1);
			let length = 0;
			while (length < bytes.length) {
				const read = await file.read(bytes, length, bytes.length - length, null);
				if (!read.bytesRead) break;
				length += read.bytesRead;
			}
			if (length > limit) throw new CloudWorkspaceError("INVALID_METADATA", `Metadata is too large: ${path}`);
			try {
				return JSON.parse(bytes.subarray(0, length).toString("utf8"));
			} catch (error) {
				throw new CloudWorkspaceError("INVALID_METADATA", `Invalid or incomplete JSON: ${path}`, { cause: error });
			}
		} finally {
			await file.close();
		}
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw cloudError(error, `Cannot read metadata ${path}`);
	}
}

export function cloudMarkerPath(directory: string, kind: CloudIdentityMarker["kind"]): string {
	return join(directory, CONFIG_DIR_NAME, `${kind}.json`);
}

async function validateMarkerDirectory(directory: string): Promise<boolean> {
	try {
		const info = await lstat(join(directory, CONFIG_DIR_NAME));
		if (!info.isDirectory() || info.isSymbolicLink()) {
			throw new CloudWorkspaceError(
				"INVALID_METADATA",
				`Marker directory must not be a file or symlink: ${directory}`,
			);
		}
		return true;
	} catch (error) {
		if (isMissing(error)) return false;
		throw cloudError(error, "Cannot inspect marker directory");
	}
}

export async function readCloudMarker(
	directory: string,
	kind: CloudIdentityMarker["kind"],
): Promise<CloudIdentityMarker | undefined> {
	if (!(await validateMarkerDirectory(directory))) return undefined;
	const value = await readJson(cloudMarkerPath(directory, kind), MAX_MARKER_BYTES);
	return value === undefined ? undefined : parseCloudMarker(value, kind);
}

/** Explicit initialization only. Exclusive creation never replaces an existing identity. */
export async function initializeCloudMarker(
	directory: string,
	kind: CloudIdentityMarker["kind"],
): Promise<{ marker: CloudIdentityMarker; created: boolean }> {
	const existing = await readCloudMarker(directory, kind);
	if (existing) return { marker: existing, created: false };
	const path = cloudMarkerPath(directory, kind);
	try {
		await mkdir(dirname(path), { recursive: true });
		await validateMarkerDirectory(directory);
	} catch (error) {
		throw cloudError(error, `Cannot prepare ${kind} marker ${path}`);
	}
	const marker: CloudIdentityMarker = { version: 1, kind, id: randomUUID() };
	let file: FileHandle;
	try {
		file = await open(path, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			const concurrent = await readCloudMarker(directory, kind);
			if (concurrent) return { marker: concurrent, created: false };
		}
		throw cloudError(error, `Cannot initialize ${kind} marker ${path}`);
	}
	let failure: CloudWorkspaceError | undefined;
	try {
		await file.writeFile(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
		await file.sync();
	} catch (error) {
		failure = cloudError(error, `Cannot initialize ${kind} marker ${path}`);
		// Check ownership before cleanup; never intentionally remove a received replacement.
		try {
			const ours = await file.stat();
			const current = await lstat(path);
			if (ours.ino === current.ino && ours.dev === current.dev) await unlink(path);
		} catch (cleanupError) {
			if (!isMissing(cleanupError)) {
				failure = new CloudWorkspaceError(
					"IO_ERROR",
					`Marker initialization and cleanup failed; inspect ${path}.`,
					{
						cause: new AggregateError([error, cleanupError]),
					},
				);
			}
		}
	}
	try {
		await file.close();
	} catch (error) {
		failure = failure
			? new CloudWorkspaceError("IO_ERROR", `${failure.message}; closing marker ${path} also failed.`, {
					cause: new AggregateError([failure, error]),
				})
			: new CloudWorkspaceError(
					"PARTIAL_INITIALIZATION",
					`Wrote ${path}, but closing it failed. Local registration has not completed; inspect the preserved marker and retry.`,
					{ cause: error },
				);
	}
	if (failure) throw failure;
	return { marker, created: true };
}

export class CloudWorkspaceStorage {
	readonly path: string;

	constructor(agentDir?: string) {
		this.path = getCloudWorkspaceRegistryPath(agentDir);
	}

	private async readAt(path: string): Promise<CloudWorkspaceState> {
		const value = await readJson(path, MAX_REGISTRY_BYTES);
		return value === undefined ? emptyCloudWorkspaceState() : parseCloudWorkspaceState(value);
	}

	read(): Promise<CloudWorkspaceState> {
		return this.readAt(this.path);
	}

	async update<T>(mutate: (state: CloudWorkspaceState) => T): Promise<T> {
		// Canonicalize the parent before locking so aliases use the same local lock.
		// No target file is needed: proper-lockfile locks a stable sibling directory.
		let path: string;
		try {
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			path = join(await realpath(dirname(this.path)), "cloud-workspaces.json");
		} catch (error) {
			throw cloudError(error, "Cannot prepare local cloud-registry directory");
		}
		let release: () => Promise<void>;
		try {
			release = await lockfile.lock(path, {
				realpath: false,
				retries: { retries: 40, factor: 1, minTimeout: 25, maxTimeout: 25, randomize: false },
			});
		} catch (error) {
			throw cloudError(error, "Cannot acquire local cloud-registry lock");
		}
		let outcome: { value: T } | { error: unknown };
		try {
			const state = await this.readAt(path);
			const before = JSON.stringify(state);
			const result = mutate(state);
			const validated = parseCloudWorkspaceState(state);
			if (JSON.stringify(validated) !== before) await this.writeAt(path, validated);
			outcome = { value: result };
		} catch (error) {
			outcome = { error: cloudError(error, "Cannot update cloud workspace registry") };
		}
		try {
			await release();
		} catch (error) {
			outcome = {
				error: new CloudWorkspaceError(
					"IO_ERROR",
					"error" in outcome
						? `${cloudError(outcome.error, "Registry update failed").message}; local lock release also failed.`
						: "Registry update may have completed, but local lock release failed.",
					{ cause: "error" in outcome ? new AggregateError([outcome.error, error]) : error },
				),
			};
		}
		if ("error" in outcome) throw outcome.error;
		return outcome.value;
	}

	private async writeAt(path: string, state: CloudWorkspaceState): Promise<void> {
		const contents = `${JSON.stringify(state, null, 2)}\n`;
		if (Buffer.byteLength(contents) > MAX_REGISTRY_BYTES) {
			throw new CloudWorkspaceError("INVALID_METADATA", "Cloud workspace registry exceeds its size limit.");
		}
		const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
		let temporaryCreated = false;
		let failure: { error: unknown } | undefined;
		try {
			const file = await open(temporary, "wx", 0o600);
			temporaryCreated = true;
			try {
				await file.writeFile(contents, "utf8");
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, path);
		} catch (error) {
			failure = { error };
		}
		if (temporaryCreated) {
			try {
				await unlink(temporary);
			} catch (error) {
				if (!isMissing(error)) {
					const cleanup = cloudError(error, `Cannot clean temporary registry file ${temporary}`);
					failure = {
						error: new CloudWorkspaceError(
							"IO_ERROR",
							failure
								? `${cloudError(failure.error, "Registry write failed").message}; ${cleanup.message}`
								: cleanup.message,
							{ cause: failure ? new AggregateError([failure.error, error]) : error },
						),
					};
				}
			}
		}
		if (failure) throw failure.error;
	}
}
