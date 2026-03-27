#!/usr/bin/env node
/**
 * CLI entry point for the coding agent.
 * Uses main.ts with AgentSession and mode modules.
 *
 * Test with: npx tsx src/cli.ts [args...]
 */
process.title = "dreb";
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { main } from "./main.js";

setGlobalDispatcher(new EnvHttpProxyAgent());

main(process.argv.slice(2));
