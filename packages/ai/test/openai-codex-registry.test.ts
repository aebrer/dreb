import { describe, expect, it } from "vitest";
import { CODEX_EXPECTED_IDS } from "../scripts/codex-models.js";
import { MODELS } from "../src/models.generated.js";
import type { Model } from "../src/types.js";

describe("openai-codex generated registry", () => {
	const providerModels = MODELS["openai-codex"];

	it("includes every expected codex model (new catalog entries may extend the list)", () => {
		expect(Object.keys(providerModels)).toEqual(expect.arrayContaining([...CODEX_EXPECTED_IDS]));
	});

	it("excludes non-codex OpenAI variants and bare family aliases", () => {
		for (const id of ["gpt-5.5-pro", "gpt-5.6", "gpt-5.4-nano", "gpt-5.3-chat-latest"]) {
			expect(providerModels[id as keyof typeof providerModels]).toBeUndefined();
		}
	});

	it("derives codex pricing from the OpenAI catalog", () => {
		for (const [id, model] of Object.entries(providerModels)) {
			const openai = MODELS.openai[id as keyof typeof MODELS.openai] as Model<"openai-responses">;
			expect(model.cost).toEqual(openai.cost);
		}
	});

	it.each([
		["gpt-5.4-mini", 272000],
		["gpt-5.5", 272000],
		["gpt-5.6-sol", 272000],
		["gpt-5.6-terra", 272000],
		["gpt-5.6-luna", 272000],
		["gpt-6-astra", 272000],
		["gpt-6-sol", 272000],
		["gpt-6-luna", 272000],
		["gpt-6.1-sol", 272000],
		["gpt-daybreak-blue-latest", 272000],
		["gpt-daybreak-red-latest", 272000],
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
