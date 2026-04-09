/**
 * Core slash commands: /start, /status, /cwd, /new, /stop, /restart
 */

import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Api, Context } from "grammy";
import type { Config } from "../config.js";
import type { UserState } from "../types.js";
import { log, safeSend } from "../util/telegram.js";

export async function cmdStart(ctx: Context): Promise<void> {
	await ctx.reply(
		"🤖 *dreb Telegram*\n\n" +
			"Send me a message and I'll forward it to dreb.\n\n" +
			"*Session:*\n" +
			"/new — Start a fresh session (keeps current directory)\n" +
			"/new <path> — Start a fresh session in a different directory\n" +
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
			"/thinking \\[level\\] — View/set thinking\n" +
			"/skills — List available skills\n\n" +
			"*Control:*\n" +
			"/stop — Interrupt current task\n" +
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

export async function cmdCwd(ctx: Context, config: Config, userState: UserState): Promise<void> {
	const cwd = userState.effectiveCwd ?? config.workingDir;
	await safeSend(ctx.api, ctx.chat!.id, `📁 Working directory: \`${cwd}\``);
}

export async function cmdNew(ctx: Context, userState: UserState, args: string): Promise<void> {
	const pathArg = args.trim();

	if (pathArg) {
		// Resolve path (expand ~ and make absolute)
		const expanded = pathArg.startsWith("~") ? pathArg.replace("~", homedir()) : pathArg;
		const resolved = resolve(expanded);

		if (!existsSync(resolved)) {
			await safeSend(ctx.api, ctx.chat!.id, `❌ Directory not found: \`${resolved}\``);
			return;
		}
		if (!statSync(resolved).isDirectory()) {
			await safeSend(ctx.api, ctx.chat!.id, `❌ Not a directory: \`${resolved}\``);
			return;
		}

		userState.newSessionFlag = true;
		userState.newSessionCwd = resolved;
		await ctx.reply(`🆕 Next message will start a fresh session in \`${resolved}\``);
	} else {
		userState.newSessionFlag = true;
		userState.newSessionCwd = null;
		await ctx.reply("🆕 Next message will start a fresh session.");
	}
}

export async function cmdStop(ctx: Context, _api: Api, userState: UserState): Promise<void> {
	userState.stopRequested = true;

	// Abort current agent activity — like pressing Esc in the TUI.
	// This stops the agent, not the bridge. Session stays connected.
	if (userState.bridge?.isAlive) {
		await userState.bridge.abort();
	}

	const parts: string[] = [];
	if (userState.bridge?.isStreaming || userState.promptInFlight) parts.push("interrupted current task");
	await ctx.reply(parts.length > 0 ? `🛑 Stopped — ${parts.join(", ")}.` : "🛑 Stopped.");
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
