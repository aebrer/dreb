import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createSubagentToolDefinition, getBackgroundAgents } from "../src/core/tools/subagent.js";

/**
 * Tests for background parallel mode — covering skipped-task paths (invalid relative
 * escape cwd) and the acceptance of absolute cwd values.
 */
describe("subagent background parallel — cwd handling", () => {
	const cwd = process.cwd();
	const dummyCtx = {} as ExtensionContext;

	function createTool() {
		return createSubagentToolDefinition(cwd, {
			onBackgroundStart: vi.fn(),
			onBackgroundComplete: vi.fn(),
		});
	}

	it("should accept absolute cwd values and launch tasks", async () => {
		const tool = createTool();
		const result = await tool.execute(
			"call-1",
			{
				background: true,
				tasks: [
					{ task: "task one", cwd: "/tmp" },
					{ task: "task two", cwd: cwd }, // absolute path equal to parent cwd
				],
			},
			undefined,
			undefined,
			dummyCtx,
		);

		const text = result.content[0].type === "text" ? result.content[0].text : "";

		// Both tasks should launch — no skipped tasks
		expect(text).toContain("2 background agents started");
		expect(text).not.toContain("failed to launch");
		expect(text).not.toContain("SKIPPED");
		expect(result.details).toEqual({ mode: "parallel", agentCount: 2 });
	});

	it("should accept an absolute cwd pointing to a different project directory", async () => {
		const tool = createTool();
		const result = await tool.execute(
			"call-2",
			{
				background: true,
				tasks: [{ task: "investigate this project", cwd: "/tmp" }],
			},
			undefined,
			undefined,
			dummyCtx,
		);

		const text = result.content[0].type === "text" ? result.content[0].text : "";

		expect(text).toContain("1 background agents started");
		expect(text).not.toContain("SKIPPED");
		expect(result.details).toEqual({ mode: "parallel", agentCount: 1 });
	});

	it("should report mix of launched and skipped tasks (relative escape is still rejected)", async () => {
		const tool = createTool();
		const result = await tool.execute(
			"call-3",
			{
				background: true,
				tasks: [
					{ task: "valid task" }, // no cwd override, uses default — should succeed
					{ task: "invalid task", cwd: "../../../../../../etc" }, // relative escape — should be skipped
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
			"call-4",
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
			"call-5",
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
			"call-6",
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
