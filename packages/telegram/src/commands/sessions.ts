/**
 * Session slash commands: /sessions, /resume, /recent
 */

import type { Context } from "grammy";
import type { UserState } from "../types.js";
import { log, safeSend, sendLong } from "../util/telegram.js";

export async function cmdSessions(ctx: Context, userState: UserState): Promise<void> {
	const chatId = ctx.chat!.id;
	const bridge = userState.bridge;

	if (!bridge?.isAlive) {
		await safeSend(ctx.api, chatId, "No active connection. Send a message first.");
		return;
	}

	const sessions = await bridge.listSessions();
	if (sessions.length === 0) {
		await safeSend(ctx.api, chatId, "No saved sessions. Send a message to start one.");
		return;
	}

	const lines = ["📂 *Recent Sessions*:\n"];
	// Show newest first, max 10
	for (const s of sessions.slice(0, 10)) {
		const date = new Date(s.modified);
		const ts =
			date.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
			" " +
			date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
		const sid = s.id.slice(0, 8);
		const preview = s.firstMessage.slice(0, 60);
		lines.push(`\`${sid}\` (${ts})\n  ${preview}`);
	}

	lines.push("\nUse /resume <id> to resume a session.");
	await safeSend(ctx.api, chatId, lines.join("\n"));
}

export async function cmdResume(ctx: Context, userState: UserState, args: string): Promise<void> {
	const chatId = ctx.chat!.id;
	const bridge = userState.bridge;

	if (!args.trim()) {
		await safeSend(ctx.api, chatId, "Usage: /resume <session\\_id>\nUse /sessions to list available sessions.");
		return;
	}

	if (!bridge?.isAlive) {
		await safeSend(ctx.api, chatId, "No active connection. Send a message first.");
		return;
	}

	const partialId = args.trim();
	const sessions = await bridge.listSessions();
	const matches = sessions.filter((s) => s.id.startsWith(partialId));

	if (matches.length === 0) {
		await safeSend(ctx.api, chatId, `No session found matching \`${partialId}\``);
		return;
	}
	if (matches.length > 1) {
		await safeSend(ctx.api, chatId, `Multiple sessions match \`${partialId}\` — be more specific.`);
		return;
	}

	const session = matches[0];
	const switched = await bridge.switchSession(session.path);
	if (switched) {
		await safeSend(
			ctx.api,
			chatId,
			`✅ Resumed session \`${session.id.slice(0, 8)}...\`\nUse /recent to see recent messages.`,
		);
	} else {
		await safeSend(ctx.api, chatId, `❌ Failed to switch to session \`${session.id.slice(0, 8)}...\``);
	}
}

export async function cmdRecent(ctx: Context, userState: UserState, args: string): Promise<void> {
	const chatId = ctx.chat!.id;
	const bridge = userState.bridge;

	if (!bridge?.isAlive) {
		await safeSend(ctx.api, chatId, "No active session. Send a message first.");
		return;
	}

	// Parse N (default 1)
	let n = 1;
	if (args.trim()) {
		n = Number.parseInt(args.trim(), 10);
		if (Number.isNaN(n) || n < 1) {
			await safeSend(ctx.api, chatId, "Usage: /recent \\[N\\] — resend last N messages (default 1, max 50)");
			return;
		}
		n = Math.min(n, 50);
	}

	try {
		const messages = await bridge.getMessages();
		// Filter to assistant text messages
		const assistantTexts: string[] = [];
		for (const msg of messages) {
			if (msg.role !== "assistant") continue;
			const content = (msg as any).content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (block.type === "text" && block.text?.trim()) {
					assistantTexts.push(block.text.trim());
				}
			}
		}

		const recent = assistantTexts.slice(-n);
		if (recent.length === 0) {
			await safeSend(ctx.api, chatId, "No assistant messages found in this session.");
			return;
		}

		for (let i = 0; i < recent.length; i++) {
			let text = recent[i];
			if (recent.length > 1) {
				text = `📨 *Message ${i + 1}/${recent.length}*\n\n${text}`;
			}
			await sendLong(ctx.api, chatId, text);
		}
	} catch (e) {
		log(`[CMD] /recent error: ${e}`);
		await safeSend(ctx.api, chatId, `❌ Failed to retrieve messages: ${e}`);
	}
}
