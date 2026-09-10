import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.js";
import { isContextOverflow } from "../src/utils/overflow.js";

const LENGTH_EXHAUSTED_ERROR =
	"Response truncated at token limit after 3 attempts — output exceeded the model's maximum token budget";

function createErrorMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 90,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: LENGTH_EXHAUSTED_ERROR,
		timestamp: Date.now(),
		...overrides,
	};
}

describe("successful responses exceeding the configured input window", () => {
	function successfulMessage(input: number, cacheRead: number, cacheWrite: number): AssistantMessage {
		return createErrorMessage({
			stopReason: "stop",
			errorMessage: undefined,
			usage: {
				...createErrorMessage().usage,
				input,
				cacheRead,
				cacheWrite,
				output: 158,
				totalTokens: input + cacheRead + cacheWrite + 158,
			},
		});
	}

	it.each([
		[568044, 0, 0],
		[2, 568042, 0],
		[2, 0, 568042], // Copilot Opus 4.8 live response, 2026-09-08
		[2, 100000, 100000],
	])("counts input=%i, cacheRead=%i, cacheWrite=%i", (input, cacheRead, cacheWrite) => {
		expect(isContextOverflow(successfulMessage(input, cacheRead, cacheWrite), 200000)).toBe(true);
	});

	it.each([199999, 200000])("does not count output toward input overflow at %i input tokens", (inputTokens) => {
		expect(isContextOverflow(successfulMessage(2, 100000, inputTokens - 100002), 200000)).toBe(false);
	});

	it("requires a configured window", () => {
		expect(isContextOverflow(successfulMessage(2, 0, 568042))).toBe(false);
	});

	it.each(["error", "aborted", "length", "toolUse"] as const)(
		"does not classify %s as a successful input overflow",
		(stopReason) => {
			const message = successfulMessage(2, 0, 568042);
			expect(isContextOverflow({ ...message, stopReason, errorMessage: "unrelated error" }, 200000)).toBe(false);
		},
	);
});

describe("context-filled length exhaustion detection", () => {
	it("classifies exhausted length retries at the context boundary as overflow", () => {
		expect(isContextOverflow(createErrorMessage(), 100)).toBe(true);
	});

	it("classifies exhausted length retries above the context boundary as overflow", () => {
		const message = createErrorMessage({
			usage: {
				...createErrorMessage().usage,
				totalTokens: 101,
			},
		});
		expect(isContextOverflow(message, 100)).toBe(true);
	});

	it("uses usage components when totalTokens is unavailable", () => {
		const message = createErrorMessage({
			usage: {
				...createErrorMessage().usage,
				input: 80,
				output: 10,
				cacheRead: 10,
				totalTokens: 0,
			},
		});
		expect(isContextOverflow(message, 100)).toBe(true);
	});

	it("keeps genuine output-budget exhaustion below the context boundary", () => {
		const message = createErrorMessage({
			usage: {
				...createErrorMessage().usage,
				totalTokens: 99,
			},
		});
		expect(isContextOverflow(message, 100)).toBe(false);
	});

	it("requires the configured context window", () => {
		expect(isContextOverflow(createErrorMessage())).toBe(false);
	});

	it("does not classify unrelated high-usage errors", () => {
		expect(isContextOverflow(createErrorMessage({ errorMessage: "529 overloaded" }), 100)).toBe(false);
	});
});
