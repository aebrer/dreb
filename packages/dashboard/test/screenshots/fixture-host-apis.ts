/**
 * Fictional replacements for the dashboard's host-filesystem surfaces: the Files
 * API and the dreb memory API.
 *
 * The real APIs read the capturing machine's disk, which must never reach a
 * README screenshot. These serve only the scenario's fictional tree and memory
 * scopes, are type-checked against the surfaces the server uses, and record and
 * throw for anything a screenshot should never do (writes, downloads, or paths
 * outside the scenario), so the capture fails loudly instead of rendering an
 * error state.
 */

import { createHash } from "node:crypto";
import type { DashboardFileApi, DashboardMemoryApi } from "../../src/server/server.js";
import type { DirListingDto, MemoryDocumentDto, MemoryListingDto, MemoryScopeDto } from "../../src/shared/protocol.js";
import type { FixtureFailures } from "./fixture-rpc-client.js";
import { type FixtureMemoryScope, memoryEntryContent, type Scenario } from "./scenario.js";

const MEMORY_INDEX_FILE = "MEMORY.md";

function sha256Hex(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Files API serving the scenario's directories; listing anything else is a capture failure. */
export function createFixtureFileApi(scenario: Scenario, failures: FixtureFailures): DashboardFileApi {
	const directories = new Map(scenario.files.map((directory) => [directory.path, directory]));
	const requireDirectory = (path: string) => {
		const directory = directories.get(path);
		if (!directory) throw failures.record(`Screenshot Files API has no fixture directory ${path}`, 404);
		return directory;
	};
	const refuse = (operation: string) => async (): Promise<never> => {
		throw failures.record(`Screenshot Files API never performs ${operation}`, 403);
	};
	return {
		async resolveDirectory(rawPath: string) {
			return requireDirectory(rawPath).path;
		},
		async list(rawPath: string): Promise<Omit<DirListingDto, "contextTrust">> {
			const directory = requireDirectory(rawPath);
			// Same order as the real FileApi: directories first, then by name.
			const entries = directory.entries
				.map((entry) => ({ ...entry }))
				.sort((a, b) =>
					(a.type === "dir") === (b.type === "dir") ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
				);
			return { path: directory.path, entries };
		},
		resolveDownload: refuse("downloads"),
		prepareUpload: refuse("uploads"),
		mkdir: refuse("mkdir"),
	};
}

function scopeDto(scope: FixtureMemoryScope): MemoryScopeDto {
	return {
		id: scope.id,
		kind: scope.kind,
		label: scope.label,
		...(scope.projectRoot === undefined ? {} : { projectRoot: scope.projectRoot }),
		memoryDir: scope.memoryDir,
		exists: true,
	};
}

/** Memory API serving the scenario's scopes read-only; any write is a capture failure. */
export function createFixtureMemoryApi(scenario: Scenario, failures: FixtureFailures): DashboardMemoryApi {
	const scopes = new Map(scenario.memories.map((scope) => [scope.id, scope]));
	const requireScope = (scopeId: string) => {
		const scope = scopes.get(scopeId);
		if (!scope) throw failures.record(`Screenshot memory API has no fixture scope ${scopeId}`, 404);
		return scope;
	};
	const refuse = (operation: string) => async (): Promise<never> => {
		throw failures.record(`Screenshot memory API never performs ${operation}`, 403);
	};
	return {
		async scopes() {
			return scenario.memories.map(scopeDto);
		},
		async listing(scopeId: string): Promise<MemoryListingDto> {
			const scope = requireScope(scopeId);
			return {
				scope: scopeDto(scope),
				indexContent: scope.index,
				indexRevision: sha256Hex(scope.index),
				indexOverLimit: false,
				entries: scope.entries
					.map((entry) => ({
						file: entry.file,
						metadata: { ...entry.metadata },
						modified: new Date(entry.modified).toISOString(),
						size: Buffer.byteLength(memoryEntryContent(entry)),
					}))
					.sort((a, b) => a.file.localeCompare(b.file)),
			};
		},
		async readDocument(scopeId: string, file: string): Promise<MemoryDocumentDto> {
			const scope = requireScope(scopeId);
			if (file === MEMORY_INDEX_FILE) {
				return { kind: "index", file, content: scope.index, revision: sha256Hex(scope.index) };
			}
			const entry = scope.entries.find((candidate) => candidate.file === file);
			if (!entry) throw failures.record(`Screenshot memory scope ${scopeId} has no document ${file}`, 404);
			const content = memoryEntryContent(entry);
			return { kind: "entry", file, content, revision: sha256Hex(content), metadata: { ...entry.metadata } };
		},
		saveDocument: refuse("saves"),
		deleteEntry: refuse("deletes"),
	};
}
