import { describe, expect, it } from "vitest";
import { adjustMaxTokensForThinking, buildBaseOptions } from "../src/providers/simple-options.js";
import type { Model } from "../src/types.js";

function model(maxTokens: number): Model<"openai-responses"> {
	return {
		id: `test-${maxTokens}`,
		name: "Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
	};
}

describe("buildBaseOptions maxTokens", () => {
	it.each([16000, 32000, 128000])("uses the model's configured %i-token maximum", (maxTokens) => {
		expect(buildBaseOptions(model(maxTokens)).maxTokens).toBe(maxTokens);
	});

	it("preserves an explicit smaller call-site budget", () => {
		expect(buildBaseOptions(model(128000), { maxTokens: 4096 }).maxTokens).toBe(4096);
	});
});

describe("adjustMaxTokensForThinking", () => {
	it("fits thinking inside the existing total instead of enlarging it", () => {
		expect(adjustMaxTokensForThinking(32000, 128000, "high")).toEqual({
			maxTokens: 32000,
			thinkingBudget: 16384,
		});
	});

	it("clamps thinking to leave output room in a bounded internal call", () => {
		expect(adjustMaxTokensForThinking(8192, 128000, "high")).toEqual({
			maxTokens: 8192,
			thinkingBudget: 7168,
		});
	});
});
