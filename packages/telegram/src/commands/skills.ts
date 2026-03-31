/**
 * Skills slash command: /skills — list available skills from the agent.
 */

import type { Context } from "grammy";
import type { AgentBridge } from "../agent-bridge.js";
import { ensureBridge } from "../bridge-lifecycle.js";
import type { Config } from "../config.js";
import type { UserState } from "../types.js";
import { safeSend } from "../util/telegram.js";

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
			const desc = skill.description ? ` — ${skill.description.slice(0, 100)}` : "";
			lines.push(`• \`${name}\`${desc}`);
		}
		lines.push('\n_Invoke via the skill tool in conversation, e.g. "use the X skill"_');

		await safeSend(ctx.api, chatId, lines.join("\n"));
	} catch (e) {
		await safeSend(ctx.api, chatId, `❌ Failed to list skills: ${e}`);
	}
}
