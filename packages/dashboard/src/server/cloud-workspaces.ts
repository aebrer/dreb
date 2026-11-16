/** Authenticated host metadata adapter. No RPC, CLI subprocess, context or provider calls. */
import { isAbsolute } from "node:path";
import {
	type CloudSessionDirectories,
	type CloudSessionStorage,
	CloudWorkspaceError,
	type CloudWorkspaceRegistry,
} from "@dreb/coding-agent/cloud-workspaces";
import type { Express, Response } from "express";
import type { CloudAvailabilityDto, CloudWorkspacesDto } from "../shared/protocol.js";

export class CloudRequestError extends Error {}

function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new CloudRequestError("Expected a JSON object.");
	}
	if (Object.keys(value).some((key) => !keys.includes(key))) {
		throw new CloudRequestError("Request contains unsupported fields.");
	}
	return value as Record<string, unknown>;
}

function hostPath(value: unknown): string {
	if (typeof value !== "string" || value.includes("\0") || !isAbsolute(value)) {
		throw new CloudRequestError("Enter an existing absolute directory path on the backend host.");
	}
	return value;
}

function id(value: unknown): string {
	if (typeof value !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)) {
		throw new CloudRequestError("Expected a full workspace/project UUID.");
	}
	return value.toLowerCase();
}

function optionalId(value: unknown): string | undefined {
	return value === undefined ? undefined : id(value);
}

function initialize(value: unknown): boolean | undefined {
	if (value !== undefined && typeof value !== "boolean") throw new CloudRequestError("initialize must be a boolean.");
	return value;
}

export function sendCloudError(res: Response, error: unknown): void {
	if (error instanceof CloudRequestError) {
		res.status(400).json({ code: "INVALID_REQUEST", error: error.message });
		return;
	}
	if (error instanceof CloudWorkspaceError) {
		const status = {
			INVALID_METADATA: 422,
			INVALID_PATH: 400,
			NOT_FOUND: 404,
			CONFLICT: 409,
			UNAVAILABLE: 409,
			IO_ERROR: 500,
			PARTIAL_INITIALIZATION: 500,
		}[error.code];
		res.status(status).json({
			code: error.code,
			error: error.message,
			...(error.canonicalPath === undefined ? {} : { canonicalPath: error.canonicalPath }),
		});
		return;
	}
	res.status(500).json({
		code: "IO_ERROR",
		error: "Cloud workspace operation failed. Check host storage permissions and retry.",
	});
}

export function registerCloudWorkspaceRoutes(
	app: Express,
	registry: () => CloudWorkspaceRegistry,
	log: (line: string) => void,
	sessionStorage: () => CloudSessionStorage,
): void {
	// Installed after DashboardAuth and JSON parsing, never on a public/auth-bypass router.
	app.use("/api/cloud-workspaces", (req, res, next) => {
		try {
			if (Object.keys(req.query).length) throw new CloudRequestError("Query parameters are not supported.");
			if (req.method === "GET" && req.body !== undefined) object(req.body, []);
			next();
		} catch (error) {
			sendCloudError(res, error);
		}
	});
	app.get("/api/cloud-workspaces/session-storage", (_req, res) => {
		(async () => res.json(await sessionStorage().read()))().catch((error) => sendCloudError(res, error));
	});
	app.put("/api/cloud-workspaces/session-storage", (req, res) => {
		(async () => {
			const body = object(req.body, ["root", "expected"]);
			const root = body.root === null ? null : hostPath(body.root);
			const expectedBody = object(body.expected, ["sessionDir", "subagentSessionDir"]);
			for (const key of ["sessionDir", "subagentSessionDir"] as const) {
				if (expectedBody[key] !== null && typeof expectedBody[key] !== "string") {
					throw new CloudRequestError("Expected both current session-log locations as strings or null.");
				}
			}
			const expected = expectedBody as unknown as CloudSessionDirectories;
			const settings = await sessionStorage().setRoot(root, expected);
			log("cloud session-log locations updated");
			res.json(settings);
		})().catch((error) => sendCloudError(res, error));
	});
	app.get("/api/cloud-workspaces", (_req, res) => {
		(async () => {
			const shared = registry();
			const state = await shared.list();
			const status = await shared.status();
			const describe = (entries: typeof status.projects) => new Map(entries.map((entry) => [entry.id, entry]));
			const workspaces = describe(status.workspaces);
			const projects = describe(status.projects);
			const availability = (entry: (typeof status.projects)[number] | undefined): CloudAvailabilityDto => {
				if (!entry)
					return {
						available: false,
						error: { code: "UNAVAILABLE", message: "Mapping changed during refresh; refresh again." },
					};
				return entry.available ? { available: true, path: entry.path } : { available: false, error: entry.error };
			};
			const body: CloudWorkspacesDto = {
				version: 1,
				pathStyle: process.platform === "win32" ? "windows" : "posix",
				workspaces: state.workspaces.map((entry) => ({ ...entry, status: availability(workspaces.get(entry.id)) })),
				projects: state.projects.map((entry) => ({ ...entry, status: availability(projects.get(entry.id)) })),
			};
			res.json(body);
		})().catch((error) => sendCloudError(res, error));
	});
	app.post("/api/cloud-workspaces/connect", (req, res) => {
		(async () => {
			const body = object(req.body, ["path", "initialize"]);
			const path = hostPath(body.path);
			const options = { initialize: initialize(body.initialize) };
			const binding = await registry().connect(path, options);
			log(`cloud connect ${binding.id}`);
			res.json(binding);
		})().catch((error) => sendCloudError(res, error));
	});
	app.post("/api/cloud-workspaces/link", (req, res) => {
		(async () => {
			const body = object(req.body, ["path", "initialize", "projectId", "workspaceId"]);
			const path = hostPath(body.path);
			const options = {
				initialize: initialize(body.initialize),
				projectId: optionalId(body.projectId),
				workspaceId: optionalId(body.workspaceId),
			};
			if (options.initialize && options.projectId)
				throw new CloudRequestError("Choose initialize or a known project ID, not both.");
			const binding = await registry().link(path, options);
			log(`cloud link ${binding.id}`);
			res.json(binding);
		})().catch((error) => sendCloudError(res, error));
	});
	app.put("/api/cloud-workspaces/workspaces/:id", (req, res) => {
		(async () => {
			const expectedId = id(req.params.id);
			const body = object(req.body, ["path"]);
			const path = hostPath(body.path);
			const binding = await registry().connect(path, { rebind: true, expectedId });
			log(`cloud rebind workspace ${expectedId}`);
			res.json(binding);
		})().catch((error) => sendCloudError(res, error));
	});
	app.put("/api/cloud-workspaces/projects/:id", (req, res) => {
		(async () => {
			const projectId = id(req.params.id);
			const body = object(req.body, ["path", "workspaceId"]);
			const path = hostPath(body.path);
			const workspaceId = optionalId(body.workspaceId);
			const binding = await registry().link(path, { projectId, workspaceId, expectedId: projectId, rebind: true });
			log(`cloud rebind project ${projectId}`);
			res.json(binding);
		})().catch((error) => sendCloudError(res, error));
	});
	for (const [kind, operation] of [
		["projects", "unlink"],
		["workspaces", "disconnect"],
	] as const) {
		app.delete(`/api/cloud-workspaces/${kind}/:id`, (req, res) => {
			(async () => {
				const identity = id(req.params.id);
				if (req.body !== undefined) object(req.body, []);
				const removed = await registry()[operation](identity);
				log(`cloud ${operation} ${identity}`);
				res.json({ removed });
			})().catch((error) => sendCloudError(res, error));
		});
	}
}

/** Validate the exclusive source without opening the registry on legacy local requests. */
export function runtimeDirectoryRequest(value: unknown): { cwd: string } | { projectId: string } {
	const body = object(value, ["cwd", "projectId", "sessionPath", "firstPrompt"]);
	const local = Object.hasOwn(body, "cwd");
	const project = Object.hasOwn(body, "projectId");
	if (local === project) throw new CloudRequestError("Choose exactly one runtime directory: cwd or projectId.");
	for (const key of ["sessionPath", "firstPrompt"] as const) {
		if (body[key] !== undefined && typeof body[key] !== "string")
			throw new CloudRequestError(`${key} must be a string.`);
	}
	if (project) return { projectId: id(body.projectId) };
	if (typeof body.cwd !== "string") throw new CloudRequestError("cwd must be a string.");
	return { cwd: body.cwd };
}
