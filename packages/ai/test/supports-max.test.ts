import { describe, expect, it } from "vitest";
import { getModel, supportsMax } from "../src/models.js";
import { resolveReasoningEffort } from "../src/providers/simple-options.js";

const base = getModel("openai", "gpt-5.6-sol")!;

describe("supportsMax", () => {
	it.each(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "openai/gpt-5.6-sol"])(
		"recognizes GPT-5.6 model id %s",
		(id) => {
			expect(supportsMax({ ...base, id })).toBe(true);
		},
	);

	it.each(["gpt-6", "gpt-6-astra", "openai/gpt-6-astra", "openai/gpt-6-astra-pro"])(
		"recognizes GPT-6 model id %s",
		(id) => {
			expect(supportsMax({ ...base, id })).toBe(true);
		},
	);

	// Claude ids on a non-Anthropic transport (the openai base) keep the legacy no-max rule.
	it.each(["gpt-5.5", "gpt-5.4-mini", "gpt-60", "gpt-5-mini", "claude-opus-5", "k3", "qwen3.8-27b"])(
		"rejects non-max-capable model id %s",
		(id) => {
			expect(supportsMax({ ...base, id })).toBe(false);
		},
	);

	it.each([
		"claude-opus-4-6",
		"claude-sonnet-4-6",
		"claude-opus-4-8",
		"claude-opus-5",
		"claude-sonnet-5",
		"claude-opus-5-5",
		"claude-sonnet-5-5",
		"claude-haiku-5-5",
	] as const)("recognizes native Anthropic max-capable model %s", (id) => {
		expect(supportsMax(getModel("anthropic", id))).toBe(true);
	});

	it.each(["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"] as const)(
		"rejects native Anthropic model %s without max",
		(id) => {
			expect(supportsMax(getModel("anthropic", id))).toBe(false);
		},
	);

	it("offers Anthropic max on Copilot's Messages API but not on OpenRouter", () => {
		expect(supportsMax(getModel("github-copilot", "claude-opus-4.8"))).toBe(true);
		expect(supportsMax(getModel("github-copilot", "claude-sonnet-4.6"))).toBe(true);
		expect(supportsMax(getModel("openrouter", "anthropic/claude-opus-4.6"))).toBe(false);
	});

	it("clamps Anthropic xhigh up to max on Opus 4.6 and passes max through", () => {
		const opus46 = getModel("anthropic", "claude-opus-4-6");
		expect(resolveReasoningEffort(opus46, "xhigh")).toBe("max");
		expect(resolveReasoningEffort(opus46, "max")).toBe("max");
	});

	it("falls max back through xhigh before high", () => {
		expect(resolveReasoningEffort({ ...base, id: "gpt-5.6-sol" }, "max")).toBe("max");
		expect(resolveReasoningEffort({ ...base, id: "gpt-5.5" }, "max")).toBe("xhigh");
		expect(resolveReasoningEffort({ ...base, id: "gpt-5-mini" }, "max")).toBe("high");
	});

	it("passes xhigh and max through unchanged for GPT-6 models", () => {
		expect(resolveReasoningEffort({ ...base, id: "gpt-6-astra" }, "xhigh")).toBe("xhigh");
		expect(resolveReasoningEffort({ ...base, id: "gpt-6-astra" }, "max")).toBe("max");
		expect(resolveReasoningEffort({ ...base, id: "openai/gpt-6-astra" }, "max")).toBe("max");
	});
});
