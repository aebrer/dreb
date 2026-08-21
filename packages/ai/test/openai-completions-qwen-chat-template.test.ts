import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { Model } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: async (params: unknown) => {
					mockState.lastParams = params;
					return {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

const QWEN38_MODEL: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "custom",
	id: "qwen3.8-27b",
	name: "Qwen 3.8 27B",
	baseUrl: "http://localhost:8080/v1",
	input: ["text"],
	reasoning: true,
	contextWindow: 65536,
	maxTokens: 16384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { thinkingFormat: "qwen-chat-template" },
};

type ChatTemplateKwargs = { enable_thinking?: boolean; reasoning_effort?: string };

function getParams(): {
	chat_template_kwargs?: ChatTemplateKwargs;
	reasoning_effort?: string;
} {
	return mockState.lastParams as {
		chat_template_kwargs?: ChatTemplateKwargs;
		reasoning_effort?: string;
	};
}

type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

async function stream(model: Model<"openai-completions">, reasoning?: ReasoningLevel) {
	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
		{ apiKey: "test", reasoning },
	).result();
}

describe("openai-completions qwen-chat-template thinkingFormat (Qwen3.8+)", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it.each([
		// Qwen3.8 natively exposes exactly three effort tiers: low, medium, xhigh.
		["minimal", "low"],
		["low", "low"],
		["medium", "medium"],
		["high", "xhigh"],
		["xhigh", "xhigh"],
	] as const)(
		"maps dreb reasoning %s to top-level reasoning_effort %s with the default Qwen3.8+ map",
		async (level, expectedEffort) => {
			await stream(QWEN38_MODEL, level);

			const params = getParams();
			expect(params.reasoning_effort).toBe(expectedEffort);
			expect(params.chat_template_kwargs).toEqual({ enable_thinking: true });
			expect(params.chat_template_kwargs).not.toHaveProperty("reasoning_effort");
		},
	);

	it("forwards xhigh unchanged (not through the xhigh→high clamp)", async () => {
		// qwen3.8-27b must be recognized as xhigh-capable so streamSimple does not clamp first.
		await stream(QWEN38_MODEL, "xhigh");

		expect(getParams().reasoning_effort).toBe("xhigh");
	});

	it("applies the default map for custom qwen-3.8 id spellings", async () => {
		const model: Model<"openai-completions"> = { ...QWEN38_MODEL, id: "qwen-3.8" };
		await stream(model, "high");

		expect(getParams().reasoning_effort).toBe("xhigh");
	});

	it("sends enable_thinking: false and omits reasoning_effort when reasoning is disabled", async () => {
		await stream(QWEN38_MODEL);

		const params = getParams();
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("omits chat_template_kwargs entirely for non-reasoning models", async () => {
		const nonReasoningModel: Model<"openai-completions"> = {
			...QWEN38_MODEL,
			reasoning: false,
		};
		await stream(nonReasoningModel, "medium");

		const params = getParams();
		expect(params.chat_template_kwargs).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("lets an explicit per-model reasoningEffortMap override the Qwen3.8+ default", async () => {
		const model: Model<"openai-completions"> = {
			...QWEN38_MODEL,
			compat: {
				thinkingFormat: "qwen-chat-template",
				reasoningEffortMap: { medium: "low" },
			},
		};
		await stream(model, "medium");

		expect(getParams().reasoning_effort).toBe("low");
	});
});

describe("openai-completions qwen-chat-template thinkingFormat (pre-3.8 Qwen and non-Qwen models)", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("keeps identity forwarding for older Qwen models (no default map)", async () => {
		const model: Model<"openai-completions"> = { ...QWEN38_MODEL, id: "qwen3.6-27b" };
		await stream(model, "medium");

		expect(getParams().reasoning_effort).toBe("medium");
		expect(getParams().chat_template_kwargs).toEqual({ enable_thinking: true });
	});

	it("keeps the xhigh→high clamp for older Qwen models", async () => {
		const model: Model<"openai-completions"> = { ...QWEN38_MODEL, id: "qwen3.6-27b" };
		await stream(model, "xhigh");

		expect(getParams().reasoning_effort).toBe("high");
	});

	it("does not treat qwen3-32b (parameter count, not minor version) as Qwen3.8+", async () => {
		const model: Model<"openai-completions"> = { ...QWEN38_MODEL, id: "qwen3-32b" };
		await stream(model, "high");

		expect(getParams().reasoning_effort).toBe("high");
	});

	it("keeps identity forwarding for non-Qwen qwen-chat-template models", async () => {
		const model: Model<"openai-completions"> = { ...QWEN38_MODEL, id: "my-local-model" };
		await stream(model, "medium");

		expect(getParams().reasoning_effort).toBe("medium");
	});

	it("does not apply the Qwen3.8+ default map to ids whose digits are parameter counts", async () => {
		// Qwen distills use the Qwen chat template, so this is a plausible local config —
		// but 32 is a parameter count, not a Qwen 32.x family version.
		const model: Model<"openai-completions"> = { ...QWEN38_MODEL, id: "deepseek-r1-distill-qwen-32b" };
		await stream(model, "high");

		expect(getParams().reasoning_effort).toBe("high");
	});
});
