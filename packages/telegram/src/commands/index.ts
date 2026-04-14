/**
 * Register all slash commands with the bot and Telegram's command menu.
 */

import type { Bot } from "grammy";
import { ensureBridgeWithSession } from "../bridge-lifecycle.js";
import type { Config } from "../config.js";
import type { UserState } from "../types.js";
import { log, safeSend } from "../util/telegram.js";
import { cmdAgents, cmdCompact, cmdModel, cmdSessionAnalysis, cmdStats, cmdThinking } from "./agent.js";
import { cmdBuddy } from "./buddy.js";
import { cmdCwd, cmdNew, cmdRestart, cmdStart, cmdStatus, cmdStop } from "./core.js";
import { STATIC_COMMANDS } from "./refresh.js";
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

	bot.command("cwd", (ctx) => {
		const us = getUserState(ctx.from!.id);
		return cmdCwd(ctx, config, us);
	});

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

	bot.command("session_analysis", (ctx) => {
		const us = getUserState(ctx.from!.id);
		return cmdSessionAnalysis(ctx, us);
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

	bot.command("buddy", (ctx) => {
		const us = getUserState(ctx.from!.id);
		return cmdBuddy(ctx, config, us);
	});

	// Dynamic skill commands: /skill_<name> [args]
	// Catches any /skill_* command and sends it as a skill invocation prompt
	bot.hears(/^\/skill_([a-z0-9_]+)(?:\s+(.*))?$/i, async (ctx) => {
		const userId = ctx.from!.id;
		const userState = getUserState(userId);
		const chatId = ctx.chat!.id;

		// Convert back from Telegram-safe name to skill name: skill_reddit_reader → reddit-reader
		const rawName = ctx.match[1].replace(/_/g, "-");
		const args = ctx.match[2]?.trim() || "";

		// Ensure bridge is alive and session is selected
		try {
			await ensureBridgeWithSession(config, userState);
		} catch (e) {
			await safeSend(ctx.api, chatId, `❌ Failed to start agent: ${e}`);
			return;
		}

		// Send as a prompt that invokes the skill
		const prompt = args ? `Use the ${rawName} skill: ${args}` : `Use the ${rawName} skill`;

		// Show thinking status
		let statusMsg: { chat_id: number; message_id: number } | null = null;
		try {
			const sent = await ctx.reply("🛠 _Invoking skill..._", { parse_mode: "Markdown" });
			statusMsg = { chat_id: sent.chat.id, message_id: sent.message_id };
		} catch (e) {
			log(`[SKILL] Failed to send status: ${e}`);
		}

		// Import sendPrompt dynamically to avoid circular deps
		const { sendPrompt } = await import("../handlers/message.js");
		sendPrompt(ctx.api, userState, {
			chatId: ctx.chat!.id,
			replyToId: ctx.message!.message_id,
			userId: ctx.from!.id,
			prompt,
			statusMessageId: statusMsg?.message_id ?? null,
		});
	});
}

/**
 * Register commands with Telegram's autocomplete menu (static commands only).
 */
export async function setMyCommands(bot: Bot): Promise<void> {
	try {
		await bot.api.setMyCommands(STATIC_COMMANDS);
		log("[BOT] Registered commands with Telegram");
	} catch (e) {
		log(`[BOT] Failed to set commands: ${e}`);
	}
}

// Re-export for use from other modules
export { refreshCommandsWithSkills } from "./refresh.js";
