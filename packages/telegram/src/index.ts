#!/usr/bin/env node

/**
 * dreb Telegram bot — entry point.
 *
 * Starts the bot in long-polling mode with the configuration from env vars.
 */

import { createBot, getUserState, setMyCommands } from "./bot.js";
import { ensureBridge } from "./bridge-lifecycle.js";
import { refreshCommandsWithSkills } from "./commands/refresh.js";
import { setSkillsBot } from "./commands/skills.js";
import { loadConfig } from "./config.js";
import { getUserSession, loadState, setUserSession } from "./state.js";
import { log } from "./util/telegram.js";

/**
 * Eagerly reconnect known users to their last session.
 * Spins up an RPC bridge and switches to the persisted session path.
 */
async function reconnectUsers(config: import("./config.js").Config): Promise<void> {
	for (const userId of config.allowedUserIds) {
		const sessionPath = getUserSession(userId);
		if (!sessionPath) {
			log(`[RECONNECT] No persisted session for user ${userId}, skipping`);
			continue;
		}

		try {
			const userState = getUserState(userId, config);
			const bridge = await ensureBridge(config, userState);
			const switched = await bridge.switchSession(sessionPath);
			if (switched) {
				log(`[RECONNECT] User ${userId} reconnected to session ${bridge.sessionId?.slice(0, 8)}`);
			} else {
				log(`[RECONNECT] User ${userId} failed to switch to persisted session, will resume latest`);
				await bridge.resumeLatest();
			}
		} catch (e) {
			log(`[RECONNECT] User ${userId} reconnect failed: ${e}`);
			// Clear stale session so we don't retry every restart
			setUserSession(userId, "");
		}
	}
}

async function main(): Promise<void> {
	const config = loadConfig();

	log(`Starting dreb Telegram bot...`);
	log(`Working directory: ${config.workingDir}`);
	if (config.allowedUserIds.length > 0) {
		log(`Allowed users: ${config.allowedUserIds.join(", ")}`);
	} else {
		log("WARNING: ALLOWED_USER_IDS not set — bot will accept messages from anyone!");
	}

	// Load persisted state and reconnect users before accepting messages
	loadState();
	await reconnectUsers(config);

	const bot = createBot(config);

	// Store bot ref for dynamic command refresh from /skills
	setSkillsBot(bot);

	// Register static commands for autocomplete
	await setMyCommands(bot);

	// Refresh command menu with dynamic skill commands from the first available bridge
	for (const userId of config.allowedUserIds) {
		const userState = getUserState(userId, config);
		if (userState.bridge?.isAlive) {
			await refreshCommandsWithSkills(bot, userState.bridge);
			break; // Only need one bridge to query skills
		}
	}

	// Start polling
	log("Bot running. Press Ctrl+C to stop.");
	await bot.start({
		drop_pending_updates: true,
		allowed_updates: ["message", "callback_query"],
		onStart: () => log("Bot polling started"),
	});
}

main().catch((e) => {
	console.error("Fatal:", e);
	process.exit(1);
});
