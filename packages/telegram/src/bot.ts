/**
 * Bot setup — creates the grammy Bot, wires up auth, commands, and message handlers.
 */

import { Bot } from "grammy";
import type { AgentBridge } from "./agent-bridge.js";
import { ensureBridge } from "./bridge-lifecycle.js";
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
		newSessionCwd: null,
		effectiveCwd: null,
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
 * Ensure bridge is alive AND a session is selected.
 * Used by message/file handlers before prompting.
 */
async function ensureBridgeWithSession(config: Config, userState: UserState): Promise<AgentBridge> {
	// Handle new session with custom working directory — requires a fresh bridge
	if (userState.newSessionFlag && userState.newSessionCwd) {
		const cwd = userState.newSessionCwd;
		userState.newSessionFlag = false;
		userState.newSessionCwd = null;

		// Kill existing bridge and start a new one with the custom cwd
		if (userState.bridge?.isAlive) {
			await userState.bridge.stop();
		}
		userState.bridge = null;

		const customConfig = { ...config, workingDir: cwd };
		const bridge = await ensureBridge(customConfig, userState);
		userState.effectiveCwd = cwd;
		await bridge.newSession();
		return bridge;
	}

	const bridge = await ensureBridge(config, userState);

	// Track effective cwd (default from config on first bridge creation)
	if (!userState.effectiveCwd) {
		userState.effectiveCwd = config.workingDir;
	}

	// Handle session flags
	if (userState.newSessionFlag) {
		userState.newSessionFlag = false;
		await bridge.newSession();
	} else if (!bridge.sessionId) {
		// First message — try to resume latest session
		await bridge.resumeLatest();
	}

	return bridge;
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
			await ensureBridgeWithSession(config, userState);
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
			await ensureBridgeWithSession(config, userState);
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

export { getUserState, setMyCommands };
