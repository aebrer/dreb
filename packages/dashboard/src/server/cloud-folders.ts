/** Bounded host-folder metadata only: no context, settings, registry or runtime access. */
import { opendir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CloudWorkspaceError } from "@dreb/coding-agent/cloud-workspaces";
import type { CloudFolderListingDto } from "../shared/protocol.js";
import { resolveExistingDirectory } from "./files.js";

const MAX_FOLDERS = 500;
const MAX_INSPECTED_ENTRIES = 10_000;

function folderError(error: unknown): CloudWorkspaceError {
	const failure = error as { code?: string; status?: number; cause?: { code?: string } } | null;
	// The shared directory validator wraps native errors with an HTTP status.
	// Preserve the underlying distinction between an invalid path and failed I/O.
	const code = failure?.cause?.code ?? failure?.code;
	const status = failure?.cause === undefined ? failure?.status : undefined;
	if (
		(code && ["ENOTDIR", "ENAMETOOLONG", "EINVAL", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE"].includes(code)) ||
		(!code && status === 400)
	) {
		return new CloudWorkspaceError("INVALID_PATH", "Enter an existing absolute directory path on the backend host.", {
			cause: error,
		});
	}
	if ((code && ["ENOENT", "EACCES", "EPERM"].includes(code)) || (!code && (status === 403 || status === 404))) {
		return new CloudWorkspaceError(
			"UNAVAILABLE",
			"Folder is missing or is not readable and searchable on the backend host. Check its location and permissions.",
			{ cause: error },
		);
	}
	return new CloudWorkspaceError(
		"IO_ERROR",
		"Could not browse folders on the backend host. Check storage permissions and retry.",
		{ cause: error },
	);
}

export async function browseCloudFolders(rawPath: string | undefined, homeDir: string): Promise<CloudFolderListingDto> {
	try {
		const path = await resolveExistingDirectory(rawPath === undefined ? homeDir : rawPath);
		const parent = dirname(path);
		const entries: CloudFolderListingDto["entries"] = [];
		let inspected = 0;
		let truncated = false;
		const directory = await opendir(path);
		// Dir's async iterator closes the stream on completion, break and errors.
		for await (const entry of directory) {
			if (inspected === MAX_INSPECTED_ENTRIES) {
				truncated = true;
				break;
			}
			inspected++;
			let isDirectory = entry.isDirectory();
			if (!isDirectory && entry.isSymbolicLink()) {
				try {
					isDirectory = (await stat(join(path, entry.name))).isDirectory();
				} catch (error) {
					if (
						["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(
							(error as NodeJS.ErrnoException).code ?? "",
						)
					)
						continue;
					throw error;
				}
			}
			if (!isDirectory) continue;
			if (entries.length === MAX_FOLDERS) {
				truncated = true;
				break;
			}
			entries.push({ name: entry.name, path: join(path, entry.name) });
		}
		entries.sort((a, b) => a.name.localeCompare(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		return { path, parent: parent === path ? null : parent, entries, truncated };
	} catch (error) {
		throw folderError(error);
	}
}
