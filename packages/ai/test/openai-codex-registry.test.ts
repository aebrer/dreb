import { describe, expect, it } from "vitest";
import { MODELS } from "../src/models.generated.js";
import type { Model } from "../src/types.js";

describe("openai-codex generated registry", () => {
	const providerModels = MODELS["openai-codex"];

	it("pins the live-probe-verified codex model set", () => {
		expect(Object.keys(providerModels).sort()).toEqual([
			"gpt-5.4-mini",
			"gpt-5.5",
			"gpt-5.6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-6-astra",
		]);
	});

	it.each([
		["gpt-5.4-mini", 272000],
		["gpt-5.5", 400000],
		["gpt-5.6-sol", 372000],
		["gpt-5.6-terra", 372000],
		["gpt-5.6-luna", 372000],
		["gpt-6-astra", 272000],
	] as const)("pins the %s codex surface spec", (id, contextWindow) => {
		const model = providerModels[id] as Model<"openai-codex-responses">;

		expect(model.id).toBe(id);
		expect(model.api).toBe("openai-codex-responses");
		expect(model.provider).toBe("openai-codex");
		expect(model.baseUrl).toBe("https://chatgpt.com/backend-api");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(contextWindow);
		expect(model.maxTokens).toBe(128000);
	});

	it("pins the gpt-6-astra codex-surface cost rates", () => {
		const astra = providerModels["gpt-6-astra"] as Model<"openai-codex-responses">;

		expect(astra.cost).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
	});

	it("routes github-copilot gpt-6 models to the openai-responses API", () => {
		const astra = MODELS["github-copilot"]["gpt-6-astra"] as Model<"openai-responses">;

		expect(astra.api).toBe("openai-responses");
		expect(astra.compat).toBeUndefined();
	});
});
