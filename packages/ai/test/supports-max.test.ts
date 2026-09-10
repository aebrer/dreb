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

	it.each(["gpt-5.5", "gpt-5.4-mini", "gpt-60", "gpt-5-mini", "claude-opus-5", "k3", "qwen3.8-27b"])(
		"rejects non-max-capable model id %s",
		(id) => {
			expect(supportsMax({ ...base, id })).toBe(false);
		},
	);

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
