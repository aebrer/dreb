/**
 * Agent slash commands: /compact, /agents, /stats, /model, /thinking
 */

import type { Context } from "grammy";
import type { UserState } from "../types.js";
import { log, safeSend } from "../util/telegram.js";

export async function cmdCompact(ctx: Context, userState: UserState): Promise<void> {
	const chatId = ctx.chat!.id;
	const bridge = userState.bridge;

	if (!bridge?.isAlive) {
		await safeSend(ctx.api, chatId, "No active session.");
		return;
	}

	await safeSend(ctx.api, chatId, "🗜 _Compacting context..._");
	try {
		const result = await bridge.compact();
		if (result) {
			const before = (result as any).tokensBefore || 0;
			await safeSend(ctx.api, chatId, `✅ Compacted (was ${Math.round(before / 1000)}k tokens)`);
		} else {
			await safeSend(ctx.api, chatId, "✅ Compacted.");
		}
	} catch (e) {
		log(`[CMD] /compact error: ${e}`);
		await safeSend(ctx.api, chatId, `❌ Compaction failed: ${e}`);
	}
}

export async function cmdAgents(ctx: Context, userState: UserState): Promise<void> {
	const chatId = ctx.chat!.id;

	if (userState.backgroundAgents.size === 0) {
		await safeSend(ctx.api, chatId, "No background agents running.");
		return;
	}

	const lines = ["🤖 *Background Agents*:\n"];
	for (const agent of userState.backgroundAgents.values()) {
		const elapsed = Math.round((Date.now() - agent.startTime) / 1000);
		lines.push(`• *${agent.agentType}* (${elapsed}s)\n  ${agent.taskSummary.slice(0, 200)}`);
	}
	await safeSend(ctx.api, chatId, lines.join("\n"));
}

export async function cmdStats(ctx: Context, userState: UserState): Promise<void> {
	const chatId = ctx.chat!.id;
	const bridge = userState.bridge;

	if (!bridge?.isAlive) {
		await safeSend(ctx.api, chatId, "No active session.");
		return;
	}

	try {
		const stats = await bridge.getSessionStats();
		if (!stats) {
			await safeSend(ctx.api, chatId, "No stats available.");
			return;
		}

		const lines = ["📊 *Session Stats*:\n"];
		lines.push(`Messages: ${stats.userMessages || 0} user, ${stats.assistantMessages || 0} assistant`);
		lines.push(`Tool calls: ${stats.toolCalls || 0}`);

		if (stats.tokens) {
			const t = stats.tokens;
			lines.push(`\nTokens: ${Math.round((t.total || 0) / 1000)}k total`);
			lines.push(`  Input: ${Math.round((t.input || 0) / 1000)}k`);
			lines.push(`  Output: ${Math.round((t.output || 0) / 1000)}k`);
			if (t.cacheRead) lines.push(`  Cache read: ${Math.round(t.cacheRead / 1000)}k`);
		}

		if (stats.cost != null) {
			lines.push(`\n💰 Cost: $${stats.cost.toFixed(4)}`);
		}

		if (stats.contextUsage) {
			const cu = stats.contextUsage;
			if (cu.percent != null) {
				lines.push(
					`\n📏 Context: ${cu.percent}% (${Math.round((cu.tokens || 0) / 1000)}k / ${Math.round((cu.contextWindow || 0) / 1000)}k)`,
				);
			}
		}

		await safeSend(ctx.api, chatId, lines.join("\n"));
	} catch (e) {
		log(`[CMD] /stats error: ${e}`);
		await safeSend(ctx.api, chatId, `❌ Failed to get stats: ${e}`);
	}
}

export async function cmdModel(ctx: Context, userState: UserState, args: string): Promise<void> {
	const chatId = ctx.chat!.id;
	const bridge = userState.bridge;

	if (!bridge?.isAlive) {
		await safeSend(ctx.api, chatId, "No active session.");
		return;
	}

	try {
		if (!args.trim()) {
			// Show current model
			const state = await bridge.getState();
			if (state?.model) {
				await safeSend(ctx.api, chatId, `🧠 Current model: \`${state.model.provider}/${state.model.id}\``);
			} else {
				await safeSend(ctx.api, chatId, "🧠 No model set.");
			}
			return;
		}

		// Try to match and switch
		const pattern = args.trim().toLowerCase();
		const models = await bridge.getAvailableModels();

		// Score matches: exact id > exact provider/id > substring
		const scored = models
			.map((m: any) => {
				const id = m.id.toLowerCase();
				const full = `${m.provider}/${m.id}`.toLowerCase();
				if (id === pattern || full === pattern) return { model: m, score: 0 };
				if (id.includes(pattern) || full.includes(pattern)) return { model: m, score: 1 };
				return { model: m, score: -1 };
			})
			.filter((s) => s.score >= 0)
			.sort((a, b) => a.score - b.score);

		if (scored.length === 0) {
			// Group models by provider for readable display
			const byProvider = new Map<string, string[]>();
			for (const m of models as any[]) {
				const list = byProvider.get(m.provider) || [];
				list.push(m.id);
				byProvider.set(m.provider, list);
			}
			const lines = [`No model matching "${pattern}". Available:`];
			for (const [provider, ids] of byProvider) {
				lines.push(`\n*${provider}*:`);
				for (const id of ids) {
					lines.push(`  \`${id}\``);
				}
			}
			await safeSend(ctx.api, chatId, lines.join("\n").slice(0, 4000));
			return;
		}

		// If multiple matches, prefer exact over substring
		const match = scored[0].model;
		await bridge.setModel((match as any).provider, (match as any).id);
		await safeSend(ctx.api, chatId, `🧠 Switched to \`${(match as any).provider}/${(match as any).id}\``);
	} catch (e) {
		log(`[CMD] /model error: ${e}`);
		await safeSend(ctx.api, chatId, `❌ ${e}`);
	}
}

export async function cmdThinking(ctx: Context, userState: UserState, args: string): Promise<void> {
	const chatId = ctx.chat!.id;
	const bridge = userState.bridge;

	if (!bridge?.isAlive) {
		await safeSend(ctx.api, chatId, "No active session.");
		return;
	}

	try {
		if (!args.trim()) {
			const state = await bridge.getState();
			await safeSend(ctx.api, chatId, `💭 Thinking level: \`${state?.thinkingLevel || "unknown"}\``);
			return;
		}

		const level = args.trim().toLowerCase();
		const valid = ["off", "minimal", "low", "medium", "high"];
		if (!valid.includes(level)) {
			await safeSend(ctx.api, chatId, `Invalid level. Options: ${valid.join(", ")}`);
			return;
		}

		await bridge.setThinkingLevel(level);
		await safeSend(ctx.api, chatId, `💭 Thinking level set to \`${level}\``);
	} catch (e) {
		log(`[CMD] /thinking error: ${e}`);
		await safeSend(ctx.api, chatId, `❌ ${e}`);
	}
}
