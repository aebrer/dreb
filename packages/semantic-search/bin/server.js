#!/usr/bin/env node

import { resolve } from "node:path";
import { startServer } from "../dist/mcp-server.js";

const projectDir = process.argv[2];

if (!projectDir) {
	console.error("Usage: semantic-search-mcp <project-directory>");
	console.error("\nStarts an MCP stdio server for semantic codebase search.");
	console.error("\nExample:");
	console.error("  claude mcp add semantic-search -- node /path/to/bin/server.js /path/to/project");
	process.exit(1);
}

startServer(resolve(projectDir)).catch((err) => {
	console.error("Failed to start MCP server:", err);
	process.exit(1);
});
