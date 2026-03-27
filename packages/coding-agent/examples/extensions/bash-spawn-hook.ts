/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   dreb -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@dreb/coding-agent";
import { createBashTool } from "@dreb/coding-agent";

export default function (dreb: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, DREB_SPAWN_HOOK: "1" },
		}),
	});

	dreb.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
