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

const KIMI_MODEL: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "kimi-coding",
	id: "kimi-k2-0711",
	name: "Kimi K2",
	baseUrl: "https://api.kimi.com/v1",
	input: ["text"],
	reasoning: true,
	contextWindow: 131072,
	maxTokens: 16384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { thinkingFormat: "kimi" },
};

describe("openai-completions kimi thinkingFormat", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("sets thinking enabled + reasoning_effort when reasoning is specified", async () => {
		let payload: unknown;

		await streamSimple(
			KIMI_MODEL,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				reasoning: "medium",
				sessionId: "sess-123",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			thinking?: { type: string };
			reasoning_effort?: string;
			prompt_cache_key?: string;
		};
		expect(params.thinking).toEqual({ type: "enabled" });
		expect(params.reasoning_effort).toBe("medium");
		expect(params.prompt_cache_key).toBe("sess-123");
	});

	it("sets thinking disabled when mapped effort is 'off'", async () => {
		const model: Model<"openai-completions"> = {
			...KIMI_MODEL,
			compat: {
				thinkingFormat: "kimi",
				reasoningEffortMap: { minimal: "off" },
			},
		};
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				reasoning: "minimal",
				sessionId: "sess-456",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			thinking?: { type: string };
			reasoning_effort?: string;
			prompt_cache_key?: string;
		};
		expect(params.thinking).toEqual({ type: "disabled" });
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.prompt_cache_key).toBe("sess-456");
	});

	it("omits thinking and reasoning_effort when mapped effort is 'auto'", async () => {
		const model: Model<"openai-completions"> = {
			...KIMI_MODEL,
			compat: {
				thinkingFormat: "kimi",
				reasoningEffortMap: { low: "auto" },
			},
		};
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				reasoning: "low",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			thinking?: { type: string };
			reasoning_effort?: string;
			prompt_cache_key?: string;
		};
		expect(params.thinking).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.prompt_cache_key).toBeUndefined();
	});

	it("omits thinking/reasoning fields when no reasoning is specified", async () => {
		let payload: unknown;

		await streamSimple(
			KIMI_MODEL,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				sessionId: "sess-789",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			thinking?: { type: string };
			reasoning_effort?: string;
			prompt_cache_key?: string;
		};
		expect(params.thinking).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.prompt_cache_key).toBe("sess-789");
	});

	it("omits prompt_cache_key when no sessionId is provided", async () => {
		let payload: unknown;

		await streamSimple(
			KIMI_MODEL,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				reasoning: "high",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			thinking?: { type: string };
			reasoning_effort?: string;
			prompt_cache_key?: string;
		};
		expect(params.thinking).toEqual({ type: "enabled" });
		expect(params.reasoning_effort).toBe("high");
		expect(params.prompt_cache_key).toBeUndefined();
	});

	it("does not set thinking fields when model has reasoning: false", async () => {
		const nonReasoningModel: Model<"openai-completions"> = {
			...KIMI_MODEL,
			reasoning: false,
		};
		let payload: unknown;

		await streamSimple(
			nonReasoningModel,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				reasoning: "medium",
				sessionId: "sess-noreason",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			thinking?: { type: string };
			reasoning_effort?: string;
			prompt_cache_key?: string;
		};
		expect(params.thinking).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
		// prompt_cache_key is set inside the kimi branch which requires model.reasoning
		expect(params.prompt_cache_key).toBeUndefined();
	});
});
