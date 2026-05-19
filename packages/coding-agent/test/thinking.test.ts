import type { ThinkingLevel as AgentThinkingLevel } from "@dreb/agent-core";
import type { ThinkingLevel as AiThinkingLevel, Model } from "@dreb/ai";
import { describe, expect, test } from "vitest";
import { resolveEffectiveThinkingLevel, thinkingLevelToReasoning } from "../src/core/thinking.js";

const reasoningModel: Model<"anthropic-messages"> = {
	id: "reasoning-model",
	name: "Reasoning Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const nonReasoningModel: Model<"anthropic-messages"> = {
	...reasoningModel,
	id: "non-reasoning-model",
	name: "Non-reasoning Model",
	reasoning: false,
};

describe("resolveEffectiveThinkingLevel", () => {
	test("undefined model clamps to off even if a thinking level is provided", () => {
		expect(resolveEffectiveThinkingLevel(undefined, "high")).toBe("off");
	});

	test("reasoning model with undefined thinking uses the default parameter", () => {
		expect(resolveEffectiveThinkingLevel(reasoningModel, undefined, "low")).toBe("low");
	});

	test.each(["minimal", "low", "medium", "high"] satisfies AgentThinkingLevel[])(
		"reasoning model preserves explicit %s thinking level",
		(thinkingLevel) => {
			expect(resolveEffectiveThinkingLevel(reasoningModel, thinkingLevel)).toBe(thinkingLevel);
		},
	);

	test("non-reasoning model clamps to off", () => {
		expect(resolveEffectiveThinkingLevel(nonReasoningModel, "high")).toBe("off");
	});
});

describe("thinkingLevelToReasoning", () => {
	test("returns undefined for off", () => {
		expect(thinkingLevelToReasoning("off")).toBeUndefined();
	});

	test.each(["minimal", "low", "medium", "high", "xhigh"] satisfies AiThinkingLevel[])(
		"passes through %s",
		(thinkingLevel) => {
			expect(thinkingLevelToReasoning(thinkingLevel)).toBe(thinkingLevel);
		},
	);
});
