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

/**
 * Ensure the user has a buddy controller, creating one if needed.
 *
 * The controller auto-loads from the shared buddy.json on creation,
 * so it picks up any buddy hatched in the TUI (and vice versa).
 *
 * @param api — grammy Api for chat actions
 * @param userState — per-user state (controller stored here)
 * @param chatId — Telegram chat ID (private chat = user ID)
 */
export function ensureBuddyController(api: any, userState: UserState, chatId: number): void {
	if (userState.buddyController) return;

	const send = (text: string, long?: boolean) => {
		enqueueSend(api, userState, chatId, text, long);
	};
	userState.buddyController = createTelegramBuddyController(send, api, chatId);
}

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
		console.error(
			`[BUDDY] state keys: ${state ? Object.keys(state).join(",") : "null"}, model: ${model ? `${model.provider}/${model.id}` : "undefined"}`,
		);
		if (model?.provider) {
			apiKey = getEnvApiKey(model.provider);
			console.error(`[BUDDY] apiKey resolved: ${apiKey ? "yes" : "no"} (provider: ${model.provider})`);
		}
	} catch (e) {
		console.error(`[BUDDY] Failed to get model from bridge: ${e}`);
	}

	// Ensure buddy controller exists
	ensureBuddyController(ctx.api, userState, chatId);

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
