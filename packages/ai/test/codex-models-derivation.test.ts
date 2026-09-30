import { describe, expect, it } from "vitest";
import { CODEX_EXPECTED_IDS, deriveCodexModels } from "../scripts/codex-models.js";
import type { Model } from "../src/types.js";

function openai(id: string, contextWindow = 1_050_000, maxTokens = 128_000): Model<"openai-responses"> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

const baseline = () => CODEX_EXPECTED_IDS.map((id) => openai(id));
const ids = (models: Model<any>[]) => models.map((m) => m.id).sort();

describe("deriveCodexModels", () => {
	it("picks up a new frontier model with no code change", () => {
		const derived = deriveCodexModels([...baseline(), openai("gpt-7-nova"), openai("gpt-daybreak-green-latest")]);
		expect(ids(derived)).toEqual(expect.arrayContaining(["gpt-7-nova", "gpt-daybreak-green-latest"]));
	});

	it("rejects excluded variants, old families, and dated snapshots", () => {
		const derived = deriveCodexModels([
			...baseline(),
			openai("gpt-7-pro"),
			openai("gpt-7-codex-max"),
			openai("gpt-7.1-nano"),
			openai("gpt-6-chat-latest"),
			openai("gpt-5.2"),
			openai("gpt-5.5-2026-10-01"),
		]);
		expect(ids(derived)).toEqual([...CODEX_EXPECTED_IDS].sort());
	});

	it("keeps a bare family id when its only siblings are dated snapshots or excluded variants", () => {
		const derived = deriveCodexModels([
			...baseline(),
			openai("gpt-7"),
			openai("gpt-7-2026-10-01"),
			openai("gpt-7-pro"),
		]);
		expect(ids(derived)).toContain("gpt-7");
	});

	it("drops a bare family id when a Codex-eligible named variant exists", () => {
		const derived = deriveCodexModels([...baseline(), openai("gpt-7"), openai("gpt-7-sol")]);
		expect(ids(derived)).toContain("gpt-7-sol");
		expect(ids(derived)).not.toContain("gpt-7");
	});

	it("ignores non-openai providers", () => {
		const foreign = { ...openai("gpt-7-nova"), provider: "openrouter" };
		expect(ids(deriveCodexModels([...baseline(), foreign]))).not.toContain("gpt-7-nova");
	});

	it("clamps limits to the Codex surface and copies pricing", () => {
		const [model] = deriveCodexModels([openai("gpt-6-sol")], ["gpt-6-sol"]);
		expect(model.contextWindow).toBe(272_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.cost).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 });
		expect(model.provider).toBe("openai-codex");
		expect(model.api).toBe("openai-codex-responses");
	});

	it.each(CODEX_EXPECTED_IDS)("throws when expected model %s disappears", (missing) => {
		const models = baseline().filter((m) => m.id !== missing);
		expect(() => deriveCodexModels(models)).toThrow(`lost expected model ${missing}`);
	});

	it("throws instead of shrinking context when catalog limits are missing", () => {
		const models = [...baseline(), openai("gpt-7-nova", 4096, 4096)];
		expect(() => deriveCodexModels(models)).toThrow(/gpt-7-nova has catalog limits 4096\/4096/);
	});
});
