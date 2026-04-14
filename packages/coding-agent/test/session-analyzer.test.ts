import type { AssistantMessage, Message, ToolResultMessage, Usage, UserMessage } from "@dreb/ai";
import { describe, expect, it } from "vitest";
import {
	type AnalysisInput,
	type AnalysisTimeline,
	analyzeSession,
	computeDateComparison,
	computeErrorRate,
	computeGroups,
	computeProjectTrend,
	computeReadEditRatio,
	computeSelfCorrectionFrequency,
	computeTimeline,
	computeToolDistribution,
	computeWriteVsEditPercent,
	extractAnalysisInput,
	type FullSessionAnalysis,
	formatAnalysisForTui,
	type SessionAnalysis,
	sparkline,
	type TimePeriod,
} from "../src/core/session-analyzer.js";

// ── Test helpers ────────────────────────────────────────────────────────

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let idCounter = 0;
function nextId(): string {
	return `tc-${++idCounter}`;
}

function makeAssistantMessage(
	toolCalls: Array<{ name: string; id?: string }>,
	text?: string,
	overrides?: Partial<AssistantMessage>,
): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (text) {
		content.push({ type: "text", text });
	}
	for (const tc of toolCalls) {
		content.push({
			type: "toolCall",
			id: tc.id ?? nextId(),
			name: tc.name,
			arguments: {},
		});
	}
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: ZERO_USAGE,
		stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function makeToolResult(toolCallId: string, toolName: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: isError ? "Error: something went wrong" : "ok" }],
		isError,
		timestamp: Date.now(),
	};
}

function makeUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

/**
 * Build a simple AnalysisInput from tool call names for metric function tests.
 */
function makeInput(tools: Array<{ name: string; isError?: boolean }>, texts: string[] = []): AnalysisInput {
	return {
		toolCalls: tools.map((t) => ({ name: t.name, isError: t.isError ?? false, timestamp: Date.now() })),
		assistantTexts: texts,
		turns: [],
		totalTurns: 0,
		totalCost: 0,
		totalTokens: 0,
	};
}

// ── extractAnalysisInput ────────────────────────────────────────────────

describe("extractAnalysisInput", () => {
	it("returns empty everything for empty messages", () => {
		const result = extractAnalysisInput([]);
		expect(result.toolCalls).toEqual([]);
		expect(result.assistantTexts).toEqual([]);
		expect(result.turns).toEqual([]);
		expect(result.totalTurns).toBe(0);
	});

	it("extracts tool calls from assistant messages", () => {
		const id1 = nextId();
		const id2 = nextId();
		const assistant = makeAssistantMessage([
			{ name: "read", id: id1 },
			{ name: "edit", id: id2 },
		]);
		const tr1 = makeToolResult(id1, "read");
		const tr2 = makeToolResult(id2, "edit");

		const result = extractAnalysisInput([assistant, tr1, tr2]);
		expect(result.toolCalls).toHaveLength(2);
		expect(result.toolCalls[0].name).toBe("read");
		expect(result.toolCalls[1].name).toBe("edit");
	});

	it("propagates isError from tool results", () => {
		const id1 = nextId();
		const id2 = nextId();
		const assistant = makeAssistantMessage([
			{ name: "read", id: id1 },
			{ name: "write", id: id2 },
		]);
		const tr1 = makeToolResult(id1, "read", false);
		const tr2 = makeToolResult(id2, "write", true);

		const result = extractAnalysisInput([assistant, tr1, tr2]);
		expect(result.toolCalls[0].isError).toBe(false);
		expect(result.toolCalls[1].isError).toBe(true);
	});

	it("extracts text content from assistant messages", () => {
		const assistant = makeAssistantMessage([], "Let me think about this");
		const result = extractAnalysisInput([assistant]);
		expect(result.assistantTexts).toEqual(["Let me think about this"]);
	});

	it("handles mixed messages correctly and builds turns", () => {
		const id1 = nextId();
		const id2 = nextId();
		const messages: Message[] = [
			makeUserMessage("Do something"),
			makeAssistantMessage([{ name: "read", id: id1 }], "Reading the file"),
			makeToolResult(id1, "read"),
			makeAssistantMessage([{ name: "edit", id: id2 }], "Now editing"),
			makeToolResult(id2, "edit"),
		];

		const result = extractAnalysisInput(messages);
		expect(result.toolCalls).toHaveLength(2);
		expect(result.assistantTexts).toEqual(["Reading the file", "Now editing"]);
		expect(result.turns).toHaveLength(2);
		expect(result.turns[0].index).toBe(0);
		expect(result.turns[0].tools).toEqual(["read"]);
		expect(result.turns[1].index).toBe(1);
		expect(result.turns[1].tools).toEqual(["edit"]);
		expect(result.totalTurns).toBe(2);
	});

	it("handles tool calls with no matching tool results", () => {
		const id1 = nextId();
		const assistant = makeAssistantMessage([{ name: "read", id: id1 }]);
		// No tool result follows — the tool call won't appear in toolCalls (only tool results create records)
		const result = extractAnalysisInput([assistant]);
		expect(result.toolCalls).toHaveLength(0);
		expect(result.turns).toHaveLength(1);
		expect(result.turns[0].toolCalls).toBe(1);
		expect(result.turns[0].tools).toEqual(["read"]);
	});
});

// ── computeReadEditRatio ────────────────────────────────────────────────

describe("computeReadEditRatio", () => {
	it("returns null when no edit or write calls", () => {
		const input = makeInput([{ name: "read" }, { name: "grep" }, { name: "search" }]);
		expect(computeReadEditRatio(input)).toBeNull();
	});

	it("returns 0 when only edit tools, no read tools", () => {
		const input = makeInput([{ name: "edit" }, { name: "write" }]);
		expect(computeReadEditRatio(input)).toBe(0);
	});

	it("returns correct ratio for mix of read and edit tools", () => {
		const input = makeInput([
			{ name: "read" },
			{ name: "grep" },
			{ name: "search" },
			{ name: "find" },
			{ name: "edit" },
			{ name: "write" },
		]);
		// 4 reads / 2 edits = 2
		expect(computeReadEditRatio(input)).toBe(2);
	});

	it("counts all read tool types: read, grep, search, find, ls, web_search, web_fetch", () => {
		const input = makeInput([
			{ name: "read" },
			{ name: "grep" },
			{ name: "search" },
			{ name: "find" },
			{ name: "ls" },
			{ name: "web_search" },
			{ name: "web_fetch" },
			{ name: "edit" },
		]);
		// 7 reads / 1 edit = 7
		expect(computeReadEditRatio(input)).toBe(7);
	});

	it("counts both edit and write as edit tools", () => {
		const input = makeInput([{ name: "read" }, { name: "edit" }, { name: "write" }]);
		// 1 read / 2 edits = 0.5
		expect(computeReadEditRatio(input)).toBe(0.5);
	});
});

// ── computeWriteVsEditPercent ───────────────────────────────────────────

describe("computeWriteVsEditPercent", () => {
	it("returns null when no writes or edits", () => {
		const input = makeInput([{ name: "read" }, { name: "grep" }]);
		expect(computeWriteVsEditPercent(input)).toBeNull();
	});

	it("returns 100 when only writes", () => {
		const input = makeInput([{ name: "write" }, { name: "write" }]);
		expect(computeWriteVsEditPercent(input)).toBe(100);
	});

	it("returns 0 when only edits", () => {
		const input = makeInput([{ name: "edit" }, { name: "edit" }]);
		expect(computeWriteVsEditPercent(input)).toBe(0);
	});

	it("returns correct percentage for mix", () => {
		const input = makeInput([{ name: "write" }, { name: "edit" }, { name: "edit" }, { name: "edit" }]);
		// 1 write / 4 total = 25%
		expect(computeWriteVsEditPercent(input)).toBe(25);
	});
});

// ── computeErrorRate ────────────────────────────────────────────────────

describe("computeErrorRate", () => {
	it("returns null when no tool calls", () => {
		const input = makeInput([]);
		expect(computeErrorRate(input)).toBeNull();
	});

	it("returns 0 when no errors", () => {
		const input = makeInput([
			{ name: "read", isError: false },
			{ name: "edit", isError: false },
		]);
		expect(computeErrorRate(input)).toBe(0);
	});

	it("returns 100 when all errors", () => {
		const input = makeInput([
			{ name: "read", isError: true },
			{ name: "edit", isError: true },
		]);
		expect(computeErrorRate(input)).toBe(100);
	});

	it("returns correct percentage for mix", () => {
		const input = makeInput([
			{ name: "read", isError: false },
			{ name: "edit", isError: true },
			{ name: "write", isError: false },
			{ name: "bash", isError: true },
		]);
		// 2 errors / 4 total = 50%
		expect(computeErrorRate(input)).toBe(50);
	});
});

// ── computeSelfCorrectionFrequency ──────────────────────────────────────

describe("computeSelfCorrectionFrequency", () => {
	it("returns null when no tool calls", () => {
		const input = makeInput([], ["Actually, I was wrong"]);
		expect(computeSelfCorrectionFrequency(input)).toBeNull();
	});

	it("returns 0 when no self-correction patterns", () => {
		const input = makeInput([{ name: "read" }, { name: "edit" }], ["This looks correct", "No issues found"]);
		expect(computeSelfCorrectionFrequency(input)).toBe(0);
	});

	it('detects "actually, " pattern', () => {
		const input = makeInput([{ name: "read" }], ["Actually, that's not right"]);
		const result = computeSelfCorrectionFrequency(input);
		expect(result).toBe(1000); // 1 match / 1 tool call * 1000
	});

	it('detects "wait," pattern', () => {
		const input = makeInput([{ name: "read" }, { name: "edit" }], ["wait, I need to check something"]);
		const result = computeSelfCorrectionFrequency(input);
		expect(result).toBe(500); // 1 match / 2 tool calls * 1000
	});

	it('detects "Actually" at start of sentence with word boundary', () => {
		const input = makeInput([{ name: "read" }], ["Actually let me reconsider this approach"]);
		const result = computeSelfCorrectionFrequency(input);
		// "Actually " matches /\bactually,?\s/i → 1
		// "let me reconsider" matches /\blet me reconsider\b/i → 1
		expect(result).toBe(2000); // 2 matches / 1 tool call * 1000
	});

	it("counts multiple patterns in one text separately", () => {
		const input = makeInput(
			[{ name: "read" }, { name: "edit" }],
			["Actually, I was wrong. Wait, no wait, let me reconsider. I made a mistake and I need to correct this."],
		);
		const result = computeSelfCorrectionFrequency(input);
		// Patterns:
		// "Actually, " → /\bactually,?\s/i → 1
		// "I was wrong" → 1
		// "Wait," → /\bwait,/i → matches both "Wait," and "wait," in "no wait," → 2
		// "no wait" → 1
		// "let me reconsider" → 1
		// "I made a mistake" → 1
		// "I need to correct" → 1
		// Total: 8 matches, 2 tool calls → 8/2*1000 = 4000
		expect(result).toBe(4000);
	});

	it("is case-insensitive", () => {
		const input = makeInput([{ name: "read" }], ["ACTUALLY, I WAS WRONG"]);
		const result = computeSelfCorrectionFrequency(input);
		// "ACTUALLY, " and "I WAS WRONG" → 2 matches
		expect(result).toBe(2000);
	});
});

// ── computeToolDistribution ─────────────────────────────────────────────

describe("computeToolDistribution", () => {
	it("returns empty object for empty input", () => {
		const input = makeInput([]);
		expect(computeToolDistribution(input)).toEqual({});
	});

	it("counts tools correctly", () => {
		const input = makeInput([
			{ name: "read" },
			{ name: "read" },
			{ name: "edit" },
			{ name: "write" },
			{ name: "bash" },
			{ name: "bash" },
			{ name: "bash" },
		]);
		expect(computeToolDistribution(input)).toEqual({
			read: 2,
			edit: 1,
			write: 1,
			bash: 3,
		});
	});
});

// ── analyzeSession ──────────────────────────────────────────────────────

describe("analyzeSession", () => {
	it("handles empty session", () => {
		const result = analyzeSession([], {
			sessionId: "test-empty",
			isSubagent: false,
		});
		expect(result.sessionId).toBe("test-empty");
		expect(result.isSubagent).toBe(false);
		expect(result.readEditRatio).toBeNull();
		expect(result.writeVsEditPercent).toBeNull();
		expect(result.errorRate).toBeNull();
		expect(result.selfCorrectionPer1K).toBeNull();
		expect(result.totalToolCalls).toBe(0);
		expect(result.toolDistribution).toEqual({});
		expect(result.timeline).toEqual([]);
		expect(result.model).toBeUndefined();
		expect(result.provider).toBeUndefined();
	});

	it("analyzes a full session with mixed messages", () => {
		const readId = nextId();
		const editId = nextId();
		const writeId = nextId();
		const grepId = nextId();
		const ts = Date.now();

		const messages: Message[] = [
			{ ...makeUserMessage("Fix the bug"), timestamp: ts },
			{
				...makeAssistantMessage(
					[
						{ name: "read", id: readId },
						{ name: "grep", id: grepId },
					],
					"Let me read the file first",
				),
				timestamp: ts + 100,
			},
			{ ...makeToolResult(readId, "read"), timestamp: ts + 200 },
			{ ...makeToolResult(grepId, "grep"), timestamp: ts + 300 },
			{
				...makeAssistantMessage([{ name: "edit", id: editId }], "Actually, I need to fix this differently"),
				timestamp: ts + 400,
			},
			{ ...makeToolResult(editId, "edit"), timestamp: ts + 500 },
			{
				...makeAssistantMessage([{ name: "write", id: writeId }]),
				timestamp: ts + 600,
			},
			{ ...makeToolResult(writeId, "write", true), timestamp: ts + 700 },
		];

		const result = analyzeSession(messages, {
			sessionId: "test-full",
			sessionFile: "/tmp/session.json",
			isSubagent: true,
		});

		expect(result.sessionId).toBe("test-full");
		expect(result.sessionFile).toBe("/tmp/session.json");
		expect(result.isSubagent).toBe(true);
		expect(result.model).toBe("claude-sonnet-4-20250514");
		expect(result.provider).toBe("anthropic");
		expect(result.timestamp).toEqual(new Date(ts));
		expect(result.totalToolCalls).toBe(4);
		// Read tools: read + grep = 2, Edit tools: edit + write = 2 → ratio = 1
		expect(result.readEditRatio).toBe(1);
		// write: 1, edit: 1 → 50%
		expect(result.writeVsEditPercent).toBe(50);
		// 1 error / 4 calls = 25%
		expect(result.errorRate).toBe(25);
		// "Actually, " → 1 match in 4 tool calls → 250
		expect(result.selfCorrectionPer1K).toBe(250);
		expect(result.toolDistribution).toEqual({ read: 1, grep: 1, edit: 1, write: 1 });
		expect(result.timeline).toHaveLength(3);
	});

	it("handles session with only user messages", () => {
		const messages: Message[] = [makeUserMessage("Hello"), makeUserMessage("How are you?")];
		const result = analyzeSession(messages, { sessionId: "users-only", isSubagent: false });
		expect(result.totalToolCalls).toBe(0);
		expect(result.model).toBeUndefined();
		expect(result.timeline).toEqual([]);
	});
});

// ── computeProjectTrend ─────────────────────────────────────────────────

describe("computeProjectTrend", () => {
	function makeSessionAnalysis(overrides: Partial<SessionAnalysis> & { timestamp: Date }): SessionAnalysis {
		const { timestamp, ...rest } = overrides;
		return {
			sessionId: `s-${Math.random().toString(36).slice(2, 8)}`,
			timestamp,
			isSubagent: false,
			readEditRatio: null,
			writeVsEditPercent: null,
			errorRate: null,
			selfCorrectionPer1K: null,
			toolDistribution: {},
			totalToolCalls: 0,
			totalCost: 0,
			totalTokens: 0,
			timeline: [],
			...rest,
		};
	}

	it("returns null for fewer than 2 sessions", () => {
		expect(computeProjectTrend([])).toBeNull();
		expect(computeProjectTrend([makeSessionAnalysis({ timestamp: new Date() })])).toBeNull();
	});

	it("splits sessions into this week and previous week", () => {
		const now = Date.now();
		const oneDay = 24 * 60 * 60 * 1000;

		const sessions: SessionAnalysis[] = [
			makeSessionAnalysis({
				timestamp: new Date(now - 1 * oneDay), // this week
				readEditRatio: 3,
				errorRate: 10,
				totalToolCalls: 20,
				toolDistribution: { read: 15, edit: 5 },
			}),
			makeSessionAnalysis({
				timestamp: new Date(now - 2 * oneDay), // this week
				readEditRatio: 5,
				errorRate: 20,
				totalToolCalls: 30,
				toolDistribution: { read: 20, edit: 10 },
			}),
			makeSessionAnalysis({
				timestamp: new Date(now - 8 * oneDay), // previous week
				readEditRatio: 2,
				errorRate: 30,
				totalToolCalls: 10,
				toolDistribution: { read: 7, edit: 3 },
			}),
		];

		const result = computeProjectTrend(sessions);
		expect(result).not.toBeNull();
		expect(result!.totalSessions).toBe(3);
		expect(result!.currentPeriod.sessionCount).toBe(2);
		expect(result!.previousPeriod.sessionCount).toBe(1);
		// Average readEditRatio this week: (3+5)/2 = 4
		expect(result!.currentPeriod.avgReadEditRatio).toBe(4);
		// Average errorRate this week: (10+20)/2 = 15
		expect(result!.currentPeriod.avgErrorRate).toBe(15);
		// Previous week
		expect(result!.previousPeriod.avgReadEditRatio).toBe(2);
		expect(result!.previousPeriod.avgErrorRate).toBe(30);
		// Tool distribution merged
		expect(result!.currentPeriod.toolDistribution).toEqual({ read: 35, edit: 15 });
		expect(result!.currentPeriod.totalToolCalls).toBe(50);
	});

	it("handles all sessions in one period", () => {
		const now = Date.now();
		const oneDay = 24 * 60 * 60 * 1000;

		const sessions: SessionAnalysis[] = [
			makeSessionAnalysis({
				timestamp: new Date(now - 1 * oneDay),
				readEditRatio: 3,
				totalToolCalls: 10,
			}),
			makeSessionAnalysis({
				timestamp: new Date(now - 2 * oneDay),
				readEditRatio: 5,
				totalToolCalls: 20,
			}),
		];

		const result = computeProjectTrend(sessions);
		expect(result).not.toBeNull();
		expect(result!.currentPeriod.sessionCount).toBe(2);
		expect(result!.previousPeriod.sessionCount).toBe(0);
		expect(result!.previousPeriod.avgReadEditRatio).toBeNull();
		expect(result!.previousPeriod.totalToolCalls).toBe(0);
	});

	it("returns null when both periods have 0 sessions", () => {
		const now = Date.now();
		const threeWeeksAgo = now - 21 * 24 * 60 * 60 * 1000;

		const sessions: SessionAnalysis[] = [
			makeSessionAnalysis({ timestamp: new Date(threeWeeksAgo), totalToolCalls: 5 }),
			makeSessionAnalysis({ timestamp: new Date(threeWeeksAgo - 1000), totalToolCalls: 5 }),
		];

		const result = computeProjectTrend(sessions);
		expect(result).toBeNull();
	});
});

// ── Edge cases ──────────────────────────────────────────────────────────

describe("edge cases", () => {
	it("division by zero: computeReadEditRatio with no edits returns null", () => {
		expect(computeReadEditRatio(makeInput([{ name: "read" }]))).toBeNull();
	});

	it("division by zero: computeWriteVsEditPercent with no writes or edits returns null", () => {
		expect(computeWriteVsEditPercent(makeInput([{ name: "bash" }]))).toBeNull();
	});

	it("division by zero: computeErrorRate with no tool calls returns null", () => {
		expect(computeErrorRate(makeInput([]))).toBeNull();
	});

	it("division by zero: computeSelfCorrectionFrequency with no tool calls returns null", () => {
		expect(computeSelfCorrectionFrequency(makeInput([], ["actually, wrong"]))).toBeNull();
	});

	it("sessions with tool calls but no matching tool results", () => {
		const id1 = nextId();
		const assistant = makeAssistantMessage([{ name: "read", id: id1 }]);
		// Tool result with a DIFFERENT id — no match
		const orphanResult = makeToolResult("unmatched-id", "read");

		const result = extractAnalysisInput([assistant, orphanResult]);
		// The tool result still creates a record, but uses toolName from the result message
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0].name).toBe("read");
	});

	it("session with only user messages produces valid analysis", () => {
		const messages: Message[] = [makeUserMessage("Hello")];
		const result = analyzeSession(messages, { sessionId: "user-only", isSubagent: false });
		expect(result.totalToolCalls).toBe(0);
		expect(result.readEditRatio).toBeNull();
		expect(result.writeVsEditPercent).toBeNull();
		expect(result.errorRate).toBeNull();
		expect(result.selfCorrectionPer1K).toBeNull();
	});
});

// ── formatAnalysisForTui ────────────────────────────────────────────────

describe("formatAnalysisForTui", () => {
	it("produces formatted text with all sections", () => {
		const analysis: FullSessionAnalysis = {
			current: {
				sessionId: "test-fmt",
				timestamp: new Date(),
				model: "claude-sonnet-4-20250514",
				provider: "anthropic",
				isSubagent: false,
				readEditRatio: 3.5,
				writeVsEditPercent: 25,
				errorRate: 5,
				selfCorrectionPer1K: 100,
				toolDistribution: { read: 10, edit: 3, write: 1, bash: 5 },
				totalToolCalls: 19,
				totalCost: 0.1234,
				totalTokens: 15000,
				timeline: [
					{ index: 0, timestamp: Date.now(), toolCalls: 3, tools: ["read", "grep", "search"] },
					{ index: 1, timestamp: Date.now(), toolCalls: 1, tools: ["edit"] },
				],
			},
			timeline: null,
			groups: null,
			comparison: null,
			trend: {
				currentPeriod: {
					label: "This week",
					sessionCount: 5,
					avgReadEditRatio: 3.0,
					avgWriteVsEditPercent: 20,
					avgErrorRate: 8,
					avgSelfCorrectionPer1K: 50,
					toolDistribution: { read: 40, edit: 15 },
					totalToolCalls: 55,
					totalCost: 0.5,
					totalTokens: 50000,
					avgCostPerToolCall: null,
					avgTokensPerToolCall: null,
				},
				previousPeriod: {
					label: "Previous week",
					sessionCount: 3,
					avgReadEditRatio: 2.5,
					avgWriteVsEditPercent: 30,
					avgErrorRate: 12,
					avgSelfCorrectionPer1K: 80,
					toolDistribution: { read: 25, edit: 10 },
					totalToolCalls: 35,
					totalCost: 0.3,
					totalTokens: 30000,
					avgCostPerToolCall: null,
					avgTokensPerToolCall: null,
				},
				totalSessions: 8,
			},
		};

		const output = formatAnalysisForTui(analysis);

		expect(output).toContain("── Current Session ──");
		expect(output).toContain("claude-sonnet-4-20250514");
		expect(output).toContain("3.5");
		expect(output).toContain("25.0%");
		expect(output).toContain("5.0%");
		expect(output).toContain("── Tool Distribution ──");
		expect(output).toContain("read");
		expect(output).toContain("█");
		expect(output).toContain("noisy proxies");
	});

	it("handles null trend gracefully", () => {
		const analysis: FullSessionAnalysis = {
			current: {
				sessionId: "no-trend",
				timestamp: new Date(),
				isSubagent: false,
				readEditRatio: null,
				writeVsEditPercent: null,
				errorRate: null,
				selfCorrectionPer1K: null,
				toolDistribution: {},
				totalToolCalls: 0,
				totalCost: 0,
				totalTokens: 0,
				timeline: [],
			},
			timeline: null,
			groups: null,
			comparison: null,
			trend: null,
		};

		const output = formatAnalysisForTui(analysis);
		expect(output).toContain("── Current Session ──");
		expect(output).not.toContain("── Project Trend ──");
		expect(output).not.toContain("── Timeline");
		expect(output).toContain("n/a");
	});

	it("renders Trends section when timeline is provided", () => {
		const now = new Date();
		const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

		const makePeriod = (weeksAgo: number, sessionCount: number): TimePeriod => {
			const start = new Date(now.getTime() - weeksAgo * oneWeekMs);
			const end = new Date(start.getTime() + oneWeekMs);
			return {
				label: `W${weeksAgo}`,
				start,
				end,
				metrics: {
					label: `W${weeksAgo}`,
					sessionCount,
					avgReadEditRatio: sessionCount > 0 ? 2 + weeksAgo * 0.5 : null,
					avgWriteVsEditPercent: null,
					avgErrorRate: sessionCount > 0 ? 10 - weeksAgo : null,
					avgSelfCorrectionPer1K: null,
					toolDistribution: sessionCount > 0 ? { read: 5 * sessionCount, edit: 2 * sessionCount } : {},
					totalToolCalls: sessionCount > 0 ? 7 * sessionCount : 0,
					totalCost: sessionCount > 0 ? 0.05 * sessionCount : 0,
					totalTokens: sessionCount > 0 ? 5000 * sessionCount : 0,
					avgCostPerToolCall: sessionCount > 0 ? 0.05 / 7 : null,
					avgTokensPerToolCall: sessionCount > 0 ? 5000 / 7 : null,
				},
			};
		};

		const timeline: AnalysisTimeline = {
			periods: [makePeriod(3, 2), makePeriod(2, 3), makePeriod(1, 1), makePeriod(0, 4)],
			totalSessions: 10,
		};

		const analysis: FullSessionAnalysis = {
			current: {
				sessionId: "trend-test",
				timestamp: now,
				isSubagent: false,
				readEditRatio: 3.0,
				writeVsEditPercent: null,
				errorRate: 5,
				selfCorrectionPer1K: null,
				toolDistribution: { read: 5, edit: 2 },
				totalToolCalls: 7,
				totalCost: 0.05,
				totalTokens: 5000,
				timeline: [],
			},
			timeline,
			groups: null,
			comparison: null,
			trend: null,
		};

		const output = formatAnalysisForTui(analysis);
		expect(output).toContain("── Trends");
		expect(output).toContain("10 sessions");
		expect(output).toContain("4 weeks");
		expect(output).toContain("W3");
		expect(output).toContain("W0");
		// Sparkline chars should be present
		expect(output).toMatch(/[▁▂▃▄▅▆▇█]/);
		// Should have Read:Edit and Error Rate sparkline rows
		expect(output).toContain("Read:Edit");
		expect(output).toContain("Error Rate");
	});

	it("renders By Model section when groups are provided", () => {
		const analysis: FullSessionAnalysis = {
			current: {
				sessionId: "groups-test",
				timestamp: new Date(),
				isSubagent: false,
				readEditRatio: null,
				writeVsEditPercent: null,
				errorRate: null,
				selfCorrectionPer1K: null,
				toolDistribution: {},
				totalToolCalls: 0,
				totalCost: 0,
				totalTokens: 0,
				timeline: [],
			},
			timeline: null,
			groups: {
				byModel: [
					{
						groupKey: "claude-sonnet-4-20250514",
						sessionCount: 5,
						totalToolCalls: 50,
						avgReadEditRatio: 3.0,
						avgErrorRate: 8,
						sparklineReadEdit: [],
						sparklineErrorRate: [],
					},
					{
						groupKey: "gpt-4o",
						sessionCount: 2,
						totalToolCalls: 15,
						avgReadEditRatio: 2.5,
						avgErrorRate: 12,
						sparklineReadEdit: [],
						sparklineErrorRate: [],
					},
				],
				byType: [
					{
						groupKey: "parent",
						sessionCount: 4,
						totalToolCalls: 40,
						avgReadEditRatio: 3.0,
						avgErrorRate: 7,
						sparklineReadEdit: [],
						sparklineErrorRate: [],
					},
				],
			},
			comparison: null,
			trend: null,
		};

		const output = formatAnalysisForTui(analysis);
		expect(output).toContain("── By Model ──");
		expect(output).toContain("claude-sonnet-4-20250514");
		expect(output).toContain("gpt-4o");
		expect(output).toContain("── By Type ──");
		expect(output).toContain("parent");
	});
});

// ── sparkline ───────────────────────────────────────────────────────────

describe("sparkline", () => {
	it("returns empty string for all null input", () => {
		expect(sparkline([null, null, null])).toBe("");
	});

	it("returns empty string for empty array", () => {
		expect(sparkline([])).toBe("");
	});

	it("returns mid char for single non-null value (max === min)", () => {
		expect(sparkline([42])).toBe("▅");
	});

	it("maps ascending sequence correctly", () => {
		const result = sparkline([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(result[0]).toBe("▁");
		expect(result[result.length - 1]).toBe("█");
		expect(result.length).toBe(8);
	});

	it("null values produce a space in the sequence", () => {
		const result = sparkline([1, null, 8]);
		expect(result).toBe("▁ █");
		expect(result.length).toBe(3);
	});
});

// ── computeTimeline ─────────────────────────────────────────────────────

describe("computeTimeline", () => {
	function makeSessionAnalysis(overrides: Partial<SessionAnalysis> & { timestamp: Date }): SessionAnalysis {
		const { timestamp, ...rest } = overrides;
		return {
			sessionId: `s-${Math.random().toString(36).slice(2, 8)}`,
			timestamp,
			isSubagent: false,
			readEditRatio: null,
			writeVsEditPercent: null,
			errorRate: null,
			selfCorrectionPer1K: null,
			toolDistribution: {},
			totalToolCalls: 0,
			totalCost: 0,
			totalTokens: 0,
			timeline: [],
			...rest,
		};
	}

	it("returns null for 0 sessions", () => {
		expect(computeTimeline([])).toBeNull();
	});

	it("returns null for 1 session", () => {
		expect(computeTimeline([makeSessionAnalysis({ timestamp: new Date() })])).toBeNull();
	});

	it("returns exactly numWeeks periods", () => {
		const now = new Date();
		const sessions = [
			makeSessionAnalysis({ timestamp: new Date(now.getTime() - 1000) }),
			makeSessionAnalysis({ timestamp: new Date(now.getTime() - 2000) }),
		];
		const result = computeTimeline(sessions, 8);
		expect(result).not.toBeNull();
		expect(result!.periods).toHaveLength(8);
	});

	it("totalSessions equals the input session count", () => {
		const now = new Date();
		const sessions = [
			makeSessionAnalysis({ timestamp: new Date(now.getTime() - 1000) }),
			makeSessionAnalysis({ timestamp: new Date(now.getTime() - 2000) }),
			makeSessionAnalysis({ timestamp: new Date(now.getTime() - 3000) }),
		];
		const result = computeTimeline(sessions, 8);
		expect(result!.totalSessions).toBe(3);
	});

	it("sessions from the same week land in the same period", () => {
		const now = new Date();
		// Two sessions very close together (same week for sure)
		const sessions = [
			makeSessionAnalysis({ timestamp: new Date(now.getTime() - 1000), totalToolCalls: 10 }),
			makeSessionAnalysis({ timestamp: new Date(now.getTime() - 2000), totalToolCalls: 20 }),
		];
		const result = computeTimeline(sessions, 8);
		expect(result).not.toBeNull();
		// The last period (current week) should have both sessions
		const lastPeriod = result!.periods[result!.periods.length - 1];
		expect(lastPeriod.metrics.sessionCount).toBe(2);
		expect(lastPeriod.metrics.totalToolCalls).toBe(30);
	});

	it("sessions older than the window have 0 in their period buckets", () => {
		const now = new Date();
		const tenWeeksAgo = new Date(now.getTime() - 10 * 7 * 24 * 60 * 60 * 1000);
		const sessions = [
			makeSessionAnalysis({ timestamp: tenWeeksAgo, totalToolCalls: 5 }),
			makeSessionAnalysis({ timestamp: new Date(now.getTime() - 1000), totalToolCalls: 10 }),
		];
		const result = computeTimeline(sessions, 8);
		expect(result).not.toBeNull();
		// totalSessions includes all sessions even if outside window
		expect(result!.totalSessions).toBe(2);
		// Only 1 session should appear in the bucketed periods
		const totalBucketed = result!.periods.reduce((sum, p) => sum + p.metrics.sessionCount, 0);
		expect(totalBucketed).toBe(1);
	});
});

// ── computeGroups ───────────────────────────────────────────────────────

describe("computeGroups", () => {
	function makeSessionAnalysis(overrides: Partial<SessionAnalysis> & { timestamp: Date }): SessionAnalysis {
		const { timestamp, ...rest } = overrides;
		return {
			sessionId: `s-${Math.random().toString(36).slice(2, 8)}`,
			timestamp,
			isSubagent: false,
			readEditRatio: null,
			writeVsEditPercent: null,
			errorRate: null,
			selfCorrectionPer1K: null,
			toolDistribution: {},
			totalToolCalls: 0,
			totalCost: 0,
			totalTokens: 0,
			timeline: [],
			...rest,
		};
	}

	it("returns null for fewer than 2 sessions", () => {
		expect(computeGroups([], null)).toBeNull();
		expect(computeGroups([makeSessionAnalysis({ timestamp: new Date() })], null)).toBeNull();
	});

	it("groups sessions by model correctly", () => {
		const now = new Date();
		const sessions = [
			makeSessionAnalysis({ timestamp: now, model: "model-a", totalToolCalls: 10 }),
			makeSessionAnalysis({ timestamp: now, model: "model-a", totalToolCalls: 20 }),
			makeSessionAnalysis({ timestamp: now, model: "model-b", totalToolCalls: 5 }),
		];
		const result = computeGroups(sessions, null);
		expect(result).not.toBeNull();
		expect(result!.byModel).toHaveLength(2);
		// model-a has more sessions, sorted first
		expect(result!.byModel[0].groupKey).toBe("model-a");
		expect(result!.byModel[0].sessionCount).toBe(2);
		expect(result!.byModel[0].totalToolCalls).toBe(30);
		expect(result!.byModel[1].groupKey).toBe("model-b");
		expect(result!.byModel[1].sessionCount).toBe(1);
	});

	it("subagent sessions with no agentType group as 'subagent (legacy)'", () => {
		const now = new Date();
		const sessions = [
			makeSessionAnalysis({ timestamp: now, isSubagent: true }),
			makeSessionAnalysis({ timestamp: now, isSubagent: true }),
		];
		const result = computeGroups(sessions, null);
		expect(result).not.toBeNull();
		const legacyGroup = result!.byType.find((g) => g.groupKey === "subagent (legacy)");
		expect(legacyGroup).toBeDefined();
		expect(legacyGroup!.sessionCount).toBe(2);
	});

	it("parent sessions group as 'parent'", () => {
		const now = new Date();
		const sessions = [
			makeSessionAnalysis({ timestamp: now, isSubagent: false }),
			makeSessionAnalysis({ timestamp: now, isSubagent: false }),
		];
		const result = computeGroups(sessions, null);
		expect(result).not.toBeNull();
		const parentGroup = result!.byType.find((g) => g.groupKey === "parent");
		expect(parentGroup).toBeDefined();
		expect(parentGroup!.sessionCount).toBe(2);
	});

	it("byModel is capped at 5 entries even with 6+ different models", () => {
		const now = new Date();
		const sessions = [
			makeSessionAnalysis({ timestamp: now, model: "m1" }),
			makeSessionAnalysis({ timestamp: now, model: "m2" }),
			makeSessionAnalysis({ timestamp: now, model: "m3" }),
			makeSessionAnalysis({ timestamp: now, model: "m4" }),
			makeSessionAnalysis({ timestamp: now, model: "m5" }),
			makeSessionAnalysis({ timestamp: now, model: "m6" }),
			makeSessionAnalysis({ timestamp: now, model: "m7" }),
		];
		const result = computeGroups(sessions, null);
		expect(result).not.toBeNull();
		expect(result!.byModel.length).toBeLessThanOrEqual(5);
	});
});

// ── computeDateComparison ───────────────────────────────────────────────

describe("computeDateComparison", () => {
	function makeSessionAnalysis(overrides: Partial<SessionAnalysis> & { timestamp: Date }): SessionAnalysis {
		const { timestamp, ...rest } = overrides;
		return {
			sessionId: `s-${Math.random().toString(36).slice(2, 8)}`,
			timestamp,
			isSubagent: false,
			readEditRatio: null,
			writeVsEditPercent: null,
			errorRate: null,
			selfCorrectionPer1K: null,
			toolDistribution: {},
			totalToolCalls: 0,
			totalCost: 0,
			totalTokens: 0,
			timeline: [],
			...rest,
		};
	}

	it("sessions before splitDate appear in before, sessions after appear in after", () => {
		const splitDate = new Date("2025-06-01");
		const sessions = [
			makeSessionAnalysis({ timestamp: new Date("2025-05-01"), totalToolCalls: 10 }),
			makeSessionAnalysis({ timestamp: new Date("2025-05-15"), totalToolCalls: 20 }),
			makeSessionAnalysis({ timestamp: new Date("2025-06-15"), totalToolCalls: 30 }),
		];
		const result = computeDateComparison(sessions, splitDate);
		expect(result.before.sessionCount).toBe(2);
		expect(result.after.sessionCount).toBe(1);
	});

	it("empty before slice produces 0 sessionCount and null metrics", () => {
		const splitDate = new Date("2025-01-01");
		const sessions = [makeSessionAnalysis({ timestamp: new Date("2025-06-01"), totalToolCalls: 10 })];
		const result = computeDateComparison(sessions, splitDate);
		expect(result.before.sessionCount).toBe(0);
		expect(result.before.avgReadEditRatio).toBeNull();
		expect(result.before.avgErrorRate).toBeNull();
		expect(result.before.totalToolCalls).toBe(0);
	});

	it("empty after slice produces 0 sessionCount and null metrics", () => {
		const splitDate = new Date("2026-12-31");
		const sessions = [makeSessionAnalysis({ timestamp: new Date("2025-06-01"), totalToolCalls: 10 })];
		const result = computeDateComparison(sessions, splitDate);
		expect(result.after.sessionCount).toBe(0);
		expect(result.after.avgReadEditRatio).toBeNull();
		expect(result.after.avgErrorRate).toBeNull();
		expect(result.after.totalToolCalls).toBe(0);
	});

	it("before.totalToolCalls equals sum of tool calls from before-sessions", () => {
		const splitDate = new Date("2025-06-01");
		const sessions = [
			makeSessionAnalysis({ timestamp: new Date("2025-05-01"), totalToolCalls: 7 }),
			makeSessionAnalysis({ timestamp: new Date("2025-05-15"), totalToolCalls: 13 }),
			makeSessionAnalysis({ timestamp: new Date("2025-07-01"), totalToolCalls: 99 }),
		];
		const result = computeDateComparison(sessions, splitDate);
		expect(result.before.totalToolCalls).toBe(20);
	});
});

// ── analyzeSession idempotency (finding 9) ──────────────────────────────

describe("analyzeSession idempotency", () => {
	it("produces identical results when called twice on the same messages", () => {
		const readId = nextId();
		const editId = nextId();
		const ts = Date.now();
		const messages: Message[] = [
			makeUserMessage("Fix the bug"),
			makeAssistantMessage([{ name: "read", id: readId }], "Reading the file"),
			{ ...makeToolResult(readId, "read"), timestamp: ts + 100 },
			makeAssistantMessage([{ name: "edit", id: editId }], "Editing"),
			{ ...makeToolResult(editId, "edit"), timestamp: ts + 200 },
		];

		const meta = { sessionId: "idem-test", isSubagent: false };
		const result1 = analyzeSession(messages, meta);
		const result2 = analyzeSession(messages, meta);

		expect(result1.totalToolCalls).toBe(result2.totalToolCalls);
		expect(result1.readEditRatio).toBe(result2.readEditRatio);
		expect(result1.errorRate).toBe(result2.errorRate);
		expect(result1.writeVsEditPercent).toBe(result2.writeVsEditPercent);
		expect(result1.selfCorrectionPer1K).toBe(result2.selfCorrectionPer1K);
		expect(result1.toolDistribution).toEqual(result2.toolDistribution);
	});

	it("doubling messages doubles the tool call count (no dedup)", () => {
		const readId1 = nextId();
		const readId2 = nextId();
		const ts = Date.now();
		const messages: Message[] = [
			makeUserMessage("Fix the bug"),
			makeAssistantMessage([{ name: "read", id: readId1 }], "Reading"),
			{ ...makeToolResult(readId1, "read"), timestamp: ts + 100 },
			makeAssistantMessage([{ name: "read", id: readId2 }], "Reading again"),
			{ ...makeToolResult(readId2, "read"), timestamp: ts + 200 },
		];

		const singleResult = analyzeSession(messages, { sessionId: "single", isSubagent: false });
		// Duplicate messages to simulate double-counting
		const doubled = [...messages, ...messages];
		const doubledResult = analyzeSession(doubled, { sessionId: "doubled", isSubagent: false });

		expect(doubledResult.totalToolCalls).toBe(singleResult.totalToolCalls * 2);
	});
});

// ── computeGroups CWD-like filtering via agentType (finding 9) ──────────

describe("computeGroups grouping correctness", () => {
	function makeSessionAnalysis(overrides: Partial<SessionAnalysis> & { timestamp: Date }): SessionAnalysis {
		const { timestamp, ...rest } = overrides;
		return {
			sessionId: `s-${Math.random().toString(36).slice(2, 8)}`,
			timestamp,
			isSubagent: false,
			readEditRatio: null,
			writeVsEditPercent: null,
			errorRate: null,
			selfCorrectionPer1K: null,
			toolDistribution: {},
			totalToolCalls: 0,
			totalCost: 0,
			totalTokens: 0,
			timeline: [],
			...rest,
		};
	}

	it("sessions with different agentType values are grouped separately in byType", () => {
		const now = new Date();
		const sessions = [
			makeSessionAnalysis({ timestamp: now, isSubagent: true, agentType: "code-reviewer" }),
			makeSessionAnalysis({ timestamp: now, isSubagent: true, agentType: "code-reviewer" }),
			makeSessionAnalysis({ timestamp: now, isSubagent: true, agentType: "error-auditor" }),
			makeSessionAnalysis({ timestamp: now, isSubagent: false }),
		];
		const result = computeGroups(sessions, null);
		expect(result).not.toBeNull();
		// Should have 3 type groups: code-reviewer, error-auditor, parent
		expect(result!.byType).toHaveLength(3);
		const codeReviewer = result!.byType.find((g) => g.groupKey === "code-reviewer");
		expect(codeReviewer).toBeDefined();
		expect(codeReviewer!.sessionCount).toBe(2);
		const errorAuditor = result!.byType.find((g) => g.groupKey === "error-auditor");
		expect(errorAuditor).toBeDefined();
		expect(errorAuditor!.sessionCount).toBe(1);
		const parent = result!.byType.find((g) => g.groupKey === "parent");
		expect(parent).toBeDefined();
		expect(parent!.sessionCount).toBe(1);
	});
});
