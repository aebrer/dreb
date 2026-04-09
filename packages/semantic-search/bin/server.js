#!/usr/bin/env node

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");

// Auto-install dependencies if missing (e.g. after plugin cache extraction).
if (!existsSync(resolve(packageRoot, "node_modules"))) {
	execFileSync("npm", ["install"], { cwd: packageRoot, stdio: "inherit" });
}

// Project directory: CLI arg if provided, otherwise CWD.
// Claude Code launches MCP servers with CWD set to the project root,
// so no argument is needed for typical usage.
const projectDir = resolve(process.argv[2] || ".");

const { startServer } = await import("../dist/mcp-server.js");
startServer(projectDir).catch((err) => {
	console.error("Failed to start MCP server:", err);
	process.exit(1);
});
