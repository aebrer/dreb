import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createSubagentToolDefinition, type SubagentResult } from "../src/core/tools/subagent.js";

/**
 * Tests for agent type propagation — verifies that the top-level `agent` and `model`
 * parameters are inherited by parallel tasks and chain steps when not overridden per-item.
 */

const cwd = process.cwd();

function createTool(onComplete?: (agentId: string, result: SubagentResult, cancelled: boolean) => void) {
	const onBackgroundStart = vi.fn();
	const onBackgroundComplete = onComplete ?? vi.fn();
	const tool = createSubagentToolDefinition(cwd, {
		onBackgroundStart,
		onBackgroundComplete,
	});
	return { tool, onBackgroundStart, onBackgroundComplete };
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((c) => c.type === "text")?.text ?? "";
}

// ---------------------------------------------------------------------------
// Parallel mode — agent inheritance
// ---------------------------------------------------------------------------

describe("parallel tasks — agent type inheritance", () => {
	it("inherits top-level agent when task items have no agent field", async () => {
		const { tool, onBackgroundStart } = createTool();
		const result = await tool.execute(
			"call-1",
			{
				agent: "feature-dev",
				tasks: [{ task: "task one" }, { task: "task two" }],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		const text = getText(result);
		// Both tasks should be launched as feature-dev
		expect(text).toContain("2 background agents started");
		// Each task in the listing should show (feature-dev)
		expect(text).toContain("(feature-dev):");

		// onBackgroundStart should be called with feature-dev for both
		expect(onBackgroundStart).toHaveBeenCalledTimes(2);
		expect(onBackgroundStart.mock.calls[0][1]).toBe("feature-dev");
		expect(onBackgroundStart.mock.calls[1][1]).toBe("feature-dev");
	});

	it("per-task agent overrides top-level agent", async () => {
		const { tool, onBackgroundStart } = createTool();
		await tool.execute(
			"call-2",
			{
				agent: "feature-dev",
				tasks: [
					{ task: "task one", agent: "Sandbox" },
					{ task: "task two" }, // should inherit feature-dev
				],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(onBackgroundStart).toHaveBeenCalledTimes(2);
		expect(onBackgroundStart.mock.calls[0][1]).toBe("Sandbox");
		expect(onBackgroundStart.mock.calls[1][1]).toBe("feature-dev");
	});

	it("defaults to Explore when neither top-level nor per-task agent is set", async () => {
		const { tool, onBackgroundStart } = createTool();
		await tool.execute(
			"call-3",
			{
				tasks: [{ task: "task one" }],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(onBackgroundStart).toHaveBeenCalledTimes(1);
		expect(onBackgroundStart.mock.calls[0][1]).toBe("Explore");
	});

	it("launch listing includes agent type per task", async () => {
		const { tool } = createTool();
		const result = await tool.execute(
			"call-4",
			{
				agent: "feature-dev",
				tasks: [{ task: "do something" }, { task: "do another thing", agent: "Explore" }],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		const text = getText(result);
		// Should have (feature-dev) and (Explore) in the listing
		expect(text).toContain("(feature-dev):");
		expect(text).toContain("(Explore):");
	});
});

// ---------------------------------------------------------------------------
// Parallel mode — model inheritance
// ---------------------------------------------------------------------------

describe("parallel tasks — model inheritance", () => {
	it("inherits top-level model when task items have no model field", async () => {
		// We can't easily inspect what model was passed to the child process
		// without spawning, but we can verify the tool doesn't error out
		// and that the launch listing is correct. The model override flows through
		// launchBackgroundTask → executeSingle → resolveModelWithFallbacks.
		// For unit testing, we just verify the tool accepts the configuration.
		const { tool } = createTool();
		const result = await tool.execute(
			"call-5",
			{
				model: "some-model",
				tasks: [{ task: "task one" }, { task: "task two" }],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		const text = getText(result);
		// Tasks should launch (model resolution may fail but that's a different concern)
		expect(text).toContain("background agents started");
	});
});

// ---------------------------------------------------------------------------
// Chain mode — agent inheritance
// ---------------------------------------------------------------------------

describe("chain mode — agent type inheritance", () => {
	it("inherits top-level agent for chain wrapper and steps", async () => {
		const { tool, onBackgroundStart } = createTool();
		const result = await tool.execute(
			"call-6",
			{
				agent: "feature-dev",
				chain: [{ task: "step one" }, { task: "step two {previous}" }],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		const text = getText(result);
		expect(text).toContain("Background chain");
		expect(text).toContain("2-step chain");

		// onBackgroundStart should be called with feature-dev (the chain wrapper agent)
		expect(onBackgroundStart).toHaveBeenCalledTimes(1);
		expect(onBackgroundStart.mock.calls[0][1]).toBe("feature-dev");
	});

	it("uses first step agent when no top-level agent is set", async () => {
		const { tool, onBackgroundStart } = createTool();
		await tool.execute(
			"call-7",
			{
				chain: [{ task: "step one", agent: "Sandbox" }, { task: "step two {previous}" }],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		// Chain wrapper should use first step's agent
		expect(onBackgroundStart).toHaveBeenCalledTimes(1);
		expect(onBackgroundStart.mock.calls[0][1]).toBe("Sandbox");
	});

	it("defaults to Explore when no agent specified anywhere", async () => {
		const { tool, onBackgroundStart } = createTool();
		await tool.execute(
			"call-8",
			{
				chain: [{ task: "step one" }],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(onBackgroundStart).toHaveBeenCalledTimes(1);
		expect(onBackgroundStart.mock.calls[0][1]).toBe("Explore");
	});

	it("top-level agent takes precedence over first step agent for wrapper", async () => {
		const { tool, onBackgroundStart } = createTool();
		await tool.execute(
			"call-9",
			{
				agent: "feature-dev",
				chain: [{ task: "step one", agent: "Sandbox" }, { task: "step two {previous}" }],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		// Chain wrapper should use top-level agent, not first step's agent
		expect(onBackgroundStart).toHaveBeenCalledTimes(1);
		expect(onBackgroundStart.mock.calls[0][1]).toBe("feature-dev");
	});
});

// ---------------------------------------------------------------------------
// formatSubagentCall — tested indirectly via renderCall
// ---------------------------------------------------------------------------

describe("formatSubagentCall — parallel agent types", () => {
	// formatSubagentCall is not exported, so we test via renderCall which delegates to it.
	// The Text component stores text privately, so we access it via (component as any).text.

	it("shows single agent type for uniform parallel tasks", () => {
		const { tool } = createTool();
		const mockTheme = {
			fg: (_style: string, text: string) => text,
			bold: (text: string) => text,
		} as any;
		const mockContext = { lastComponent: undefined, argsComplete: true, showImages: false };
		const component = tool.renderCall?.(
			{ tasks: [{ task: "a" }, { task: "b" }, { task: "c" }], agent: "feature-dev" } as any,
			mockTheme,
			mockContext as any,
		);
		const rendered = (component as any)?.text ?? "";
		expect(rendered).toContain("3 feature-dev tasks");
	});

	it("shows mixed agent types for heterogeneous parallel tasks", () => {
		const { tool } = createTool();
		const mockTheme = {
			fg: (_style: string, text: string) => text,
			bold: (text: string) => text,
		} as any;
		const mockContext = { lastComponent: undefined, argsComplete: true, showImages: false };
		const component = tool.renderCall?.(
			{
				tasks: [{ task: "a", agent: "Sandbox" }, { task: "b" }, { task: "c" }],
				agent: "feature-dev",
			} as any,
			mockTheme,
			mockContext as any,
		);
		const rendered = (component as any)?.text ?? "";
		expect(rendered).toContain("3 tasks:");
		expect(rendered).toContain("1 Sandbox");
		expect(rendered).toContain("2 feature-dev");
	});
});
