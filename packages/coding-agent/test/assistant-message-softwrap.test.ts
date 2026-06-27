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

function expectNoRawLineBreaks(lines: string[]): void {
	for (const [index, line] of lines.entries()) {
		expect(line, `line ${index} must not contain raw CR/LF`).not.toMatch(/[\r\n]/);
	}
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

	test("renders streamed markdown list continuations without raw line breaks", () => {
		const component = new AssistantMessageComponent(undefined, false);
		const updates = [
			"Next practical step:\n\n1. In the Bridge GUI, confirm your account is logged in.",
			"Next practical step:\n\n1. In the Bridge GUI, confirm your account is logged in.\n2. Find the mail client settings Bridge shows:\n    - IMAP host, usually 127.0.0.1\n    -",
			"Next practical step:\n\n1. In the Bridge GUI, confirm your account is logged in.\n2. Find the mail client settings Bridge shows:\n    - IMAP host, usually 127.0.0.1\n    - IMAP port",
		];

		for (const text of updates) {
			component.updateContent(createAssistantMessage({ content: [{ type: "text", text }] }));
			const lines = component.render(170);
			expectNoRawLineBreaks(lines);
		}
	});

	test("renders streamed thinking markdown list continuations without raw line breaks", () => {
		const component = new AssistantMessageComponent(undefined, false);
		const updates = [
			"Reasoning steps:\n\n1. Check the Bridge GUI state.",
			"Reasoning steps:\n\n1. Check the Bridge GUI state.\n2. Inspect connection settings:\n    - IMAP host, usually 127.0.0.1\n    -",
			"Reasoning steps:\n\n1. Check the Bridge GUI state.\n2. Inspect connection settings:\n    - IMAP host, usually 127.0.0.1\n    - IMAP port",
		];

		for (const thinking of updates) {
			component.updateContent(createAssistantMessage({ content: [{ type: "thinking", thinking }] }));
			const lines = component.render(170);
			expectNoRawLineBreaks(lines);
		}
	});
});
