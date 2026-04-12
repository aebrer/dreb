/**
 * Bot setup — creates the grammy Bot, wires up auth, commands, and message handlers.
 */

import { Bot } from "grammy";
import { ensureBridgeWithSession } from "./bridge-lifecycle.js";
import { registerCommands, setMyCommands } from "./commands/index.js";
import type { Config } from "./config.js";
import { handleFile } from "./handlers/file.js";
import { sendPrompt } from "./handlers/message.js";
import type { UserState } from "./types.js";
import { log, safeDelete, safeSend } from "./util/telegram.js";

/** Per-user state store */
const userStates = new Map<number, UserState>();

function createUserState(config: Config): UserState {
	return {
		bridge: null,
		config,
		promptInFlight: false,
		newSessionFlag: false,
		newSessionCwd: null,
		effectiveCwd: null,
		backgroundAgents: new Map(),
		stopRequested: false,
		outbox: [],
		buddyController: null,
	};
}

function getUserState(userId: number, config?: Config): UserState {
	let state = userStates.get(userId);
	if (!state) {
		if (!config) throw new Error("Config required for new user state creation");
		state = createUserState(config);
		userStates.set(userId, state);
	}
	return state;
}

export function createBot(config: Config): Bot {
	const bot = new Bot(config.botToken);

	// Auth middleware — check allowed user IDs
	if (config.allowedUserIds.length > 0) {
		bot.use(async (ctx, next) => {
			const userId = ctx.from?.id;
			if (!userId || !config.allowedUserIds.includes(userId)) {
				log(`[AUTH] Rejected user ${userId}`);
				await ctx.reply("⛔ Not authorized");
				return;
			}
			await next();
		});
	}

	// Register slash commands — bind config so callers see (userId) => UserState
	const boundGetUserState = (userId: number) => getUserState(userId, config);
	registerCommands(bot, config, boundGetUserState);

	// Text message handler
	bot.on("message:text", async (ctx) => {
		// Skip commands (already handled above)
		if (ctx.message.text.startsWith("/")) return;

		const userId = ctx.from!.id;
		const userState = getUserState(userId, config);
		const isBusy = userState.bridge?.isStreaming || userState.promptInFlight;

		// Show status immediately
		const statusText = isBusy ? "↩️ _Steering..._" : "🧠 _Thinking..._";
		let statusMessageId: number | null = null;
		try {
			const sent = await ctx.reply(statusText, { parse_mode: "Markdown" });
			statusMessageId = sent.message_id;
		} catch (e) {
			log(`[MSG] Failed to send status: ${e}`);
		}

		// Ensure bridge is alive and session is set up
		try {
			await ensureBridgeWithSession(config, userState);
		} catch (e) {
			log(`[MSG] Bridge setup failed: ${e}`);
			if (statusMessageId) void safeDelete(ctx.api, ctx.chat!.id, statusMessageId);
			await safeSend(ctx.api, ctx.chat!.id, `❌ Failed to start agent: ${e}`);
			return;
		}

		// Surface model fallback warning (e.g. saved model unavailable after restart)
		if (userState.pendingModelFallbackWarning) {
			await safeSend(ctx.api, ctx.chat!.id, `⚠️ _${userState.pendingModelFallbackWarning}_`);
			userState.pendingModelFallbackWarning = undefined;
		}

		sendPrompt(ctx.api, userState, {
			chatId: ctx.chat!.id,
			replyToId: ctx.message.message_id,
			userId,
			prompt: ctx.message.text,
			statusMessageId,
		});
	});

	// File handler (documents, photos, voice, audio, video)
	bot.on(["message:document", "message:photo", "message:voice", "message:audio", "message:video"], async (ctx) => {
		const userId = ctx.from!.id;
		const userState = getUserState(userId, config);

		// Ensure bridge is alive
		try {
			await ensureBridgeWithSession(config, userState);
		} catch (e) {
			log(`[FILE] Bridge setup failed: ${e}`);
			await safeSend(ctx.api, ctx.chat!.id, `❌ Failed to start agent: ${e}`);
			return;
		}

		// Surface model fallback warning (e.g. saved model unavailable after restart)
		if (userState.pendingModelFallbackWarning) {
			await safeSend(ctx.api, ctx.chat!.id, `⚠️ _${userState.pendingModelFallbackWarning}_`);
			userState.pendingModelFallbackWarning = undefined;
		}

		await handleFile(ctx, ctx.api, boundGetUserState);
	});

	// Error handler
	bot.catch((err) => {
		log(`[ERROR] ${err.error}`);
	});

	return bot;
}

export { getUserState, setMyCommands };
