import { isAbsolute, join, normalize, win32 } from "node:path";

export const CLOUD_WORKSPACE_VERSION = 1;

export type CloudWorkspaceErrorCode =
	| "INVALID_METADATA"
	| "INVALID_PATH"
	| "NOT_FOUND"
	| "CONFLICT"
	| "UNAVAILABLE"
	| "IO_ERROR"
	| "PARTIAL_INITIALIZATION";

export class CloudWorkspaceError extends Error {
	constructor(
		readonly code: CloudWorkspaceErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CloudWorkspaceError";
	}
}

/** Portable metadata only. A marker is not an execution/trust certificate. */
export interface CloudIdentityMarker {
	version: 1;
	kind: "workspace" | "project";
	id: string;
}

export interface CloudWorkspaceBinding {
	id: string;
	path: string;
}

export type CloudProjectLocation =
	| { kind: "local"; path: string }
	| { kind: "workspace"; workspaceId: string; relativePath: string };

export interface CloudProjectBinding {
	id: string;
	location: CloudProjectLocation;
	/** False only for an explicit known-ID link without a project marker. */
	markerRequired: boolean;
}

/** Machine-local state; never copy this file between devices. */
export interface CloudWorkspaceState {
	version: 1;
	workspaces: CloudWorkspaceBinding[];
	projects: CloudProjectBinding[];
}

export type CloudLocationStatus = { id: string } & (
	| { available: true; path: string }
	| { available: false; error: { code: CloudWorkspaceErrorCode; message: string } }
);

export interface CloudWorkspaceStatus {
	version: 1;
	workspaces: CloudLocationStatus[];
	projects: CloudLocationStatus[];
}

export interface ConnectCloudWorkspaceOptions {
	initialize?: boolean;
	rebind?: boolean;
}

export interface LinkCloudProjectOptions extends ConnectCloudWorkspaceOptions {
	projectId?: string;
	workspaceId?: string;
}

export function cloudId(value: unknown): string {
	if (typeof value !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)) {
		throw new CloudWorkspaceError("INVALID_METADATA", "Expected a full workspace/project UUID.");
	}
	return value.toLowerCase();
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new CloudWorkspaceError("INVALID_METADATA", "Expected a metadata object.");
	}
	if (Object.keys(value).some((key) => !keys.includes(key))) {
		throw new CloudWorkspaceError("INVALID_METADATA", "Metadata contains unsupported fields.");
	}
	return value as Record<string, unknown>;
}

export function nativeAbsolutePath(value: unknown): string {
	if (typeof value !== "string" || value.includes("\0") || !isAbsolute(value)) {
		throw new CloudWorkspaceError("INVALID_PATH", "Expected an absolute path on this device.");
	}
	return value;
}

/** Canonical portable spelling, deliberately not host-dependent path.normalize(). */
export function portableRelativePath(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		/[\\:\0]/.test(value) ||
		isAbsolute(value) ||
		win32.isAbsolute(value) ||
		(value !== "." && value.split("/").some((part) => !part || part === "." || part === ".."))
	) {
		throw new CloudWorkspaceError("INVALID_PATH", "Expected a portable relative directory without traversal.");
	}
	return value;
}

export function parseCloudMarker(value: unknown, kind: CloudIdentityMarker["kind"]): CloudIdentityMarker {
	const data = record(value, ["version", "kind", "id"]);
	if (data.version !== CLOUD_WORKSPACE_VERSION || data.kind !== kind) {
		throw new CloudWorkspaceError("INVALID_METADATA", `Unsupported ${kind} marker version or kind.`);
	}
	return { version: 1, kind, id: cloudId(data.id) };
}

export function emptyCloudWorkspaceState(): CloudWorkspaceState {
	return { version: 1, workspaces: [], projects: [] };
}

export function parseCloudWorkspaceState(value: unknown): CloudWorkspaceState {
	const data = record(value, ["version", "workspaces", "projects"]);
	if (data.version !== 1 || !Array.isArray(data.workspaces) || !Array.isArray(data.projects)) {
		throw new CloudWorkspaceError("INVALID_METADATA", "Invalid or unsupported cloud workspace registry version.");
	}
	const workspaces = data.workspaces.map((value) => {
		const item = record(value, ["id", "path"]);
		return { id: cloudId(item.id), path: nativeAbsolutePath(item.path) };
	});
	const projects = data.projects.map((value): CloudProjectBinding => {
		const item = record(value, ["id", "location", "markerRequired"]);
		if (typeof item.markerRequired !== "boolean") {
			throw new CloudWorkspaceError("INVALID_METADATA", "Invalid project marker requirement.");
		}
		const location = record(item.location, ["kind", "path", "workspaceId", "relativePath"]);
		let parsed: CloudProjectLocation;
		if (location.kind === "local" && Object.keys(location).every((key) => ["kind", "path"].includes(key))) {
			parsed = { kind: "local", path: nativeAbsolutePath(location.path) };
		} else if (
			location.kind === "workspace" &&
			Object.keys(location).every((key) => ["kind", "workspaceId", "relativePath"].includes(key))
		) {
			parsed = {
				kind: "workspace",
				workspaceId: cloudId(location.workspaceId),
				relativePath: portableRelativePath(location.relativePath),
			};
		} else {
			throw new CloudWorkspaceError("INVALID_METADATA", "Invalid project location.");
		}
		return { id: cloudId(item.id), location: parsed, markerRequired: item.markerRequired };
	});
	for (const entries of [workspaces, projects]) {
		if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
			throw new CloudWorkspaceError("CONFLICT", "Ambiguous duplicate identities in the local registry.");
		}
	}
	// Detect ambiguous mappings lexically, without statting/hydrating unrelated folders.
	const pathKey = (path: string) => {
		const key = normalize(path);
		return process.platform === "win32" ? key.toLowerCase() : key;
	};
	const roots = new Map(workspaces.map((item) => [item.id, item.path]));
	const workspacePaths = workspaces.map((item) => pathKey(item.path));
	const projectPaths = projects.map(({ location }) => {
		if (location.kind === "local") return `path:${pathKey(location.path)}`;
		const root = roots.get(location.workspaceId);
		return root
			? `path:${pathKey(join(root, ...location.relativePath.split("/")))}`
			: `workspace:${location.workspaceId}/${location.relativePath}`;
	});
	for (const paths of [workspacePaths, projectPaths]) {
		if (new Set(paths).size !== paths.length) {
			throw new CloudWorkspaceError("CONFLICT", "Ambiguous duplicate locations in the local registry.");
		}
	}
	return { version: 1, workspaces, projects };
}
