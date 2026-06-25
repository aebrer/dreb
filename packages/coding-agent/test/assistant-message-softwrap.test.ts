import type { AssistantMessage } from "@dreb/ai";
import { isWrappableLine, stripWrapMarker, visibleWidth } from "@dreb/tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Hello" }],
		api: "messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function plain(line: string): string {
	return stripAnsi(stripWrapMarker(line));
}

describe("AssistantMessageComponent soft-wrap rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders long assistant prose, thinking, and errors as wrappable logical lines", () => {
		const prose = "assistant-prose-".repeat(8);
		const thinking = "assistant-thinking-".repeat(8);
		const error = "assistant-error-".repeat(8);
		const component = new AssistantMessageComponent(
			createAssistantMessage({
				content: [
					{ type: "thinking", thinking },
					{ type: "text", text: prose },
				],
				stopReason: "error",
				errorMessage: error,
			}),
			false,
		);

		const lines = component.render(24);
		const proseLine = lines.find((line) => plain(line).includes(prose));
		const thinkingLine = lines.find((line) => plain(line).includes(thinking));
		const errorLine = lines.find((line) => plain(line).includes(error));

		for (const [name, line] of [
			["prose", proseLine],
			["thinking", thinkingLine],
			["error", errorLine],
		] as const) {
			expect(line, `${name} line should render`).toBeDefined();
			expect(isWrappableLine(line!), `${name} line should be marked wrappable`).toBe(true);
			expect(
				visibleWidth(stripWrapMarker(line!)),
				`${name} logical line should exceed narrow width`,
			).toBeGreaterThan(24);
		}
	});
});
