#!/usr/bin/env node
/** Source-only launcher for this downstream; never installs, builds or changes profiles. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cli = new URL("../packages/coding-agent/dist/cli.js", import.meta.url);
if (!existsSync(cli)) {
	console.error("dreb-cloud: compiled CLI missing. Build and validate this checkout first; see CLOUD-WORKSPACES-MAINTENANCE.md.");
	process.exit(1);
}

// Subagent startup captures argv[1]; descendants must use the matching compiled CLI.
process.argv[1] = fileURLToPath(cli);
await import(cli.href);
