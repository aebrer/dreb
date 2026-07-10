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

	it("returns false for Opus 4.1 (below threshold)", () => {
		const model = getModel("anthropic", "claude-opus-4-1");
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

	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const)("returns true for GPT-5.6 model %s", (id) => {
		const model = getModel("openai-codex", id);
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});

	it.each([
		["gpt-5.6-sol", { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }],
		["gpt-5.6-terra", { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }],
		["gpt-5.6-luna", { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 0 }],
	] as const)("has the expected OpenAI Codex registry spec for %s", (id, cost) => {
		const model = getModel("openai-codex", id);
		expect(model).toBeDefined();
		expect(model!.cost.input).toBe(cost.input);
		expect(model!.cost.output).toBe(cost.output);
		expect(model!.cost.cacheRead).toBe(cost.cacheRead);
		expect(model!.cost.cacheWrite).toBe(cost.cacheWrite);
		expect(model!.contextWindow).toBe(400000);
	});
});
