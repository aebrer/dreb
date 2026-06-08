import { describe, expect, it } from "vitest";
import { supportsAdaptiveThinking } from "../src/models.js";
import type { Model } from "../src/types.js";

/** Build a minimal Model object carrying just an id, like other unit tests do. */
function model(id: string): Model<any> {
	return { id } as Model<any>;
}

describe("supportsAdaptiveThinking", () => {
	it("returns true for opus-4-6 (threshold)", () => {
		expect(supportsAdaptiveThinking(model("opus-4-6"))).toBe(true);
	});

	it("returns true for sonnet-4-6 (threshold)", () => {
		expect(supportsAdaptiveThinking(model("sonnet-4-6"))).toBe(true);
	});

	it("returns false for opus-4-5 (below threshold)", () => {
		expect(supportsAdaptiveThinking(model("opus-4-5"))).toBe(false);
	});

	it("returns false for sonnet-4-5 (below threshold)", () => {
		expect(supportsAdaptiveThinking(model("sonnet-4-5"))).toBe(false);
	});

	it("returns true for opus-4-7", () => {
		expect(supportsAdaptiveThinking(model("opus-4-7"))).toBe(true);
	});

	it("returns true for opus-4-8", () => {
		expect(supportsAdaptiveThinking(model("opus-4-8"))).toBe(true);
	});

	it("returns true for opus-4-10 (two-digit minor version)", () => {
		expect(supportsAdaptiveThinking(model("opus-4-10"))).toBe(true);
	});

	it("returns true for Bedrock-prefixed anthropic.claude-opus-4-7", () => {
		expect(supportsAdaptiveThinking(model("anthropic.claude-opus-4-7"))).toBe(true);
	});

	it("returns true for OpenRouter-style anthropic/claude-opus-4-6", () => {
		expect(supportsAdaptiveThinking(model("anthropic/claude-opus-4-6"))).toBe(true);
	});

	it("returns false for date-stamped base opus-4 (claude-opus-4-20250514)", () => {
		// The (?!\d) negative lookahead prevents the date suffix from matching as a minor version.
		expect(supportsAdaptiveThinking(model("claude-opus-4-20250514"))).toBe(false);
	});

	it("returns false for opus-4-100 (three-digit minor version)", () => {
		expect(supportsAdaptiveThinking(model("opus-4-100"))).toBe(false);
	});

	it("returns false for a non-Claude model id (gpt-5)", () => {
		expect(supportsAdaptiveThinking(model("gpt-5"))).toBe(false);
	});
});
