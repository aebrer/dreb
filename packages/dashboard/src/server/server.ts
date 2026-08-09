/**
 * Dashboard HTTP server — Express app wiring auth, the runtime pool, the SSE
 * hub, and the file API into the REST surface the browser client consumes.
 *
 * Bind address discipline: local mode binds 127.0.0.1 only. The
 * caller decides the bind address; `createDashboardServer` never listens by
 * itself. Remote mode still passes every request through DashboardAuth.
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import type {
	ActiveRuntimeSnapshotDto,
	AuthStatusDto,
	ClientConnectionDiagnosticDto,
	DashboardResyncDto,
	FleetDto,
	ImageAttachmentDto,
	PairingCodeDto,
	RuntimeHydrationDto,
	SessionInfoDto,
	SessionInventoryDto,
} from "../shared/protocol.js";
import {
	MAX_CLIENT_DIAGNOSTIC_BYTES,
	MAX_PROMPT_BODY_BYTES,
	MAX_SESSION_PREVIEW_CHARACTERS,
} from "../shared/protocol.js";
import type { AuthDecision, DashboardAuth } from "./auth.js";
import {
	DASHBOARD_IMAGE_ID_PATTERN,
	DashboardImageNotFoundError,
	DashboardImagePreviewError,
	type DashboardImageScope,
	DashboardImageService,
} from "./dashboard-images.js";
import { EventHub, formatHeartbeatFrame, type SseWriteMetadata } from "./event-hub.js";
import { defaultPlaces, FileApi } from "./files.js";
import { ImagePreviewWorker } from "./image-preview.js";
import { MemoryApi } from "./memories.js";
import type { DashboardRuntimeSnapshot, RuntimePool } from "./runtime-pool.js";
import { readSubagentMessages, SubagentSessionLogNotFoundError } from "./subagent-log.js";

export type DashboardServerApp = express.Express & {
	/** Close dashboard-owned services. Safe to call more than once during shutdown. */
	closeDashboard(): Promise<void>;
};

export interface DashboardSessionInfoSource {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
}

export interface DashboardServerOptions {
	auth: DashboardAuth;
	pool: RuntimePool;
	/** Directory of built client assets; omit to skip static serving (tests). */
	staticDir?: string;
	/** Session listing (cross-project) — injected so tests can stub it. */
	listAllSessions: () => Promise<DashboardSessionInfoSource[]>;
	deleteSession: (path: string) => Promise<unknown>;
	logger?: (line: string) => void;
	/** Build version of the running server process (for the settings footer / stale-server detection). */
	serverVersion?: string;
	/** Restart hook — when set, POST /api/server/restart invokes it (typically process exit for a supervisor to respawn). */
	onRestart?: () => void;
	/** Injectable only to make SSE limits deterministic in integration tests. */
	eventHub?: EventHub;
	/** Injectable bounded image repository/preview service for deterministic tests and lifecycle ownership. */
	imageService?: DashboardImageService;
	/** Named heartbeat interval; defaults to 25 seconds. */
	heartbeatIntervalMs?: number;
	/** Test-only override for the global dreb memory home directory. */
	memoryHomeDir?: string;
}

const DEVICE_COOKIE = "dreb_dashboard_device";
export const MAX_SSE_BUFFERED_BYTES = 4 * 1024 * 1024;
export const CLIENT_DIAGNOSTIC_RATE_LIMIT_MS = 30_000;
const CLIENT_DIAGNOSTIC_CONNECTION_TTL_MS = 10 * 60_000;

function boundedSessionPreview(text: string): string {
	let preview = "";
	let characters = 0;
	for (const character of text) {
		if (characters === MAX_SESSION_PREVIEW_CHARACTERS) break;
		preview += character;
		characters++;
	}
	return preview;
}

function toSessionInfoDto(session: DashboardSessionInfoSource): SessionInfoDto {
	return {
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		name: session.name,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
		messageCount: session.messageCount,
		firstMessage: boundedSessionPreview(session.firstMessage),
	};
}

function isClientDiagnostic(value: unknown): value is ClientConnectionDiagnosticDto {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const body = value as Record<string, unknown>;
	const allowed = new Set([
		"connectionId",
		"state",
		"previousState",
		"attempt",
		"delayMs",
		"visibility",
		"lastAppliedSeq",
		"heartbeatAgeMs",
		"eventCount",
		"eventRatePerMinute",
		"processingLagTotalMs",
		"processingLagMaxMs",
	]);
	if (Object.keys(body).some((key) => !allowed.has(key))) return false;
	const states = new Set(["connecting", "connected", "retrying", "resyncing", "disconnected", "auth_failed"]);
	const nonNegativeNumber = (item: unknown) => typeof item === "number" && Number.isFinite(item) && item >= 0;
	const nonNegativeInteger = (item: unknown) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
	return (
		typeof body.connectionId === "string" &&
		/^[0-9a-f-]{36}$/i.test(body.connectionId) &&
		typeof body.state === "string" &&
		states.has(body.state) &&
		(body.previousState === undefined ||
			(typeof body.previousState === "string" && states.has(body.previousState))) &&
		nonNegativeInteger(body.attempt) &&
		nonNegativeNumber(body.eventCount) &&
		nonNegativeNumber(body.eventRatePerMinute) &&
		nonNegativeNumber(body.processingLagTotalMs) &&
		nonNegativeNumber(body.processingLagMaxMs) &&
		(body.delayMs === undefined || nonNegativeNumber(body.delayMs)) &&
		(body.lastAppliedSeq === undefined || nonNegativeInteger(body.lastAppliedSeq)) &&
		(body.heartbeatAgeMs === undefined || nonNegativeNumber(body.heartbeatAgeMs)) &&
		(body.visibility === "visible" || body.visibility === "hidden")
	);
}

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
	/** Per-SSE-request opaque diagnostic correlation id. */
	sseConnectionId?: string;
}

export function createDashboardServer(options: DashboardServerOptions): DashboardServerApp {
	const { auth, pool } = options;
	const serverStartedAt = new Date().toISOString();
	const diagnosticConnections = new Map<string, { issuedAt: number; lastAt?: number }>();
	const log = options.logger ?? ((line: string) => console.log(`[dashboard] ${line}`));
	const files = new FileApi((op, path, detail) => log(`file ${op}: ${path}${detail ? ` (${detail})` : ""}`));
	const memories = new MemoryApi(options.memoryHomeDir ?? homedir(), (op, scopeId, detail) =>
		log(`memory ${op}: ${scopeId}${detail ? ` (${detail})` : ""}`),
	);
	const hub = options.eventHub ?? new EventHub();
	const images = options.imageService ?? new DashboardImageService(new ImagePreviewWorker());
	hub.setEventProjector((key, event) => (key ? images.projectEvent(event, { runtimeKey: key }) : event));
	pool.onEvent((key, event) => {
		if (event.type === "dashboard_snapshot_barrier" && typeof event.snapshotId === "string") {
			// This RPC marker has no browser frame: its synchronous sequence capture
			// orders the HTTP snapshot before all later EventHub publications.
			pool.recordDashboardBarrier(key, event.snapshotId, hub.currentSequence);
			return;
		}
		hub.publish(key, event);
		if (event.type === "runtime_removed") images.removeRuntime(key);
	});
	pool.onFleetSnapshot((event) => hub.publish("", { ...event }));

	const app = express() as DashboardServerApp;
	let closePromise: Promise<void> | undefined;
	app.closeDashboard = () => {
		closePromise ??= images.close();
		return closePromise;
	};
	app.disable("x-powered-by");

	// -- auth middleware (every route, fail-closed) ---------------------------
	app.use((req: AuthedRequest, res: Response, next: NextFunction) => {
		if (req.path === "/api/events") req.sseConnectionId = randomUUID();
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
				if (req.sseConnectionId) {
					log(
						`sse ${JSON.stringify({
							connectionId: req.sseConnectionId,
							kind: "auth_denial",
							method: req.method,
							path: req.path,
							status: decision.status,
						})}`,
					);
				} else {
					log(`denied ${req.method} ${req.path}: ${decision.reason}`);
				}
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

	// Authenticate before consuming request bodies. Diagnostics have their own
	// small parser limit; the larger limit exists only for prompt image payloads.
	app.use("/api/events/diagnostic", express.json({ limit: MAX_CLIENT_DIAGNOSTIC_BYTES }));
	app.use(express.json({ limit: MAX_PROMPT_BODY_BYTES }));
	app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
		if ((err as { type?: string }).type === "entity.too.large") {
			res.status(413).json({ error: "Request body is too large" });
			return;
		}
		next(err);
	});

	// -- auth/pairing ----------------------------------------------------------
	app.get("/api/auth", (req: AuthedRequest, res) => {
		const decision = req.authDecision!;
		if (decision.allowed && decision.mode === "local") {
			const status: AuthStatusDto = { mode: "local" };
			res.json({ ...status, needsPairing: false });
			return;
		}
		if (decision.allowed) {
			auth
				.claimPairingExpiryStatus(decision.pairing.id)
				.then((expiry) => {
					const status: AuthStatusDto = {
						mode: "remote",
						identity: decision.identity.loginName,
						device: decision.identity.device,
						...(expiry.warning ? { pairingExpiryWarning: expiry.warning } : {}),
						...(expiry.nextCheckAt ? { pairingExpiryCheckAt: expiry.nextCheckAt } : {}),
					};
					res.json({ ...status, needsPairing: false });
				})
				.catch((err) => {
					log(`pairing expiry status failed: ${err instanceof Error ? err.message : String(err)}`);
					res.status(500).json({ error: "Auth subsystem error — denied", needsPairing: false });
				});
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

	app.get("/api/pairing-settings", (_req, res) => {
		auth
			.getPairingSettings()
			.then((settings) => res.json(settings))
			.catch((err) => res.status(500).json({ error: String(err?.message ?? err) }));
	});

	app.put("/api/pairing-settings", (req, res) => {
		const pairingTtlDays = req.body?.pairingTtlDays;
		if (typeof pairingTtlDays !== "number") {
			res.status(400).json({ error: "pairingTtlDays must be a number" });
			return;
		}
		auth
			.setPairingSettings(pairingTtlDays)
			.then((settings) => res.json(settings))
			.catch((err) => {
				const status = typeof err?.status === "number" ? err.status : 500;
				res.status(status).json({ error: String(err?.message ?? err) });
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
	app.get("/api/events", (req: AuthedRequest, res) => {
		const connectionId = req.sseConnectionId ?? randomUUID();
		const diagnostic = (kind: string, metadata: object = {}) =>
			log(`sse ${JSON.stringify({ connectionId, kind, ...metadata })}`);
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		const guardedWrite = (
			chunk: string,
			metadata: SseWriteMetadata | { kind: "handshake" | "heartbeat" | "connection" },
		): boolean => {
			if (res.destroyed || res.writableEnded) {
				diagnostic("write_closed", { writeKind: metadata.kind });
				return false;
			}
			const accepted = res.write(chunk);
			const details = {
				writeKind: metadata.kind,
				...("seq" in metadata
					? { seq: metadata.seq, type: metadata.type, frameBytes: metadata.frameBytes, reason: metadata.reason }
					: {}),
				writableLength: res.writableLength,
			};
			diagnostic("write", details);
			if (!accepted && res.writableLength > MAX_SSE_BUFFERED_BYTES) {
				diagnostic("backpressure", details);
				res.destroy();
				return false;
			}
			return true;
		};

		const lastIdRaw = req.headers["last-event-id"] ?? req.query.lastEventId;
		const lastEventId =
			typeof lastIdRaw === "string" && /^\d+$/.test(lastIdRaw) ? Number.parseInt(lastIdRaw, 10) : undefined;
		diagnostic("connect", { cursor: lastEventId });
		if (!guardedWrite(":ok\n\n", { kind: "handshake" })) return;
		// Unnumbered connection metadata lets a browser correlate optional,
		// payload-free diagnostics without mutating its application SSE cursor.
		const issuedAt = Date.now();
		for (const [id, record] of diagnosticConnections) {
			if (issuedAt - record.issuedAt > CLIENT_DIAGNOSTIC_CONNECTION_TTL_MS) diagnosticConnections.delete(id);
		}
		diagnosticConnections.set(connectionId, { issuedAt });
		if (!guardedWrite(`event: connection\ndata: ${JSON.stringify({ connectionId })}\n\n`, { kind: "connection" }))
			return;
		let detach = () => {};
		let keepAlive: ReturnType<typeof setInterval> | undefined;
		const stop = () => {
			if (keepAlive) clearInterval(keepAlive);
			detach();
		};
		let usable = true;
		detach = hub.attach(
			{
				write: (chunk, metadata) => {
					if (!metadata) return false;
					usable = guardedWrite(chunk, metadata);
					return usable;
				},
			},
			lastEventId,
			(replay) => diagnostic(replay.kind, replay),
		);
		// A rejected/destroyed replay must not leave a timer or live client behind.
		if (!usable) return;
		// Named heartbeats are visible to EventSource but have no id, so they do
		// not alter the application cursor or consume replay history.
		keepAlive = setInterval(() => {
			if (!guardedWrite(formatHeartbeatFrame(), { kind: "heartbeat" })) stop();
		}, options.heartbeatIntervalMs ?? 25_000);
		req.on("close", () => {
			diagnostic("close", { writableLength: res.writableLength });
			stop();
		});
	});

	// -- optional client stream diagnostics -----------------------------------
	app.post("/api/events/diagnostic", (req, res) => {
		const declaredLength = Number(req.headers["content-length"] ?? 0);
		const encodedBytes = Buffer.byteLength(JSON.stringify(req.body ?? null));
		if (declaredLength > MAX_CLIENT_DIAGNOSTIC_BYTES || encodedBytes > MAX_CLIENT_DIAGNOSTIC_BYTES) {
			res.status(413).json({ error: "Diagnostic summary exceeds the 4 KiB limit" });
			return;
		}
		if (!isClientDiagnostic(req.body)) {
			res.status(400).json({ error: "Invalid diagnostic summary" });
			return;
		}
		const now = Date.now();
		for (const [id, record] of diagnosticConnections) {
			if (now - record.issuedAt > CLIENT_DIAGNOSTIC_CONNECTION_TTL_MS) diagnosticConnections.delete(id);
		}
		const record = diagnosticConnections.get(req.body.connectionId);
		if (!record) {
			res.status(400).json({ error: "Unknown or expired SSE connection" });
			return;
		}
		if (record.lastAt !== undefined && now - record.lastAt < CLIENT_DIAGNOSTIC_RATE_LIMIT_MS) {
			res.status(429).json({ error: "Diagnostic summary rate limited" });
			return;
		}
		record.lastAt = now;
		// Never log the request body wholesale. The schema is intentionally only
		// connection metadata, and this explicit projection prevents future fields
		// from accidentally turning diagnostics into a payload side-channel.
		log(
			`sse ${JSON.stringify({
				connectionId: req.body.connectionId,
				kind: "client_diagnostic",
				state: req.body.state,
				previousState: req.body.previousState,
				attempt: req.body.attempt,
				delayMs: req.body.delayMs,
				visibility: req.body.visibility,
				lastAppliedSeq: req.body.lastAppliedSeq,
				heartbeatAgeMs: req.body.heartbeatAgeMs,
				eventCount: req.body.eventCount,
				eventRatePerMinute: req.body.eventRatePerMinute,
				processingLagTotalMs: req.body.processingLagTotalMs,
				processingLagMaxMs: req.body.processingLagMaxMs,
			})}`,
		);
		res.json({ ok: true });
	});

	// -- fleet -----------------------------------------------------------------
	const listDiskSessions = async (): Promise<SessionInfoDto[]> =>
		(await options.listAllSessions()).filter((session) => existsSync(session.cwd)).map(toSessionInfoDto);

	const currentCwdInventory = async (): Promise<string[]> => [
		...pool.list().map((handle) => handle.cwd),
		...(await listDiskSessions()).map((session) => session.cwd),
	];

	const handleMemoryError = (res: Response, err: unknown): void => {
		const status =
			typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
		res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
	};

	app.get("/api/memories/scopes", (_req, res) => {
		currentCwdInventory()
			.then((inventory) => memories.scopes(inventory))
			.then((scopes) => res.json({ scopes }))
			.catch((err) => handleMemoryError(res, err));
	});

	app.get("/api/memories/:scopeId", (req, res) => {
		currentCwdInventory()
			.then((inventory) => memories.listing(req.params.scopeId, inventory))
			.then((listing) => res.json(listing))
			.catch((err) => handleMemoryError(res, err));
	});

	app.get("/api/memories/:scopeId/documents/:file", (req, res) => {
		currentCwdInventory()
			.then((inventory) => memories.readDocument(req.params.scopeId, req.params.file, inventory))
			.then((document) => res.json(document))
			.catch((err) => handleMemoryError(res, err));
	});

	app.put("/api/memories/:scopeId/documents/:file", (req, res) => {
		currentCwdInventory()
			.then((inventory) => memories.saveDocument(req.params.scopeId, req.params.file, req.body, inventory))
			.then((result) => res.json(result))
			.catch((err) => handleMemoryError(res, err));
	});

	app.delete("/api/memories/:scopeId/entries/:file", (req, res) => {
		currentCwdInventory()
			.then((inventory) => memories.deleteEntry(req.params.scopeId, req.params.file, req.body, inventory))
			.then((result) => res.json(result))
			.catch((err) => handleMemoryError(res, err));
	});

	const getFleet = async (): Promise<FleetDto> => {
		const runtimes = await Promise.all(pool.list().map((h) => pool.describe(h)));
		return { runtimes, diskSessions: await listDiskSessions() };
	};

	/** Map the one-RPC parent snapshot consistently for recovery and drill-in hydration. */
	const toRuntimeHydration = (snapshot: DashboardRuntimeSnapshot): RuntimeHydrationDto => ({
		key: snapshot.key,
		state: snapshot.snapshot.state,
		messages: images.project(snapshot.snapshot.messages, { runtimeKey: snapshot.key }),
		backgroundAgents: snapshot.snapshot.backgroundAgents,
		pendingExtensionUiRequests: snapshot.snapshot.pendingExtensionUiRequests ?? [],
		barrierSeq: snapshot.barrierSeq,
	});

	app.get("/api/fleet", (_req, res) => {
		const startedAt = Date.now();
		getFleet()
			.then((fleet) => {
				// Serialize once so the diagnostic reports the exact JSON response size
				// without retaining or logging any fleet payload fields.
				const body = JSON.stringify(fleet);
				const diagnostic = {
					elapsedMs: Date.now() - startedAt,
					encodedBytes: Buffer.byteLength(body),
					runtimeCount: fleet.runtimes.length,
					diskSessionCount: fleet.diskSessions.length,
				};
				res.type("json").send(body);
				log(`fleet ${JSON.stringify(diagnostic)}`);
			})
			.catch((err) => res.status(500).json({ error: String(err?.message ?? err) }));
	});

	/** On-disk inventory only; does not query or describe live runtimes. */
	app.get("/api/sessions", (_req, res) => {
		listDiskSessions()
			.then((sessions) => {
				const body: SessionInventoryDto = { sessions };
				res.json(body);
			})
			.catch((err) => res.status(500).json({ error: String(err?.message ?? err) }));
	});

	/**
	 * Full recovery snapshot. For an active runtime, its RPC marker captures the
	 * current EventHub sequence before the response; later publications have a
	 * higher sequence. This is an ordering contract, not a timing heuristic.
	 */
	app.get("/api/resync", (req, res) => {
		(async () => {
			const activeKey = typeof req.query.key === "string" ? req.query.key : undefined;
			const activeAgentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
			let active: DashboardResyncDto["active"];
			let barrierSeq: number;
			if (activeKey) {
				const handle = pool.get(activeKey);
				if (!handle) {
					const body: DashboardResyncDto = { fleet: await getFleet(), barrierSeq: hub.currentSequence };
					res.json(body);
					return;
				}
				// The disk transcript has its own sequence boundary because it is read
				// before the parent RPC snapshot. Relays between these two barriers must
				// be reapplied so a subagent delta cannot disappear during recovery.
				let preBarrierSubagent: NonNullable<ActiveRuntimeSnapshotDto["subagent"]> | undefined;
				if (activeAgentId) {
					const agents = await handle.client.listBackgroundAgents();
					const agent = agents.find((candidate) => candidate.agentId === activeAgentId);
					if (!agent) throw new Error(`No background agent ${activeAgentId} in this runtime`);
					const messages = readSubagentMessages(agent);
					preBarrierSubagent = {
						agentId: activeAgentId,
						agent,
						messages: images.project(messages, { runtimeKey: activeKey, agentId: activeAgentId }),
						barrierSeq: hub.currentSequence,
					};
				}
				const snapshot = await pool.snapshotDashboard(handle);
				barrierSeq = snapshot.barrierSeq;
				active = {
					...toRuntimeHydration(snapshot),
					...(preBarrierSubagent ? { subagent: preBarrierSubagent } : {}),
				};
			} else {
				barrierSeq = hub.currentSequence;
			}
			const body: DashboardResyncDto = { fleet: await getFleet(), ...(active ? { active } : {}), barrierSeq };
			res.json(body);
		})().catch((err) => res.status(502).json({ error: String(err?.message ?? err) }));
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
				images.removeRuntime(String(req.params.key));
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

	/**
	 * Atomic drill-in snapshot. snapshotDashboard performs exactly one RPC and
	 * consumes its marker barrier, so no independently-read runtime fields can
	 * describe different moments in a live turn.
	 */
	app.get("/api/runtimes/:key/hydrate", (req, res) => {
		withRuntime(req, res, async (h) => toRuntimeHydration(await pool.snapshotDashboard(h)));
	});

	app.get("/api/runtimes/:key/messages", (req, res) => {
		withRuntime(req, res, async (h) => ({
			messages: images.project(await h.client.getMessages(), { runtimeKey: h.key }),
		}));
	});

	const sendImage = async (
		req: Request,
		res: Response,
		scope: DashboardImageScope,
		variant: "preview" | "original",
		loadAuthoritative: () => Promise<unknown>,
	): Promise<void> => {
		const id = String(req.params.id);
		if (!DASHBOARD_IMAGE_ID_PATTERN.test(id)) {
			res.status(400).json({ error: "Invalid dashboard image ID" });
			return;
		}
		try {
			const image =
				variant === "preview"
					? await images.preview(scope, id, loadAuthoritative)
					: await images.original(scope, id, loadAuthoritative);
			res.set({
				"Content-Type": image.mimeType,
				"Content-Length": String(image.bytes.byteLength),
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "private, max-age=31536000, immutable",
			});
			res.send(Buffer.from(image.bytes));
		} catch (error) {
			if (error instanceof DashboardImageNotFoundError) {
				res.status(404).json({ error: error.message });
			} else if (error instanceof DashboardImagePreviewError) {
				res.status(422).json({ error: error.message });
			} else {
				res.status(502).json({
					error: `Image source unavailable: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
	};

	app.get("/api/runtimes/:key/images/:id/:variant", (req, res) => {
		const key = String(req.params.key);
		const variant = String(req.params.variant);
		if (variant !== "preview" && variant !== "original") {
			res.status(404).json({ error: "Unknown dashboard image variant" });
			return;
		}
		const handle = pool.get(key);
		if (!handle) {
			res.status(404).json({ error: `No runtime ${key}` });
			return;
		}
		void sendImage(req, res, { runtimeKey: key }, variant, () => handle.client.getMessages());
	});

	app.get("/api/runtimes/:key/subagents/:agentId/images/:id/:variant", (req, res) => {
		const key = String(req.params.key);
		const agentId = String(req.params.agentId);
		const variant = String(req.params.variant);
		if (variant !== "preview" && variant !== "original") {
			res.status(404).json({ error: "Unknown dashboard image variant" });
			return;
		}
		const handle = pool.get(key);
		if (!handle) {
			res.status(404).json({ error: `No runtime ${key}` });
			return;
		}
		void sendImage(req, res, { runtimeKey: key, agentId }, variant, async () => {
			const agents = await handle.client.listBackgroundAgents();
			const agent = agents.find((candidate) => candidate.agentId === agentId);
			if (!agent) throw new DashboardImageNotFoundError(`No background agent ${agentId} in this runtime`);
			return readSubagentMessages(agent);
		});
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

	app.post("/api/runtimes/:key/new-session", (req, res) => {
		withRuntime(req, res, (h) => h.client.newSession());
	});

	app.post("/api/runtimes/:key/reload", (req, res) => {
		withRuntime(req, res, async (h) => {
			await h.client.reload();
			return { ok: true };
		});
	});

	app.post("/api/runtimes/:key/dream", (req, res) => {
		const args = typeof req.body?.args === "string" ? req.body.args : undefined;
		withRuntime(req, res, (h) => h.client.dream(args));
	});

	app.post("/api/runtimes/:key/import", (req, res) => {
		const inputPath = typeof req.body?.inputPath === "string" ? req.body.inputPath.trim() : "";
		if (!inputPath) {
			res.status(400).json({ error: "inputPath is required" });
			return;
		}
		withRuntime(req, res, (h) => h.client.importJsonl(inputPath));
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

	app.post("/api/runtimes/:key/fork-current", (req, res) => {
		withRuntime(req, res, (h) => h.client.forkCurrent());
	});

	app.get("/api/runtimes/:key/tree", (req, res) => {
		withRuntime(req, res, (h) => h.client.getTree());
	});

	app.post("/api/runtimes/:key/tree", (req, res) => {
		const targetId = typeof req.body?.targetId === "string" ? req.body.targetId : "";
		if (!targetId) {
			res.status(400).json({ error: "targetId is required" });
			return;
		}
		withRuntime(req, res, (h) => h.client.navigateTree(targetId));
	});

	app.get("/api/runtimes/:key/sessions", (req, res) => {
		withRuntime(req, res, async (h) => ({ sessions: await h.client.listSessions() }));
	});

	app.post("/api/runtimes/:key/resume", (req, res) => {
		const sessionPath = typeof req.body?.sessionPath === "string" ? req.body.sessionPath : "";
		if (!sessionPath) {
			res.status(400).json({ error: "sessionPath is required" });
			return;
		}
		withRuntime(req, res, (h) => h.client.switchSession(sessionPath));
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
			let messages: unknown[];
			try {
				messages = readSubagentMessages(agent);
			} catch (error) {
				const failedBeforeSpawn =
					agent.arbitrations !== undefined &&
					agent.arbitrations.length > 0 &&
					agent.arbitrations.every((record) => record.status === "failure");
				if (!(error instanceof SubagentSessionLogNotFoundError) || !failedBeforeSpawn) throw error;
				messages = [];
			}
			return { agent, messages: images.project(messages, { runtimeKey: h.key, agentId }) };
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
				hub.publish("", { type: "disk_sessions_changed" });
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

	function optionalSettingsCwd(req: Request, res: Response): string | undefined | null {
		if (req.query.cwd === undefined) return undefined;
		if (typeof req.query.cwd !== "string" || !req.query.cwd.trim()) {
			res.status(400).json({ error: "cwd must be a non-empty path" });
			return null;
		}
		if (!existsSync(req.query.cwd)) {
			res.status(400).json({ error: `cwd does not exist: ${req.query.cwd}` });
			return null;
		}
		try {
			if (!statSync(req.query.cwd).isDirectory()) {
				res.status(400).json({ error: `cwd is not a directory: ${req.query.cwd}` });
				return null;
			}
		} catch (error) {
			res.status(400).json({ error: `cannot access cwd ${req.query.cwd}: ${(error as Error).message}` });
			return null;
		}
		return req.query.cwd;
	}

	app.get("/api/settings", (req, res) => {
		const cwd = optionalSettingsCwd(req, res);
		if (cwd === null) return;
		withAnyRuntime(res, (h) => h.client.getSettings(), cwd);
	});

	app.get("/api/settings/models", (req, res) => {
		const cwd = optionalSettingsCwd(req, res);
		if (cwd === null) return;
		withAnyRuntime(res, async (h) => ({ models: await h.client.getAvailableModels() }), cwd);
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
		const cwd = optionalSettingsCwd(req, res);
		if (cwd === null) return;
		withAnyRuntime(res, (h) => h.client.setSettings(req.body ?? {}), cwd);
	});

	app.get("/api/version", (_req, res) => {
		withAnyRuntime(res, async (h) => ({ version: await h.client.getVersion() }));
	});

	app.post("/api/settings/remove-trusted", (req, res) => {
		const rawPath = typeof req.body?.path === "string" ? req.body.path : "";
		if (!rawPath) {
			res.status(400).json({ error: "path is required" });
			return;
		}
		pool
			.ensureUtilityRuntime()
			.then(async (handle) => {
				const result = await handle.client.removeTrustedContextFolder(rawPath);
				log(`context trust configured remove: ${rawPath}`);
				res.json(result);
			})
			.catch((err) => res.status(err?.status ?? 502).json({ error: String(err?.message ?? err) }));
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
			.then(async (listing) => {
				const handle = await pool.ensureUtilityRuntime();
				const contextTrust = await handle.client.evaluateContextTrust(listing.path);
				res.json({ ...listing, contextTrust });
			})
			.catch((err) => res.status(err?.status ?? 502).json({ error: String(err?.message ?? err) }));
	});

	function contextTrustMutation(
		req: Request,
		res: Response,
		operation: "trustContextFolder" | "untrustContextFolder",
	): void {
		const rawPath = typeof req.body?.path === "string" ? req.body.path : "";
		if (!rawPath) {
			res.status(400).json({ error: "path is required" });
			return;
		}
		files
			.resolveDirectory(rawPath)
			.then(async (path) => {
				const handle = await pool.ensureUtilityRuntime();
				const result = await handle.client[operation](path);
				log(`context trust ${operation === "trustContextFolder" ? "add" : "remove"}: ${path}`);
				res.json(result);
			})
			.catch((err) => res.status(err?.status ?? 502).json({ error: String(err?.message ?? err) }));
	}

	app.post("/api/files/trust", (req, res) => contextTrustMutation(req, res, "trustContextFolder"));
	app.post("/api/files/untrust", (req, res) => contextTrustMutation(req, res, "untrustContextFolder"));

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
