/**
 * Core slash commands: /start, /status, /cwd, /new, /stop, /restart
 */

import { execSync } from "node:child_process";
import type { Api, Context } from "grammy";
import type { Config } from "../config.js";
import type { UserState } from "../types.js";
import { log, safeDelete, safeSend } from "../util/telegram.js";

export async function cmdStart(ctx: Context): Promise<void> {
	await ctx.reply(
		"🤖 *dreb Telegram*\n\n" +
			"Send me a message and I'll forward it to dreb.\n\n" +
			"*Session:*\n" +
			"/new — Start a fresh session\n" +
			"/sessions — List recent sessions\n" +
			"/resume <id> — Resume a session\n" +
			"/recent \\[N\\] — Resend last N messages\n\n" +
			"*Agent:*\n" +
			"/status — Connection info\n" +
			"/cwd — Working directory\n" +
			"/stats — Token usage & cost\n" +
			"/compact — Compact context\n" +
			"/agents — Background subagents\n" +
			"/model \\[pattern\\] — View/switch model\n" +
			"/thinking \\[level\\] — View/set thinking\n\n" +
			"*Control:*\n" +
			"/stop — Interrupt & clear queue\n" +
			"/restart — Restart the bot",
		{ parse_mode: "Markdown" },
	);
}

export async function cmdStatus(ctx: Context, config: Config, userState: UserState): Promise<void> {
	const chatId = ctx.chat!.id;
	const bridge = userState.bridge;

	let version = "unknown";
	let model = "none";
	try {
		if (bridge?.isAlive) {
			version = await bridge.getVersion();
			const state = await bridge.getState();
			if (state?.model) model = `${state.model.provider}/${state.model.id}`;
		}
	} catch (e) {
		log(`[CMD] /status error: ${e}`);
	}

	const lines = [
		bridge?.isAlive ? "✅ Connected" : "⚠️ Not connected (will start on next message)",
		`📁 Working dir: \`${config.workingDir}\``,
		`🔧 dreb ${version}`,
		`🧠 Model: ${model}`,
	];

	if (bridge?.sessionId) {
		lines.push(`📂 Session: \`${bridge.sessionId.slice(0, 8)}...\``);
	}

	await safeSend(ctx.api, chatId, lines.join("\n"));
}

export async function cmdCwd(ctx: Context, config: Config): Promise<void> {
	await safeSend(ctx.api, ctx.chat!.id, `📁 Working directory: \`${config.workingDir}\``);
}

export async function cmdNew(ctx: Context, userState: UserState): Promise<void> {
	userState.newSessionFlag = true;
	await ctx.reply("🆕 Next message will start a fresh session.");
}

export async function cmdStop(ctx: Context, api: Api, userState: UserState): Promise<void> {
	const hadProc = userState.bridge?.isStreaming;
	const queuedCount = userState.queue.length;

	if (!hadProc && queuedCount === 0) {
		await ctx.reply("Nothing running to stop.");
		return;
	}

	// Clear queue and clean up status messages
	for (const item of userState.queue) {
		if (item.statusMessage) {
			await safeDelete(api, item.statusMessage.chat_id, item.statusMessage.message_id);
		}
	}
	userState.queue = [];
	userState.stopRequested = true;

	// Abort the running agent
	if (userState.bridge?.isStreaming) {
		await userState.bridge.abort();
	}

	const parts: string[] = [];
	if (hadProc) parts.push("interrupted current task");
	if (queuedCount > 0) parts.push(`cleared ${queuedCount} queued message(s)`);
	await ctx.reply(`🛑 Stopped — ${parts.join(", ")}.`);
}

export async function cmdRestart(ctx: Context, config: Config): Promise<void> {
	await ctx.reply("🔄 Restarting...");
	log("[CMD] /restart — triggering systemctl restart");
	try {
		execSync(`systemctl --user restart ${config.serviceName}`, { timeout: 5000 });
	} catch {
		// Process will be killed by systemd restart
	}
}
