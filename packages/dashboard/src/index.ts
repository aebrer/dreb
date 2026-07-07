#!/usr/bin/env node
/**
 * dreb-dashboard — launch the dreb web dashboard server.
 *
 * Modes (SPEC.md §6 — exactly two, no LAN mode):
 *   default        loopback bind (127.0.0.1), no auth, no Tailscale needed
 *   --remote       requires Tailscale; binds all interfaces but every request
 *                  passes identity allowlist + PIN pairing + device cookies
 *
 * Usage:
 *   dreb-dashboard [--port 5343] [--remote --allow me@example.com [--allow ...]]
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DashboardAuth } from "./server/auth.js";
import { FilePairingStorage } from "./server/pairing-storage.js";
import { RuntimePool } from "./server/runtime-pool.js";
import { createDashboardServer } from "./server/server.js";

export { DashboardAuth, TailscaleStatusResolver } from "./server/auth.js";
export { EventHub } from "./server/event-hub.js";
export { canonicalizePath, FileApi } from "./server/files.js";
export { FilePairingStorage } from "./server/pairing-storage.js";
export { RuntimePool, resolveDrebCliPath } from "./server/runtime-pool.js";
export { createDashboardServer, parseDeviceCookie } from "./server/server.js";
export type * from "./shared/protocol.js";

const DEFAULT_PORT = 5343;

interface CliArgs {
	port: number;
	remote: boolean;
	allow: string[];
	help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { port: DEFAULT_PORT, remote: false, allow: [], help: false };
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
		} else if (arg === "--help" || arg === "-h") {
			args.help = true;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (args.remote && args.allow.length === 0) {
		throw new Error("--remote requires at least one --allow <tailscale-login> (empty allowlist denies everyone)");
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

	const auth = new DashboardAuth({
		remoteEnabled: args.remote,
		allowedIdentities: args.allow,
		storage: new FilePairingStorage(join(homedir(), ".dreb", "agent", "dashboard-pairings.json")),
	});
	const pool = new RuntimePool();

	// Static client assets live next to the compiled server (dist/static).
	const staticDir = join(dirname(fileURLToPath(import.meta.url)), "static");

	const { SessionManager } = await import("@dreb/coding-agent");
	const app = createDashboardServer({
		auth,
		pool,
		staticDir: existsSync(staticDir) ? staticDir : undefined,
		listAllSessions: () => SessionManager.listAll(),
		deleteSession: async (path: string) => {
			const result = await SessionManager.deleteSession(path, {});
			if (!result.ok) throw new Error(result.error ?? "Unknown deletion error");
			return { method: result.method };
		},
	});

	const host = args.remote ? "0.0.0.0" : "127.0.0.1";
	const server = app.listen(args.port, host, () => {
		console.log(`dreb dashboard listening on http://${host === "0.0.0.0" ? "<tailscale-ip>" : host}:${args.port}`);
		if (args.remote) {
			console.log(`remote mode: allowed identities = ${args.allow.join(", ")}`);
			const { pin, expiresAt } = auth.generatePin();
			console.log(`pairing PIN: ${pin} (single-use, expires ${expiresAt})`);
			console.log("new devices must enter this PIN; generate a fresh one by restarting");
		} else {
			console.log("local mode: loopback only — use --remote for Tailscale access");
		}
	});

	const shutdown = () => {
		console.log("shutting down…");
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
