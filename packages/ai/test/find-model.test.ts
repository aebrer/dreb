import { describe, expect, it } from "vitest";
import { findModel, getModel } from "../src/models.js";

describe("findModel", () => {
	it("returns exact match when available", () => {
		const model = findModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(model!.id).toBe("claude-sonnet-4-5");
	});

	it("returns undefined for unknown provider", () => {
		expect(findModel("nonexistent", "sonnet")).toBeUndefined();
	});

	it("returns undefined for no matching pattern", () => {
		expect(findModel("anthropic", "zzz-no-match")).toBeUndefined();
	});

	it("finds model by substring (case-insensitive)", () => {
		const model = findModel("anthropic", "haiku");
		expect(model).toBeDefined();
		expect(model!.id).toContain("haiku");
	});

	it("finds model by substring — sonnet", () => {
		const model = findModel("anthropic", "sonnet");
		expect(model).toBeDefined();
		expect(model!.id).toContain("sonnet");
	});

	it("finds model by substring — opus", () => {
		const model = findModel("anthropic", "opus");
		expect(model).toBeDefined();
		expect(model!.id).toContain("opus");
	});

	it("prefers alias over dated version", () => {
		const model = findModel("anthropic", "sonnet");
		expect(model).toBeDefined();
		// Should not return a dated version like claude-sonnet-4-5-20250514
		expect(model!.id).not.toMatch(/\d{8}/);
	});

	it("matches are consistent with getModel for exact IDs", () => {
		const exact = getModel("anthropic", "claude-sonnet-4-5");
		const fuzzy = findModel("anthropic", "claude-sonnet-4-5");
		expect(fuzzy).toBe(exact);
	});

	it("works across providers", () => {
		const openaiModel = findModel("openai", "gpt-5");
		expect(openaiModel).toBeDefined();

		const googleModel = findModel("google", "gemini");
		expect(googleModel).toBeDefined();
	});
});
