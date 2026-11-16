import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isWithinCanonicalRoot } from "../context-trust.js";
import {
	CloudWorkspaceStorage,
	cloudError,
	cloudMarkerPath,
	initializeCloudMarker,
	readCloudMarker,
} from "./storage.js";
import {
	type CloudIdentityMarker,
	type CloudLocationStatus,
	type CloudProjectBinding,
	type CloudProjectLocation,
	type CloudWorkspaceBinding,
	CloudWorkspaceError,
	type CloudWorkspaceState,
	type CloudWorkspaceStatus,
	type ConnectCloudWorkspaceOptions,
	cloudId,
	type LinkCloudProjectOptions,
	nativeAbsolutePath,
	portableRelativePath,
} from "./types.js";

async function existingDirectory(path: string): Promise<string> {
	nativeAbsolutePath(path);
	try {
		const canonical = await realpath(path);
		if (!(await stat(canonical)).isDirectory()) throw new Error("Not a directory");
		await access(canonical, constants.R_OK | constants.X_OK);
		return canonical;
	} catch (error) {
		throw new CloudWorkspaceError("UNAVAILABLE", `Directory is unavailable or not readable/searchable: ${path}`, {
			cause: error,
		});
	}
}

function samePath(a: string, b: string): boolean {
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sortState(state: CloudWorkspaceState): CloudWorkspaceState {
	const compare = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	state.workspaces.sort(compare);
	state.projects.sort(compare);
	return state;
}

function bindingPath(state: CloudWorkspaceState, location: CloudProjectLocation): string | undefined {
	if (location.kind === "local") return location.path;
	const workspace = state.workspaces.find((item) => item.id === location.workspaceId);
	return workspace ? join(workspace.path, ...location.relativePath.split("/")) : undefined;
}

function checkOptions(options: ConnectCloudWorkspaceOptions): void {
	for (const key of ["initialize", "rebind"] as const) {
		if (options[key] !== undefined && typeof options[key] !== "boolean") {
			throw new CloudWorkspaceError("INVALID_METADATA", `${key} must be a boolean.`);
		}
	}
	if (options.expectedId !== undefined) {
		cloudId(options.expectedId);
		if (options.initialize) {
			throw new CloudWorkspaceError("CONFLICT", "An expected identity cannot initialize a replacement marker.");
		}
	}
}

/**
 * Explicit metadata management only: no provider API, discovery scan, session mutation,
 * context loading or agent execution. Each read observes durable machine-local state.
 */
export class CloudWorkspaceRegistry {
	private readonly storage: CloudWorkspaceStorage;

	constructor(options: { agentDir?: string } = {}) {
		this.storage = new CloudWorkspaceStorage(options.agentDir);
	}

	get path(): string {
		return this.storage.path;
	}

	async list(): Promise<CloudWorkspaceState> {
		return sortState(await this.storage.read());
	}

	private update<T>(mutate: (state: CloudWorkspaceState) => T): Promise<T> {
		return this.storage.update((state) => {
			const result = mutate(state);
			sortState(state);
			return result;
		});
	}

	private async marker(directory: string, kind: CloudIdentityMarker["kind"], initialize: boolean) {
		if (initialize) return initializeCloudMarker(directory, kind);
		const marker = await readCloudMarker(directory, kind);
		if (!marker) {
			throw new CloudWorkspaceError(
				"NOT_FOUND",
				`No ${kind} marker at ${cloudMarkerPath(directory, kind)}. Connect an existing identity or explicitly initialize one.`,
			);
		}
		return { marker, created: false };
	}

	private registrationError(
		error: unknown,
		created: boolean,
		directory: string,
		kind: CloudIdentityMarker["kind"],
	): never {
		if (created) {
			throw new CloudWorkspaceError(
				"PARTIAL_INITIALIZATION",
				`Created ${cloudMarkerPath(directory, kind)}, but local registration failed: ${cloudError(error, "Registration failed").message} The marker is preserved; retry after fixing the local error.`,
				{ cause: error },
			);
		}
		throw cloudError(error, "Cannot register cloud location");
	}

	async connect(directory: string, options: ConnectCloudWorkspaceOptions = {}): Promise<CloudWorkspaceBinding> {
		checkOptions(options);
		const state = await this.list(); // Refuse corrupt state before initializing any shared marker.
		const path = await existingDirectory(directory);
		if (
			options.initialize &&
			state.workspaces.some((item) => samePath(item.path, path)) &&
			!(await readCloudMarker(path, "workspace"))
		) {
			throw new CloudWorkspaceError(
				"CONFLICT",
				"A connected workspace lost its marker; restore it or disconnect before initializing a new identity.",
			);
		}
		const { marker, created } = await this.marker(path, "workspace", options.initialize ?? false);
		if (options.expectedId !== undefined && marker.id !== cloudId(options.expectedId)) {
			throw new CloudWorkspaceError("CONFLICT", "Workspace marker does not match the intended identity.");
		}
		try {
			return await this.update((state) => {
				const existing = state.workspaces.find((item) => item.id === marker.id);
				if (existing && !samePath(existing.path, path) && !options.rebind) {
					throw new CloudWorkspaceError("CONFLICT", "Workspace is connected elsewhere; use an explicit rebind.");
				}
				if (state.workspaces.some((item) => item.id !== marker.id && samePath(item.path, path))) {
					throw new CloudWorkspaceError("CONFLICT", "A different workspace is already registered at this path.");
				}
				const binding = { id: marker.id, path };
				state.workspaces = state.workspaces.filter((item) => item.id !== marker.id);
				state.workspaces.push(binding);
				return binding;
			});
		} catch (error) {
			this.registrationError(error, created, path, "workspace");
		}
	}

	async link(directory: string, options: LinkCloudProjectOptions = {}): Promise<CloudProjectBinding> {
		checkOptions(options);
		if (options.initialize && options.projectId !== undefined) {
			throw new CloudWorkspaceError("CONFLICT", "Choose initialize or a known project ID, not both.");
		}
		const explicitId = options.projectId === undefined ? undefined : cloudId(options.projectId);
		const expectedId = options.expectedId === undefined ? undefined : cloudId(options.expectedId);
		if (explicitId && expectedId && explicitId !== expectedId) {
			throw new CloudWorkspaceError("CONFLICT", "Known project ID does not match the intended identity.");
		}
		const workspaceId = options.workspaceId === undefined ? undefined : cloudId(options.workspaceId);
		const state = await this.list();
		const path = await existingDirectory(directory);
		let location: CloudProjectLocation = { kind: "local", path };
		if (workspaceId) {
			const root = await this.resolveWorkspace(state, workspaceId);
			if (!isWithinCanonicalRoot(root, path)) {
				throw new CloudWorkspaceError(
					"INVALID_PATH",
					"Project must remain within the selected canonical workspace.",
				);
			}
			location = {
				kind: "workspace",
				workspaceId,
				relativePath: portableRelativePath(relative(root, path).split(sep).join("/") || "."),
			};
		}
		if (
			options.initialize &&
			state.projects.some((item) => samePath(bindingPath(state, item.location) ?? "", path)) &&
			!(await readCloudMarker(path, "project"))
		) {
			throw new CloudWorkspaceError(
				"CONFLICT",
				"This folder is already linked without a marker; retain its known ID rather than initializing a different identity.",
			);
		}
		const result = options.initialize
			? await initializeCloudMarker(path, "project")
			: { marker: await readCloudMarker(path, "project"), created: false };
		const id = explicitId ?? result.marker?.id;
		if (!id) {
			throw new CloudWorkspaceError(
				"NOT_FOUND",
				"Project has no marker; explicitly initialize one or supply its known ID.",
				{ canonicalPath: path },
			);
		}
		if ((expectedId && id !== expectedId) || (result.marker && result.marker.id !== id)) {
			throw new CloudWorkspaceError("CONFLICT", "Project marker does not match the supplied identity.");
		}
		const binding: CloudProjectBinding = { id, location, markerRequired: result.marker !== undefined };
		try {
			return await this.update((latest) => {
				// A concurrent disconnect/rebind must not redirect this just-validated link.
				if (location.kind === "workspace") {
					const before = state.workspaces.find((item) => item.id === location.workspaceId);
					const after = latest.workspaces.find((item) => item.id === location.workspaceId);
					if (!before || !after || !samePath(before.path, after.path)) {
						throw new CloudWorkspaceError("CONFLICT", "Workspace mapping changed while linking; retry.");
					}
				}
				const existing = latest.projects.find((item) => item.id === id);
				if (
					existing &&
					(JSON.stringify(existing.location) !== JSON.stringify(location) ||
						(existing.markerRequired && !binding.markerRequired)) &&
					!options.rebind
				) {
					throw new CloudWorkspaceError(
						"CONFLICT",
						"Project is already linked differently; use an explicit rebind.",
					);
				}
				if (
					latest.projects.some(
						(item) => item.id !== id && samePath(bindingPath(latest, item.location) ?? "", path),
					)
				) {
					throw new CloudWorkspaceError("CONFLICT", "A different project is already registered at this path.");
				}
				latest.projects = latest.projects.filter((item) => item.id !== id);
				latest.projects.push(binding);
				return binding;
			});
		} catch (error) {
			this.registrationError(error, result.created, path, "project");
		}
	}

	private async resolveWorkspace(state: CloudWorkspaceState, id: string): Promise<string> {
		const binding = state.workspaces.find((item) => item.id === id);
		if (!binding) throw new CloudWorkspaceError("NOT_FOUND", `Workspace ${id} is not connected on this device.`);
		const path = await existingDirectory(binding.path);
		const marker = await readCloudMarker(path, "workspace");
		if (!marker || marker.id !== id) {
			throw new CloudWorkspaceError("CONFLICT", `Workspace identity is missing or changed at ${path}.`);
		}
		return path;
	}

	private async resolveProject(state: CloudWorkspaceState, binding: CloudProjectBinding): Promise<string> {
		const location = binding.location;
		let path: string;
		if (location.kind === "local") {
			path = await existingDirectory(location.path);
		} else {
			const root = await this.resolveWorkspace(state, location.workspaceId);
			path = await existingDirectory(join(root, ...portableRelativePath(location.relativePath).split("/")));
			if (!isWithinCanonicalRoot(root, path)) {
				throw new CloudWorkspaceError("INVALID_PATH", "Project resolves outside its canonical workspace.");
			}
		}
		const marker = await readCloudMarker(path, "project");
		if ((binding.markerRequired && !marker) || (marker && marker.id !== binding.id)) {
			throw new CloudWorkspaceError("CONFLICT", `Project identity is missing or changed at ${path}.`);
		}
		return path;
	}

	async resolve(projectId: string): Promise<string> {
		const id = cloudId(projectId);
		const state = await this.list();
		const project = state.projects.find((item) => item.id === id);
		if (!project) throw new CloudWorkspaceError("NOT_FOUND", `Project ${id} is not linked on this device.`);
		return this.resolveProject(state, project);
	}

	async status(): Promise<CloudWorkspaceStatus> {
		const state = await this.list();
		const describe = async (id: string, resolve: () => Promise<string>): Promise<CloudLocationStatus> => {
			try {
				return { id, available: true, path: await resolve() };
			} catch (error) {
				const failure = cloudError(error, "Location is unavailable");
				return { id, available: false, error: { code: failure.code, message: failure.message } };
			}
		};
		const workspaces: CloudLocationStatus[] = [];
		const projects: CloudLocationStatus[] = [];
		for (const binding of state.workspaces) {
			workspaces.push(await describe(binding.id, () => this.resolveWorkspace(state, binding.id)));
		}
		for (const binding of state.projects) {
			projects.push(await describe(binding.id, () => this.resolveProject(state, binding)));
		}
		return { version: 1, workspaces, projects };
	}

	/** Remove only a local binding. Markers, folders and transcripts are never deleted. */
	async unlink(projectId: string): Promise<boolean> {
		const id = cloudId(projectId);
		return this.update((state) => {
			const before = state.projects.length;
			state.projects = state.projects.filter((item) => item.id !== id);
			return state.projects.length !== before;
		});
	}

	/** Retain dependent project identities; status reports them unavailable until reconnection. */
	async disconnect(workspaceId: string): Promise<boolean> {
		const id = cloudId(workspaceId);
		return this.update((state) => {
			const before = state.workspaces.length;
			state.workspaces = state.workspaces.filter((item) => item.id !== id);
			return state.workspaces.length !== before;
		});
	}
}
