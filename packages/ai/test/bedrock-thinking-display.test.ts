import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { type BedrockOptions, buildAdditionalModelRequestFields } from "../src/providers/amazon-bedrock.js";

// Adaptive thinking model (Opus 4.8) — honors thinkingDisplay.
const adaptiveModel = getModel("amazon-bedrock", "anthropic.claude-opus-4-8");
// Budget-based reasoning model (Sonnet 4.5) — thinkingDisplay must be gated out.
const budgetModel = getModel("amazon-bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0");

describe("Bedrock buildAdditionalModelRequestFields thinking display", () => {
	it("sets thinking.display=summarized for adaptive models when requested", () => {
		const fields = buildAdditionalModelRequestFields(adaptiveModel, {
			reasoning: "high",
			thinkingDisplay: "summarized",
		} satisfies BedrockOptions);

		expect(fields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(fields?.thinking.display).toBe("summarized");
	});

	it("sets thinking.display=omitted for adaptive models when requested", () => {
		const fields = buildAdditionalModelRequestFields(adaptiveModel, {
			reasoning: "high",
			thinkingDisplay: "omitted",
		} satisfies BedrockOptions);

		expect(fields?.thinking.display).toBe("omitted");
	});

	it("omits the display field for adaptive models when thinkingDisplay is unset", () => {
		const fields = buildAdditionalModelRequestFields(adaptiveModel, {
			reasoning: "high",
		} satisfies BedrockOptions);

		expect(fields?.thinking).toEqual({ type: "adaptive" });
		expect(fields?.thinking.display).toBeUndefined();
	});

	it("uses adaptive thinking and native xhigh effort for Claude Opus 5 xhigh", () => {
		const fields = buildAdditionalModelRequestFields({ ...adaptiveModel, id: "anthropic.claude-opus-5" }, {
			reasoning: "xhigh",
			thinkingDisplay: "summarized",
		} satisfies BedrockOptions);

		expect(fields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(fields?.output_config).toEqual({ effort: "xhigh" });
	});

	it("never sets display on budget-based models even when thinkingDisplay is requested", () => {
		const fields = buildAdditionalModelRequestFields(budgetModel, {
			reasoning: "high",
			thinkingDisplay: "summarized",
		} satisfies BedrockOptions);

		expect(fields?.thinking.type).toBe("enabled");
		expect(fields?.thinking.display).toBeUndefined();
	});

	it("keeps dated Claude 3.7 IDs on budget-based thinking", () => {
		const fields = buildAdditionalModelRequestFields(
			{ ...budgetModel, id: "us.anthropic.claude-3-7-sonnet-20250219-v1:0" },
			{
				reasoning: "xhigh",
				thinkingDisplay: "summarized",
			} satisfies BedrockOptions,
		);

		expect(fields?.thinking.type).toBe("enabled");
		expect(fields?.thinking.budget_tokens).toBeTypeOf("number");
		expect(fields?.thinking.display).toBeUndefined();
		expect(fields?.output_config).toBeUndefined();
	});
});

describe("Bedrock buildAdditionalModelRequestFields effort mapping", () => {
	it.each([
		["anthropic.claude-opus-5", "max", "max"],
		["global.anthropic.claude-opus-5-5", "xhigh", "xhigh"],
		["global.anthropic.claude-opus-5-5", "max", "max"],
		["us.anthropic.claude-sonnet-5-5", "xhigh", "xhigh"],
		["us.anthropic.claude-sonnet-5-5", "max", "max"],
		["global.anthropic.claude-haiku-5-5", "xhigh", "xhigh"],
		["global.anthropic.claude-haiku-5-5", "max", "max"],
		["global.anthropic.claude-haiku-5-5", "minimal", "low"],
		["us.anthropic.claude-opus-4-6-v1", "max", "max"],
		["us.anthropic.claude-opus-4-6-v1", "xhigh", "max"],
		["us.anthropic.claude-sonnet-4-6", "xhigh", "max"],
	] as const)("sends %s reasoning=%s as adaptive effort %s", (id, reasoning, effort) => {
		const fields = buildAdditionalModelRequestFields({ ...adaptiveModel, id }, {
			reasoning,
		} satisfies BedrockOptions);

		expect(fields?.thinking).toEqual({ type: "adaptive" });
		expect(fields?.output_config).toEqual({ effort });
		expect(fields?.anthropic_beta).toBeUndefined();
	});
});

describe("Bedrock buildAdditionalModelRequestFields with reasoning off", () => {
	it.each([
		["anthropic.claude-opus-5", { thinking: { type: "disabled" } }],
		["us.anthropic.claude-sonnet-5", { thinking: { type: "disabled" } }],
		["global.anthropic.claude-haiku-5-5", { thinking: { type: "disabled" } }],
		["us.anthropic.claude-sonnet-5-5", { thinking: { type: "between_tools" } }],
		["global.anthropic.claude-opus-5-5", undefined],
		["anthropic.claude-opus-4-8", undefined],
		["us.anthropic.claude-sonnet-4-6", undefined],
		["anthropic.claude-sonnet-4-5-20250929-v1:0", undefined],
	] as const)("sends the off config for %s", (id, expected) => {
		const fields = buildAdditionalModelRequestFields({ ...adaptiveModel, id }, {} satisfies BedrockOptions);

		expect(fields).toEqual(expected);
	});

	it("returns undefined for non-reasoning models", () => {
		const fields = buildAdditionalModelRequestFields(
			{ ...adaptiveModel, id: "anthropic.claude-opus-5", reasoning: false },
			{} satisfies BedrockOptions,
		);

		expect(fields).toBeUndefined();
	});
});
