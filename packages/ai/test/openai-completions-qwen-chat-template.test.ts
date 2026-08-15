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

const QWEN_CHAT_TEMPLATE_MODEL: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "custom",
	id: "qwen3.8",
	name: "Qwen 3.8",
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

async function stream(model: Model<"openai-completions">, reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh") {
	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
		{ apiKey: "test", reasoning },
	).result();
}

describe("openai-completions qwen-chat-template thinkingFormat", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("forwards the mapped reasoning level inside chat_template_kwargs when enabled", async () => {
		await stream(QWEN_CHAT_TEMPLATE_MODEL, "medium");

		expect(getParams().chat_template_kwargs).toEqual({
			enable_thinking: true,
			reasoning_effort: "medium",
		});
	});

	it("applies reasoningEffortMap before forwarding", async () => {
		const model: Model<"openai-completions"> = {
			...QWEN_CHAT_TEMPLATE_MODEL,
			compat: {
				thinkingFormat: "qwen-chat-template",
				reasoningEffortMap: { high: "max" },
			},
		};
		await stream(model, "high");

		expect(getParams().chat_template_kwargs).toEqual({
			enable_thinking: true,
			reasoning_effort: "max",
		});
	});

	it("sends enable_thinking: false and omits reasoning_effort when reasoning is disabled", async () => {
		await stream(QWEN_CHAT_TEMPLATE_MODEL);

		const kwargs = getParams().chat_template_kwargs;
		expect(kwargs).toEqual({ enable_thinking: false });
		expect(kwargs).not.toHaveProperty("reasoning_effort");
	});

	it("omits chat_template_kwargs entirely for non-reasoning models", async () => {
		const nonReasoningModel: Model<"openai-completions"> = {
			...QWEN_CHAT_TEMPLATE_MODEL,
			reasoning: false,
		};
		await stream(nonReasoningModel, "medium");

		expect(getParams().chat_template_kwargs).toBeUndefined();
	});

	it("never sets the top-level reasoning_effort field for this format", async () => {
		await stream(QWEN_CHAT_TEMPLATE_MODEL, "high");

		expect(getParams().reasoning_effort).toBeUndefined();
	});
});
