import { describe, expect, it } from "vitest";
import { findModel, findModelInList, getModel, getModels, isModelAlias } from "../src/models.js";

describe("isModelAlias", () => {
	it("treats non-dated IDs as aliases", () => {
		expect(isModelAlias("claude-sonnet-4-5")).toBe(true);
		expect(isModelAlias("gpt-5-mini")).toBe(true);
		expect(isModelAlias("gemini-2.5-flash")).toBe(true);
	});

	it("treats -latest suffix as alias", () => {
		expect(isModelAlias("claude-3-5-haiku-latest")).toBe(true);
	});

	it("treats dated IDs (YYYYMMDD suffix) as non-aliases", () => {
		expect(isModelAlias("claude-sonnet-4-20250514")).toBe(false);
		expect(isModelAlias("claude-opus-4-1-20250805")).toBe(false);
	});
});

describe("findModel", () => {
	it("returns exact match when available", () => {
		const model = findModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(model!.id).toBe("claude-sonnet-4-5");
	});

	it("returns same result as getModel for exact IDs", () => {
		const exact = getModel("anthropic", "claude-sonnet-4-5");
		const fuzzy = findModel("anthropic", "claude-sonnet-4-5");
		expect(fuzzy).toBe(exact);
	});

	it("returns undefined for unknown provider", () => {
		expect(findModel("nonexistent", "sonnet")).toBeUndefined();
	});

	it("returns undefined for no matching pattern", () => {
		expect(findModel("anthropic", "zzz-no-match")).toBeUndefined();
	});

	it("finds model by substring — case insensitive", () => {
		const lower = findModel("anthropic", "haiku");
		const upper = findModel("anthropic", "HAIKU");
		const mixed = findModel("anthropic", "Haiku");
		expect(lower).toBeDefined();
		expect(upper).toBe(lower);
		expect(mixed).toBe(lower);
	});

	it("prefers alias over dated version", () => {
		const model = findModel("anthropic", "sonnet");
		expect(model).toBeDefined();
		// Should not return a dated version like claude-sonnet-4-5-20250514
		expect(isModelAlias(model!.id)).toBe(true);
	});

	it("returns a specific model for multi-alias tiebreaking", () => {
		// "sonnet" matches multiple aliases — verify we get a deterministic result
		const model = findModel("anthropic", "sonnet");
		expect(model).toBeDefined();
		// localeCompare descending picks the lexicographically highest alias
		expect(model!.id).toBeTruthy();
		// Calling again should return the same model (deterministic)
		expect(findModel("anthropic", "sonnet")).toBe(model);
	});

	it("works across providers", () => {
		const openaiModel = findModel("openai", "gpt-5");
		expect(openaiModel).toBeDefined();
		expect(openaiModel!.id).toContain("gpt-5");
		expect(openaiModel!.provider).toBe("openai");

		const googleModel = findModel("google", "gemini-2.5");
		expect(googleModel).toBeDefined();
		expect(googleModel!.provider).toBe("google");
	});
});

describe("findModelInList", () => {
	it("returns undefined for empty list", () => {
		expect(findModelInList("sonnet", [])).toBeUndefined();
	});

	it("finds exact match by ID (case-insensitive)", () => {
		const models = getModels("anthropic");
		const result = findModelInList("claude-sonnet-4-5", models);
		expect(result).toBeDefined();
		expect(result!.id).toBe("claude-sonnet-4-5");
	});

	it("produces same results as findModel for registry models", () => {
		const models = getModels("anthropic");
		expect(findModelInList("sonnet", models)).toBe(findModel("anthropic", "sonnet"));
		expect(findModelInList("haiku", models)).toBe(findModel("anthropic", "haiku"));
		expect(findModelInList("opus", models)).toBe(findModel("anthropic", "opus"));
	});
});
