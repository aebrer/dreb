import type { ThinkingLevel as AgentThinkingLevel } from "@dreb/agent-core";
import type { ThinkingLevel as AiThinkingLevel, Model } from "@dreb/ai";
import { describe, expect, test } from "vitest";
import {
	resolveEffectiveThinkingLevel,
	resolveThinkingDisplay,
	thinkingLevelToReasoning,
	validateThinkingLevelForModel,
} from "../src/core/thinking.js";

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

	test("unsupported xhigh clamps to high for normal session defaults", () => {
		expect(resolveEffectiveThinkingLevel(reasoningModel, "xhigh")).toBe("high");
	});

	test("xhigh-capable models preserve xhigh for normal session defaults", () => {
		const xhighModel = { ...reasoningModel, id: "gpt-5.6-test" } as Model<any>;
		expect(resolveEffectiveThinkingLevel(xhighModel, "xhigh")).toBe("xhigh");
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

describe("validateThinkingLevelForModel", () => {
	const xhighModel = { ...reasoningModel, id: "gpt-5.6-test" } as Model<any>;

	test("accepts off without a resolved model", () => {
		expect(validateThinkingLevelForModel(undefined, "off")).toEqual({ ok: true });
	});

	test.each(["minimal", "low", "medium", "high"] satisfies AgentThinkingLevel[])(
		"accepts %s for reasoning models",
		(thinkingLevel) => {
			expect(validateThinkingLevelForModel(reasoningModel, thinkingLevel)).toEqual({ ok: true });
		},
	);

	test("accepts xhigh only for xhigh-capable models", () => {
		expect(validateThinkingLevelForModel(xhighModel, "xhigh")).toEqual({ ok: true });
		expect(validateThinkingLevelForModel(reasoningModel, "xhigh")).toMatchObject({ ok: false });
	});

	test("rejects non-off thinking for non-reasoning models", () => {
		const result = validateThinkingLevelForModel(nonReasoningModel, "high");
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.error).toContain("non-reasoning model");
	});

	test("rejects non-off thinking without a concrete model", () => {
		const result = validateThinkingLevelForModel(undefined, "high");
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.error).toContain("no concrete child model");
	});
});

describe("resolveThinkingDisplay", () => {
	// supportsAdaptiveThinking only inspects model.id (opus/sonnet 4.6+).
	const adaptiveModel = { id: "claude-opus-4-8", reasoning: true } as unknown as Model<any>;
	const nonAdaptiveModel = { id: "claude-sonnet-4-5", reasoning: true } as unknown as Model<any>;

	test("adaptive model with no override defaults to 'summarized' (default-on)", () => {
		expect(resolveThinkingDisplay(adaptiveModel, undefined)).toBe("summarized");
	});

	test("adaptive model honors a stored override", () => {
		expect(resolveThinkingDisplay(adaptiveModel, "omitted")).toBe("omitted");
		expect(resolveThinkingDisplay(adaptiveModel, "summarized")).toBe("summarized");
	});

	test("non-adaptive model returns undefined regardless of override", () => {
		expect(resolveThinkingDisplay(nonAdaptiveModel, undefined)).toBeUndefined();
		expect(resolveThinkingDisplay(nonAdaptiveModel, "summarized")).toBeUndefined();
		expect(resolveThinkingDisplay(nonAdaptiveModel, "omitted")).toBeUndefined();
	});

	test("undefined model returns undefined", () => {
		expect(resolveThinkingDisplay(undefined, "summarized")).toBeUndefined();
		expect(resolveThinkingDisplay(undefined, undefined)).toBeUndefined();
	});
});
