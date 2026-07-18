import { describe, expect, it } from "vitest";
import { MODELS } from "../src/models.generated.js";
import type { Model } from "../src/types.js";

describe("kimi-coding-oauth generated registry", () => {
	const providerModels = MODELS["kimi-coding-oauth"];

	it("registers all three managed OAuth model IDs", () => {
		expect(Object.keys(providerModels).sort()).toEqual(["k3", "kimi-for-coding", "kimi-for-coding-highspeed"]);
	});

	it.each([
		["kimi-for-coding", "Kimi For Coding", 262144],
		["kimi-for-coding-highspeed", "Kimi For Coding Highspeed", 262144],
		["k3", "Kimi K3", 1048576],
	] as const)("pins the %s registry spec", (id, name, contextWindow) => {
		const model = providerModels[id] as Model<"openai-completions">;

		expect(model.id).toBe(id);
		expect(model.name).toBe(name);
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("kimi-coding-oauth");
		expect(model.baseUrl).toBe("https://api.kimi.com/coding/v1");
		expect(model.reasoning).toBe(true);
		expect(model.input).toContain("text");
		expect(model.input).toContain("image");
		expect(model.contextWindow).toBe(contextWindow);
		expect(model.maxTokens).toBe(32768);
		expect(model.compat).toMatchObject({
			thinkingFormat: "kimi",
			supportsDeveloperRole: false,
		});
	});

	it("maps K2.7 managed variants to Kimi's automatic reasoning effort", () => {
		const autoMap = {
			minimal: "auto",
			low: "auto",
			medium: "auto",
			high: "auto",
			xhigh: "auto",
		} as const;

		const standard = providerModels["kimi-for-coding"] as Model<"openai-completions">;
		const highspeed = providerModels["kimi-for-coding-highspeed"] as Model<"openai-completions">;

		expect(standard.compat?.reasoningEffortMap).toEqual(autoMap);
		expect(highspeed.compat?.reasoningEffortMap).toEqual(autoMap);
	});

	it("maps K3 reasoning effort to its advertised low/high/max efforts", () => {
		const k3 = providerModels.k3 as Model<"openai-completions">;

		expect(k3.compat?.reasoningEffortMap).toEqual({
			minimal: "low",
			low: "low",
			medium: "high",
			high: "high",
			xhigh: "max",
		});
	});
});
