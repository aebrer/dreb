/**
 * /buddy command — manage the buddy companion in Telegram.
 */

import { getEnvApiKey } from "@dreb/ai";
import type { Context } from "grammy";
import { ensureBridgeWithSession } from "../bridge-lifecycle.js";
import type { Config } from "../config.js";
import { createTelegramBuddyController, formatBuddyHatch, formatBuddyStats } from "../handlers/buddy.js";
import { enqueueSend } from "../handlers/message.js";
import type { UserState } from "../types.js";
import { safeSend } from "../util/telegram.js";

export async function cmdBuddy(ctx: Context, config: Config, userState: UserState): Promise<void> {
	const chatId = ctx.chat!.id;
	const args = (ctx.match as string)?.trim() ?? "";
	const subcommand = args.split(/\s+/)[0]?.toLowerCase() ?? "";

	// Ensure bridge for model/apiKey access
	let model: any;
	let apiKey: string | undefined;
	try {
		const bridge = await ensureBridgeWithSession(config, userState);
		const state = await bridge.getState();
		model = state?.model;
		if (model?.provider) {
			apiKey = getEnvApiKey(model.provider);
		}
	} catch {
		// Bridge might not be needed for all subcommands (e.g. pet, stats)
	}

	// Get or create buddy controller lazily
	if (!userState.buddyController) {
		const send = (text: string, long?: boolean) => {
			enqueueSend(ctx.api, userState, chatId, text, long);
		};
		userState.buddyController = createTelegramBuddyController(send, ctx.api, chatId);
	}

	const controller = userState.buddyController;
	const result = await controller.handleCommand(subcommand, model, apiKey);

	switch (result.type) {
		case "hatch":
		case "reroll": {
			await safeSend(ctx.api, chatId, formatBuddyHatch(result.state));
			// Heart reaction on the command message
			try {
				await ctx.api.setMessageReaction(chatId, ctx.message!.message_id, [{ type: "emoji", emoji: "❤" }]);
			} catch {
				// Reactions not available in all chats
			}
			break;
		}
		case "show": {
			await safeSend(ctx.api, chatId, formatBuddyHatch(result.state));
			break;
		}
		case "pet": {
			try {
				await ctx.api.setMessageReaction(chatId, ctx.message!.message_id, [{ type: "emoji", emoji: "❤" }]);
			} catch {
				await safeSend(ctx.api, chatId, "❤️");
			}
			break;
		}
		case "stats": {
			await safeSend(ctx.api, chatId, formatBuddyStats(result.state));
			break;
		}
		case "off": {
			await safeSend(ctx.api, chatId, "🐣 Buddy hidden. Use /buddy to bring them back.");
			break;
		}
		case "warning": {
			await safeSend(ctx.api, chatId, `⚠️ ${result.message}`);
			break;
		}
		case "error": {
			await safeSend(ctx.api, chatId, `❌ ${result.message}`);
			break;
		}
	}
}
