/**
 * Register all slash commands with the bot and Telegram's command menu.
 */

import type { Bot } from "grammy";
import type { Config } from "../config.js";
import type { UserState } from "../types.js";
import { log } from "../util/telegram.js";
import { cmdAgents, cmdCompact, cmdModel, cmdStats, cmdThinking } from "./agent.js";
import { cmdCwd, cmdNew, cmdRestart, cmdStart, cmdStatus, cmdStop } from "./core.js";
import { cmdRecent, cmdResume, cmdSessions } from "./sessions.js";
import { cmdSkills } from "./skills.js";

/**
 * Register all command handlers on the bot.
 */
export function registerCommands(bot: Bot, config: Config, getUserState: (userId: number) => UserState): void {
	bot.command("start", (ctx) => cmdStart(ctx));

	bot.command("status", (ctx) => {
		const us = getUserState(ctx.from!.id);
		return cmdStatus(ctx, config, us);
	});

	bot.command("cwd", (ctx) => cmdCwd(ctx, config));

	bot.command("new", (ctx) => {
		const us = getUserState(ctx.from!.id);
		const args = ctx.match as string;
		return cmdNew(ctx, us, args);
	});

	bot.command("stop", (ctx) => {
		const us = getUserState(ctx.from!.id);
		return cmdStop(ctx, ctx.api, us);
	});

	bot.command("restart", (ctx) => cmdRestart(ctx, config));

	bot.command("sessions", (ctx) => {
		const us = getUserState(ctx.from!.id);
		return cmdSessions(ctx, us, config);
	});

	bot.command("resume", (ctx) => {
		const us = getUserState(ctx.from!.id);
		const args = ctx.match as string;
		return cmdResume(ctx, us, args, config);
	});

	bot.command("recent", (ctx) => {
		const us = getUserState(ctx.from!.id);
		const args = ctx.match as string;
		return cmdRecent(ctx, us, args, config);
	});

	bot.command("skills", (ctx) => {
		const us = getUserState(ctx.from!.id);
		return cmdSkills(ctx, us, config);
	});

	bot.command("compact", (ctx) => {
		const us = getUserState(ctx.from!.id);
		return cmdCompact(ctx, us);
	});

	bot.command("agents", (ctx) => {
		const us = getUserState(ctx.from!.id);
		return cmdAgents(ctx, us);
	});

	bot.command("stats", (ctx) => {
		const us = getUserState(ctx.from!.id);
		return cmdStats(ctx, us);
	});

	bot.command("model", (ctx) => {
		const us = getUserState(ctx.from!.id);
		const args = ctx.match as string;
		return cmdModel(ctx, us, args);
	});

	bot.command("thinking", (ctx) => {
		const us = getUserState(ctx.from!.id);
		const args = ctx.match as string;
		return cmdThinking(ctx, us, args);
	});
}

/**
 * Register commands with Telegram's autocomplete menu.
 */
export async function setMyCommands(bot: Bot): Promise<void> {
	try {
		await bot.api.setMyCommands([
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
			{ command: "stop", description: "Interrupt & clear queue" },
			{ command: "restart", description: "Restart the bot" },
		]);
		log("[BOT] Registered commands with Telegram");
	} catch (e) {
		log(`[BOT] Failed to set commands: ${e}`);
	}
}
