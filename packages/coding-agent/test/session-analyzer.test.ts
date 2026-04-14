import { describe, expect, it } from "vitest";
import {
	computeAggregateStats,
	computeModelDistribution,
	computeSessionMetrics,
	computeTimeSeries,
	type SessionMetrics,
} from "../src/core/session-analyzer.js";
import type { SessionEntry, SessionHeader, SessionMessageEntry } from "../src/core/session-manager.js";

// =============================================================================
// Test Helpers
// =============================================================================

let nextId = 1;
function uid(): string {
	return `entry-${nextId++}`;
}

function makeHeader(opts?: Partial<SessionHeader>): SessionHeader {
	return {
		type: "session",
		id: opts?.id ?? "test-session",
		timestamp: opts?.timestamp ?? "2026-01-15T10:00:00.000Z",
		cwd: opts?.cwd ?? "/test/project",
		...opts,
	};
}

function makeAssistantEntry(
	tools: string[],
	opts?: {
		text?: string;
		model?: string;
		provider?: string;
		stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
		totalTokens?: number;
		cost?: number;
		toolArgs?: Record<string, Record<string, unknown>>;
	},
): SessionMessageEntry {
	const content: Array<{ type: string; [key: string]: unknown }> = [];

	if (opts?.text) {
		content.push({ type: "text", text: opts.text });
	}

	for (const name of tools) {
		const args = opts?.toolArgs?.[name] ?? {};
		content.push({
			type: "toolCall",
			id: uid(),
			name,
			arguments: args,
		});
	}

	return {
		type: "message",
		id: uid(),
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: content as any,
			api: "messages",
			provider: opts?.provider ?? "anthropic",
			model: opts?.model ?? "claude-sonnet-4-20250514",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: opts?.totalTokens ?? 150,
				cost: {
					input: 0.001,
					output: 0.002,
					cacheRead: 0,
					cacheWrite: 0,
					total: opts?.cost ?? 0.003,
				},
			},
			stopReason: opts?.stopReason ?? "toolUse",
			timestamp: Date.now(),
		} as any,
	};
}

function makeToolResultEntry(toolName: string, isError = false): SessionMessageEntry {
	return {
		type: "message",
		id: uid(),
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolCallId: uid(),
			toolName,
			content: [{ type: "text", text: isError ? "Error: something failed" : "ok" }],
			isError,
			timestamp: Date.now(),
		} as any,
	};
}

function makeUserEntry(text = "hello"): SessionMessageEntry {
	return {
		type: "message",
		id: uid(),
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "user",
			content: text,
			timestamp: Date.now(),
		} as any,
	};
}

// =============================================================================
// computeSessionMetrics
// =============================================================================

describe("computeSessionMetrics", () => {
	it("computes metrics for a normal session with mixed tool calls and some errors", () => {
		const header = makeHeader();
		const entries: SessionEntry[] = [
			makeUserEntry("fix the bug"),
			makeAssistantEntry(["read", "read", "edit"], {
				toolArgs: {
					read: { path: "src/foo.ts" },
					edit: { path: "src/foo.ts" },
				},
			}),
			makeToolResultEntry("read"),
			makeToolResultEntry("read"),
			makeToolResultEntry("edit", true),
			makeAssistantEntry(["edit"], {
				stopReason: "stop",
				toolArgs: { edit: { path: "src/bar.ts" } },
			}),
			makeToolResultEntry("edit"),
		];

		const m = computeSessionMetrics(header, entries, "/tmp/session.jsonl", false);

		expect(m.sessionId).toBe("test-session");
		expect(m.cwd).toBe("/test/project");
		expect(m.isSubagent).toBe(false);
		expect(m.toolCallVolume).toBe(4); // 3 + 1
		expect(m.sessionLengthTurns).toBe(2);
		expect(m.errorRate).toBeCloseTo(1 / 4); // 1 error out of 4 tool results
		expect(m.successfulEnd).toBe(true);
		expect(m.aborted).toBe(false);
		expect(m.model).toBe("claude-sonnet-4-20250514");
		expect(m.provider).toBe("anthropic");
	});

	it("handles an empty session gracefully", () => {
		const header = makeHeader();
		const entries: SessionEntry[] = [];

		const m = computeSessionMetrics(header, entries, "/tmp/empty.jsonl", false);

		expect(m.toolCallVolume).toBe(0);
		expect(m.sessionLengthTurns).toBe(0);
		expect(m.errorRate).toBe(0);
		expect(m.readEditRatio).toBeNull();
		expect(m.writeVsEditPercent).toBeNull();
		expect(m.tokensPerToolCall).toBeNull();
		expect(m.selfCorrectionFrequency).toBe(0);
		expect(m.simplestFixMentions).toBe(0);
		expect(m.successfulEnd).toBe(false);
		expect(m.aborted).toBe(true); // no final assistant
		expect(m.totalTokens).toBe(0);
		expect(m.totalCost).toBe(0);
		expect(m.model).toBe("unknown");
		expect(m.provider).toBe("unknown");
	});

	it("returns null tokensPerToolCall and 0 rates when zero tool calls", () => {
		const header = makeHeader();
		const entries: SessionEntry[] = [
			makeUserEntry("what is 2+2"),
			makeAssistantEntry([], { text: "It is 4.", stopReason: "stop", totalTokens: 200 }),
		];

		const m = computeSessionMetrics(header, entries, "/tmp/no-tools.jsonl", false);

		expect(m.toolCallVolume).toBe(0);
		expect(m.tokensPerToolCall).toBeNull();
		expect(m.readEditRatio).toBeNull();
		expect(m.writeVsEditPercent).toBeNull();
		expect(m.selfCorrectionFrequency).toBe(0);
		expect(m.simplestFixMentions).toBe(0);
		expect(m.successfulEnd).toBe(true);
	});

	it("computes 100% error rate when all results are errors", () => {
		const header = makeHeader();
		const entries: SessionEntry[] = [
			makeUserEntry(),
			makeAssistantEntry(["bash", "bash"]),
			makeToolResultEntry("bash", true),
			makeToolResultEntry("bash", true),
			makeAssistantEntry(["bash"], { stopReason: "stop" }),
			makeToolResultEntry("bash", true),
		];

		const m = computeSessionMetrics(header, entries, "/tmp/errors.jsonl", false);

		expect(m.errorRate).toBe(1);
	});

	it("detects self-correction patterns in assistant text", () => {
		const header = makeHeader();
		const entries: SessionEntry[] = [
			makeUserEntry(),
			makeAssistantEntry(["read"], {
				text: "Actually, wait, let me reconsider. I was wrong about that.",
				toolArgs: { read: { path: "a.ts" } },
			}),
			makeToolResultEntry("read"),
			makeAssistantEntry(["edit"], {
				text: "That's not right, my mistake.",
				stopReason: "stop",
				toolArgs: { edit: { path: "a.ts" } },
			}),
			makeToolResultEntry("edit"),
		];

		const m = computeSessionMetrics(header, entries, "/tmp/corrections.jsonl", false);

		// "actually", "wait", "let me reconsider", "I was wrong" = 4
		// "that's not right", "my mistake" = 2
		// total = 6, tool calls = 2 → 6/2*1000 = 3000
		expect(m.selfCorrectionFrequency).toBe(3000);
	});

	it("detects simplest-fix patterns in assistant text", () => {
		const header = makeHeader();
		const entries: SessionEntry[] = [
			makeUserEntry(),
			makeAssistantEntry(["edit"], {
				text: "The simplest fix is to just do a quick fix here.",
				stopReason: "stop",
				toolArgs: { edit: { path: "x.ts" } },
			}),
			makeToolResultEntry("edit"),
		];

		const m = computeSessionMetrics(header, entries, "/tmp/simple.jsonl", false);

		// "simplest fix", "just do", "quick fix" = 3 matches, 1 tool call → 3000
		expect(m.simplestFixMentions).toBe(3000);
	});

	it("returns null readEditRatio when 0 edits", () => {
		const header = makeHeader();
		const entries: SessionEntry[] = [
			makeUserEntry(),
			makeAssistantEntry(["read", "read"], {
				stopReason: "stop",
				toolArgs: { read: { path: "a.ts" } },
			}),
			makeToolResultEntry("read"),
			makeToolResultEntry("read"),
		];

		const m = computeSessionMetrics(header, entries, "/tmp/no-edits.jsonl", false);

		expect(m.readEditRatio).toBeNull();
	});

	it("returns null writeVsEditPercent when 0 writes and 0 edits", () => {
		const header = makeHeader();
		const entries: SessionEntry[] = [
			makeUserEntry(),
			makeAssistantEntry(["read", "bash"], {
				stopReason: "stop",
				toolArgs: { read: { path: "a.ts" } },
			}),
			makeToolResultEntry("read"),
			makeToolResultEntry("bash"),
		];

		const m = computeSessionMetrics(header, entries, "/tmp/no-writes.jsonl", false);

		expect(m.writeVsEditPercent).toBeNull();
	});

	it("computes writeVsEditPercent correctly", () => {
		const header = makeHeader();
		const entries: SessionEntry[] = [
			makeUserEntry(),
			makeAssistantEntry(["write", "write", "edit"], {
				stopReason: "stop",
				toolArgs: {
					write: { path: "new.ts" },
					edit: { path: "old.ts" },
				},
			}),
			makeToolResultEntry("write"),
			makeToolResultEntry("write"),
			makeToolResultEntry("edit"),
		];

		const m = computeSessionMetrics(header, entries, "/tmp/writes.jsonl", false);

		// 2 writes / (2 writes + 1 edit) * 100 = 66.67
		expect(m.writeVsEditPercent).toBeCloseTo(66.67, 1);
	});

	it("detects successfulEnd from last assistant message stop reason", () => {
		const header = makeHeader();
		const entries: SessionEntry[] = [
			makeUserEntry(),
			makeAssistantEntry(["read"], { stopReason: "toolUse" }),
			makeToolResultEntry("read"),
			makeAssistantEntry([], { text: "Done!", stopReason: "stop" }),
		];

		const m = computeSessionMetrics(header, entries, "/tmp/success.jsonl", false);

		expect(m.successfulEnd).toBe(true);
		expect(m.aborted).toBe(false);
	});

	it("detects aborted from last assistant message", () => {
		const header = makeHeader();
		const entries: SessionEntry[] = [
			makeUserEntry(),
			makeAssistantEntry(["read"], { stopReason: "toolUse" }),
			makeToolResultEntry("read"),
			makeAssistantEntry(["edit"], { stopReason: "aborted" }),
		];

		const m = computeSessionMetrics(header, entries, "/tmp/aborted.jsonl", false);

		expect(m.successfulEnd).toBe(false);
		expect(m.aborted).toBe(true);
	});

	it("deduplicates uniqueFilesTouched", () => {
		const header = makeHeader();
		const entries: SessionEntry[] = [
			makeUserEntry(),
			makeAssistantEntry(["read", "read", "edit", "write"], {
				stopReason: "stop",
				toolArgs: {
					read: { path: "src/foo.ts" },
					edit: { path: "src/foo.ts" },
					write: { path: "src/bar.ts" },
				},
			}),
			makeToolResultEntry("read"),
			makeToolResultEntry("read"),
			makeToolResultEntry("edit"),
			makeToolResultEntry("write"),
		];

		const m = computeSessionMetrics(header, entries, "/tmp/files.jsonl", false);

		// read: src/foo.ts (x2), edit: src/foo.ts, write: src/bar.ts → 2 unique
		expect(m.uniqueFilesTouched).toBe(2);
	});

	it("selects the most-used model and provider", () => {
		const header = makeHeader();
		const entries: SessionEntry[] = [
			makeUserEntry(),
			makeAssistantEntry(["read"], { model: "gpt-4o", provider: "openai" }),
			makeToolResultEntry("read"),
			makeAssistantEntry(["read"], { model: "claude-sonnet-4-20250514", provider: "anthropic" }),
			makeToolResultEntry("read"),
			makeAssistantEntry(["read"], { model: "claude-sonnet-4-20250514", provider: "anthropic", stopReason: "stop" }),
			makeToolResultEntry("read"),
		];

		const m = computeSessionMetrics(header, entries, "/tmp/models.jsonl", false);

		expect(m.model).toBe("claude-sonnet-4-20250514");
		expect(m.provider).toBe("anthropic");
	});

	it("sums totalTokens and totalCost from all assistant messages", () => {
		const header = makeHeader();
		const entries: SessionEntry[] = [
			makeUserEntry(),
			makeAssistantEntry(["read"], { totalTokens: 100, cost: 0.01 }),
			makeToolResultEntry("read"),
			makeAssistantEntry(["read"], { totalTokens: 200, cost: 0.02, stopReason: "stop" }),
			makeToolResultEntry("read"),
		];

		const m = computeSessionMetrics(header, entries, "/tmp/tokens.jsonl", false);

		expect(m.totalTokens).toBe(300);
		expect(m.totalCost).toBeCloseTo(0.03);
		expect(m.tokensPerToolCall).toBe(150); // 300 / 2
	});

	it("computes tool distribution as percentages", () => {
		const header = makeHeader();
		const entries: SessionEntry[] = [
			makeUserEntry(),
			makeAssistantEntry(["read", "read", "edit", "bash"], { stopReason: "stop" }),
			makeToolResultEntry("read"),
			makeToolResultEntry("read"),
			makeToolResultEntry("edit"),
			makeToolResultEntry("bash"),
		];

		const m = computeSessionMetrics(header, entries, "/tmp/dist.jsonl", false);

		expect(m.toolDistribution.read).toBe(50);
		expect(m.toolDistribution.edit).toBe(25);
		expect(m.toolDistribution.bash).toBe(25);
	});

	it("parses date from header timestamp", () => {
		const header = makeHeader({ timestamp: "2026-03-20T14:30:00.000Z" });
		const entries: SessionEntry[] = [
			makeUserEntry(),
			makeAssistantEntry(["read"], { stopReason: "stop" }),
			makeToolResultEntry("read"),
		];

		const m = computeSessionMetrics(header, entries, "/tmp/date.jsonl", false);

		expect(m.date.toISOString()).toBe("2026-03-20T14:30:00.000Z");
	});
});

// =============================================================================
// computeAggregateStats
// =============================================================================

describe("computeAggregateStats", () => {
	it("computes means across multiple sessions", () => {
		const header = makeHeader();
		const sessions: SessionMetrics[] = [
			computeSessionMetrics(
				header,
				[
					makeUserEntry(),
					makeAssistantEntry(["read", "edit"], {
						stopReason: "stop",
						totalTokens: 100,
						cost: 0.01,
						toolArgs: { read: { path: "a.ts" }, edit: { path: "a.ts" } },
					}),
					makeToolResultEntry("read"),
					makeToolResultEntry("edit"),
				],
				"/tmp/s1.jsonl",
				false,
			),
			computeSessionMetrics(
				header,
				[
					makeUserEntry(),
					makeAssistantEntry(["read", "read", "edit", "edit"], {
						stopReason: "stop",
						totalTokens: 200,
						cost: 0.02,
						toolArgs: { read: { path: "b.ts" }, edit: { path: "b.ts" } },
					}),
					makeToolResultEntry("read"),
					makeToolResultEntry("read"),
					makeToolResultEntry("edit"),
					makeToolResultEntry("edit"),
				],
				"/tmp/s2.jsonl",
				false,
			),
		];

		const stats = computeAggregateStats(sessions);

		expect(stats.sessionCount).toBe(2);
		expect(stats.meanErrorRate).toBe(0);
		expect(stats.successRate).toBe(100);
		expect(stats.abortRate).toBe(0);
		expect(stats.totalCost).toBeCloseTo(0.03);
		// s1: 2 tool calls, s2: 4 tool calls → mean 3
		expect(stats.meanToolCallVolume).toBe(3);
		// s1: readEditRatio = 1, s2: readEditRatio = 1 → mean 1
		expect(stats.meanReadEditRatio).toBe(1);
	});

	it("returns null for ratio metrics when all sessions have null values", () => {
		const header = makeHeader();
		// sessions with no edits → readEditRatio is null
		const sessions: SessionMetrics[] = [
			computeSessionMetrics(
				header,
				[makeUserEntry(), makeAssistantEntry(["bash"], { stopReason: "stop" }), makeToolResultEntry("bash")],
				"/tmp/s1.jsonl",
				false,
			),
		];

		const stats = computeAggregateStats(sessions);

		expect(stats.meanReadEditRatio).toBeNull();
		expect(stats.meanWriteVsEditPercent).toBeNull();
	});

	it("returns zero stats for empty sessions array", () => {
		const stats = computeAggregateStats([]);

		expect(stats.sessionCount).toBe(0);
		expect(stats.meanErrorRate).toBe(0);
		expect(stats.successRate).toBe(0);
		expect(stats.totalCost).toBe(0);
	});

	it("computes success and abort rates correctly", () => {
		const header = makeHeader();
		const successSession = computeSessionMetrics(
			header,
			[makeUserEntry(), makeAssistantEntry(["read"], { stopReason: "stop" }), makeToolResultEntry("read")],
			"/tmp/success.jsonl",
			false,
		);
		const abortSession = computeSessionMetrics(
			header,
			[makeUserEntry(), makeAssistantEntry(["read"], { stopReason: "aborted" }), makeToolResultEntry("read")],
			"/tmp/aborted.jsonl",
			false,
		);
		const errorSession = computeSessionMetrics(
			header,
			[makeUserEntry(), makeAssistantEntry(["read"], { stopReason: "error" }), makeToolResultEntry("read")],
			"/tmp/error.jsonl",
			false,
		);

		const stats = computeAggregateStats([successSession, abortSession, errorSession]);

		expect(stats.successRate).toBeCloseTo(33.33, 1);
		expect(stats.abortRate).toBeCloseTo(33.33, 1);
	});
});

// =============================================================================
// computeTimeSeries
// =============================================================================

describe("computeTimeSeries", () => {
	it("returns empty arrays for empty sessions", () => {
		const ts = computeTimeSeries([]);
		expect(ts.errorRate).toHaveLength(0);
		expect(ts.successRate).toHaveLength(0);
	});

	it("groups by day and computes daily averages", () => {
		const header1 = makeHeader({ timestamp: "2026-01-01T10:00:00.000Z" });
		const header2 = makeHeader({ timestamp: "2026-01-01T14:00:00.000Z" });

		const s1 = computeSessionMetrics(
			header1,
			[
				makeUserEntry(),
				makeAssistantEntry(["read"], { stopReason: "stop", totalTokens: 100 }),
				makeToolResultEntry("read"),
			],
			"/tmp/s1.jsonl",
			false,
		);

		const s2 = computeSessionMetrics(
			header2,
			[
				makeUserEntry(),
				makeAssistantEntry(["read", "read"], { stopReason: "stop", totalTokens: 200 }),
				makeToolResultEntry("read"),
				makeToolResultEntry("read"),
			],
			"/tmp/s2.jsonl",
			false,
		);

		const ts = computeTimeSeries([s1, s2]);

		// Both sessions are on the same day → 1 point
		expect(ts.toolCallVolume).toHaveLength(1);
		// s1: 1 tool call, s2: 2 tool calls → avg 1.5
		expect(ts.toolCallVolume[0].value).toBe(1.5);
		// Only 1 day, so rollingAvg is null (need >= 7 days)
		expect(ts.toolCallVolume[0].rollingAvg).toBeNull();
	});

	it("computes 7-day trailing rolling average", () => {
		const sessions: SessionMetrics[] = [];
		// Create 10 days of sessions with toolCallVolume = day index
		for (let i = 0; i < 10; i++) {
			const day = `2026-01-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`;
			const header = makeHeader({ timestamp: day });
			const toolNames = Array(i + 1).fill("read") as string[];
			const entries: SessionEntry[] = [
				makeUserEntry(),
				makeAssistantEntry(toolNames, { stopReason: "stop" }),
				...toolNames.map((t) => makeToolResultEntry(t)),
			];
			sessions.push(computeSessionMetrics(header, entries, `/tmp/s${i}.jsonl`, false));
		}

		const ts = computeTimeSeries(sessions);

		expect(ts.toolCallVolume).toHaveLength(10);
		// First 6 points should have null rollingAvg
		for (let i = 0; i < 6; i++) {
			expect(ts.toolCallVolume[i].rollingAvg).toBeNull();
		}
		// 7th point (index 6): rolling avg of days 0-6, values 1,2,3,4,5,6,7 → mean=4
		expect(ts.toolCallVolume[6].rollingAvg).toBe(4);
		// 8th point (index 7): rolling avg of days 1-7, values 2,3,4,5,6,7,8 → mean=5
		expect(ts.toolCallVolume[7].rollingAvg).toBe(5);
	});

	it("computes successRate time series as percentage", () => {
		const header1 = makeHeader({ timestamp: "2026-01-01T10:00:00.000Z" });
		const header2 = makeHeader({ timestamp: "2026-01-01T14:00:00.000Z" });

		const s1 = computeSessionMetrics(
			header1,
			[makeUserEntry(), makeAssistantEntry(["read"], { stopReason: "stop" }), makeToolResultEntry("read")],
			"/tmp/s1.jsonl",
			false,
		);

		const s2 = computeSessionMetrics(
			header2,
			[makeUserEntry(), makeAssistantEntry(["read"], { stopReason: "aborted" }), makeToolResultEntry("read")],
			"/tmp/s2.jsonl",
			false,
		);

		const ts = computeTimeSeries([s1, s2]);

		expect(ts.successRate).toHaveLength(1);
		expect(ts.successRate[0].value).toBe(50); // 1 out of 2
	});
});

// =============================================================================
// computeModelDistribution
// =============================================================================

describe("computeModelDistribution", () => {
	it("returns empty array for empty sessions", () => {
		expect(computeModelDistribution([])).toHaveLength(0);
	});

	it("computes model percentages per day", () => {
		const header = makeHeader({ timestamp: "2026-01-01T10:00:00.000Z" });

		const s1 = computeSessionMetrics(
			header,
			[
				makeUserEntry(),
				makeAssistantEntry(["read"], { model: "gpt-4o", provider: "openai", stopReason: "stop" }),
				makeToolResultEntry("read"),
			],
			"/tmp/s1.jsonl",
			false,
		);

		const s2 = computeSessionMetrics(
			header,
			[
				makeUserEntry(),
				makeAssistantEntry(["read"], {
					model: "claude-sonnet-4-20250514",
					provider: "anthropic",
					stopReason: "stop",
				}),
				makeToolResultEntry("read"),
			],
			"/tmp/s2.jsonl",
			false,
		);

		const s3 = computeSessionMetrics(
			header,
			[
				makeUserEntry(),
				makeAssistantEntry(["read"], {
					model: "claude-sonnet-4-20250514",
					provider: "anthropic",
					stopReason: "stop",
				}),
				makeToolResultEntry("read"),
			],
			"/tmp/s3.jsonl",
			false,
		);

		const dist = computeModelDistribution([s1, s2, s3]);

		expect(dist).toHaveLength(1);
		expect(dist[0].models["gpt-4o"]).toBeCloseTo(33.33, 1);
		expect(dist[0].models["claude-sonnet-4-20250514"]).toBeCloseTo(66.67, 1);
	});
});

// =============================================================================
// Date Split (before/after)
// =============================================================================

describe("date split (before/after)", () => {
	it("correctly splits sessions by splitDate via computeAggregateStats", () => {
		const headerBefore = makeHeader({ timestamp: "2026-01-10T10:00:00.000Z" });
		const headerAfter = makeHeader({ timestamp: "2026-02-10T10:00:00.000Z" });
		const splitDate = new Date("2026-02-01T00:00:00.000Z");

		const sBefore = computeSessionMetrics(
			headerBefore,
			[
				makeUserEntry(),
				makeAssistantEntry(["read", "read"], { stopReason: "stop", cost: 0.01 }),
				makeToolResultEntry("read"),
				makeToolResultEntry("read"),
			],
			"/tmp/before.jsonl",
			false,
		);

		const sAfter = computeSessionMetrics(
			headerAfter,
			[
				makeUserEntry(),
				makeAssistantEntry(["read"], { stopReason: "stop", cost: 0.05 }),
				makeToolResultEntry("read"),
			],
			"/tmp/after.jsonl",
			false,
		);

		const all = [sBefore, sAfter];
		const before = all.filter((s) => s.date < splitDate);
		const after = all.filter((s) => s.date >= splitDate);

		const statsBefore = computeAggregateStats(before);
		const statsAfter = computeAggregateStats(after);

		expect(statsBefore.sessionCount).toBe(1);
		expect(statsAfter.sessionCount).toBe(1);
		expect(statsBefore.totalCost).toBeCloseTo(0.01);
		expect(statsAfter.totalCost).toBeCloseTo(0.05);
		expect(statsBefore.meanToolCallVolume).toBe(2);
		expect(statsAfter.meanToolCallVolume).toBe(1);
	});
});
