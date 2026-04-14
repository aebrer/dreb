import type { AssistantMessage, Message, TextContent, ToolCall, ToolResultMessage } from "@dreb/ai";

// ── Types ───────────────────────────────────────────────────────────────

export interface ToolCallRecord {
	name: string;
	isError: boolean;
	timestamp: number;
}

export interface TurnSummary {
	index: number;
	timestamp: number;
	toolCalls: number;
	tools: string[];
}

export interface AnalysisInput {
	toolCalls: ToolCallRecord[];
	assistantTexts: string[];
	turns: TurnSummary[];
	totalTurns: number;
	totalCost: number;
	totalTokens: number;
}

export interface SessionAnalysis {
	sessionId: string;
	sessionFile?: string;
	timestamp: Date;
	model?: string;
	provider?: string;
	isSubagent: boolean;
	agentType?: string;
	readEditRatio: number | null;
	writeVsEditPercent: number | null;
	errorRate: number | null;
	selfCorrectionPer1K: number | null;
	toolDistribution: Record<string, number>;
	totalToolCalls: number;
	totalCost: number;
	totalTokens: number;
	timeline: TurnSummary[];
}

export interface PeriodMetrics {
	label: string;
	sessionCount: number;
	avgReadEditRatio: number | null;
	avgWriteVsEditPercent: number | null;
	avgErrorRate: number | null;
	avgSelfCorrectionPer1K: number | null;
	toolDistribution: Record<string, number>;
	totalToolCalls: number;
	totalCost: number;
	totalTokens: number;
	avgCostPerToolCall: number | null;
	avgTokensPerToolCall: number | null;
}

export interface ProjectTrend {
	currentPeriod: PeriodMetrics;
	previousPeriod: PeriodMetrics;
	totalSessions: number;
}

// ── New multi-period types ──────────────────────────────────────────────

export interface TimePeriod {
	label: string;
	start: Date;
	end: Date;
	metrics: PeriodMetrics;
}

export interface AnalysisTimeline {
	periods: TimePeriod[];
	totalSessions: number;
}

export interface GroupSummary {
	groupKey: string;
	sessionCount: number;
	totalToolCalls: number;
	avgReadEditRatio: number | null;
	avgErrorRate: number | null;
	sparklineReadEdit: (number | null)[];
	sparklineErrorRate: (number | null)[];
}

export interface DateComparison {
	splitDate: Date;
	before: PeriodMetrics;
	after: PeriodMetrics;
}

export interface FullSessionAnalysis {
	current: SessionAnalysis;
	timeline: AnalysisTimeline | null;
	groups: {
		byModel: GroupSummary[];
		byType: GroupSummary[];
	} | null;
	comparison: DateComparison | null;
	trend: { currentPeriod: PeriodMetrics; previousPeriod: PeriodMetrics; totalSessions: number } | null;
}

// ── Read / Edit tool sets ───────────────────────────────────────────────

const READ_TOOLS = new Set(["read", "grep", "search", "find", "ls", "web_search", "web_fetch"]);
const EDIT_TOOLS = new Set(["edit", "write"]);

// ── Self-correction patterns ────────────────────────────────────────────

const SELF_CORRECTION_PATTERNS: RegExp[] = [
	/\bactually,?\s/i,
	/\bwait,/i,
	/\bno wait\b/i,
	/\bI was wrong\b/i,
	/\blet me reconsider\b/i,
	/\bI made a mistake\b/i,
	/\bI need to correct\b/i,
];

// ── extractAnalysisInput ────────────────────────────────────────────────

export function extractAnalysisInput(messages: Message[]): AnalysisInput {
	const toolCalls: ToolCallRecord[] = [];
	const assistantTexts: string[] = [];
	const turns: TurnSummary[] = [];
	let totalCost = 0;
	let totalTokens = 0;

	const pendingToolCalls = new Map<string, { name: string; timestamp: number }>();

	let currentTurn: { timestamp: number; toolCallNames: string[]; toolCallIds: string[] } | null = null;
	let turnIndex = 0;

	for (const msg of messages) {
		if (msg.role === "assistant") {
			if (currentTurn) {
				turns.push({
					index: currentTurn === null ? 0 : turnIndex,
					timestamp: currentTurn.timestamp,
					toolCalls: currentTurn.toolCallNames.length,
					tools: currentTurn.toolCallNames,
				});
				turnIndex++;
			}

			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.usage) {
				totalCost += assistantMsg.usage.cost?.total ?? 0;
				totalTokens += assistantMsg.usage.totalTokens ?? 0;
			}
			const turnToolNames: string[] = [];
			const turnToolIds: string[] = [];

			for (const block of assistantMsg.content) {
				if (block.type === "text") {
					assistantTexts.push((block as TextContent).text);
				} else if (block.type === "toolCall") {
					const tc = block as ToolCall;
					pendingToolCalls.set(tc.id, { name: tc.name, timestamp: assistantMsg.timestamp });
					turnToolNames.push(tc.name);
					turnToolIds.push(tc.id);
				}
			}

			currentTurn = {
				timestamp: assistantMsg.timestamp,
				toolCallNames: turnToolNames,
				toolCallIds: turnToolIds,
			};
		} else if (msg.role === "toolResult") {
			const tr = msg as ToolResultMessage;
			const pending = pendingToolCalls.get(tr.toolCallId);
			toolCalls.push({
				name: pending?.name ?? tr.toolName,
				isError: tr.isError,
				timestamp: tr.timestamp,
			});
		}
	}

	if (currentTurn) {
		turns.push({
			index: turnIndex,
			timestamp: currentTurn.timestamp,
			toolCalls: currentTurn.toolCallNames.length,
			tools: currentTurn.toolCallNames,
		});
	}

	return {
		toolCalls,
		assistantTexts,
		turns,
		totalTurns: turns.length,
		totalCost,
		totalTokens,
	};
}

// ── Metric functions ────────────────────────────────────────────────────

export function computeReadEditRatio(input: AnalysisInput): number | null {
	let readCount = 0;
	let editCount = 0;
	for (const tc of input.toolCalls) {
		if (READ_TOOLS.has(tc.name)) readCount++;
		if (EDIT_TOOLS.has(tc.name)) editCount++;
	}
	if (editCount === 0) return null;
	return readCount / editCount;
}

export function computeWriteVsEditPercent(input: AnalysisInput): number | null {
	let writeCount = 0;
	let editCount = 0;
	for (const tc of input.toolCalls) {
		if (tc.name === "write") writeCount++;
		if (tc.name === "edit") editCount++;
	}
	const total = writeCount + editCount;
	if (total === 0) return null;
	return (writeCount / total) * 100;
}

export function computeErrorRate(input: AnalysisInput): number | null {
	const total = input.toolCalls.length;
	if (total === 0) return null;
	const errors = input.toolCalls.filter((tc) => tc.isError).length;
	return (errors / total) * 100;
}

export function computeSelfCorrectionFrequency(input: AnalysisInput): number | null {
	const totalToolCalls = input.toolCalls.length;
	if (totalToolCalls === 0) return null;

	let matchCount = 0;
	for (const text of input.assistantTexts) {
		for (const pattern of SELF_CORRECTION_PATTERNS) {
			const matches = text.match(new RegExp(pattern, "gi"));
			if (matches) matchCount += matches.length;
		}
	}

	return (matchCount / totalToolCalls) * 1000;
}

export function computeToolDistribution(input: AnalysisInput): Record<string, number> {
	const dist: Record<string, number> = {};
	for (const tc of input.toolCalls) {
		dist[tc.name] = (dist[tc.name] ?? 0) + 1;
	}
	return dist;
}

// ── analyzeSession ──────────────────────────────────────────────────────

export function analyzeSession(
	messages: Message[],
	metadata: { sessionId: string; sessionFile?: string; isSubagent: boolean; agentType?: string },
): SessionAnalysis {
	const input = extractAnalysisInput(messages);

	const firstAssistant = messages.find((m) => m.role === "assistant") as AssistantMessage | undefined;
	const firstMessage = messages[0];
	const timestamp = firstMessage ? new Date(firstMessage.timestamp) : new Date();

	return {
		sessionId: metadata.sessionId,
		sessionFile: metadata.sessionFile,
		timestamp,
		model: firstAssistant?.model,
		provider: firstAssistant?.provider,
		isSubagent: metadata.isSubagent,
		agentType: metadata.agentType,
		readEditRatio: computeReadEditRatio(input),
		writeVsEditPercent: computeWriteVsEditPercent(input),
		errorRate: computeErrorRate(input),
		selfCorrectionPer1K: computeSelfCorrectionFrequency(input),
		toolDistribution: computeToolDistribution(input),
		totalToolCalls: input.toolCalls.length,
		totalCost: input.totalCost,
		totalTokens: input.totalTokens,
		timeline: input.turns,
	};
}

// ── Period/trend helpers ────────────────────────────────────────────────

function averageNonNull(values: (number | null)[]): number | null {
	const valid = values.filter((v): v is number => v !== null);
	if (valid.length === 0) return null;
	return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function mergeToolDistributions(sessions: SessionAnalysis[]): Record<string, number> {
	const merged: Record<string, number> = {};
	for (const s of sessions) {
		for (const [name, count] of Object.entries(s.toolDistribution)) {
			merged[name] = (merged[name] ?? 0) + count;
		}
	}
	return merged;
}

function buildPeriodMetrics(label: string, sessions: SessionAnalysis[]): PeriodMetrics {
	const totalToolCalls = sessions.reduce((sum, s) => sum + s.totalToolCalls, 0);
	const totalCost = sessions.reduce((sum, s) => sum + s.totalCost, 0);
	const totalTokens = sessions.reduce((sum, s) => sum + s.totalTokens, 0);
	return {
		label,
		sessionCount: sessions.length,
		avgReadEditRatio: averageNonNull(sessions.map((s) => s.readEditRatio)),
		avgWriteVsEditPercent: averageNonNull(sessions.map((s) => s.writeVsEditPercent)),
		avgErrorRate: averageNonNull(sessions.map((s) => s.errorRate)),
		avgSelfCorrectionPer1K: averageNonNull(sessions.map((s) => s.selfCorrectionPer1K)),
		toolDistribution: mergeToolDistributions(sessions),
		totalToolCalls,
		totalCost,
		totalTokens,
		avgCostPerToolCall: totalToolCalls > 0 ? totalCost / totalToolCalls : null,
		avgTokensPerToolCall: totalToolCalls > 0 ? totalTokens / totalToolCalls : null,
	};
}

export function computeProjectTrend(sessions: SessionAnalysis[]): ProjectTrend | null {
	if (sessions.length < 2) return null;

	const now = Date.now();
	const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

	const thisWeek = sessions.filter((s) => {
		const age = now - s.timestamp.getTime();
		return age >= 0 && age < oneWeekMs;
	});

	const previousWeek = sessions.filter((s) => {
		const age = now - s.timestamp.getTime();
		return age >= oneWeekMs && age < 2 * oneWeekMs;
	});

	if (thisWeek.length === 0 && previousWeek.length === 0) return null;

	return {
		currentPeriod: buildPeriodMetrics("This week", thisWeek),
		previousPeriod: buildPeriodMetrics("Previous week", previousWeek),
		totalSessions: sessions.length,
	};
}

// ── Sparkline ───────────────────────────────────────────────────────────

const SPARK_CHARS = "▁▂▃▄▅▆▇█";

export function sparkline(values: (number | null)[]): string {
	const nonNull = values.filter((v): v is number => v !== null);
	if (nonNull.length === 0) return "";

	const min = Math.min(...nonNull);
	const max = Math.max(...nonNull);

	return values
		.map((v) => {
			if (v === null) return " ";
			if (max === min) return SPARK_CHARS[4]; // ▄
			const idx = Math.round(((v - min) / (max - min)) * 7);
			return SPARK_CHARS[idx];
		})
		.join("");
}

// ── computeTimeline ─────────────────────────────────────────────────────

function getMondayOfWeek(date: Date): Date {
	const d = new Date(date);
	const day = d.getDay(); // 0=Sun, 1=Mon, ...
	const diff = day === 0 ? -6 : 1 - day;
	d.setDate(d.getDate() + diff);
	d.setHours(0, 0, 0, 0);
	return d;
}

function formatShortDate(date: Date): string {
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return `${months[date.getMonth()]} ${date.getDate()}`;
}

export function computeTimeline(sessions: SessionAnalysis[], numWeeks = 8): AnalysisTimeline | null {
	if (sessions.length < 2) return null;

	const now = new Date();
	const currentMonday = getMondayOfWeek(now);
	const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

	const periods: TimePeriod[] = [];
	for (let i = numWeeks - 1; i >= 0; i--) {
		const start = new Date(currentMonday.getTime() - i * oneWeekMs);
		const end = new Date(start.getTime() + oneWeekMs);
		const label = formatShortDate(start);

		const bucket = sessions.filter((s) => {
			const t = s.timestamp.getTime();
			return t >= start.getTime() && t < end.getTime();
		});

		periods.push({
			label,
			start,
			end,
			metrics: buildPeriodMetrics(label, bucket),
		});
	}

	return {
		periods,
		totalSessions: sessions.length,
	};
}

// ── computeGroups ───────────────────────────────────────────────────────

function buildGroupSummary(
	groupKey: string,
	sessions: SessionAnalysis[],
	timeline: AnalysisTimeline | null,
): GroupSummary {
	const sessionCount = sessions.length;
	const totalToolCalls = sessions.reduce((sum, s) => sum + s.totalToolCalls, 0);
	const avgReadEditRatio = averageNonNull(sessions.map((s) => s.readEditRatio));
	const avgErrorRate = averageNonNull(sessions.map((s) => s.errorRate));

	const sparklineReadEdit: (number | null)[] = [];
	const sparklineErrorRate: (number | null)[] = [];

	if (timeline) {
		for (const period of timeline.periods) {
			const inPeriod = sessions.filter((s) => {
				const t = s.timestamp.getTime();
				return t >= period.start.getTime() && t < period.end.getTime();
			});
			sparklineReadEdit.push(inPeriod.length > 0 ? averageNonNull(inPeriod.map((s) => s.readEditRatio)) : null);
			sparklineErrorRate.push(inPeriod.length > 0 ? averageNonNull(inPeriod.map((s) => s.errorRate)) : null);
		}
	}

	return {
		groupKey,
		sessionCount,
		totalToolCalls,
		avgReadEditRatio,
		avgErrorRate,
		sparklineReadEdit,
		sparklineErrorRate,
	};
}

export function computeGroups(
	sessions: SessionAnalysis[],
	timeline: AnalysisTimeline | null,
): { byModel: GroupSummary[]; byType: GroupSummary[] } | null {
	if (sessions.length < 2) return null;

	// By model
	const modelMap = new Map<string, SessionAnalysis[]>();
	for (const s of sessions) {
		const key = s.model ?? "unknown";
		const arr = modelMap.get(key);
		if (arr) arr.push(s);
		else modelMap.set(key, [s]);
	}

	const byModel = Array.from(modelMap.entries())
		.map(([key, group]) => buildGroupSummary(key, group, timeline))
		.sort((a, b) => b.sessionCount - a.sessionCount)
		.slice(0, 5);

	// By type
	const typeMap = new Map<string, SessionAnalysis[]>();
	for (const s of sessions) {
		const key = s.isSubagent ? (s.agentType ?? "unknown subagent") : "parent";
		const arr = typeMap.get(key);
		if (arr) arr.push(s);
		else typeMap.set(key, [s]);
	}

	const byType = Array.from(typeMap.entries())
		.map(([key, group]) => buildGroupSummary(key, group, timeline))
		.sort((a, b) => b.sessionCount - a.sessionCount);

	return { byModel, byType };
}

// ── computeDateComparison ───────────────────────────────────────────────

export function computeDateComparison(sessions: SessionAnalysis[], splitDate: Date): DateComparison {
	const before = sessions.filter((s) => s.timestamp.getTime() < splitDate.getTime());
	const after = sessions.filter((s) => s.timestamp.getTime() >= splitDate.getTime());

	return {
		splitDate,
		before: buildPeriodMetrics(`Before ${formatShortDate(splitDate)}`, before),
		after: buildPeriodMetrics(`After ${formatShortDate(splitDate)}`, after),
	};
}

// ── Format helpers ──────────────────────────────────────────────────────

function bar(count: number, max: number, maxWidth = 30): string {
	if (max === 0) return "";
	const width = Math.round((count / max) * maxWidth);
	return "█".repeat(width);
}

function fmtNum(v: number | null, suffix = ""): string {
	if (v === null) return "n/a";
	return `${v.toFixed(1)}${suffix}`;
}

function changeStr(current: number | null, previous: number | null): string {
	if (current === null || previous === null) return "—";
	if (previous === 0) {
		if (current === 0) return "→";
		return "↑ new";
	}
	const change = ((current - previous) / Math.abs(previous)) * 100;
	if (Math.abs(change) < 1) return "→";
	const arrow = change > 0 ? "↑" : "↓";
	return `${arrow} ${change > 0 ? "+" : ""}${change.toFixed(0)}%`;
}

/** Build per-tool sparkline data from a timeline */
function buildToolSparklines(timeline: AnalysisTimeline, topN = 5): { toolName: string; spark: string }[] {
	// Aggregate total tool calls across all periods
	const totalByTool = new Map<string, number>();
	for (const period of timeline.periods) {
		for (const [name, count] of Object.entries(period.metrics.toolDistribution)) {
			totalByTool.set(name, (totalByTool.get(name) ?? 0) + count);
		}
	}

	const topTools = Array.from(totalByTool.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, topN)
		.map(([name]) => name);

	return topTools.map((toolName) => {
		const values = timeline.periods.map((p) => {
			const count = p.metrics.toolDistribution[toolName];
			return count !== undefined && count > 0 ? count : null;
		});
		return { toolName, spark: sparkline(values) };
	});
}

// ── formatAnalysisForTui ────────────────────────────────────────────────

export function formatAnalysisForTui(analysis: FullSessionAnalysis): string {
	const { current, timeline, groups, comparison } = analysis;
	const lines: string[] = [];

	// ── Current Session ──
	lines.push("── Current Session ──");
	lines.push("");
	if (current.model) lines.push(`  Model:              ${current.model}`);
	if (current.provider) lines.push(`  Provider:           ${current.provider}`);
	lines.push(`  Subagent:           ${current.isSubagent ? "yes" : "no"}`);
	if (current.agentType) lines.push(`  Agent type:         ${current.agentType}`);
	lines.push(`  Total tool calls:   ${current.totalToolCalls}`);
	lines.push(`  Tokens:             ${current.totalTokens.toLocaleString()}`);
	lines.push(`  Cost:               $${current.totalCost.toFixed(4)}`);
	lines.push(`  Read/Edit ratio:    ${fmtNum(current.readEditRatio)}`);
	lines.push(`  Write vs Edit:      ${fmtNum(current.writeVsEditPercent, "%")}`);
	lines.push(`  Error rate:         ${fmtNum(current.errorRate, "%")}`);
	lines.push(`  Self-corrections:   ${fmtNum(current.selfCorrectionPer1K, " per 1K calls")}`);
	lines.push("");

	// ── Tool Distribution ──
	const dist = current.toolDistribution;
	const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
	if (entries.length > 0) {
		lines.push("── Tool Distribution ──");
		lines.push("");
		const maxCount = entries[0][1];
		const maxNameLen = Math.max(...entries.map(([n]) => n.length));
		const maxCountLen = Math.max(...entries.map(([, c]) => String(c).length));
		for (const [name, count] of entries) {
			const paddedName = name.padEnd(maxNameLen);
			const paddedCount = String(count).padStart(maxCountLen);
			lines.push(`  ${paddedName}  ${paddedCount}  ${bar(count, maxCount)}`);
		}
		lines.push("");
	}

	// ── Trends (sparkline section) ──
	if (timeline) {
		const weekCount = timeline.periods.length;
		lines.push(`── Trends (${timeline.totalSessions} sessions, ${weekCount} weeks) ──`);
		lines.push("");

		// Period header labels
		const periodLabels = timeline.periods.map((p) => p.label);
		const labelHeader = `${"".padEnd(16)}${periodLabels.map((l) => l.padEnd(7)).join("")}`;
		lines.push(labelHeader);

		// Overall metric sparklines
		const readEditValues = timeline.periods.map((p) => p.metrics.avgReadEditRatio);
		const errorValues = timeline.periods.map((p) => p.metrics.avgErrorRate);
		const selfCorrValues = timeline.periods.map((p) => p.metrics.avgSelfCorrectionPer1K);

		const avgRE = averageNonNull(readEditValues);
		const avgErr = averageNonNull(errorValues);
		const avgSC = averageNonNull(selfCorrValues);

		const costValues = timeline.periods.map((p) => (p.metrics.totalCost > 0 ? p.metrics.totalCost : null));
		const tokensPerCallValues = timeline.periods.map((p) => p.metrics.avgTokensPerToolCall);
		const avgCost = averageNonNull(costValues);
		const avgTPC = averageNonNull(tokensPerCallValues);

		lines.push(`  Read:Edit     ${sparkline(readEditValues)}   avg ${fmtNum(avgRE)}`);
		lines.push(`  Error Rate    ${sparkline(errorValues)}   avg ${fmtNum(avgErr, "%")}`);
		lines.push(`  Self-Correct  ${sparkline(selfCorrValues)}   avg ${fmtNum(avgSC, "/1K")}`);
		lines.push(`  Cost/week     ${sparkline(costValues)}   avg $${avgCost != null ? avgCost.toFixed(4) : "n/a"}`);
		lines.push(
			`  Tokens/call   ${sparkline(tokensPerCallValues)}   avg ${avgTPC != null ? Math.round(avgTPC).toLocaleString() : "n/a"}`,
		);
		lines.push("");

		// Per-tool sparklines
		const toolSparks = buildToolSparklines(timeline);
		if (toolSparks.length > 0) {
			const maxToolName = Math.max(...toolSparks.map((t) => t.toolName.length));
			for (const { toolName, spark } of toolSparks) {
				lines.push(`  Tool: ${toolName.padEnd(maxToolName)}  ${spark}`);
			}
			lines.push("");
		}
	}

	// ── By Model ──
	if (groups && groups.byModel.length > 0) {
		lines.push("── By Model ──");
		lines.push("");
		const maxKeyLen = Math.max(...groups.byModel.map((g) => g.groupKey.length));
		for (const g of groups.byModel) {
			const key = g.groupKey.padEnd(maxKeyLen);
			const count = `${g.sessionCount} sessions`.padEnd(14);
			const re = `R:E ${fmtNum(g.avgReadEditRatio)}`.padEnd(10);
			const err = `Err ${fmtNum(g.avgErrorRate, "%")}`.padEnd(11);
			const spark = sparkline(g.sparklineReadEdit);
			lines.push(`  ${key}  ${count}  ${re}  ${err}  ${spark}`);
		}
		lines.push("");
	}

	// ── By Type ──
	if (groups && groups.byType.length > 0) {
		lines.push("── By Type ──");
		lines.push("");
		const maxKeyLen = Math.max(...groups.byType.map((g) => g.groupKey.length));
		for (const g of groups.byType) {
			const key = g.groupKey.padEnd(maxKeyLen);
			const count = `${g.sessionCount} sessions`.padEnd(14);
			const re = `R:E ${fmtNum(g.avgReadEditRatio)}`.padEnd(10);
			const err = `Err ${fmtNum(g.avgErrorRate, "%")}`.padEnd(11);
			const spark = sparkline(g.sparklineReadEdit);
			lines.push(`  ${key}  ${count}  ${re}  ${err}  ${spark}`);
		}
		lines.push("");
	}

	// ── Date Comparison ──
	if (comparison) {
		const splitStr = comparison.splitDate.toISOString().slice(0, 10);
		lines.push(`── Comparison: split at ${splitStr} ──`);
		lines.push("");
		const { before: b, after: a } = comparison;
		const colW = 13;
		const hdrBefore = `Before (${b.sessionCount})`.padEnd(colW);
		const hdrAfter = `After (${a.sessionCount})`.padEnd(colW);
		lines.push(`${"".padEnd(20)} ${hdrBefore} ${hdrAfter}  Change`);
		lines.push(
			`  Read:Edit          ${fmtNum(b.avgReadEditRatio).padEnd(colW)} ${fmtNum(a.avgReadEditRatio).padEnd(colW)}  ${changeStr(a.avgReadEditRatio, b.avgReadEditRatio)}`,
		);
		lines.push(
			`  Write vs Edit      ${fmtNum(b.avgWriteVsEditPercent, "%").padEnd(colW)} ${fmtNum(a.avgWriteVsEditPercent, "%").padEnd(colW)}  ${changeStr(a.avgWriteVsEditPercent, b.avgWriteVsEditPercent)}`,
		);
		lines.push(
			`  Error Rate         ${fmtNum(b.avgErrorRate, "%").padEnd(colW)} ${fmtNum(a.avgErrorRate, "%").padEnd(colW)}  ${changeStr(a.avgErrorRate, b.avgErrorRate)}`,
		);
		lines.push(
			`  Self-Correction    ${fmtNum(b.avgSelfCorrectionPer1K, "/1K").padEnd(colW)} ${fmtNum(a.avgSelfCorrectionPer1K, "/1K").padEnd(colW)}  ${changeStr(a.avgSelfCorrectionPer1K, b.avgSelfCorrectionPer1K)}`,
		);
		lines.push(
			`  Cost               $${b.totalCost.toFixed(4).padEnd(colW - 1)} $${a.totalCost.toFixed(4).padEnd(colW - 1)}  ${changeStr(a.totalCost, b.totalCost)}`,
		);
		lines.push(
			`  Tokens/call        ${fmtNum(b.avgTokensPerToolCall).padEnd(colW)} ${fmtNum(a.avgTokensPerToolCall).padEnd(colW)}  ${changeStr(a.avgTokensPerToolCall, b.avgTokensPerToolCall)}`,
		);
		lines.push("");
	}

	// ── Footer ──
	lines.push("Note: These metrics are noisy proxies for session behavior, not quality scores.");
	lines.push("Use them for self-reflection, not performance evaluation.");

	return lines.join("\n");
}

// ── formatAnalysisForTelegram ───────────────────────────────────────────

export function formatAnalysisForTelegram(analysis: FullSessionAnalysis): string {
	const { current, timeline, groups, comparison } = analysis;
	const lines: string[] = [];

	// ── Current Session ──
	lines.push("📊 *Session Analysis*");
	lines.push("");
	if (current.model) lines.push(`Model: \`${current.model}\``);
	if (current.provider) lines.push(`Provider: \`${current.provider}\``);
	lines.push(`Subagent: ${current.isSubagent ? "yes" : "no"}`);
	if (current.agentType) lines.push(`Type: \`${current.agentType}\``);
	lines.push(`Total tool calls: ${current.totalToolCalls}`);
	lines.push(`Tokens: ${current.totalTokens.toLocaleString()} | Cost: $${current.totalCost.toFixed(4)}`);
	lines.push("");
	lines.push("```");
	lines.push(`Read/Edit ratio:   ${fmtNum(current.readEditRatio)}`);
	lines.push(`Write vs Edit:     ${fmtNum(current.writeVsEditPercent, "%")}`);
	lines.push(`Error rate:        ${fmtNum(current.errorRate, "%")}`);
	lines.push(`Self-corrections:  ${fmtNum(current.selfCorrectionPer1K, "/1K")}`);
	lines.push("```");

	// ── Tool Distribution ──
	const dist = current.toolDistribution;
	const distEntries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
	if (distEntries.length > 0) {
		lines.push("");
		lines.push("🔧 *Tool Distribution*");
		lines.push("");
		lines.push("```");
		const maxNameLen = Math.max(...distEntries.map(([n]) => n.length));
		const maxCountLen = Math.max(...distEntries.map(([, c]) => String(c).length));
		for (const [name, count] of distEntries) {
			lines.push(`${name.padEnd(maxNameLen)}  ${String(count).padStart(maxCountLen)}`);
		}
		lines.push("```");
	}

	// ── Trends ──
	if (timeline) {
		lines.push("");
		lines.push(`📈 *Trends* (${timeline.totalSessions} sessions, ${timeline.periods.length} weeks)`);
		lines.push("");

		const readEditValues = timeline.periods.map((p) => p.metrics.avgReadEditRatio);
		const errorValues = timeline.periods.map((p) => p.metrics.avgErrorRate);
		const selfCorrValues = timeline.periods.map((p) => p.metrics.avgSelfCorrectionPer1K);

		const costValues = timeline.periods.map((p) => (p.metrics.totalCost > 0 ? p.metrics.totalCost : null));
		const avgCostTg = averageNonNull(costValues);

		lines.push("```");
		lines.push(`Read:Edit    ${sparkline(readEditValues)}  avg ${fmtNum(averageNonNull(readEditValues))}`);
		lines.push(`Error Rate   ${sparkline(errorValues)}  avg ${fmtNum(averageNonNull(errorValues), "%")}`);
		lines.push(`Self-Corr    ${sparkline(selfCorrValues)}  avg ${fmtNum(averageNonNull(selfCorrValues), "/1K")}`);
		lines.push(`Cost/week    ${sparkline(costValues)}  avg $${avgCostTg != null ? avgCostTg.toFixed(4) : "n/a"}`);
		lines.push("```");
	}

	// ── By Model (top 3) ──
	if (groups && groups.byModel.length > 0) {
		lines.push("");
		lines.push("🤖 *By Model*");
		lines.push("");
		lines.push("```");
		const top = groups.byModel.slice(0, 3);
		const maxKeyLen = Math.max(...top.map((g) => g.groupKey.length));
		for (const g of top) {
			const key = g.groupKey.padEnd(maxKeyLen);
			const spark = sparkline(g.sparklineReadEdit);
			lines.push(`${key}  ${String(g.sessionCount).padStart(3)}s  R:E ${fmtNum(g.avgReadEditRatio)}  ${spark}`);
		}
		lines.push("```");
	}

	// ── By Type (top 3) ──
	if (groups && groups.byType.length > 0) {
		lines.push("");
		lines.push("🏷️ *By Type*");
		lines.push("");
		lines.push("```");
		const top = groups.byType.slice(0, 3);
		const maxKeyLen = Math.max(...top.map((g) => g.groupKey.length));
		for (const g of top) {
			const key = g.groupKey.padEnd(maxKeyLen);
			const spark = sparkline(g.sparklineReadEdit);
			lines.push(`${key}  ${String(g.sessionCount).padStart(3)}s  R:E ${fmtNum(g.avgReadEditRatio)}  ${spark}`);
		}
		lines.push("```");
	}

	// ── Date Comparison ──
	if (comparison) {
		const splitStr = comparison.splitDate.toISOString().slice(0, 10);
		const { before: b, after: a } = comparison;
		lines.push("");
		lines.push(`📅 *Comparison: split at ${splitStr}*`);
		lines.push("");
		lines.push("```");
		lines.push(`              Before(${b.sessionCount})  After(${a.sessionCount})  Change`);
		lines.push(
			`Read:Edit     ${fmtNum(b.avgReadEditRatio).padEnd(11)} ${fmtNum(a.avgReadEditRatio).padEnd(10)} ${changeStr(a.avgReadEditRatio, b.avgReadEditRatio)}`,
		);
		lines.push(
			`Write/Edit    ${fmtNum(b.avgWriteVsEditPercent, "%").padEnd(11)} ${fmtNum(a.avgWriteVsEditPercent, "%").padEnd(10)} ${changeStr(a.avgWriteVsEditPercent, b.avgWriteVsEditPercent)}`,
		);
		lines.push(
			`Error Rate    ${fmtNum(b.avgErrorRate, "%").padEnd(11)} ${fmtNum(a.avgErrorRate, "%").padEnd(10)} ${changeStr(a.avgErrorRate, b.avgErrorRate)}`,
		);
		lines.push(
			`Self-Corr     ${fmtNum(b.avgSelfCorrectionPer1K, "/1K").padEnd(11)} ${fmtNum(a.avgSelfCorrectionPer1K, "/1K").padEnd(10)} ${changeStr(a.avgSelfCorrectionPer1K, b.avgSelfCorrectionPer1K)}`,
		);
		lines.push(
			`Cost          $${b.totalCost.toFixed(4).padEnd(10)} $${a.totalCost.toFixed(4).padEnd(9)} ${changeStr(a.totalCost, b.totalCost)}`,
		);
		lines.push("```");
	}

	// ── Footer ──
	lines.push("");
	lines.push("_These metrics are noisy proxies, not quality scores._");

	return lines.join("\n");
}
