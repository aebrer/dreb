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
import type { AuthStatusDto, FleetDto, ImageAttachmentDto, PairingCodeDto } from "../shared/protocol.js";
import type { AuthDecision, DashboardAuth } from "./auth.js";
import { EventHub } from "./event-hub.js";
import { defaultPlaces, FileApi } from "./files.js";
import type { RuntimePool } from "./runtime-pool.js";
import { readSubagentMessages } from "./subagent-log.js";

export interface DashboardServerOptions {
	auth: DashboardAuth;
	pool: RuntimePool;
	/** Directory of built client assets; omit to skip static serving (tests). */
	staticDir?: string;
	/** Session listing (cross-project) — injected so tests can stub it. */
	listAllSessions: () => Promise<unknown[]>;
	deleteSession: (path: string) => Promise<unknown>;
	logger?: (line: string) => void;
	/** Build version of the running server process (for the settings footer / stale-server detection). */
	serverVersion?: string;
	/** Restart hook — when set, POST /api/server/restart invokes it (typically process exit for a supervisor to respawn). */
	onRestart?: () => void;
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
	const serverStartedAt = new Date().toISOString();
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
				const canRenderAuthScreen = decision.needsPairing || Boolean(decision.identity);
				if (canRenderAuthScreen) {
					// The auth/pairing endpoints must be reachable by allowed-but-unpaired
					// identities, and /api/auth must also be reachable by rejected
					// Tailscale identities so the SPA denial screen can name them.
					if (req.path === "/api/auth" || (decision.needsPairing && req.path === "/api/pair")) return next();
					// Let the SPA shell + static assets load so the client-side pairing or
					// denial screen can render. No data exposure: every /api/* data route
					// below stays fail-closed — only non-API GETs (the app shell) are allowed.
					if (req.method === "GET" && !req.path.startsWith("/api/")) return next();
				}
				log(`denied ${req.method} ${req.path}: ${decision.reason}`);
				res.status(decision.status).json({
					error: decision.reason,
					needsPairing: decision.needsPairing ?? false,
					identity: decision.identity?.loginName,
				});
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

	app.get("/api/pairing-code", (req: AuthedRequest, res) => {
		const decision = req.authDecision!;
		if (!decision.allowed || decision.mode !== "local") {
			res.status(403).json({ error: "Pairing code is only available from the host machine" });
			return;
		}
		if (!auth.isRemoteEnabled) {
			const body: PairingCodeDto = { enabled: false };
			res.json(body);
			return;
		}
		const body: PairingCodeDto = { enabled: true, ...auth.currentPairingCode() };
		res.json(body);
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
			const diskSessions = ((await options.listAllSessions()) as FleetDto["diskSessions"]).filter((session) =>
				existsSync(session.cwd),
			);
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

	app.get("/api/runtimes/:key/subagents/:agentId/messages", (req, res) => {
		const agentId = String(req.params.agentId);
		withRuntime(req, res, async (h) => {
			// The runtime's registry is authoritative for status + log location.
			const agents = await h.client.listBackgroundAgents();
			const agent = agents.find((a) => a.agentId === agentId);
			if (!agent) throw new Error(`No background agent ${agentId} in this runtime`);
			const messages = readSubagentMessages(agent);
			return { agent, messages };
		});
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
	// Settings are process-global persistent defaults. They route through hidden
	// utility runtimes instead of whichever user session happened to open first.
	// Agent-definition discovery is cwd-sensitive, so callers may pass an explicit
	// project cwd for endpoints that need project-local .dreb/agents.
	function withAnyRuntime(
		res: Response,
		fn: (h: NonNullable<ReturnType<RuntimePool["get"]>>) => Promise<unknown>,
		cwd?: string,
	) {
		pool
			.ensureUtilityRuntime(cwd)
			.then((handle) => fn(handle))
			.then((data) => res.json(data ?? { ok: true }))
			.catch((err) => {
				res.status(502).json({ error: String(err?.message ?? err) });
			});
	}

	app.get("/api/settings", (_req, res) => {
		withAnyRuntime(res, (h) => h.client.getSettings());
	});

	app.get("/api/settings/models", (_req, res) => {
		withAnyRuntime(res, async (h) => ({ models: await h.client.getAvailableModels() }));
	});

	app.get("/api/settings/agent-types", (req, res) => {
		const cwd = typeof req.query.cwd === "string" && req.query.cwd.trim() ? req.query.cwd : undefined;
		if (cwd && !existsSync(cwd)) {
			res.status(400).json({ error: `cwd does not exist: ${cwd}` });
			return;
		}
		withAnyRuntime(res, async (h) => ({ agentTypes: await h.client.listAgentTypes() }), cwd);
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

	// -- server lifecycle ----------------------------------------------------------
	// Build/version of the *server* process (distinct from a freshly-spawned RPC
	// child's version) so a stale long-running service is visible at a glance.
	app.get("/api/server/info", (_req, res) => {
		res.json({
			version: options.serverVersion ?? null,
			startedAt: serverStartedAt,
			// systemd sets INVOCATION_ID; other supervisors set LISTEN_PID. Best-effort.
			supervised: Boolean(process.env.INVOCATION_ID || process.env.LISTEN_PID),
			restartable: Boolean(options.onRestart),
		});
	});

	app.post("/api/server/restart", (_req, res) => {
		if (!options.onRestart) {
			res.status(501).json({
				error: "Restart is unavailable — the dashboard is not running under a supervisor that can respawn it",
			});
			return;
		}
		log("restart requested via API");
		res.json({ ok: true, restarting: true });
		// Defer so the HTTP response flushes before the process exits.
		setTimeout(() => options.onRestart?.(), 100);
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
		(async () => {
			const dir = typeof req.query.dir === "string" ? req.query.dir : "";
			const name = typeof req.query.name === "string" ? req.query.name : "";
			const overwrite = req.query.overwrite === "true";
			const upload = await files.prepareUpload(dir, name, overwrite);
			try {
				await new Promise<void>((resolve, reject) => {
					let settled = false;
					const fail = (err: unknown) => {
						if (settled) return;
						settled = true;
						upload.stream.destroy();
						reject(err);
					};
					req.pipe(upload.stream);
					upload.stream.on("finish", () => {
						if (settled) return;
						settled = true;
						resolve();
					});
					upload.stream.on("error", fail);
					req.on("error", fail);
					req.on("aborted", () => fail(Object.assign(new Error("Upload aborted"), { status: 499 })));
				});
				await upload.commit();
				res.json({ path: upload.path });
			} catch (err) {
				await upload.cleanup();
				throw err;
			}
		})().catch((err) => {
			if (!res.headersSent) res.status(err?.status ?? 500).json({ error: String(err?.message ?? err) });
		});
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
