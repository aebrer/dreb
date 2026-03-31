/**
 * Configuration loaded from environment variables.
 * All secrets must come from env vars — never hardcode tokens.
 */

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

export function loadConfig(): Config {
	const botToken = process.env.TELEGRAM_BOT_TOKEN;
	if (!botToken) {
		throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");
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
