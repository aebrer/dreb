import { describe, expect, it } from "vitest";
import { findModel, getModel, supportsXhigh } from "../src/models.js";

describe("supportsXhigh", () => {
	it("returns true for latest Anthropic Opus on anthropic-messages API", () => {
		const model = findModel("anthropic", "opus")!;
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});

	it("returns true for Opus 4.6 by exact ID", () => {
		const model = getModel("anthropic", "claude-opus-4-6");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});

	it("returns false for non-Opus Anthropic models", () => {
		const model = findModel("anthropic", "sonnet")!;
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(false);
	});

	it("returns false for base Opus 4 dated model (opus-4-20250514)", () => {
		const model = getModel("anthropic", "claude-opus-4-20250514");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(false);
	});

	it("returns false for Opus 4.5 (below threshold)", () => {
		const model = getModel("anthropic", "claude-opus-4-5");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(false);
	});

	it("returns true for GPT-5.4 models", () => {
		const model = getModel("openai-codex", "gpt-5.4");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});

	it("returns true for OpenRouter Opus 4.6 (openai-completions API)", () => {
		const model = getModel("openrouter", "anthropic/claude-opus-4.6");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});

	it("returns true for GPT-5.5 models", () => {
		const model = getModel("openai-codex", "gpt-5.5");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});

	it("returns true for OpenRouter GPT-5.5", () => {
		const model = getModel("openrouter", "openai/gpt-5.5");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});
});
