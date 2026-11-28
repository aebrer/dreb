import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "../src/types.js";
import { getMistralTestModel } from "./fixtures/mistral-models.js";

const { getModels } = vi.hoisted(() => ({ getModels: vi.fn<() => Model<Api>[]>() }));
vi.mock("../src/models.js", () => ({ getModels }));

function model(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "mistral-conversations",
		provider: "mistral",
		baseUrl: "https://api.mistral.ai",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 4096,
		...overrides,
	};
}

describe("getMistralTestModel", () => {
	beforeEach(() => getModels.mockReset());

	it("prefers eligible named models regardless of catalog order", () => {
		const preferred = model("ministral-8b-latest", { input: ["text", "image"] });
		const small = model("mistral-small-latest", { reasoning: true, input: ["text", "image"] });
		getModels.mockReturnValue([model("other"), small, preferred]);

		expect(getMistralTestModel()).toBe(preferred);
		expect(getMistralTestModel("image")).toBe(preferred);
		expect(getMistralTestModel("reasoning")).toBe(small);
		expect(getModels).toHaveBeenCalledWith("mistral");
	});

	it("finds eligible replacement models without switching transports", () => {
		const text = model("new-text-model");
		const image = model("new-image-model", { input: ["text", "image"] });
		const reasoning = model("new-thinking-model", { reasoning: true });
		getModels.mockReturnValue([
			model("mistral-small-latest", { api: "openai-completions", reasoning: true, input: ["text", "image"] }),
			model("codestral-latest"),
			model("voxtral-small-latest"),
			text,
			image,
			reasoning,
		]);

		expect(getMistralTestModel()).toBe(text);
		expect(getMistralTestModel("image")).toBe(image);
		expect(getMistralTestModel("reasoning")).toBe(reasoning);
	});

	it.each(["image", "reasoning"] as const)(
		"reports missing %s support instead of picking a text-only model",
		(capability) => {
			getModels.mockReturnValue([model("ministral-8b-latest")]);
			expect(() => getMistralTestModel(capability)).toThrow(
				`Expected a Mistral Conversations model with ${capability} support`,
			);
		},
	);

	it("reports an absent Mistral catalog", () => {
		getModels.mockReturnValue([]);
		expect(() => getMistralTestModel()).toThrow("Expected a Mistral Conversations model with text support");
	});
});
