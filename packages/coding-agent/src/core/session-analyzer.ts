import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@dreb/agent-core";
import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage } from "@dreb/ai";
import { getSessionsDir, getSubagentSessionsDir } from "../config.js";
import {
	loadEntriesFromFile,
	type SessionEntry,
	type SessionHeader,
	type SessionMessageEntry,
} from "./session-manager.js";

// =============================================================================
// Types
// =============================================================================

export interface SessionMetrics {
	sessionId: string;
	sessionFile: string;
	cwd: string;
	date: Date;
	model: string;
	provider: string;
	isSubagent: boolean;

	// Metrics
	errorRate: number;
	readEditRatio: number | null;
	writeVsEditPercent: number | null;
	toolDistribution: Record<string, number>;
	selfCorrectionFrequency: number;
	simplestFixMentions: number;
	toolCallVolume: number;
	sessionLengthTurns: number;
	totalTokens: number;
	tokensPerToolCall: number | null;
	successfulEnd: boolean;
	aborted: boolean;
	uniqueFilesTouched: number;
	totalCost: number;
}

export interface AggregateStats {
	sessionCount: number;
	meanErrorRate: number;
	meanReadEditRatio: number | null;
	meanWriteVsEditPercent: number | null;
	meanSelfCorrectionFreq: number;
	meanSimplestFixMentions: number;
	meanToolCallVolume: number;
	meanSessionLength: number;
	meanTokensPerToolCall: number | null;
	successRate: number;
	abortRate: number;
	totalCost: number;
}

export interface TimeSeriesPoint {
	date: Date;
	value: number;
	rollingAvg: number | null;
}

export interface ModelBreakdown {
	model: string;
	provider: string;
	stats: AggregateStats;
	lowN: boolean;
}

export interface ProjectBreakdown {
	cwd: string;
	stats: AggregateStats;
}

export interface AnalysisResult {
	generatedAt: Date;
	totalSessions: number;
	dateRange: { start: Date; end: Date };
	splitDate?: Date;

	sessions: SessionMetrics[];

	timeSeries: {
		errorRate: TimeSeriesPoint[];
		readEditRatio: TimeSeriesPoint[];
		writeVsEditPercent: TimeSeriesPoint[];
		selfCorrectionFreq: TimeSeriesPoint[];
		simplestFixMentions: TimeSeriesPoint[];
		toolCallVolume: TimeSeriesPoint[];
		sessionLength: TimeSeriesPoint[];
		tokensPerToolCall: TimeSeriesPoint[];
		successRate: TimeSeriesPoint[];
		abortRate: TimeSeriesPoint[];
	};

	modelDistribution: Array<{ date: Date; models: Record<string, number> }>;

	modelBreakdown: ModelBreakdown[];
	projectBreakdown: ProjectBreakdown[];
	parentVsSubagent: { parent: AggregateStats; subagent: AggregateStats };

	beforeAfter?: { before: AggregateStats; after: AggregateStats };
}

// =============================================================================
// Helpers
// =============================================================================

const SELF_CORRECTION_RE =
	/\b(actually|wait|no wait|let me reconsider|I was wrong|that's not right|correction|my mistake)\b/i;

const SIMPLEST_FIX_RE = /\b(simplest fix|easiest way|just do|quick fix|simple fix|straightforward fix)\b/i;

function isAssistantMessage(msg: AgentMessage): msg is AssistantMessage {
	return (msg as AssistantMessage).role === "assistant";
}

function isToolResultMessage(msg: AgentMessage): msg is ToolResultMessage {
	return (msg as ToolResultMessage).role === "toolResult";
}

function getToolCalls(msg: AssistantMessage): ToolCall[] {
	if (!Array.isArray(msg.content)) return [];
	return msg.content.filter((c): c is ToolCall => c.type === "toolCall");
}

function getTextContent(msg: AssistantMessage): string {
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join(" ");
}

function countMatches(text: string, regex: RegExp): number {
	const globalRegex = new RegExp(regex.source, "gi");
	const matches = text.match(globalRegex);
	return matches ? matches.length : 0;
}

function dateKey(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function meanOfValues(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function meanOfNonNull(values: (number | null)[]): number | null {
	const valid = values.filter((v): v is number => v !== null);
	if (valid.length === 0) return null;
	return valid.reduce((sum, v) => sum + v, 0) / valid.length;
}

// =============================================================================
// Per-Session Metrics
// =============================================================================

export function computeSessionMetrics(
	header: SessionHeader,
	entries: SessionEntry[],
	sessionFile: string,
	isSubagent: boolean,
): SessionMetrics {
	const assistantMessages: AssistantMessage[] = [];
	const toolResultMessages: ToolResultMessage[] = [];
	const allToolCalls: ToolCall[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = (entry as SessionMessageEntry).message;
		if (isAssistantMessage(msg)) {
			assistantMessages.push(msg);
			for (const tc of getToolCalls(msg)) {
				allToolCalls.push(tc);
			}
		} else if (isToolResultMessage(msg)) {
			toolResultMessages.push(msg);
		}
	}

	const totalToolCalls = allToolCalls.length;

	// Error rate: isError tool results / total tool results
	const errorToolResults = toolResultMessages.filter((m) => m.isError).length;
	const totalToolResults = toolResultMessages.length;
	const errorRate = totalToolResults > 0 ? errorToolResults / totalToolResults : 0;

	// Tool name counts
	const toolCounts: Record<string, number> = {};
	for (const tc of allToolCalls) {
		toolCounts[tc.name] = (toolCounts[tc.name] || 0) + 1;
	}

	// Read/edit ratio
	const readCount = toolCounts.read || 0;
	const editCount = toolCounts.edit || 0;
	const readEditRatio = editCount > 0 ? readCount / editCount : null;

	// Write vs edit percent
	const writeCount = toolCounts.write || 0;
	const writeVsEditPercent = writeCount + editCount > 0 ? (writeCount / (writeCount + editCount)) * 100 : null;

	// Tool distribution (percentages)
	const toolDistribution: Record<string, number> = {};
	if (totalToolCalls > 0) {
		for (const [name, count] of Object.entries(toolCounts)) {
			toolDistribution[name] = (count / totalToolCalls) * 100;
		}
	}

	// Self-correction frequency (per 1K tool calls)
	let selfCorrectionCount = 0;
	let simplestFixCount = 0;
	for (const msg of assistantMessages) {
		const text = getTextContent(msg);
		selfCorrectionCount += countMatches(text, SELF_CORRECTION_RE);
		simplestFixCount += countMatches(text, SIMPLEST_FIX_RE);
	}
	const selfCorrectionFrequency = totalToolCalls > 0 ? (selfCorrectionCount / totalToolCalls) * 1000 : 0;
	const simplestFixMentions = totalToolCalls > 0 ? (simplestFixCount / totalToolCalls) * 1000 : 0;

	// Model/provider: most frequently used
	const modelCounts: Record<string, number> = {};
	const providerCounts: Record<string, number> = {};
	for (const msg of assistantMessages) {
		if (msg.model) {
			modelCounts[msg.model] = (modelCounts[msg.model] || 0) + 1;
		}
		if (msg.provider) {
			providerCounts[msg.provider] = (providerCounts[msg.provider] || 0) + 1;
		}
	}
	const model = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";
	const provider = Object.entries(providerCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

	// Successful end / aborted
	const lastAssistant = assistantMessages[assistantMessages.length - 1];
	const successfulEnd = lastAssistant?.stopReason === "stop";
	const aborted = lastAssistant ? lastAssistant.stopReason === "aborted" : assistantMessages.length === 0;

	// Unique files touched
	const filePaths = new Set<string>();
	for (const tc of allToolCalls) {
		if ((tc.name === "read" || tc.name === "edit" || tc.name === "write") && tc.arguments?.path) {
			filePaths.add(tc.arguments.path as string);
		}
	}

	// Total tokens
	const totalTokens = assistantMessages.reduce((sum, msg) => sum + (msg.usage?.totalTokens || 0), 0);

	// Total cost
	const totalCost = assistantMessages.reduce((sum, msg) => sum + (msg.usage?.cost?.total || 0), 0);

	// Tokens per tool call
	const tokensPerToolCall = totalToolCalls > 0 ? totalTokens / totalToolCalls : null;

	return {
		sessionId: header.id,
		sessionFile,
		cwd: header.cwd || "",
		date: new Date(header.timestamp),
		model,
		provider,
		isSubagent,
		errorRate,
		readEditRatio,
		writeVsEditPercent,
		toolDistribution,
		selfCorrectionFrequency,
		simplestFixMentions,
		toolCallVolume: totalToolCalls,
		sessionLengthTurns: assistantMessages.length,
		totalTokens,
		tokensPerToolCall,
		successfulEnd,
		aborted,
		uniqueFilesTouched: filePaths.size,
		totalCost,
	};
}

// =============================================================================
// Aggregate Stats
// =============================================================================

export function computeAggregateStats(sessions: SessionMetrics[]): AggregateStats {
	if (sessions.length === 0) {
		return {
			sessionCount: 0,
			meanErrorRate: 0,
			meanReadEditRatio: null,
			meanWriteVsEditPercent: null,
			meanSelfCorrectionFreq: 0,
			meanSimplestFixMentions: 0,
			meanToolCallVolume: 0,
			meanSessionLength: 0,
			meanTokensPerToolCall: null,
			successRate: 0,
			abortRate: 0,
			totalCost: 0,
		};
	}

	const n = sessions.length;
	return {
		sessionCount: n,
		meanErrorRate: meanOfValues(sessions.map((s) => s.errorRate)),
		meanReadEditRatio: meanOfNonNull(sessions.map((s) => s.readEditRatio)),
		meanWriteVsEditPercent: meanOfNonNull(sessions.map((s) => s.writeVsEditPercent)),
		meanSelfCorrectionFreq: meanOfValues(sessions.map((s) => s.selfCorrectionFrequency)),
		meanSimplestFixMentions: meanOfValues(sessions.map((s) => s.simplestFixMentions)),
		meanToolCallVolume: meanOfValues(sessions.map((s) => s.toolCallVolume)),
		meanSessionLength: meanOfValues(sessions.map((s) => s.sessionLengthTurns)),
		meanTokensPerToolCall: meanOfNonNull(sessions.map((s) => s.tokensPerToolCall)),
		successRate: (sessions.filter((s) => s.successfulEnd).length / n) * 100,
		abortRate: (sessions.filter((s) => s.aborted).length / n) * 100,
		totalCost: sessions.reduce((sum, s) => sum + s.totalCost, 0),
	};
}

// =============================================================================
// Time Series
// =============================================================================

export function computeTimeSeries(sessions: SessionMetrics[]): AnalysisResult["timeSeries"] {
	if (sessions.length === 0) {
		return {
			errorRate: [],
			readEditRatio: [],
			writeVsEditPercent: [],
			selfCorrectionFreq: [],
			simplestFixMentions: [],
			toolCallVolume: [],
			sessionLength: [],
			tokensPerToolCall: [],
			successRate: [],
			abortRate: [],
		};
	}

	// Group sessions by date
	const byDate = new Map<string, SessionMetrics[]>();
	for (const s of sessions) {
		const key = dateKey(s.date);
		const arr = byDate.get(key);
		if (arr) {
			arr.push(s);
		} else {
			byDate.set(key, [s]);
		}
	}

	// Sort dates
	const sortedDates = [...byDate.keys()].sort();

	type MetricExtractor = (s: SessionMetrics) => number | null;

	function buildSeries(extractor: MetricExtractor, useNonNull = false): TimeSeriesPoint[] {
		const dailyValues: { date: Date; value: number }[] = [];

		for (const dk of sortedDates) {
			const daySessions = byDate.get(dk)!;
			let value: number;
			if (useNonNull) {
				const vals = daySessions.map(extractor).filter((v): v is number => v !== null);
				value = vals.length > 0 ? meanOfValues(vals) : 0;
			} else {
				value = meanOfValues(daySessions.map((s) => extractor(s) ?? 0));
			}
			dailyValues.push({ date: new Date(dk), value });
		}

		// Compute 7-day trailing rolling average
		const points: TimeSeriesPoint[] = [];
		for (let i = 0; i < dailyValues.length; i++) {
			let rollingAvg: number | null = null;
			if (dailyValues.length >= 7 && i >= 6) {
				const window = dailyValues.slice(i - 6, i + 1);
				rollingAvg = meanOfValues(window.map((d) => d.value));
			}
			points.push({
				date: dailyValues[i].date,
				value: dailyValues[i].value,
				rollingAvg,
			});
		}
		return points;
	}

	function buildBoolSeries(extractor: (s: SessionMetrics) => boolean): TimeSeriesPoint[] {
		const dailyValues: { date: Date; value: number }[] = [];

		for (const dk of sortedDates) {
			const daySessions = byDate.get(dk)!;
			const value = (daySessions.filter(extractor).length / daySessions.length) * 100;
			dailyValues.push({ date: new Date(dk), value });
		}

		const points: TimeSeriesPoint[] = [];
		for (let i = 0; i < dailyValues.length; i++) {
			let rollingAvg: number | null = null;
			if (dailyValues.length >= 7 && i >= 6) {
				const window = dailyValues.slice(i - 6, i + 1);
				rollingAvg = meanOfValues(window.map((d) => d.value));
			}
			points.push({
				date: dailyValues[i].date,
				value: dailyValues[i].value,
				rollingAvg,
			});
		}
		return points;
	}

	return {
		errorRate: buildSeries((s) => s.errorRate),
		readEditRatio: buildSeries((s) => s.readEditRatio, true),
		writeVsEditPercent: buildSeries((s) => s.writeVsEditPercent, true),
		selfCorrectionFreq: buildSeries((s) => s.selfCorrectionFrequency),
		simplestFixMentions: buildSeries((s) => s.simplestFixMentions),
		toolCallVolume: buildSeries((s) => s.toolCallVolume),
		sessionLength: buildSeries((s) => s.sessionLengthTurns),
		tokensPerToolCall: buildSeries((s) => s.tokensPerToolCall, true),
		successRate: buildBoolSeries((s) => s.successfulEnd),
		abortRate: buildBoolSeries((s) => s.aborted),
	};
}

// =============================================================================
// Model Distribution
// =============================================================================

export function computeModelDistribution(sessions: SessionMetrics[]): AnalysisResult["modelDistribution"] {
	if (sessions.length === 0) return [];

	const byDate = new Map<string, SessionMetrics[]>();
	for (const s of sessions) {
		const key = dateKey(s.date);
		const arr = byDate.get(key);
		if (arr) {
			arr.push(s);
		} else {
			byDate.set(key, [s]);
		}
	}

	const sortedDates = [...byDate.keys()].sort();
	return sortedDates.map((dk) => {
		const daySessions = byDate.get(dk)!;
		const modelCounts: Record<string, number> = {};
		for (const s of daySessions) {
			modelCounts[s.model] = (modelCounts[s.model] || 0) + 1;
		}
		const total = daySessions.length;
		const models: Record<string, number> = {};
		for (const [m, count] of Object.entries(modelCounts)) {
			models[m] = (count / total) * 100;
		}
		return { date: new Date(dk), models };
	});
}

// =============================================================================
// File Discovery
// =============================================================================

function discoverSessionFiles(dir: string): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(fullPath);
			} else if (entry.isDirectory()) {
				// Recurse into subdirectories (for sessions/<encoded-cwd>/ and subagent-sessions/<run-id>/)
				try {
					const subEntries = readdirSync(fullPath);
					for (const sub of subEntries) {
						if (sub.endsWith(".jsonl")) {
							files.push(join(fullPath, sub));
						}
					}
				} catch {
					// Skip unreadable subdirectories
				}
			}
		}
	} catch {
		// Skip unreadable directory
	}

	return files;
}

// =============================================================================
// Main Entry Point
// =============================================================================

export async function analyzeAllSessions(splitDate?: Date): Promise<AnalysisResult> {
	const sessionsDir = getSessionsDir();
	const subagentSessionsDir = getSubagentSessionsDir();

	const parentFiles = discoverSessionFiles(sessionsDir);
	const subagentFiles = discoverSessionFiles(subagentSessionsDir);

	const allMetrics: SessionMetrics[] = [];

	for (const file of parentFiles) {
		const fileEntries = loadEntriesFromFile(file);
		if (fileEntries.length === 0) continue;

		const header = fileEntries[0] as SessionHeader;
		if (header.type !== "session") continue;

		const sessionEntries = fileEntries.slice(1) as SessionEntry[];
		const metrics = computeSessionMetrics(header, sessionEntries, file, false);

		// Filter out sessions with 0 tool calls (empty starts)
		if (metrics.toolCallVolume > 0) {
			allMetrics.push(metrics);
		}
	}

	for (const file of subagentFiles) {
		const isSubagent = file.includes("/subagent-sessions/");
		const fileEntries = loadEntriesFromFile(file);
		if (fileEntries.length === 0) continue;

		const header = fileEntries[0] as SessionHeader;
		if (header.type !== "session") continue;

		const sessionEntries = fileEntries.slice(1) as SessionEntry[];
		const metrics = computeSessionMetrics(header, sessionEntries, file, isSubagent);

		if (metrics.toolCallVolume > 0) {
			allMetrics.push(metrics);
		}
	}

	// Sort by date
	allMetrics.sort((a, b) => a.date.getTime() - b.date.getTime());

	const timeSeries = computeTimeSeries(allMetrics);
	const modelDistribution = computeModelDistribution(allMetrics);

	// Model breakdown
	const byModel = new Map<string, SessionMetrics[]>();
	for (const s of allMetrics) {
		const key = `${s.provider}/${s.model}`;
		const arr = byModel.get(key);
		if (arr) {
			arr.push(s);
		} else {
			byModel.set(key, [s]);
		}
	}
	const modelBreakdown: ModelBreakdown[] = [...byModel.entries()].map(([key, sessions]) => {
		const [provider, ...modelParts] = key.split("/");
		return {
			model: modelParts.join("/"),
			provider,
			stats: computeAggregateStats(sessions),
			lowN: sessions.length < 10,
		};
	});

	// Project breakdown
	const byProject = new Map<string, SessionMetrics[]>();
	for (const s of allMetrics) {
		const arr = byProject.get(s.cwd);
		if (arr) {
			arr.push(s);
		} else {
			byProject.set(s.cwd, [s]);
		}
	}
	const projectBreakdown: ProjectBreakdown[] = [...byProject.entries()].map(([cwd, sessions]) => ({
		cwd,
		stats: computeAggregateStats(sessions),
	}));

	// Parent vs subagent
	const parentSessions = allMetrics.filter((s) => !s.isSubagent);
	const subagentSessions = allMetrics.filter((s) => s.isSubagent);
	const parentVsSubagent = {
		parent: computeAggregateStats(parentSessions),
		subagent: computeAggregateStats(subagentSessions),
	};

	// Before/after split
	let beforeAfter: { before: AggregateStats; after: AggregateStats } | undefined;
	if (splitDate) {
		const before = allMetrics.filter((s) => s.date < splitDate);
		const after = allMetrics.filter((s) => s.date >= splitDate);
		beforeAfter = {
			before: computeAggregateStats(before),
			after: computeAggregateStats(after),
		};
	}

	const dateRange =
		allMetrics.length > 0
			? { start: allMetrics[0].date, end: allMetrics[allMetrics.length - 1].date }
			: { start: new Date(), end: new Date() };

	return {
		generatedAt: new Date(),
		totalSessions: allMetrics.length,
		dateRange,
		splitDate,
		sessions: allMetrics,
		timeSeries,
		modelDistribution,
		modelBreakdown,
		projectBreakdown,
		parentVsSubagent,
		beforeAfter,
	};
}
