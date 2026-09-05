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
