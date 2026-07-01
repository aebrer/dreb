#!/usr/bin/env node

import { DashboardAuth } from "./auth.js";
import { FileApi } from "./files.js";
import { createDashboardServer } from "./server.js";

export { DashboardAuth, isLoopbackAddress, TailscaleStatusResolver } from "./auth.js";
export { FileApi } from "./files.js";
export { DashboardRuntime, DashboardRuntimePool, runtimeId } from "./runtime.js";
export { createDashboardServer } from "./server.js";
export { SessionApi } from "./sessions.js";

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = parseArgs(process.argv.slice(2));
	const host = args.host ?? "127.0.0.1";
	const port = Number(args.port ?? 3762);
	const remoteEnabled = args.remote === "true" || args.remote === "1" || args.remote === "yes";
	const auth = new DashboardAuth({
		remoteEnabled,
		agentDir: args.agentDir,
		allowedIdentities: parseCsv(args.allowedIdentity ?? args.allowedIdentities),
		allowedDevices: parseCsv(args.allowedDevice ?? args.allowedDevices),
	});
	const pin = remoteEnabled ? auth.generatePin() : null;
	const server = createDashboardServer({
		auth,
		files: new FileApi({ cwd: args.cwd ?? process.cwd() }),
	});
	server.listen(port, host, () => {
		const address = server.address();
		const bound = typeof address === "object" && address ? `${address.address}:${address.port}` : `${host}:${port}`;
		console.log(`dreb dashboard listening on http://${bound}`);
		if (pin) console.log(`remote pairing PIN: ${pin.pin} (expires ${pin.expiresAt})`);
	});
}

function parseArgs(args: string[]): Record<string, string | undefined> {
	const parsed: Record<string, string | undefined> = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith("--")) continue;
		const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
		parsed[rawKey] = inlineValue ?? args[++i] ?? "true";
	}
	return parsed;
}

function parseCsv(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}
