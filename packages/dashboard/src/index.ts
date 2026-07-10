#!/usr/bin/env node
/**
 * dreb-dashboard — launch the dreb web dashboard server.
 *
 * Modes (exactly two, no LAN mode):
 *   default        loopback bind (127.0.0.1), no auth, no Tailscale needed
 *   --remote       requires Tailscale; binds all interfaces but every request
 *                  passes identity allowlist + pairing code + device cookies
 *
 * Usage:
 *   dreb-dashboard [--port 5343] [--remote --allow me@example.com [--allow ...]]
 */

import { existsSync, readFileSync, watch } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DashboardAuth } from "./server/auth.js";
import { FilePairingStorage, loadOrCreateDashboardSecret } from "./server/pairing-storage.js";
import { RuntimePool } from "./server/runtime-pool.js";
import { createDashboardServer } from "./server/server.js";

export { DashboardAuth, TailscaleStatusResolver } from "./server/auth.js";
export { EventHub } from "./server/event-hub.js";
export { canonicalizePath, FileApi } from "./server/files.js";
export { FilePairingStorage, loadOrCreateDashboardSecret } from "./server/pairing-storage.js";
export { RuntimePool, resolveDrebCliPath } from "./server/runtime-pool.js";
export { createDashboardServer, parseDeviceCookie } from "./server/server.js";
export type * from "./shared/protocol.js";

const DEFAULT_PORT = 5343;

interface CliArgs {
	port: number;
	remote: boolean;
	allow: string[];
	help: boolean;
	https: boolean;
	cert?: string;
	key?: string;
}

export function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { port: DEFAULT_PORT, remote: false, allow: [], help: false, https: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--port") {
			const value = argv[++i];
			const port = Number.parseInt(value ?? "", 10);
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				throw new Error(`Invalid --port value: ${value}`);
			}
			args.port = port;
		} else if (arg === "--remote") {
			args.remote = true;
		} else if (arg === "--allow") {
			const value = argv[++i];
			if (!value) throw new Error("--allow requires an identity (Tailscale login name)");
			args.allow.push(value);
		} else if (arg === "--https") {
			args.https = true;
		} else if (arg === "--cert") {
			const value = argv[++i];
			if (!value) throw new Error("--cert requires a path to a PEM certificate file");
			args.cert = value;
		} else if (arg === "--key") {
			const value = argv[++i];
			if (!value) throw new Error("--key requires a path to a PEM private key file");
			args.key = value;
		} else if (arg === "--help" || arg === "-h") {
			args.help = true;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (args.remote && args.allow.length === 0) {
		throw new Error("--remote requires at least one --allow <tailscale-login> (empty allowlist denies everyone)");
	}
	// Native TLS. `https` is opt-in; it requires cert AND key (no silent
	// fallback to plain HTTP). The dashboard terminates TLS itself — no reverse
	// proxy, no auth-model change. `req.socket.remoteAddress` stays the real
	// tailnet IP, so identity resolution + allowlist + pairing keep working.
	if (args.https) {
		if (!args.cert) throw new Error("--https requires --cert <path>");
		if (!args.key) throw new Error("--https requires --key <path>");
	}
	return args;
}

const HELP = `dreb-dashboard — dreb web dashboard server

Usage: dreb-dashboard [options]

Options:
  --port <n>          Port to listen on (default ${DEFAULT_PORT})
  --remote            Enable remote mode (requires Tailscale). Without this
                      flag the server binds 127.0.0.1 only — no LAN access.
  --allow <identity>  Tailscale login name allowed to pair (repeatable;
                      required with --remote)
  --https             Terminate TLS on the dashboard itself (native TLS). No
                      reverse proxy, no auth-model change. Requires --cert
                      and --key. Mainly for --remote (loopback is already a
                      secure context): use 'tailscale cert' files for a
                      tailnet hostname so mobile PWAs + notifications work.
                      NOTE: with --https the server speaks TLS only, so the
                      host's plain-http local tab (http://127.0.0.1) stops
                      working — use the tailnet hostname (https://...) there.
  --cert <path>       PEM certificate file (required with --https)
  --key <path>        PEM private key file (required with --https)
  --help              Show this help
`;

async function main(): Promise<void> {
	let args: CliArgs;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
		console.error(HELP);
		process.exit(1);
	}
	if (args.help) {
		console.log(HELP);
		return;
	}

	const agentDir = join(homedir(), ".dreb", "agent");
	const auth = new DashboardAuth({
		remoteEnabled: args.remote,
		allowedIdentities: args.allow,
		storage: new FilePairingStorage(join(agentDir, "dashboard-pairings.json")),
		secret: loadOrCreateDashboardSecret(join(agentDir, "dashboard-auth-secret")),
		logger: (line) => console.warn(`[dashboard-auth] ${line}`),
	});
	const pool = new RuntimePool();

	// Static client assets live next to the compiled server (dist/static).
	const staticDir = join(dirname(fileURLToPath(import.meta.url)), "static");

	// The server's own build version (dist/index.js → ../package.json) — surfaced
	// in the settings footer so a stale long-running service is spottable.
	let serverVersion: string | undefined;
	try {
		const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
		serverVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;
	} catch {
		serverVersion = undefined;
	}

	// Restart hook: exit non-zero so a supervisor (systemd Restart=on-failure,
	// etc.) respawns the process with the freshly-built dist. Assigned the http
	// server below via a mutable holder so the closure can close it first.
	// The TLS hot-reload debounce timer and directory watchers are lifted here
	// too, so onRestart and the shutdown handler can release them (otherwise
	// they leak across restart/exit).
	let httpServer: HttpServer | HttpsServer | undefined;
	let reloadTimer: ReturnType<typeof setTimeout> | undefined;
	const tlsWatchers: ReturnType<typeof watch>[] = [];
	const onRestart = () => {
		console.log("restart requested — exiting for supervisor to respawn");
		if (reloadTimer) clearTimeout(reloadTimer);
		for (const w of tlsWatchers) w.close();
		httpServer?.close();
		pool.stopAll().finally(() => process.exit(1));
	};

	const { SessionManager } = await import("@dreb/coding-agent");
	const app = createDashboardServer({
		auth,
		pool,
		staticDir: existsSync(staticDir) ? staticDir : undefined,
		serverVersion,
		onRestart,
		listAllSessions: () => SessionManager.listAll(),
		deleteSession: async (path: string) => {
			const result = await SessionManager.deleteSession(path, {});
			if (!result.ok) throw new Error(result.error ?? "Unknown deletion error");
			return { method: result.method };
		},
	});

	const host = args.remote ? "0.0.0.0" : "127.0.0.1";
	const scheme = args.https ? "https" : "http";

	// Native TLS: the dashboard terminates TLS itself (no reverse proxy). The
	// auth model is unchanged — `req.socket.remoteAddress` is still the real
	// tailnet IP, so Tailscale identity resolution + allowlist + pairing keep
	// working. Local mode never sets --https (loopback is already a secure
	// context), but it's allowed if the operator wants it.
	let server: HttpServer | HttpsServer;
	if (args.https && args.cert && args.key) {
		let tlsOptions: { cert: string; key: string };
		try {
			tlsOptions = {
				cert: readFileSync(args.cert, "utf-8"),
				key: readFileSync(args.key, "utf-8"),
			};
		} catch (err) {
			console.error(`error: failed to read TLS cert/key: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		}
		const httpsServer = createHttpsServer(tlsOptions, app);
		// Hot-reload the cert on file change (zero-downtime renewal — e.g. a
		// systemd timer rewrites the `tailscale cert` files daily). New
		// connections pick up the new cert; existing ones finish on the old.
		const reloadTls = () => {
			try {
				httpsServer.setSecureContext({
					cert: readFileSync(args.cert!, "utf-8"),
					key: readFileSync(args.key!, "utf-8"),
				});
				console.log("tls certificate reloaded");
			} catch (err) {
				console.warn(`tls reload failed (keeping old cert): ${err instanceof Error ? err.message : String(err)}`);
			}
		};
		// Debounce: cert + key are often rewritten in quick succession. Watch
		// the PARENT DIRECTORY (not each file) and filter by filename: `fs.watch`
		// follows the inode, so an atomic renewal (write temp + rename(2))
		// replaces the inode and a file-level watcher goes silent on the new
		// file after the first reload. A directory watcher survives renames and
		// reports the changed basename via the `filename` callback argument.
		const certBase = basename(args.cert!);
		const keyBase = basename(args.key!);
		for (const dir of new Set([dirname(args.cert!), dirname(args.key!)])) {
			try {
				const watcher = watch(dir, (_event, filename) => {
					// `fs.watch` directory events on macOS (FSEvents) frequently fire
					// with `filename === null`; a strict `!== certBase` filter would
					// reject it and renewals would silently never reload on macOS. When
					// filename is null, fall through and reload anyway — `reloadTls` is
					// idempotent and debounced, so a spurious reload just re-reads the
					// same files. On Linux (inotify) the basename is carried reliably.
					if (filename != null && filename !== certBase && filename !== keyBase) return;
					if (reloadTimer) clearTimeout(reloadTimer);
					reloadTimer = setTimeout(reloadTls, 500);
				});
				watcher.on("error", (err) => {
					console.warn(`tls cert watch error: ${err instanceof Error ? err.message : String(err)}`);
				});
				tlsWatchers.push(watcher);
			} catch (err) {
				console.warn(`tls cert watch setup failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		server = httpsServer;
	} else {
		server = createHttpServer(app);
	}
	server.listen(args.port, host, () => {
		console.log(
			`dreb dashboard listening on ${scheme}://${host === "0.0.0.0" ? "<tailscale-ip>" : host}:${args.port}`,
		);
		if (args.remote) {
			console.log(`remote mode: allowed identities = ${args.allow.join(", ")}`);
			const { code, expiresInMs } = auth.currentPairingCode();
			console.log(
				`pairing code: ${code} (rotates every 30s; current code rolls in ${Math.ceil(expiresInMs / 1000)}s)`,
			);
			console.log("new devices enter this code; see it live in dashboard Settings on the host machine");
		} else {
			console.log("local mode: loopback only — use --remote for Tailscale access");
		}
		if (args.https) {
			console.log("tls: native HTTPS enabled (cert + key hot-reload on file change)");
		}
	});
	httpServer = server;

	const shutdown = () => {
		console.log("shutting down…");
		if (reloadTimer) clearTimeout(reloadTimer);
		for (const w of tlsWatchers) w.close();
		server.close();
		pool.stopAll().finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

// Only run when executed directly (not when imported for the library exports).
const entryPath = process.argv[1];
if (entryPath && import.meta.url === new URL(`file://${entryPath}`).href) {
	main().catch((err) => {
		console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}
