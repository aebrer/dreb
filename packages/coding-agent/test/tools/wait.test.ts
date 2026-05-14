import { describe, expect, it } from "vitest";
import { filterSubagentTools } from "../../src/core/tools/subagent.js";
import {
	createWaitToolDefinition,
	formatWaitCall,
	formatWaitResult,
	type WaitAgentInfo,
	type WaitToolDetails,
	waitToolDefinition,
} from "../../src/core/tools/wait.js";

// Lightweight mock theme matching patterns in subagent-agent-type.test.ts
const mockTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("wait tool", () => {
	// Cast execute to skip the ctx parameter (not used by this tool)
	const execute = waitToolDefinition.execute.bind(waitToolDefinition) as (
		toolCallId: string,
		params: { reason?: string },
		signal?: AbortSignal,
		onUpdate?: any,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details?: WaitToolDetails; endTurn?: boolean }>;

	it("returns confirmation text with no reason", async () => {
		const result = await execute("call-1", {});

		expect(result.content[0]).toEqual({ type: "text", text: "Waiting…" });
		expect(result.details?.reason).toBeUndefined();
		expect(result.endTurn).toBe(true);
	});

	it("returns confirmation text with a reason", async () => {
		const result = await execute("call-2", { reason: "background subagent still running" });

		expect(result.content[0]).toEqual({ type: "text", text: "Waiting: background subagent still running" });
		expect(result.details?.reason).toBe("background subagent still running");
		expect(result.endTurn).toBe(true);
	});

	it("trims whitespace-only reason to undefined", async () => {
		const result = await execute("call-3", { reason: "   " });

		expect(result.content[0]).toEqual({ type: "text", text: "Waiting…" });
		expect(result.details?.reason).toBeUndefined();
	});

	it("trims reason string", async () => {
		const result = await execute("call-4", { reason: "  waiting for agent  " });

		expect(result.content[0]).toEqual({ type: "text", text: "Waiting: waiting for agent" });
		expect(result.details?.reason).toBe("waiting for agent");
	});

	it("returns immediately (is synchronous aside from Promise wrapper)", async () => {
		const start = Date.now();
		await execute("call-5", { reason: "test" });
		const elapsed = Date.now() - start;

		// Should complete in well under 50ms — it's a pure no-op
		expect(elapsed).toBeLessThan(50);
	});

	it("includes runningAgents in details", async () => {
		const result = await execute("call-6", {});
		// No agents spawned in test context, so should be empty array
		expect(result.details?.runningAgents).toEqual([]);
	});

	it("has correct tool metadata", () => {
		expect(waitToolDefinition.name).toBe("wait");
		expect(waitToolDefinition.label).toBe("wait");
		expect(waitToolDefinition.promptSnippet).toBeTruthy();
		expect(waitToolDefinition.promptGuidelines).toBeTruthy();
		expect(waitToolDefinition.promptGuidelines!.length).toBeGreaterThanOrEqual(2);
	});

	it("description mentions ending the turn", () => {
		expect(waitToolDefinition.description).toContain("end your turn");
	});

	it("prompt guidelines scope usage narrowly", () => {
		const guidelines = waitToolDefinition.promptGuidelines!.join(" ");
		expect(guidelines).toContain("explicitly told to wait");
		expect(guidelines).toContain("background subagents");
	});

	describe("createWaitToolDefinition factory", () => {
		it("returns the same shape as the singleton when called without args", () => {
			const created = createWaitToolDefinition();
			expect(created.name).toBe("wait");
			expect(created.label).toBe("wait");
			expect(created.description).toBe(waitToolDefinition.description);
		});

		it("populates runningAgents from the injected callback", async () => {
			const agents: WaitAgentInfo[] = [
				{ agentId: "abc123def456gh", agentType: "code-reviewer", taskSummary: "review PR" },
			];
			const tool = createWaitToolDefinition({ getRunningAgents: () => agents });
			const result = (await tool.execute("id", {}, undefined, undefined, undefined as any)) as any;
			expect(result.details?.runningAgents).toEqual(agents);
			expect(result.endTurn).toBe(true);
		});

		it("trims reason when callback is provided", async () => {
			const tool = createWaitToolDefinition({ getRunningAgents: () => [] });
			const result = (await tool.execute(
				"id",
				{ reason: "  trimmed  " },
				undefined,
				undefined,
				undefined as any,
			)) as any;
			expect(result.details?.reason).toBe("trimmed");
			expect(result.content[0]).toEqual({ type: "text", text: "Waiting: trimmed" });
		});

		it("returns endTurn: true from factory-created tool", async () => {
			const tool = createWaitToolDefinition({ getRunningAgents: () => [] });
			const result = (await tool.execute("id", {}, undefined, undefined, undefined as any)) as any;
			expect(result.endTurn).toBe(true);
		});
	});
});

describe("formatWaitCall", () => {
	it("renders just 'wait' with no reason", () => {
		expect(formatWaitCall(undefined, mockTheme)).toBe("wait");
	});

	it("renders just 'wait' with empty reason", () => {
		expect(formatWaitCall({}, mockTheme)).toBe("wait");
	});

	it("renders wait with reason", () => {
		expect(formatWaitCall({ reason: "agents running" }, mockTheme)).toBe("wait agents running");
	});
});

describe("formatWaitResult", () => {
	it("shows 'doing nothing — no subagents running' when no agents", () => {
		const result = {
			content: [{ type: "text", text: "Waiting…" }],
			details: { reason: undefined, runningAgents: [] },
		};
		expect(formatWaitResult(result, mockTheme)).toBe("→ doing nothing — no subagents running");
	});

	it("shows running agents when present", () => {
		const result = {
			content: [{ type: "text", text: "Waiting…" }],
			details: {
				reason: undefined,
				runningAgents: [
					{
						agentId: "abc123def456gh",
						agentType: "code-reviewer",
						taskSummary: "review",
						startedAt: 0,
						status: "running" as const,
					},
					{
						agentId: "xyz789012345ab",
						agentType: "error-auditor",
						taskSummary: "audit",
						startedAt: 0,
						status: "running" as const,
					},
				],
			},
		};
		expect(formatWaitResult(result, mockTheme)).toBe(
			"→ doing nothing (waiting on: abc123def456 code-reviewer, xyz789012345 error-auditor)",
		);
	});

	it("handles missing details gracefully", () => {
		const result = { content: [{ type: "text", text: "Waiting…" }] };
		expect(formatWaitResult(result, mockTheme)).toBe("→ doing nothing — no subagents running");
	});
});

describe("filterSubagentTools", () => {
	it("returns defaults when tools is undefined", () => {
		const result = filterSubagentTools(undefined);
		expect(result).toBe("read,bash,edit,write,grep,find,ls,web_search,web_fetch");
	});

	it("filters out wait from tool list", () => {
		const result = filterSubagentTools("read,bash,wait,grep");
		expect(result).toBe("read,bash,grep");
	});

	it("filters out subagent from tool list", () => {
		const result = filterSubagentTools("read,subagent,bash");
		expect(result).toBe("read,bash");
	});

	it("filters out both wait and subagent", () => {
		const result = filterSubagentTools("read,wait,bash,subagent,grep");
		expect(result).toBe("read,bash,grep");
	});

	it("returns defaults when all tools are excluded", () => {
		const result = filterSubagentTools("wait,subagent");
		expect(result).toBe("read,bash,edit,write,grep,find,ls,web_search,web_fetch");
	});

	it("returns defaults when only wait is specified", () => {
		const result = filterSubagentTools("wait");
		expect(result).toBe("read,bash,edit,write,grep,find,ls,web_search,web_fetch");
	});

	it("trims whitespace around tool names", () => {
		const result = filterSubagentTools("read , bash , wait , grep");
		expect(result).toBe("read,bash,grep");
	});

	it("passes through valid tools unchanged", () => {
		const result = filterSubagentTools("read,bash,edit,write");
		expect(result).toBe("read,bash,edit,write");
	});
});
