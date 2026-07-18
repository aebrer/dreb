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

const KIMI_OAUTH_MODEL: Model<"openai-completions"> = {
	...KIMI_MODEL,
	provider: "kimi-coding-oauth",
	id: "kimi-for-coding",
	name: "Kimi For Coding",
	baseUrl: "https://api.kimi.com/coding/v1",
};

describe("openai-completions kimi thinkingFormat", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("re-encodes readable cross-provider summaries as reasoning_content", async () => {
		let payload: unknown;
		const sourceSignature = JSON.stringify({ type: "reasoning", encrypted_content: "opaque" });

		await streamSimple(
			KIMI_OAUTH_MODEL,
			{
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Readable GPT summary", thinkingSignature: sourceSignature },
							{ type: "text", text: "Visible answer" },
						],
						api: "openai-codex-responses",
						provider: "openai-codex",
						model: "gpt-5.6-sol",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test",
				reasoning: "medium",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			messages: Array<Record<string, unknown>>;
		};
		const assistant = params.messages.find((message) => message.role === "assistant");
		expect(assistant).toEqual({
			role: "assistant",
			content: "Visible answer",
			reasoning_content: "Readable GPT summary",
		});
	});

	it("preserves recognized reasoning fields across same-provider completions models", async () => {
		await streamSimple(
			KIMI_MODEL,
			{
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Portable reasoning", thinkingSignature: "reasoning" },
							{ type: "text", text: "Visible answer" },
						],
						api: "openai-completions",
						provider: "kimi-coding",
						model: "another-kimi-model",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test", reasoning: "medium" },
		).result();

		const params = mockState.lastParams as { messages: Array<Record<string, unknown>> };
		expect(params.messages[0]).toEqual({
			role: "assistant",
			content: "Visible answer",
			reasoning: "Portable reasoning",
		});
	});

	it("sets thinking effort using the Kimi Code request shape", async () => {
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
		expect(params.thinking).toEqual({ type: "enabled", effort: "medium" });
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.prompt_cache_key).toBe("sess-123");
	});

	it("nests mapped K3 effort values inside thinking", async () => {
		const model: Model<"openai-completions"> = {
			...KIMI_MODEL,
			provider: "kimi-coding-oauth",
			id: "k3",
			compat: { thinkingFormat: "kimi", reasoningEffortMap: { xhigh: "max" } },
		};
		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
			{ apiKey: "test", reasoning: "xhigh" },
		).result();

		const params = mockState.lastParams as {
			thinking?: { type: string; effort?: string };
			reasoning_effort?: string;
		};
		expect(params.thinking).toEqual({ type: "enabled", effort: "max" });
		expect(params.reasoning_effort).toBeUndefined();
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

	it("sends thinking: { type: 'enabled' } without effort when mapped effort is 'auto'", async () => {
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
			thinking?: { type: string; effort?: string };
			reasoning_effort?: string;
			prompt_cache_key?: string;
		};
		expect(params.thinking).toEqual({ type: "enabled" });
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
		expect(params.thinking).toEqual({ type: "enabled", effort: "high" });
		expect(params.reasoning_effort).toBeUndefined();
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
