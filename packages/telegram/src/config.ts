/**
 * Configuration loaded from environment variables.
 * All secrets must come from env vars — never hardcode tokens.
 *
 * If TELEGRAM_BOT_TOKEN is not already set, we auto-load from
 * ~/.dreb/secrets/telegram.env (the same file the systemd service uses).
 * This way `node dist/index.js` works without manual env setup.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
	/** Telegram Bot API token */
	botToken: string;
	/** Authorized Telegram user IDs */
	allowedUserIds: number[];
	/** Working directory for dreb sessions */
	workingDir: string;
	/** Path to the dreb CLI binary */
	drebPath: string;
	/** Systemd service name for /restart */
	serviceName: string;
	/** Provider to use for dreb */
	provider?: string;
	/** Model to use for dreb */
	model?: string;
}

/** Default path to the secrets env file */
export const DEFAULT_SECRETS_FILE = join(homedir(), ".dreb", "secrets", "telegram.env");

/**
 * Load KEY=VALUE pairs from a file into process.env (without overwriting).
 * Handles quoting, comments, and empty lines.
 */
function loadEnvFile(path: string): void {
	if (!existsSync(path)) return;

	const content = readFileSync(path, "utf-8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;

		const key = trimmed.slice(0, eqIndex).trim();
		let value = trimmed.slice(eqIndex + 1).trim();

		// Strip surrounding quotes
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}

		// Don't overwrite existing env vars (explicit env takes priority)
		if (!(key in process.env)) {
			process.env[key] = value;
		}
	}
}

export function loadConfig(secretsFile: string = DEFAULT_SECRETS_FILE): Config {
	// Auto-load secrets file if env vars aren't already set
	loadEnvFile(secretsFile);

	const botToken = process.env.TELEGRAM_BOT_TOKEN;
	if (!botToken) {
		throw new Error(
			`TELEGRAM_BOT_TOKEN not set.\n\n` +
				`Either:\n` +
				`  1. Set the environment variable directly, or\n` +
				`  2. Create ${secretsFile} with:\n\n` +
				`     TELEGRAM_BOT_TOKEN=your-token-here\n` +
				`     ALLOWED_USER_IDS=your-user-id-here\n\n` +
				`     Then: chmod 600 ${secretsFile}`,
		);
	}

	const allowedUserIds = (process.env.ALLOWED_USER_IDS || "")
		.split(",")
		.filter((id) => id.trim())
		.map((id) => {
			const n = Number.parseInt(id.trim(), 10);
			if (Number.isNaN(n)) throw new Error(`Invalid user ID: ${id}`);
			return n;
		});

	return {
		botToken,
		allowedUserIds,
		workingDir: process.env.DREB_WORKING_DIR || process.env.HOME || "/",
		drebPath: process.env.DREB_PATH || "dreb",
		serviceName: process.env.DREB_TELEGRAM_SERVICE || "dreb-telegram",
		provider: process.env.DREB_PROVIDER,
		model: process.env.DREB_MODEL,
	};
}
