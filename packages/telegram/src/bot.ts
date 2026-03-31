/**
 * Bot setup — creates the grammy Bot, wires up auth, commands, and message handlers.
 */

import { Bot } from "grammy";
import { AgentBridge } from "./agent-bridge.js";
import { registerCommands, setMyCommands } from "./commands/index.js";
import type { Config } from "./config.js";
import { handleFile } from "./handlers/file.js";
import { enqueuePrompt } from "./handlers/message.js";
import type { UserState } from "./types.js";
import { log, safeSend } from "./util/telegram.js";

/** Per-user state store */
const userStates = new Map<number, UserState>();

function createUserState(): UserState {
	return {
		bridge: null,
		queue: [],
		processing: false,
		newSessionFlag: false,
		backgroundAgents: new Map(),
		stopRequested: false,
	};
}

function getUserState(userId: number): UserState {
	let state = userStates.get(userId);
	if (!state) {
		state = createUserState();
		userStates.set(userId, state);
	}
	return state;
}

/**
 * Ensure the user has an active agent bridge, starting one if needed.
 * Handles session resume logic (new session, resume by path, or continue latest).
 */
async function ensureBridge(_userId: number, config: Config, userState: UserState): Promise<AgentBridge> {
	if (!userState.bridge || !userState.bridge.isAlive) {
		const bridge = new AgentBridge(config);
		await bridge.start();
		userState.bridge = bridge;

		// Wire up background agent tracking
		bridge.onEvent((event: any) => {
			if (event.type === "background_agent_start") {
				userState.backgroundAgents.set(event.agentId, {
					agentId: event.agentId,
					agentType: event.agentType,
					taskSummary: event.taskSummary,
					startTime: Date.now(),
				});
			} else if (event.type === "background_agent_end") {
				userState.backgroundAgents.delete(event.agentId);
			}
		});
	}

	// Handle session flags
	if (userState.newSessionFlag) {
		userState.newSessionFlag = false;
		await userState.bridge.newSession();
	} else if (!userState.bridge.sessionId) {
		// First message — try to resume latest session
		await userState.bridge.resumeLatest();
	}

	return userState.bridge;
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

	// Register slash commands
	registerCommands(bot, config, getUserState);

	// Text message handler
	bot.on("message:text", async (ctx) => {
		// Skip commands (already handled above)
		if (ctx.message.text.startsWith("/")) return;

		const userId = ctx.from!.id;
		const userState = getUserState(userId);
		const isBusy = userState.processing;

		// Show status immediately
		const statusText = isBusy ? "📋 _Queued..._" : "🧠 _Thinking..._";
		let statusMsg: { chat_id: number; message_id: number } | null = null;
		try {
			const sent = await ctx.reply(statusText, { parse_mode: "Markdown" });
			statusMsg = { chat_id: sent.chat.id, message_id: sent.message_id };
		} catch (e) {
			log(`[MSG] Failed to send status: ${e}`);
		}

		// Ensure bridge is alive and session is set up
		try {
			await ensureBridge(userId, config, userState);
		} catch (e) {
			log(`[MSG] Bridge setup failed: ${e}`);
			await safeSend(ctx.api, ctx.chat!.id, `❌ Failed to start agent: ${e}`);
			return;
		}

		enqueuePrompt(ctx.api, userState, {
			message: ctx.message,
			prompt: ctx.message.text,
			statusMessage: statusMsg,
			wasQueued: isBusy,
		});
	});

	// File handler (documents, photos, voice, audio, video)
	bot.on(["message:document", "message:photo", "message:voice", "message:audio", "message:video"], async (ctx) => {
		const userId = ctx.from!.id;
		const userState = getUserState(userId);

		// Ensure bridge is alive
		try {
			await ensureBridge(userId, config, userState);
		} catch (e) {
			log(`[FILE] Bridge setup failed: ${e}`);
			await safeSend(ctx.api, ctx.chat!.id, `❌ Failed to start agent: ${e}`);
			return;
		}

		await handleFile(ctx, ctx.api, userState, getUserState);
	});

	// Error handler
	bot.catch((err) => {
		log(`[ERROR] ${err.error}`);
	});

	return bot;
}

export { setMyCommands };
