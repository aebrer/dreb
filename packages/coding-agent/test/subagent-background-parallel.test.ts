import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createSubagentToolDefinition, getBackgroundAgents } from "../src/core/tools/subagent.js";

/**
 * Tests for background parallel mode — specifically the skipped-task path
 * when tasks have invalid cwd values that fail clampCwd validation.
 */
describe("subagent background parallel — skipped tasks", () => {
	const cwd = process.cwd();
	const dummyCtx = {} as ExtensionContext;

	function createTool() {
		return createSubagentToolDefinition(cwd, {
			onBackgroundStart: vi.fn(),
			onBackgroundComplete: vi.fn(),
		});
	}

	it("should report skipped tasks when all tasks have invalid absolute cwd", async () => {
		const tool = createTool();
		const result = await tool.execute(
			"call-1",
			{
				background: true,
				tasks: [
					{ task: "task one", cwd: "/tmp/evil" },
					{ task: "task two", cwd: "/absolute/path" },
				],
			},
			undefined,
			undefined,
			dummyCtx,
		);

		const text = result.content[0].type === "text" ? result.content[0].text : "";

		// Should report 0 launched
		expect(text).toContain("0 background agents started");
		// Should report both tasks as failed to launch
		expect(text).toContain("2 task(s) failed to launch");
		expect(text).toContain("SKIPPED");
		expect(text).toContain("task one");
		expect(text).toContain("task two");
		// Should NOT say "Each will notify" when nothing was launched
		expect(text).not.toContain("Each will notify independently");
		// Should say no agents launched
		expect(text).toContain("No agents were launched");
		// agentCount should be 0
		expect(result.details).toEqual({ mode: "parallel", agentCount: 0 });
	});

	it("should report mix of launched and skipped tasks", async () => {
		const tool = createTool();
		const result = await tool.execute(
			"call-2",
			{
				background: true,
				tasks: [
					{ task: "valid task" }, // no cwd override, uses default — should succeed
					{ task: "invalid task", cwd: "/absolute/path" }, // should be skipped
				],
			},
			undefined,
			undefined,
			dummyCtx,
		);

		const text = result.content[0].type === "text" ? result.content[0].text : "";

		// Should have 1 launched, 1 skipped
		expect(text).toContain("1 background agents started");
		expect(text).toContain("1 task(s) failed to launch");
		expect(text).toContain("SKIPPED");
		expect(text).toContain("invalid task");
		// Should say "Each will notify" since at least one was launched
		expect(text).toContain("Each will notify independently");
		expect(result.details).toEqual({ mode: "parallel", agentCount: 1 });
	});

	it("should report escape-cwd tasks as skipped", async () => {
		const tool = createTool();
		const result = await tool.execute(
			"call-3",
			{
				background: true,
				tasks: [{ task: "escape attempt", cwd: "../../../../../../etc" }],
			},
			undefined,
			undefined,
			dummyCtx,
		);

		const text = result.content[0].type === "text" ? result.content[0].text : "";

		expect(text).toContain("0 background agents started");
		expect(text).toContain("1 task(s) failed to launch");
		expect(text).toContain("SKIPPED");
		expect(text).toContain("resolves outside parent cwd");
		expect(text).toContain("No agents were launched");
	});

	it("should register inherited agent type in background agent registry", async () => {
		const tool = createTool();
		const result = await tool.execute(
			"call-4",
			{
				agent: "feature-dev",
				tasks: [{ task: "valid task with inherited agent" }],
			},
			undefined,
			undefined,
			dummyCtx,
		);

		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("1 background agents started");

		// Check that the background agent registry has the correct agent type
		const agents = getBackgroundAgents();
		const ourAgent = agents.find((a) => a.agentType === "feature-dev");
		expect(ourAgent).toBeDefined();
		expect(ourAgent!.agentType).toBe("feature-dev");
	});

	it("should show inherited agent type in launch listing", async () => {
		const tool = createTool();
		const result = await tool.execute(
			"call-5",
			{
				agent: "feature-dev",
				tasks: [{ task: "task one" }, { task: "task two" }],
			},
			undefined,
			undefined,
			dummyCtx,
		);

		const text = result.content[0].type === "text" ? result.content[0].text : "";
		// Each task line should include (feature-dev)
		expect(text).toContain("(feature-dev):");
		// Should NOT contain (Explore) since all tasks inherit feature-dev
		expect(text).not.toContain("(Explore)");
	});
});
