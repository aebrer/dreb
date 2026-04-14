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

export async function cmdSessionAnalysis(ctx: Context, userState: UserState): Promise<void> {
	const chatId = ctx.chat!.id;
	const bridge = userState.bridge;

	if (!bridge?.isAlive) {
		await safeSend(ctx.api, chatId, "No active session.");
		return;
	}

	await safeSend(ctx.api, chatId, "\ud83d\udd2c _Analyzing sessions..._");

	try {
		const analysis = await bridge.getSessionAnalysis();
		if (!analysis) {
			await safeSend(ctx.api, chatId, "No analysis available.");
			return;
		}

		const { current, timeline, groups, comparison } = analysis;
		const lines: string[] = ["\ud83d\udcca *Session Analysis*\n"];

		// Current session
		if (current.model) {
			lines.push(`\ud83e\udde0 Model: \`${current.provider ? `${current.provider}/` : ""}${current.model}\``);
		}
		lines.push(`\ud83d\udd27 Tool calls: ${current.totalToolCalls}`);
		if (current.totalTokens) {
			lines.push(
				`📊 Tokens: ${current.totalTokens.toLocaleString()} | Cost: $${current.totalCost?.toFixed(4) ?? "0"}`,
			);
		}

		if (current.totalToolCalls > 0) {
			lines.push("");
			lines.push(`Read:Edit ratio: ${current.readEditRatio != null ? current.readEditRatio.toFixed(1) : "N/A"}`);
			lines.push(
				`Write vs Edit: ${current.writeVsEditPercent != null ? `${current.writeVsEditPercent.toFixed(0)}%` : "N/A"}`,
			);
			lines.push(`Error rate: ${current.errorRate != null ? `${current.errorRate.toFixed(1)}%` : "N/A"}`);
			lines.push(
				`Self-correction: ${current.selfCorrectionPer1K != null ? `${current.selfCorrectionPer1K.toFixed(1)}/1K` : "N/A"}`,
			);
		}

		// Tool distribution (top 8)
		const dist = Object.entries(current.toolDistribution || {}).sort((a, b) => (b[1] as number) - (a[1] as number));
		if (dist.length > 0) {
			lines.push("\n\ud83d\udd27 *Tool Distribution*:");
			for (const [name, count] of dist.slice(0, 8)) {
				lines.push(`  ${name}: ${count}`);
			}
			if (dist.length > 8) {
				lines.push(`  ...and ${dist.length - 8} more`);
			}
		}

		// Timeline sparklines
		if (timeline && timeline.periods.length > 1) {
			lines.push(`\n\ud83d\udcc8 *Trends* (${timeline.totalSessions} sessions, ${timeline.periods.length} weeks):`);
			const readEditVals = timeline.periods.map((p: any) => p.metrics?.avgReadEditRatio ?? null);
			const errorVals = timeline.periods.map((p: any) => p.metrics?.avgErrorRate ?? null);
			// Simple sparkline using block chars
			const spark = (vals: (number | null)[]): string => {
				const chars = " \u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
				const valid = vals.filter((v): v is number => v !== null);
				if (valid.length === 0) return "";
				const min = Math.min(...valid);
				const max = Math.max(...valid);
				const range = max - min || 1;
				return vals.map((v) => (v === null ? " " : chars[Math.round(((v - min) / range) * 7) + 1])).join("");
			};
			lines.push(`  Read:Edit:  ${spark(readEditVals)}`);
			lines.push(`  Error Rate: ${spark(errorVals)}`);
		}

		// Groups (compact: top 3 each)
		if (groups) {
			if (groups.byModel.length > 0) {
				lines.push("\n\ud83e\udde0 *By Model*:");
				for (const g of groups.byModel.slice(0, 3)) {
					const re = g.avgReadEditRatio != null ? `R:E ${g.avgReadEditRatio.toFixed(1)}` : "";
					const err = g.avgErrorRate != null ? `Err ${g.avgErrorRate.toFixed(1)}%` : "";
					lines.push(`  ${g.groupKey}: ${g.sessionCount} sessions  ${re}  ${err}`);
				}
			}
			if (groups.byType.length > 0) {
				lines.push("\n\ud83d\udcdd *By Type*:");
				for (const g of groups.byType.slice(0, 5)) {
					const re = g.avgReadEditRatio != null ? `R:E ${g.avgReadEditRatio.toFixed(1)}` : "";
					const err = g.avgErrorRate != null ? `Err ${g.avgErrorRate.toFixed(1)}%` : "";
					lines.push(`  ${g.groupKey}: ${g.sessionCount} sessions  ${re}  ${err}`);
				}
			}
		}

		// Date comparison
		if (comparison) {
			const dateStr = new Date(comparison.splitDate).toISOString().slice(0, 10);
			lines.push(`\n\ud83d\udcc5 *Split at ${dateStr}*:`);
			const b = comparison.before;
			const a = comparison.after;
			const tl = (label: string, bv: number | null, av: number | null, suffix = ""): string => {
				const bs = bv != null ? bv.toFixed(1) + suffix : "\u2014";
				const as_ = av != null ? av.toFixed(1) + suffix : "\u2014";
				return `  ${label}: ${bs} \u2192 ${as_}`;
			};
			lines.push(tl("Read:Edit", b.avgReadEditRatio, a.avgReadEditRatio));
			lines.push(tl("Error Rate", b.avgErrorRate, a.avgErrorRate, "%"));
			lines.push(`  Sessions: ${b.sessionCount} before, ${a.sessionCount} after`);
		}

		lines.push("\n_Metrics are noisy proxies \u2014 interpret relative to your baseline._");

		await safeSend(ctx.api, chatId, lines.join("\n"));
	} catch (e) {
		log(`[CMD] /session_analysis error: ${e}`);
		await safeSend(ctx.api, chatId, `\u274c Failed to get analysis: ${e}`);
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

		// Resolve pattern using the same logic as CLI/TUI
		const pattern = args.trim();
		const result = await bridge.resolveModel(pattern);

		if (!result) {
			// No match — list available models grouped by provider
			const models = await bridge.getAvailableModels();
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

		const model = result.model as any;
		await bridge.setModel(model.provider, model.id);
		const warning = result.warning ? ` ⚠️ ${result.warning}` : "";
		await safeSend(ctx.api, chatId, `🧠 Switched to \`${model.provider}/${model.id}\`${warning}`);
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
