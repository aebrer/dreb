import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getCloudWorkspaceRegistryPath, resolveConfiguredDirectory } from "../../config.js";
import { cloudError, isMissing, readJson } from "./storage.js";
import { CloudWorkspaceError, nativeAbsolutePath } from "./types.js";

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
const DIRECTORY_ACCESS = constants.R_OK | constants.W_OK | constants.X_OK;
const STORAGE_FIELDS = ["sessionDir", "subagentSessionDir"] as const;

export type CloudSessionDirectories = { sessionDir: string | null; subagentSessionDir: string | null };

export interface CloudSessionStorageStatus extends CloudSessionDirectories {
	subdirectories: { sessionDir: string; subagentSessionDir: string };
	restartRequired: boolean;
}

function directories(settings: Record<string, unknown>): CloudSessionDirectories {
	const result: CloudSessionDirectories = { sessionDir: null, subagentSessionDir: null };
	for (const field of STORAGE_FIELDS) {
		if (!Object.hasOwn(settings, field)) continue;
		const value = settings[field];
		if (value !== null && typeof value !== "string") {
			throw new CloudWorkspaceError("INVALID_METADATA", `${field} must be a string or null.`);
		}
		result[field] = value;
	}
	return result;
}

function expectedDirectories(value: unknown): CloudSessionDirectories {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Reflect.ownKeys(value).length !== STORAGE_FIELDS.length ||
		!STORAGE_FIELDS.every((field) => Object.hasOwn(value, field))
	) {
		throw new CloudWorkspaceError("INVALID_METADATA", "Expected exactly the two nullable storage settings.");
	}
	return directories(value as Record<string, unknown>);
}

/** Inspect only the selected path components, never log contents or directory inventories. */
async function storageRoot(path: string): Promise<string> {
	try {
		const canonical = await realpath(path);
		if (!(await lstat(canonical)).isDirectory()) throw new Error("Not a directory");
		await access(canonical, DIRECTORY_ACCESS);
		for (const leaf of ["sessions", "subagent-sessions"]) {
			let existing = canonical;
			for (const component of [CONFIG_DIR_NAME, leaf]) {
				const candidate = join(existing, component);
				try {
					const info = await lstat(candidate);
					if (!info.isDirectory() || info.isSymbolicLink()) {
						throw new CloudWorkspaceError(
							"INVALID_PATH",
							`Session storage path must be a directory, not a file or symlink: ${candidate}`,
						);
					}
					existing = candidate;
				} catch (error) {
					if (isMissing(error)) break;
					throw error;
				}
			}
			await access(existing, DIRECTORY_ACCESS);
		}
		return canonical;
	} catch (error) {
		if (error instanceof CloudWorkspaceError) throw error;
		throw new CloudWorkspaceError(
			"UNAVAILABLE",
			`Session storage directory is unavailable or not readable/writable/searchable: ${path}`,
			{
				cause: error,
			},
		);
	}
}

/** Global storage metadata only. Saving never creates logs, markers, a registry, or a runtime. */
export class CloudSessionStorage {
	readonly path: string;
	private readonly baseCwd: string;
	private readonly activeSessionDir: string | undefined;

	constructor(options: { agentDir?: string; baseCwd?: string; activeSessionDir?: string } = {}) {
		this.path = join(dirname(getCloudWorkspaceRegistryPath(options.agentDir)), "settings.json");
		this.baseCwd = options.baseCwd ?? process.cwd();
		this.activeSessionDir = options.activeSessionDir;
	}

	private async readAt(path: string): Promise<Record<string, unknown>> {
		const value = await readJson(path, MAX_SETTINGS_BYTES);
		if (value === undefined) return {};
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new CloudWorkspaceError("INVALID_METADATA", "Global settings must be a JSON object.");
		}
		const settings = value as Record<string, unknown>;
		directories(settings);
		return settings;
	}

	private status(settings: Record<string, unknown>): CloudSessionStorageStatus {
		const pair = directories(settings);
		const configured = resolveConfiguredDirectory(pair.sessionDir ?? undefined, this.baseCwd);
		const pathKey = (path: string | undefined) => (process.platform === "win32" ? path?.toLowerCase() : path);
		return {
			...pair,
			subdirectories: {
				sessionDir: `${CONFIG_DIR_NAME}/sessions`,
				subagentSessionDir: `${CONFIG_DIR_NAME}/subagent-sessions`,
			},
			restartRequired: pathKey(configured) !== pathKey(this.activeSessionDir),
		};
	}

	async read(): Promise<CloudSessionStorageStatus> {
		return this.status(await this.readAt(this.path));
	}

	async setRoot(root: string | null, expected: CloudSessionDirectories): Promise<CloudSessionStorageStatus> {
		if (root !== null) nativeAbsolutePath(root);
		const previous = expectedDirectories(expected);
		const canonical = root === null ? null : await storageRoot(root);
		const next: CloudSessionDirectories = {
			sessionDir: canonical === null ? null : join(canonical, CONFIG_DIR_NAME, "sessions"),
			subagentSessionDir: canonical === null ? null : join(canonical, CONFIG_DIR_NAME, "subagent-sessions"),
		};
		let path: string;
		try {
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			path = join(await realpath(dirname(this.path)), "settings.json");
		} catch (error) {
			throw cloudError(error, "Cannot prepare local settings directory");
		}
		let release: () => Promise<void>;
		try {
			release = await lockfile.lock(path, {
				realpath: false,
				retries: { retries: 40, factor: 1, minTimeout: 25, maxTimeout: 25, randomize: false },
			});
		} catch (error) {
			throw cloudError(error, "Cannot acquire local settings lock");
		}
		let outcome: { value: CloudSessionStorageStatus } | { error: unknown };
		try {
			// Cooperate with FileSettingsStorage and compare only after acquiring its lock.
			const settings = await this.readAt(path);
			const current = directories(settings);
			if (STORAGE_FIELDS.some((field) => current[field] !== previous[field])) {
				throw new CloudWorkspaceError("CONFLICT", "Global session storage settings changed; reload before saving.");
			}
			const changed = STORAGE_FIELDS.some((field) =>
				root === null ? Object.hasOwn(settings, field) : settings[field] !== next[field],
			);
			for (const field of STORAGE_FIELDS) {
				if (root === null) delete settings[field];
				else settings[field] = next[field];
			}
			const status = this.status(settings);
			if (changed) await this.writeAt(path, settings);
			outcome = { value: status };
		} catch (error) {
			outcome = { error: cloudError(error, "Cannot update global session storage settings") };
		}
		try {
			await release();
		} catch (error) {
			outcome = {
				error: new CloudWorkspaceError(
					"IO_ERROR",
					"error" in outcome
						? `${cloudError(outcome.error, "Settings update failed").message}; local lock release also failed.`
						: "Settings may already have changed, but local lock release failed.",
					{ cause: "error" in outcome ? new AggregateError([outcome.error, error]) : error },
				),
			};
		}
		if ("error" in outcome) throw outcome.error;
		return outcome.value;
	}

	private async writeAt(path: string, settings: Record<string, unknown>): Promise<void> {
		const contents = `${JSON.stringify(settings, null, 2)}\n`;
		if (Buffer.byteLength(contents) > MAX_SETTINGS_BYTES) {
			throw new CloudWorkspaceError("INVALID_METADATA", "Global settings exceed their size limit.");
		}
		const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
		let temporaryCreated = false;
		let renamed = false;
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
			renamed = true;
		} catch (error) {
			failure = { error };
		}
		if (temporaryCreated) {
			try {
				await unlink(temporary);
			} catch (error) {
				if (!isMissing(error)) {
					const cleanup = cloudError(error, `Cannot clean temporary settings file ${temporary}`);
					failure = {
						error: new CloudWorkspaceError(
							"IO_ERROR",
							failure
								? `${cloudError(failure.error, "Settings write failed").message}; ${cleanup.message}`
								: `${renamed ? "Settings may already have changed; " : ""}${cleanup.message}`,
							{ cause: failure ? new AggregateError([failure.error, error]) : error },
						),
					};
				}
			}
		}
		if (failure) throw failure.error;
	}
}
