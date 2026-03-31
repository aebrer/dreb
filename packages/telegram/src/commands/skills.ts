/**
 * Skills slash command: /skills — list available skills from the agent.
 * Also refreshes the Telegram command menu with skill-specific commands.
 */

import type { Bot, Context } from "grammy";
import type { AgentBridge } from "../agent-bridge.js";
import { ensureBridge } from "../bridge-lifecycle.js";
import type { Config } from "../config.js";
import type { UserState } from "../types.js";
import { safeSend } from "../util/telegram.js";
import { refreshCommandsWithSkills } from "./refresh.js";

/** Store bot reference so /skills can refresh command menu */
let _bot: Bot | null = null;
export function setSkillsBot(bot: Bot): void {
	_bot = bot;
}

export async function cmdSkills(ctx: Context, userState: UserState, config: Config): Promise<void> {
	const chatId = ctx.chat!.id;

	let bridge: AgentBridge;
	try {
		bridge = await ensureBridge(config, userState);
	} catch (e) {
		await safeSend(ctx.api, chatId, `❌ Failed to start agent: ${e}`);
		return;
	}

	try {
		const commands = await bridge.getCommands();
		const skills = commands.filter((c: any) => c.source === "skill");

		if (skills.length === 0) {
			await safeSend(ctx.api, chatId, "No skills available in the current session.");
			return;
		}

		const lines = ["🛠 *Available Skills*\n"];
		for (const skill of skills) {
			const name = skill.name.replace("skill:", "");
			const safeName = name.replace(/-/g, "_");
			const desc = skill.description ? ` — ${skill.description.slice(0, 100)}` : "";
			lines.push(`• /skill\\_${safeName}${desc}`);
		}
		lines.push("\n_Tap a command above or invoke via conversation_");

		await safeSend(ctx.api, chatId, lines.join("\n"));

		// Also refresh the command menu so skills appear in autocomplete
		if (_bot) {
			await refreshCommandsWithSkills(_bot, bridge);
		}
	} catch (e) {
		await safeSend(ctx.api, chatId, `❌ Failed to list skills: ${e}`);
	}
}
