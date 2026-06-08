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

	it("never sets display on budget-based models even when thinkingDisplay is requested", () => {
		const fields = buildAdditionalModelRequestFields(budgetModel, {
			reasoning: "high",
			thinkingDisplay: "summarized",
		} satisfies BedrockOptions);

		expect(fields?.thinking.type).toBe("enabled");
		expect(fields?.thinking.display).toBeUndefined();
	});
});
