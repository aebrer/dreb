/**
 * Dynamic command menu refresh — queries skills from the agent bridge
 * and registers them as Telegram bot commands alongside the static ones.
 */

import type { Bot } from "grammy";
import type { AgentBridge } from "../agent-bridge.js";
import { log } from "../util/telegram.js";

/** Static bot commands — always present in the command menu */
export const STATIC_COMMANDS: Array<{ command: string; description: string }> = [
	{ command: "start", description: "Help & command list" },
	{ command: "status", description: "Connection & version info" },
	{ command: "new", description: "Start fresh session [optional: path]" },
	{ command: "sessions", description: "List recent sessions" },
	{ command: "resume", description: "Resume a session by ID" },
	{ command: "recent", description: "Resend last N messages" },
	{ command: "skills", description: "List available skills" },
	{ command: "stats", description: "Token usage & cost" },
	{ command: "compact", description: "Compact context" },
	{ command: "model", description: "View/switch model" },
	{ command: "thinking", description: "View/set thinking level" },
	{ command: "agents", description: "Background subagents" },
	{ command: "cwd", description: "Working directory" },
	{ command: "analysis", description: "Session analysis report [optional: split date]" },
	{ command: "stop", description: "Interrupt current task" },
	{ command: "restart", description: "Restart the bot" },
	{ command: "buddy", description: "Hatch or manage your companion" },
];

/**
 * Refresh the Telegram command menu with dynamic skill commands.
 * Queries the bridge for available skills and adds them as /skill_<name> commands.
 * Call after bridge startup or when the working directory changes.
 */
export async function refreshCommandsWithSkills(bot: Bot, bridge: AgentBridge): Promise<void> {
	try {
		const commands = await bridge.getCommands();
		const skills = commands.filter((c: any) => c.source === "skill");

		if (skills.length === 0) {
			// No skills — just use static commands
			await bot.api.setMyCommands(STATIC_COMMANDS);
			return;
		}

		// Map skill names to Telegram-safe command names
		// skill:reddit-reader → skill_reddit_reader
		const skillCommands = skills.map((s: any) => {
			const name = s.name.replace("skill:", "").replace(/-/g, "_");
			const desc = s.description ? s.description.slice(0, 200) : `Invoke ${s.name} skill`;
			return { command: `skill_${name}`, description: desc };
		});

		// Telegram limits to 100 commands — static + skills should be well under
		const allCommands = [...STATIC_COMMANDS, ...skillCommands];
		await bot.api.setMyCommands(allCommands);
		log(`[BOT] Registered ${STATIC_COMMANDS.length} static + ${skillCommands.length} skill commands with Telegram`);
	} catch (e) {
		log(`[BOT] Failed to refresh commands with skills: ${e}`);
	}
}
