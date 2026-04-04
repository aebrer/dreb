/**
 * /buddy command — manage the buddy companion in Telegram.
 */

import type { Context } from "grammy";
import type { Config } from "../config.js";
import { createTelegramBuddyController, formatBuddyStats } from "../handlers/buddy.js";
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
 * @param config — bot config (for bridge resolution in hatch/reroll)
 */
export function ensureBuddyController(api: any, userState: UserState, chatId: number, config: Config): void {
	if (userState.buddyController) return;

	const send = (text: string, long?: boolean) => {
		enqueueSend(api, userState, chatId, text, long);
	};
	userState.buddyController = createTelegramBuddyController(send, api, chatId, config, userState);
}

export async function cmdBuddy(ctx: Context, config: Config, userState: UserState): Promise<void> {
	const chatId = ctx.chat!.id;
	const args = (ctx.match as string)?.trim() ?? "";
	const subcommand = args.split(/\s+/)[0]?.toLowerCase() ?? "";

	try {
		// Ensure buddy controller exists
		ensureBuddyController(ctx.api, userState, chatId, config);

		const controller = userState.buddyController;
		const result = await controller.handleCommand(subcommand);

		switch (result.type) {
			case "hatch":
			case "reroll": {
				// Reload manager state after RPC hatch/reroll changed buddy.json
				controller.manager.load();
				await safeSend(ctx.api, chatId, formatBuddyStats(result.state));
				try {
					await ctx.api.setMessageReaction(chatId, ctx.message!.message_id, [{ type: "emoji", emoji: "❤" }]);
				} catch {
					/* Reactions not available in all chats */
				}
				break;
			}
			case "show": {
				await safeSend(ctx.api, chatId, formatBuddyStats(result.state));
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
	} catch (err) {
		await safeSend(
			ctx.api,
			chatId,
			`❌ Failed to initialize buddy: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
