import { Container, Text } from "@dreb/tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolRenderContext, ToolRenderResultOptions } from "../src/core/extensions/types.js";
import { createSuggestNextToolDefinition, type SuggestNextDetails } from "../src/core/tools/suggest-next.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

describe("suggest_next tool", () => {
	function createTool() {
		const onSuggest = vi.fn();
		const tool = createSuggestNextToolDefinition(onSuggest);
		// Cast execute to skip the ctx parameter (not used by this tool)
		const execute = tool.execute.bind(tool) as (
			toolCallId: string,
			params: { command: string; summary?: string },
			signal?: AbortSignal,
			onUpdate?: any,
		) => Promise<{
			content: Array<{ type: string; text?: string }>;
			details?: SuggestNextDetails;
			endTurn?: boolean;
		}>;
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

	describe("endTurn behavior", () => {
		it("sets endTurn: true on successful execution", async () => {
			const { execute } = createTool();

			const result = await execute("call-et-1", { command: "/compact" });

			expect(result.endTurn).toBe(true);
		});

		it("does not set endTurn on error (invalid command)", async () => {
			const { execute } = createTool();

			const result = await execute("call-et-2", { command: "npm run build" });

			expect(result.endTurn).toBeUndefined();
		});

		it("does not set endTurn on error (empty command)", async () => {
			const { execute } = createTool();

			const result = await execute("call-et-3", { command: "" });

			expect(result.endTurn).toBeUndefined();
		});
	});

	describe("summary parameter", () => {
		it("includes summary in details when provided", async () => {
			const { execute } = createTool();

			const result = await execute("call-s-1", {
				command: "/skill:mach6-push",
				summary: "Updated the auth handler and added tests.",
			});

			expect(result.details).toEqual({
				suggestion: "/skill:mach6-push",
				summary: "Updated the auth handler and added tests.",
			});
		});

		it("works without summary (backward compat)", async () => {
			const { execute } = createTool();

			const result = await execute("call-s-2", { command: "/compact" });

			expect(result.details).toEqual({ suggestion: "/compact" });
			expect(result.details!.summary).toBeUndefined();
		});

		it("trims whitespace from summary", async () => {
			const { execute } = createTool();

			const result = await execute("call-s-3", {
				command: "/compact",
				summary: "  Done with the refactor.  ",
			});

			expect(result.details!.summary).toBe("Done with the refactor.");
		});

		it("treats empty summary as undefined", async () => {
			const { execute } = createTool();

			const result = await execute("call-s-4", {
				command: "/compact",
				summary: "   ",
			});

			expect(result.details!.summary).toBeUndefined();
		});

		it("strips control characters from summary but preserves newlines", async () => {
			const { execute } = createTool();

			const result = await execute("call-s-5", {
				command: "/compact",
				summary: "Line one\nLine two\x00\x1b[2J\x07end",
			});

			expect(result.details!.summary).toBe("Line one\nLine two[2Jend");
		});

		it("strips carriage return from summary", async () => {
			const { execute } = createTool();

			const result = await execute("call-s-7", {
				command: "/compact",
				summary: "Line one\r\nLine two\rLine three",
			});

			// \r\n → \n (CR stripped, LF preserved), bare \r → removed
			expect(result.details!.summary).toBe("Line one\nLine twoLine three");
		});

		it("treats control-character-only summary as undefined", async () => {
			const { execute } = createTool();

			const result = await execute("call-s-6", {
				command: "/compact",
				summary: "\x01\x02\x03",
			});

			expect(result.details!.summary).toBeUndefined();
		});

		it("converts literal backslash-n sequences to actual newlines", async () => {
			const { execute } = createTool();

			const result = await execute("call-s-8", {
				command: "/compact",
				summary: "Line one\\nLine two\\n\\nFinal line",
			});

			expect(result.details!.summary).toBe("Line one\nLine two\n\nFinal line");
		});
	});

	describe("control character sanitization", () => {
		it("strips control characters and accepts valid command", async () => {
			const { execute, onSuggest } = createTool();

			const result = await execute("call-7", { command: "/skill:mach6-push\nrm -rf /" });

			expect(onSuggest).toHaveBeenCalledWith("/skill:mach6-pushrm -rf /");
			expect(result.details).toEqual({ suggestion: "/skill:mach6-pushrm -rf /" });
		});

		it("strips leading newline — resulting command starts with / so it passes", async () => {
			const { execute, onSuggest } = createTool();

			const result = await execute("call-8", { command: "\n/compact" });

			expect(onSuggest).toHaveBeenCalledWith("/compact");
			expect(result.details).toEqual({ suggestion: "/compact" });
		});

		it("rejects command that becomes empty after stripping control chars", async () => {
			const { execute, onSuggest } = createTool();

			const result = await execute("call-9", { command: "\n\t\r" });

			expect(onSuggest).not.toHaveBeenCalled();
			expect(result.details).toBeUndefined();
		});

		it("strips tabs and other control chars from middle of command", async () => {
			const { execute, onSuggest } = createTool();

			const result = await execute("call-10", { command: "/skill:mach6\t-plan 42" });

			expect(onSuggest).toHaveBeenCalledWith("/skill:mach6-plan 42");
			expect(result.details).toEqual({ suggestion: "/skill:mach6-plan 42" });
		});
	});

	describe("renderResult", () => {
		beforeAll(() => {
			initTheme("dark");
		});

		function createRenderContext(overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
			return {
				args: {},
				toolCallId: "test-call",
				invalidate: () => {},
				lastComponent: undefined,
				state: {},
				cwd: process.cwd(),
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				expanded: false,
				showImages: false,
				isError: false,
				...overrides,
			};
		}

		const renderOptions: ToolRenderResultOptions = { expanded: false, isPartial: false };

		it("renders error message when no details present", () => {
			const tool = createSuggestNextToolDefinition(() => {});
			const result = {
				content: [{ type: "text" as const, text: "Error: command must start with /" }],
				details: undefined,
				isError: true,
			};

			const component = tool.renderResult!(result, renderOptions, theme, createRenderContext());

			expect(component).toBeInstanceOf(Text);
			const rendered = stripAnsi(component.render(120).join("\n"));
			expect(rendered).toContain("Error: command must start with /");
		});

		it("renders arrow with suggestion when details present but no summary", () => {
			const tool = createSuggestNextToolDefinition(() => {});
			const result = {
				content: [{ type: "text" as const, text: "Suggestion registered: /compact" }],
				details: { suggestion: "/compact" },
				isError: false,
			};

			const component = tool.renderResult!(result, renderOptions, theme, createRenderContext());

			expect(component).toBeInstanceOf(Text);
			const rendered = stripAnsi(component.render(120).join("\n"));
			expect(rendered).toContain("→ /compact");
		});

		it("renders Container with summary markdown and arrow when summary present", () => {
			const tool = createSuggestNextToolDefinition(() => {});
			const result = {
				content: [{ type: "text" as const, text: "Suggestion registered: /skill:mach6-push" }],
				details: { suggestion: "/skill:mach6-push", summary: "Updated the auth handler." },
				isError: false,
			};

			const component = tool.renderResult!(result, renderOptions, theme, createRenderContext());

			expect(component).toBeInstanceOf(Container);
			const rendered = stripAnsi(component.render(120).join("\n"));
			expect(rendered).toContain("Updated the auth handler.");
			expect(rendered).toContain("→ /skill:mach6-push");
		});

		it("reuses lastComponent Text on re-render without summary", () => {
			const tool = createSuggestNextToolDefinition(() => {});
			const existingText = new Text("old", 0, 0);
			const result = {
				content: [{ type: "text" as const, text: "Suggestion registered: /compact" }],
				details: { suggestion: "/compact" },
				isError: false,
			};

			const component = tool.renderResult!(
				result,
				renderOptions,
				theme,
				createRenderContext({ lastComponent: existingText }),
			);

			expect(component).toBe(existingText);
			const rendered = stripAnsi(component.render(120).join("\n"));
			expect(rendered).toContain("→ /compact");
		});

		it("reuses lastComponent Container on re-render with summary", () => {
			const tool = createSuggestNextToolDefinition(() => {});
			const existingContainer = new Container();
			const result = {
				content: [{ type: "text" as const, text: "Suggestion registered: /compact" }],
				details: { suggestion: "/compact", summary: "Done." },
				isError: false,
			};

			const component = tool.renderResult!(
				result,
				renderOptions,
				theme,
				createRenderContext({ lastComponent: existingContainer }),
			);

			expect(component).toBe(existingContainer);
			const rendered = stripAnsi(component.render(120).join("\n"));
			expect(rendered).toContain("Done.");
			expect(rendered).toContain("→ /compact");
		});
	});
});
