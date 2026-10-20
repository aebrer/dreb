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
		const xhighModel = { ...reasoningModel, id: "gpt-5.5" } as Model<any>;
		expect(resolveEffectiveThinkingLevel(xhighModel, "xhigh")).toBe("xhigh");
	});

	test("unsupported max falls back to xhigh before high", () => {
		expect(resolveEffectiveThinkingLevel({ ...reasoningModel, id: "gpt-5.5" }, "max")).toBe("xhigh");
		expect(resolveEffectiveThinkingLevel(reasoningModel, "max")).toBe("high");
	});

	test("max-capable models preserve max", () => {
		expect(resolveEffectiveThinkingLevel({ ...reasoningModel, id: "gpt-5.6-sol" }, "max")).toBe("max");
	});

	test("off clamps to minimal on Claude Opus 5.5, whose thinking cannot be turned off", () => {
		expect(resolveEffectiveThinkingLevel({ ...reasoningModel, id: "claude-opus-5-5" }, "off")).toBe("minimal");
		expect(resolveEffectiveThinkingLevel({ ...reasoningModel, id: "claude-sonnet-5-5" }, "off")).toBe("off");
	});

	test("unsupported xhigh clamps up to max on Claude Opus/Sonnet 4.6", () => {
		expect(resolveEffectiveThinkingLevel({ ...reasoningModel, id: "claude-opus-4-6" }, "xhigh")).toBe("max");
		expect(resolveEffectiveThinkingLevel({ ...reasoningModel, id: "claude-sonnet-4-6" }, "xhigh")).toBe("max");
	});

	test("Claude 5.5 models preserve native xhigh and max", () => {
		for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
			expect(resolveEffectiveThinkingLevel({ ...reasoningModel, id }, "xhigh")).toBe("xhigh");
			expect(resolveEffectiveThinkingLevel({ ...reasoningModel, id }, "max")).toBe("max");
		}
	});
});

describe("thinkingLevelToReasoning", () => {
	test("returns undefined for off", () => {
		expect(thinkingLevelToReasoning("off")).toBeUndefined();
	});

	test.each(["minimal", "low", "medium", "high", "xhigh", "max"] satisfies AiThinkingLevel[])(
		"passes through %s",
		(thinkingLevel) => {
			expect(thinkingLevelToReasoning(thinkingLevel)).toBe(thinkingLevel);
		},
	);
});

describe("validateThinkingLevelForModel", () => {
	const xhighModel = { ...reasoningModel, id: "gpt-5.5" } as Model<any>;
	const maxModel = { ...reasoningModel, id: "gpt-5.6-sol" } as Model<any>;

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

	test("accepts max only for max-capable models", () => {
		expect(validateThinkingLevelForModel(maxModel, "max")).toEqual({ ok: true });
		expect(validateThinkingLevelForModel(xhighModel, "max")).toMatchObject({ ok: false });
	});

	test("rejects off for a model whose thinking cannot be turned off", () => {
		const result = validateThinkingLevelForModel({ ...reasoningModel, id: "claude-opus-5-5" }, "off");
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) {
			expect(result.error).toContain('Thinking level "off" is not supported');
			expect(result.error).toContain('"minimal" or "low"');
		}
	});

	test("accepts off for reasoning models that can turn thinking off, and for non-reasoning models", () => {
		expect(validateThinkingLevelForModel({ ...reasoningModel, id: "claude-sonnet-5-5" }, "off")).toEqual({
			ok: true,
		});
		expect(validateThinkingLevelForModel(reasoningModel, "off")).toEqual({ ok: true });
		expect(validateThinkingLevelForModel({ ...nonReasoningModel, id: "claude-opus-5-5" }, "off")).toEqual({
			ok: true,
		});
	});

	test("max error suggests xhigh only when the model supports it", () => {
		const xhighResult = validateThinkingLevelForModel(xhighModel, "max");
		const plainResult = validateThinkingLevelForModel(reasoningModel, "max");
		if (xhighResult.ok || plainResult.ok) throw new Error("expected max to be rejected");
		expect(xhighResult.error).toContain('Use "xhigh"');
		expect(plainResult.error).toContain('Use "high"');
		expect(plainResult.error).not.toContain('"xhigh"');
	});

	test("xhigh error suggests max on models that have max but not xhigh", () => {
		const result = validateThinkingLevelForModel({ ...reasoningModel, id: "claude-opus-4-6" }, "xhigh");
		if (result.ok) throw new Error("expected xhigh to be rejected");
		expect(result.error).toContain('Use "max" or "high"');
	});

	test("accepts native Anthropic max on Claude Opus 4.6 and the 5.5 models", () => {
		for (const id of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-5-5", "claude-haiku-5-5"]) {
			expect(validateThinkingLevelForModel({ ...reasoningModel, id }, "max")).toEqual({ ok: true });
		}
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
