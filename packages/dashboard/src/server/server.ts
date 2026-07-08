/**
 * Dashboard HTTP server — Express app wiring auth, the runtime pool, the SSE
 * hub, and the file API into the REST surface the browser client consumes.
 *
 * Bind address discipline (SPEC.md §6): local mode binds 127.0.0.1 only. The
 * caller decides the bind address; `createDashboardServer` never listens by
 * itself. Remote mode still passes every request through DashboardAuth.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import type { AuthStatusDto, FleetDto, ImageAttachmentDto } from "../shared/protocol.js";
import type { AuthDecision, DashboardAuth } from "./auth.js";
import { EventHub } from "./event-hub.js";
import { defaultPlaces, FileApi } from "./files.js";
import type { RuntimePool } from "./runtime-pool.js";

export interface DashboardServerOptions {
	auth: DashboardAuth;
	pool: RuntimePool;
	/** Directory of built client assets; omit to skip static serving (tests). */
	staticDir?: string;
	/** Session listing (cross-project) — injected so tests can stub it. */
	listAllSessions: () => Promise<unknown[]>;
	deleteSession: (path: string) => Promise<unknown>;
	logger?: (line: string) => void;
}

const DEVICE_COOKIE = "dreb_dashboard_device";

/** Parse the device cookie from a Cookie header. */
export function parseDeviceCookie(cookieHeader: string | undefined): string | undefined {
	if (!cookieHeader) return undefined;
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === DEVICE_COOKIE) return part.slice(eq + 1).trim();
	}
	return undefined;
}

interface AuthedRequest extends Request {
	authDecision?: AuthDecision;
}

export function createDashboardServer(options: DashboardServerOptions): express.Express {
	const { auth, pool } = options;
	const log = options.logger ?? ((line: string) => console.log(`[dashboard] ${line}`));
	const files = new FileApi((op, path, detail) => log(`file ${op}: ${path}${detail ? ` (${detail})` : ""}`));
	const hub = new EventHub();
	pool.onEvent((key, event) => hub.publish(key, event));

	const app = express();
	app.disable("x-powered-by");
	app.use(express.json({ limit: "25mb" }));

	// -- auth middleware (every route, fail-closed) ---------------------------
	app.use((req: AuthedRequest, res: Response, next: NextFunction) => {
		auth
			.authenticate({
				remoteAddress: req.socket.remoteAddress,
				hostHeader: req.headers.host,
				originHeader: req.headers.origin,
				deviceToken: parseDeviceCookie(req.headers.cookie),
			})
			.then((decision) => {
				req.authDecision = decision;
				if (decision.allowed) return next();
				// The pairing endpoints must be reachable by allowed-but-unpaired identities.
				if (decision.needsPairing && (req.path === "/api/pair" || req.path === "/api/auth")) return next();
				log(`denied ${req.method} ${req.path}: ${decision.reason}`);
				res.status(decision.status).json({ error: decision.reason, needsPairing: decision.needsPairing ?? false });
			})
			.catch((err) => {
				// authenticate() already catches internally; this is belt-and-suspenders.
				log(`auth middleware error — denying: ${err instanceof Error ? err.message : String(err)}`);
				res.status(500).json({ error: "Auth subsystem error — denied" });
			});
	});

	// -- auth/pairing ----------------------------------------------------------
	app.get("/api/auth", (req: AuthedRequest, res) => {
		const decision = req.authDecision!;
		if (decision.allowed) {
			const status: AuthStatusDto =
				decision.mode === "local"
					? { mode: "local" }
					: { mode: "remote", identity: decision.identity.loginName, device: decision.identity.device };
			res.json({ ...status, needsPairing: false });
			return;
		}
		res.status(decision.status).json({
			error: decision.reason,
			needsPairing: decision.needsPairing ?? false,
			identity: decision.identity?.loginName,
		});
	});

	app.post("/api/pair", (req: AuthedRequest, res) => {
		const pin = typeof req.body?.pin === "string" ? req.body.pin : "";
		auth
			.pair(
				{
					remoteAddress: req.socket.remoteAddress,
					hostHeader: req.headers.host,
					originHeader: req.headers.origin,
					deviceToken: undefined,
				},
				pin,
			)
			.then(({ token, device }) => {
				log(`paired device ${device.id} (${device.identity})`);
				res.cookie(DEVICE_COOKIE, token, {
					httpOnly: true,
					sameSite: "strict",
					secure: false, // Tailscale already encrypts; the dashboard serves plain HTTP on the tailnet.
					expires: new Date(device.expiresAt),
				}).json({ device });
			})
			.catch((err) => {
				const status = typeof err?.status === "number" ? err.status : 500;
				log(`pairing failed: ${err instanceof Error ? err.message : String(err)}`);
				res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
			});
	});

	app.get("/api/devices", (_req, res) => {
		auth
			.listDevices()
			.then((devices) => res.json({ devices }))
			.catch((err) => res.status(500).json({ error: String(err?.message ?? err) }));
	});

	app.delete("/api/devices/:id", (req, res) => {
		auth
			.unpair(req.params.id)
			.then((removed) => {
				if (!removed) {
					res.status(404).json({ error: `No paired device with id ${String(req.params.id)}` });
					return;
				}
				log(`unpaired device ${String(req.params.id)}`);
				res.json({ ok: true });
			})
			.catch((err) => res.status(500).json({ error: String(err?.message ?? err) }));
	});

	// -- events (SSE) ----------------------------------------------------------
	app.get("/api/events", (req, res) => {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write(":ok\n\n");
		const lastIdRaw = req.headers["last-event-id"] ?? req.query.lastEventId;
		const lastEventId =
			typeof lastIdRaw === "string" && /^\d+$/.test(lastIdRaw) ? Number.parseInt(lastIdRaw, 10) : undefined;
		const detach = hub.attach({ write: (chunk) => res.write(chunk) }, lastEventId);
		const keepAlive = setInterval(() => {
			res.write(":ka\n\n");
		}, 25_000);
		req.on("close", () => {
			clearInterval(keepAlive);
			detach();
		});
	});

	// -- fleet -----------------------------------------------------------------
	app.get("/api/fleet", (_req, res) => {
		(async () => {
			const runtimes = await Promise.all(pool.list().map((h) => pool.describe(h)));
			const diskSessions = (await options.listAllSessions()) as FleetDto["diskSessions"];
			const fleet: FleetDto = { runtimes, diskSessions };
			res.json(fleet);
		})().catch((err) => res.status(500).json({ error: String(err?.message ?? err) }));
	});

	// -- runtimes ---------------------------------------------------------------
	app.post("/api/runtimes", (req, res) => {
		(async () => {
			const cwd = typeof req.body?.cwd === "string" ? req.body.cwd : "";
			if (!cwd || !existsSync(cwd)) {
				res.status(400).json({ error: `Working directory does not exist: ${cwd || "(empty)"}` });
				return;
			}
			const sessionPath = typeof req.body?.sessionPath === "string" ? req.body.sessionPath : undefined;
			const handle = await pool.create(cwd, sessionPath);
			log(`runtime ${handle.key} started in ${cwd}${sessionPath ? ` (resume ${basename(sessionPath)})` : ""}`);
			const firstPrompt = typeof req.body?.firstPrompt === "string" ? req.body.firstPrompt : undefined;
			if (firstPrompt) await handle.client.prompt(firstPrompt);
			res.status(201).json(await pool.describe(handle));
		})().catch((err) => res.status(500).json({ error: String(err?.message ?? err) }));
	});

	app.delete("/api/runtimes/:key", (req, res) => {
		pool
			.stop(req.params.key)
			.then((stopped) => {
				if (!stopped) {
					res.status(404).json({ error: `No runtime ${String(req.params.key)}` });
					return;
				}
				log(`runtime ${String(req.params.key)} stopped`);
				res.json({ ok: true });
			})
			.catch((err) => res.status(500).json({ error: String(err?.message ?? err) }));
	});

	/** Helper: run an async op against a pooled runtime with uniform errors. */
	function withRuntime(
		req: Request,
		res: Response,
		fn: (handle: NonNullable<ReturnType<RuntimePool["get"]>>) => Promise<unknown>,
	): void {
		const handle = pool.get(String(req.params.key));
		if (!handle) {
			res.status(404).json({ error: `No runtime ${String(req.params.key)}` });
			return;
		}
		fn(handle)
			.then((data) => res.json(data ?? { ok: true }))
			.catch((err) => {
				res.status(502).json({ error: String(err?.message ?? err) });
			});
	}

	app.get("/api/runtimes/:key", (req, res) => {
		withRuntime(req, res, (h) => pool.describe(h));
	});

	app.get("/api/runtimes/:key/messages", (req, res) => {
		withRuntime(req, res, async (h) => ({ messages: await h.client.getMessages() }));
	});

	app.get("/api/runtimes/:key/pending", (req, res) => {
		withRuntime(req, res, (h) => h.client.getPendingMessages());
	});

	app.post("/api/runtimes/:key/dequeue", (req, res) => {
		withRuntime(req, res, (h) => h.client.clearPendingMessages());
	});

	function parseImages(body: unknown): ImageAttachmentDto[] | undefined | "invalid" {
		const images = (body as { images?: unknown } | undefined)?.images;
		if (images === undefined) return undefined;
		if (!Array.isArray(images)) return "invalid";
		const parsed: ImageAttachmentDto[] = [];
		for (const image of images) {
			if (
				!image ||
				typeof image !== "object" ||
				typeof (image as { data?: unknown }).data !== "string" ||
				typeof (image as { mimeType?: unknown }).mimeType !== "string"
			) {
				return "invalid";
			}
			parsed.push({ data: (image as ImageAttachmentDto).data, mimeType: (image as ImageAttachmentDto).mimeType });
		}
		return parsed;
	}

	app.post("/api/runtimes/:key/prompt", (req, res) => {
		const { message, mode } = req.body ?? {};
		if (typeof message !== "string" || message.length === 0) {
			res.status(400).json({ error: "message is required" });
			return;
		}
		const images = parseImages(req.body);
		if (images === "invalid") {
			res.status(400).json({ error: "images must be an array of {data, mimeType} objects" });
			return;
		}
		const rpcImages = images?.map((image) => ({
			type: "image" as const,
			data: image.data,
			mimeType: image.mimeType,
		}));
		withRuntime(req, res, async (h) => {
			if (mode === "steer") await h.client.steer(message, rpcImages);
			else if (mode === "follow_up") await h.client.followUp(message, rpcImages);
			else await h.client.prompt(message, rpcImages);
		});
	});

	app.post("/api/runtimes/:key/abort", (req, res) => {
		withRuntime(req, res, (h) => h.client.abort());
	});

	app.post("/api/runtimes/:key/abort-compaction", (req, res) => {
		withRuntime(req, res, (h) => h.client.abortCompaction());
	});

	app.post("/api/runtimes/:key/abort-retry", (req, res) => {
		withRuntime(req, res, (h) => h.client.abortRetry());
	});

	app.post("/api/runtimes/:key/model", (req, res) => {
		const { provider, modelId } = req.body ?? {};
		if (typeof provider !== "string" || typeof modelId !== "string") {
			res.status(400).json({ error: "provider and modelId are required" });
			return;
		}
		withRuntime(req, res, (h) => h.client.setModel(provider, modelId));
	});

	app.get("/api/runtimes/:key/models", (req, res) => {
		withRuntime(req, res, async (h) => ({ models: await h.client.getAvailableModels() }));
	});

	app.post("/api/runtimes/:key/thinking", (req, res) => {
		const { level } = req.body ?? {};
		if (typeof level !== "string") {
			res.status(400).json({ error: "level is required" });
			return;
		}
		withRuntime(req, res, (h) => h.client.setThinkingLevel(level as never));
	});

	app.post("/api/runtimes/:key/compact", (req, res) => {
		const instructions = typeof req.body?.instructions === "string" ? req.body.instructions : undefined;
		withRuntime(req, res, (h) => h.client.compact(instructions));
	});

	app.post("/api/runtimes/:key/name", (req, res) => {
		const { name } = req.body ?? {};
		if (typeof name !== "string" || name.length === 0) {
			res.status(400).json({ error: "name is required" });
			return;
		}
		withRuntime(req, res, (h) => h.client.setSessionName(name));
	});

	app.get("/api/runtimes/:key/stats", (req, res) => {
		withRuntime(req, res, (h) => h.client.getSessionStats());
	});

	app.get("/api/runtimes/:key/performance", (req, res) => {
		withRuntime(req, res, (h) => h.client.getPerformanceStats());
	});

	app.get("/api/runtimes/:key/resources", (req, res) => {
		withRuntime(req, res, (h) => h.client.getResources());
	});

	app.get("/api/runtimes/:key/commands", (req, res) => {
		withRuntime(req, res, async (h) => ({ commands: await h.client.getCommands() }));
	});

	app.get("/api/runtimes/:key/branch", (req, res) => {
		withRuntime(req, res, async (h) => ({ branch: await h.client.getGitBranch() }));
	});

	app.get("/api/runtimes/:key/fork-messages", (req, res) => {
		withRuntime(req, res, async (h) => ({ messages: await h.client.getForkMessages() }));
	});

	app.post("/api/runtimes/:key/fork", (req, res) => {
		const { entryId } = req.body ?? {};
		if (typeof entryId !== "string") {
			res.status(400).json({ error: "entryId is required" });
			return;
		}
		withRuntime(req, res, (h) => h.client.fork(entryId));
	});

	app.get("/api/runtimes/:key/export-html", (req, res) => {
		const handle = pool.get(String(req.params.key));
		if (!handle) {
			res.status(404).json({ error: `No runtime ${String(req.params.key)}` });
			return;
		}
		handle.client
			.exportHtml()
			.then(({ path }) => {
				res.download(path);
			})
			.catch((err) => res.status(502).json({ error: String(err?.message ?? err) }));
	});

	app.get("/api/runtimes/:key/background-agents", (req, res) => {
		withRuntime(req, res, async (h) => ({ agents: await h.client.listBackgroundAgents() }));
	});

	app.post("/api/runtimes/:key/extension-ui-response", (req, res) => {
		const handle = pool.get(String(req.params.key));
		if (!handle) {
			res.status(404).json({ error: `No runtime ${String(req.params.key)}` });
			return;
		}
		try {
			handle.client.sendExtensionUIResponse(req.body);
			res.json({ ok: true });
		} catch (err) {
			res.status(502).json({ error: String((err as Error)?.message ?? err) });
		}
	});

	// -- disk sessions -----------------------------------------------------------
	app.delete("/api/sessions", (req, res) => {
		const path = typeof req.body?.path === "string" ? req.body.path : "";
		if (!path) {
			res.status(400).json({ error: "path is required" });
			return;
		}
		options
			.deleteSession(path)
			.then((result) => {
				log(`session deleted: ${path}`);
				res.json(result ?? { ok: true });
			})
			.catch((err) => res.status(500).json({ error: String(err?.message ?? err) }));
	});

	// -- settings ------------------------------------------------------------------
	// Settings go through a pooled runtime (any one — they are process-global
	// persistent defaults). 503 when no runtime is live.
	function withAnyRuntime(res: Response, fn: (h: NonNullable<ReturnType<RuntimePool["get"]>>) => Promise<unknown>) {
		const handle = pool.list()[0];
		if (!handle) {
			res.status(503).json({ error: "No live runtime — start or resume a session first" });
			return;
		}
		fn(handle)
			.then((data) => res.json(data ?? { ok: true }))
			.catch((err) => {
				res.status(502).json({ error: String(err?.message ?? err) });
			});
	}

	app.get("/api/settings", (_req, res) => {
		withAnyRuntime(res, (h) => h.client.getSettings());
	});

	app.get("/api/daily-cost", (_req, res) => {
		withAnyRuntime(res, async (h) => ({ cost: await h.client.getDailyCost() }));
	});

	app.put("/api/settings", (req, res) => {
		withAnyRuntime(res, (h) => h.client.setSettings(req.body ?? {}));
	});

	app.get("/api/version", (_req, res) => {
		withAnyRuntime(res, async (h) => ({ version: await h.client.getVersion() }));
	});

	// -- files -----------------------------------------------------------------------
	app.get("/api/files", (req, res) => {
		const path = typeof req.query.path === "string" ? req.query.path : homedir();
		files
			.list(path)
			.then((listing) => res.json(listing))
			.catch((err) => res.status(err?.status ?? 500).json({ error: String(err?.message ?? err) }));
	});

	app.get("/api/files/places", (_req, res) => {
		const roots = [...new Set(pool.list().map((h) => h.cwd))];
		res.json({ places: defaultPlaces(homedir(), roots) });
	});

	app.get("/api/files/download", (req, res) => {
		const path = typeof req.query.path === "string" ? req.query.path : "";
		files
			.resolveDownload(path)
			.then(({ path: real }) => {
				res.download(real);
			})
			.catch((err) => res.status(err?.status ?? 500).json({ error: String(err?.message ?? err) }));
	});

	app.post("/api/files/upload", (req, res) => {
		const dir = typeof req.query.dir === "string" ? req.query.dir : "";
		const name = typeof req.query.name === "string" ? req.query.name : "";
		const overwrite = req.query.overwrite === "true";
		files
			.prepareUpload(dir, name, overwrite)
			.then(
				({ path, stream }) =>
					new Promise<void>((resolve, reject) => {
						req.pipe(stream);
						stream.on("finish", () => {
							res.json({ path });
							resolve();
						});
						stream.on("error", reject);
						req.on("error", reject);
					}),
			)
			.catch((err) => res.status(err?.status ?? 500).json({ error: String(err?.message ?? err) }));
	});

	app.post("/api/files/mkdir", (req, res) => {
		const { dir, name } = req.body ?? {};
		if (typeof dir !== "string" || typeof name !== "string") {
			res.status(400).json({ error: "dir and name are required" });
			return;
		}
		files
			.mkdir(dir, name)
			.then((path) => res.json({ path }))
			.catch((err) => res.status(err?.status ?? 500).json({ error: String(err?.message ?? err) }));
	});

	// -- static client -----------------------------------------------------------------
	if (options.staticDir) {
		app.use(express.static(options.staticDir));
		// SPA fallback: serve index.html for non-API GETs (client-side routing).
		app.get(/^\/(?!api\/).*/, (_req, res) => {
			res.sendFile(join(options.staticDir!, "index.html"));
		});
	}

	return app;
}
