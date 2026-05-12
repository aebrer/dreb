import { describe, expect, it, vi } from "vitest";
import { createSuggestNextToolDefinition, type SuggestNextDetails } from "../src/core/tools/suggest-next.js";

describe("suggest_next tool", () => {
	function createTool() {
		const onSuggest = vi.fn();
		const tool = createSuggestNextToolDefinition(onSuggest);
		// Cast execute to skip the ctx parameter (not used by this tool)
		const execute = tool.execute.bind(tool) as (
			toolCallId: string,
			params: { command: string },
			signal?: AbortSignal,
			onUpdate?: any,
		) => Promise<{ content: Array<{ type: string; text?: string }>; details?: SuggestNextDetails }>;
		return { execute, onSuggest };
	}

	it("calls onSuggest callback with the command", async () => {
		const { execute, onSuggest } = createTool();

		const result = await execute("call-1", { command: "/skill:mach6-push" });

		expect(onSuggest).toHaveBeenCalledWith("/skill:mach6-push");
		expect(result.details).toEqual({ suggestion: "/skill:mach6-push" });
		expect(result.content[0]).toEqual({ type: "text", text: "Suggestion registered: /skill:mach6-push" });
	});

	it("rejects commands that don't start with /", async () => {
		const { execute, onSuggest } = createTool();

		const result = await execute("call-2", { command: "npm run build" });

		expect(onSuggest).not.toHaveBeenCalled();
		expect(result.details).toBeUndefined();
		expect(result.content[0]?.text).toContain("Error");
	});

	it("rejects empty command", async () => {
		const { execute, onSuggest } = createTool();

		const result = await execute("call-3", { command: "" });

		expect(onSuggest).not.toHaveBeenCalled();
		expect(result.details).toBeUndefined();
	});

	it("accepts various command formats", async () => {
		const { execute, onSuggest } = createTool();

		await execute("call-4", { command: "/compact" });
		expect(onSuggest).toHaveBeenCalledWith("/compact");

		await execute("call-5", { command: "/skill:mach6-review 42" });
		expect(onSuggest).toHaveBeenCalledWith("/skill:mach6-review 42");

		await execute("call-6", { command: "/skill:mach6-plan 201" });
		expect(onSuggest).toHaveBeenCalledWith("/skill:mach6-plan 201");
	});
});
