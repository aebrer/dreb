#!/usr/bin/env node

/**
 * dreb Telegram bot — entry point.
 *
 * Starts the bot in long-polling mode with the configuration from env vars.
 */

import { createBot, setMyCommands } from "./bot.js";
import { loadConfig } from "./config.js";
import { log } from "./util/telegram.js";

async function main(): Promise<void> {
	const config = loadConfig();

	log(`Starting dreb Telegram bot...`);
	log(`Working directory: ${config.workingDir}`);
	if (config.allowedUserIds.length > 0) {
		log(`Allowed users: ${config.allowedUserIds.join(", ")}`);
	} else {
		log("WARNING: ALLOWED_USER_IDS not set — bot will accept messages from anyone!");
	}

	const bot = createBot(config);

	// Register commands for autocomplete
	await setMyCommands(bot);

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
