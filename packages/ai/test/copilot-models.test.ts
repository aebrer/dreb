import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "../src/types.js";
import { getCopilotTestModel } from "./fixtures/copilot-models.js";

const { getModels } = vi.hoisted(() => ({
	getModels: vi.fn<() => Model<Api>[]>(),
}));

vi.mock("../src/models.js", () => ({ getModels }));

const APIS = ["anthropic-messages", "openai-completions", "openai-responses"] as const;
const RESPONSES_PREFERENCES = ["gpt-6-luna", "gpt-6-astra", "gpt-6.1-sol", "gpt-5.3-codex"];

function createModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "test-copilot-model",
		name: "Copilot test fixture",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 4096,
		...overrides,
	};
}

describe("getCopilotTestModel", () => {
	beforeEach(() => {
		getModels.mockReset();
	});

	afterEach(() => {
		expect(getModels).toHaveBeenCalledExactlyOnceWith("github-copilot");
	});

	it.each(APIS)("requires exact API, reasoning, and image input for %s", (api) => {
		const eligible = createModel({ api, id: "eligible" });
		getModels.mockReturnValue([
			...APIS.filter((otherApi) => otherApi !== api).map((otherApi) => createModel({ api: otherApi })),
			createModel({ api: "openai-codex-responses" }),
			createModel({ api, reasoning: false }),
			createModel({ api, input: ["text"] }),
			eligible,
		]);

		expect(getCopilotTestModel(api)).toBe(eligible);
	});

	it.each(RESPONSES_PREFERENCES.map((id, index) => ({ id, remaining: RESPONSES_PREFERENCES.slice(index) })))(
		"prefers $id over lower-ranked Responses models regardless of catalog order",
		({ id, remaining }) => {
			const preferred = createModel({ id });
			const lowerRanked = remaining.slice(1).map((otherId) => createModel({ id: otherId }));
			getModels.mockReturnValue([
				createModel({ id: "unlisted-responses-model" }),
				...lowerRanked.reverse(),
				preferred,
			]);

			expect(getCopilotTestModel("openai-responses")).toBe(preferred);
		},
	);

	it.each(APIS)("falls back to the first eligible %s model when preferred models retire", (api) => {
		const fallback = createModel({ api, id: "replacement-model" });
		getModels.mockReturnValue([
			createModel({ api: "unrelated-api" }),
			fallback,
			createModel({ api, id: "another-replacement" }),
		]);

		expect(getCopilotTestModel(api)).toBe(fallback);
	});

	it.each(APIS)("reports a descriptive error for an empty %s catalog", (api) => {
		getModels.mockReturnValue([]);

		expect(() => getCopilotTestModel(api)).toThrow(
			`Expected a reasoning- and image-capable Copilot model using ${api}`,
		);
	});

	it.each(APIS)("reports a descriptive error when no %s model is eligible", (api) => {
		getModels.mockReturnValue([
			...APIS.filter((otherApi) => otherApi !== api).map((otherApi) => createModel({ api: otherApi })),
			createModel({ api, reasoning: false }),
			createModel({ api, input: ["text"] }),
		]);

		expect(() => getCopilotTestModel(api)).toThrow(
			`Expected a reasoning- and image-capable Copilot model using ${api}`,
		);
	});

	it.each([
		{ api: "anthropic-messages", ids: ["claude-sonnet-5", "claude-opus-5", "claude-opus-4.8", "claude-opus-4.7"] },
		{ api: "openai-completions", ids: ["gemini-3.8-flash", "gemini-3.7-flash"] },
	] as const)("retains the existing $api preference order", ({ api, ids }) => {
		const preferred = createModel({ api, id: ids[0] });
		const lowerRanked = ids.slice(1).map((id) => createModel({ api, id }));
		getModels.mockReturnValue([createModel({ api, id: "unlisted-model" }), ...lowerRanked.reverse(), preferred]);

		expect(getCopilotTestModel(api)).toBe(preferred);
	});
});
