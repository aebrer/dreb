#!/usr/bin/env node

import { resolve } from "node:path";
import { startServer } from "../dist/mcp-server.js";

// Project directory: CLI arg if provided, otherwise CWD.
// Claude Code launches MCP servers with CWD set to the project root,
// so no argument is needed for typical usage.
const projectDir = resolve(process.argv[2] || ".");

startServer(projectDir).catch((err) => {
	console.error("Failed to start MCP server:", err);
	process.exit(1);
});
