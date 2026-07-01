import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DashboardAuth } from "./auth.js";
import { FileApi } from "./files.js";
import { DashboardRuntimePool } from "./runtime.js";
import { SessionApi } from "./sessions.js";

export interface DashboardServerOptions {
	auth?: DashboardAuth;
	files?: FileApi;
	sessions?: SessionApi;
	runtimes?: DashboardRuntimePool;
	staticDir?: string;
	maxJsonBytes?: number;
}

const DEFAULT_STATIC_DIR = fileURLToPath(new URL("./static", import.meta.url));

export function createDashboardServer(options: DashboardServerOptions = {}): Server {
	const app = new DashboardServer(options);
	return createServer((req, res) => app.handle(req, res));
}

class DashboardServer {
	private readonly auth = this.options.auth ?? new DashboardAuth();
	private readonly files = this.options.files ?? new FileApi();
	private readonly sessions = this.options.sessions ?? new SessionApi();
	private readonly runtimes = this.options.runtimes ?? new DashboardRuntimePool({ sessionApi: this.sessions });
	private readonly staticDir = this.options.staticDir ?? DEFAULT_STATIC_DIR;
	private readonly maxJsonBytes = this.options.maxJsonBytes ?? 1024 * 1024;

	constructor(private readonly options: DashboardServerOptions) {}

	async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const url = new URL(req.url ?? "/", "http://localhost");
			if (url.pathname === "/api/health") {
				return json(res, 200, { ok: true });
			}
			if (url.pathname === "/api/auth/pair" && req.method === "POST") {
				return this.handlePair(req, res);
			}
			if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/events")) {
				const auth = await this.auth.authenticate(req);
				if (!auth.allowed) return json(res, auth.status, { error: auth.reason ?? "Unauthorized" });
				return this.handleApi(req, res, url);
			}
			return this.serveStatic(req, res, url);
		} catch (error) {
			const status = statusFromError(error);
			return json(res, status, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson<{ pin?: string }>(req, this.maxJsonBytes);
		const result = await this.auth.pair(req, body.pin ?? "");
		res.setHeader(
			"Set-Cookie",
			`dreb_dashboard_pairing=${encodeURIComponent(result.token)}; HttpOnly; SameSite=Strict; Path=/`,
		);
		return json(res, 200, result);
	}

	private async handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		if (url.pathname === "/api/auth/status" && req.method === "GET") return json(res, 200, { authenticated: true });
		if (url.pathname === "/api/roots" && req.method === "GET")
			return json(res, 200, { roots: this.files.listRoots() });
		if (url.pathname === "/api/files/browse" && req.method === "GET") {
			return json(
				res,
				200,
				await this.files.browse(requiredQuery(url, "root"), url.searchParams.get("path") ?? "."),
			);
		}
		if (url.pathname === "/api/files/upload" && req.method === "POST") {
			const body = await readBody(req, Number(url.searchParams.get("maxBytes") ?? 10 * 1024 * 1024));
			return json(
				res,
				200,
				await this.files.upload(
					requiredQuery(url, "root"),
					url.searchParams.get("path") ?? ".",
					requiredQuery(url, "name"),
					body,
				),
			);
		}
		if (url.pathname === "/api/files/download" && req.method === "GET") {
			const download = await this.files.download(requiredQuery(url, "root"), requiredQuery(url, "path"));
			res.writeHead(200, {
				"content-type": download.mime,
				"content-length": String(download.size),
				"content-disposition": `attachment; filename="${download.filename.replaceAll('"', "")}"`,
			});
			download.stream.pipe(res);
			return;
		}
		if (url.pathname === "/api/sessions" && req.method === "GET")
			return json(res, 200, { sessions: await this.sessions.listAll() });
		if (url.pathname === "/api/sessions/project" && req.method === "GET") {
			return json(res, 200, { sessions: await this.sessions.listProject(requiredQuery(url, "cwd")) });
		}
		if (url.pathname === "/api/runtime" && req.method === "POST") {
			const body = await readJson<RuntimeBody>(req, this.maxJsonBytes);
			const runtime = await this.runtimes.getOrCreate({
				id: body.id,
				cwd: requiredBodyString(body, "cwd"),
				sessionPath: body.sessionPath,
				provider: body.provider,
				model: body.model,
			});
			return json(res, 200, { id: runtime.id, state: await runtime.getState() });
		}
		const match =
			/^\/api\/runtime\/([^/]+)\/(prompt|steer|follow_up|abort|state|messages|model|thinking|modes|models|events)$/.exec(
				url.pathname,
			);
		if (match) return this.handleRuntimeRoute(req, res, url, decodeURIComponent(match[1]), match[2]);
		return json(res, 404, { error: "Not found" });
	}

	private async handleRuntimeRoute(
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
		id: string,
		action: string,
	): Promise<void> {
		if (action === "events" && req.method === "GET") {
			const runtime = await this.runtimes.getOrCreate({
				id,
				cwd: requiredQuery(url, "cwd"),
				sessionPath: url.searchParams.get("sessionPath") ?? undefined,
			});
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(`event: ready\ndata: ${JSON.stringify({ id: runtime.id })}\n\n`);
			const unsubscribe = runtime.onEvent((event) => {
				res.write(`event: agent\ndata: ${JSON.stringify(event)}\n\n`);
			});
			req.on("close", unsubscribe);
			return;
		}

		const body =
			req.method === "GET" ? queryRuntimeBody(url) : await readJson<RuntimeActionBody>(req, this.maxJsonBytes);
		const runtime = await this.runtimes.getOrCreate({
			id,
			cwd: requiredBodyString(body, "cwd"),
			sessionPath: body.sessionPath,
			provider: body.provider,
			model: body.model,
		});
		switch (action) {
			case "prompt":
				await runtime.prompt(requiredBodyString(body, "message"), body.images);
				return json(res, 200, { ok: true });
			case "steer":
				await runtime.steer(requiredBodyString(body, "message"), body.images);
				return json(res, 200, { ok: true });
			case "follow_up":
				await runtime.followUp(requiredBodyString(body, "message"), body.images);
				return json(res, 200, { ok: true });
			case "abort":
				await runtime.abort();
				return json(res, 200, { ok: true });
			case "state":
				return json(res, 200, { state: await runtime.getState() });
			case "messages":
				return json(res, 200, { messages: await runtime.getMessages() });
			case "model":
				return json(res, 200, {
					model: await runtime.setModel(requiredBodyString(body, "provider"), requiredBodyString(body, "modelId")),
				});
			case "thinking":
				await runtime.setThinkingLevel(requiredBodyString(body, "level") as never);
				return json(res, 200, { ok: true });
			case "modes":
				if (body.steeringMode) await runtime.setSteeringMode(body.steeringMode);
				if (body.followUpMode) await runtime.setFollowUpMode(body.followUpMode);
				return json(res, 200, { ok: true });
			case "models":
				return json(res, 200, { models: await runtime.getAvailableModels() });
			default:
				return json(res, 404, { error: "Not found" });
		}
	}

	private async serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed" });
		const relativePath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
		if (relativePath.includes("..")) return json(res, 403, { error: "Forbidden" });
		const filePath = join(this.staticDir, relativePath);
		let info = await stat(filePath).catch(() => null);
		const resolvedPath = info?.isDirectory() ? join(filePath, "index.html") : filePath;
		info = await stat(resolvedPath).catch(() => null);
		if (!info?.isFile()) return json(res, 404, { error: "Not found" });
		res.writeHead(200, { "content-type": contentType(resolvedPath), "content-length": String(info.size) });
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		createReadStream(resolvedPath).pipe(res);
	}
}

interface RuntimeBody {
	id?: string;
	cwd?: string;
	sessionPath?: string;
	provider?: string;
	model?: string;
}

interface RuntimeActionBody extends RuntimeBody {
	message?: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	provider?: string;
	modelId?: string;
	level?: string;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
}

async function readJson<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
	const body = await readBody(req, maxBytes);
	if (body.byteLength === 0) return {} as T;
	return JSON.parse(body.toString("utf8")) as T;
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.byteLength;
			if (size > maxBytes) {
				reject(Object.assign(new Error("Request body exceeds size limit"), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function json(res: ServerResponse, status: number, body: unknown): void {
	const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(encoded.byteLength),
	});
	res.end(encoded);
}

function requiredQuery(url: URL, key: string): string {
	const value = url.searchParams.get(key);
	if (!value) throw Object.assign(new Error(`Missing query parameter: ${key}`), { status: 400 });
	return value;
}

function requiredBodyString(body: object, key: string): string {
	const value = (body as Record<string, unknown>)[key];
	if (typeof value !== "string" || value.length === 0)
		throw Object.assign(new Error(`Missing body field: ${key}`), { status: 400 });
	return value;
}

function queryRuntimeBody(url: URL): RuntimeActionBody {
	return {
		cwd: url.searchParams.get("cwd") ?? undefined,
		sessionPath: url.searchParams.get("sessionPath") ?? undefined,
	};
}

function statusFromError(error: unknown): number {
	const status = (error as { status?: unknown }).status;
	return typeof status === "number" ? status : 500;
}

function contentType(path: string): string {
	switch (extname(path)) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		default:
			return "application/octet-stream";
	}
}
