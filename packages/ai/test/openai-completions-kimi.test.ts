import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { AssistantMessage, Model } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	chunks: undefined as unknown[] | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: async (params: unknown) => {
					mockState.lastParams = params;
					return {
						async *[Symbol.asyncIterator]() {
							for (const chunk of mockState.chunks ?? [
								{
									choices: [{ delta: {}, finish_reason: "stop" }],
									usage: {
										prompt_tokens: 1,
										completion_tokens: 1,
										prompt_tokens_details: { cached_tokens: 0 },
										completion_tokens_details: { reasoning_tokens: 0 },
									},
								},
							]) {
								yield chunk;
							}
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

function assistantHistory(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "kimi-coding-oauth",
		model: "kimi-for-coding",
		content: [
			{ type: "thinking", thinking: "historical plan", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "historical answer" },
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

describe("openai-completions kimi thinkingFormat", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.chunks = undefined;
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

	it.each(["reasoning_content", "reasoning", "reasoning_text"])(
		"replays compatible Kimi %s structurally across Kimi models",
		async (reasoningField) => {
			const k3: Model<"openai-completions"> = {
				...KIMI_MODEL,
				provider: "kimi-coding-oauth",
				id: "k3",
			};
			await streamSimple(
				k3,
				{
					messages: [
						{ role: "user", content: "hello", timestamp: 0 },
						assistantHistory({
							content: [
								{ type: "thinking", thinking: "historical plan", thinkingSignature: reasoningField },
								{ type: "text", text: "historical answer" },
							],
						}),
					],
				},
				{ apiKey: "test" },
			).result();

			const params = mockState.lastParams as {
				messages: Array<Record<string, unknown> & { role: string; content?: string | null }>;
			};
			const historical = params.messages.find((message) => message.role === "assistant");
			expect(historical).toMatchObject({
				role: "assistant",
				content: "historical answer",
				[reasoningField]: "historical plan",
			});
			expect(historical?.content).not.toContain("historical plan");
		},
	);

	it("uses the labeled fallback when the destination requires thinking as text", async () => {
		const k3: Model<"openai-completions"> = {
			...KIMI_MODEL,
			provider: "kimi-coding-oauth",
			id: "k3",
			compat: { thinkingFormat: "kimi", requiresThinkingAsText: true },
		};
		await streamSimple(
			k3,
			{
				messages: [assistantHistory()],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as {
			messages: Array<Record<string, unknown> & { role: string; content?: string | null }>;
		};
		const historical = params.messages.find((message) => message.role === "assistant");
		expect(historical?.content).toBe(
			"<reformatted-pre-switch-reasoning>\nhistorical plan\n" +
				"</reformatted-pre-switch-reasoning>\n\nhistorical answer",
		);
		expect(historical).not.toHaveProperty("reasoning_content");
	});

	it("uses only labeled plaintext for incompatible Responses reasoning", async () => {
		const k3: Model<"openai-completions"> = {
			...KIMI_MODEL,
			provider: "kimi-coding-oauth",
			id: "k3",
		};
		await streamSimple(
			k3,
			{
				messages: [
					{ role: "user", content: "hello", timestamp: 0 },
					assistantHistory({
						api: "openai-codex-responses",
						provider: "openai-codex",
						model: "gpt-5.6-sol",
						content: [
							{
								type: "thinking",
								thinking: "readable summary",
								thinkingSignature: JSON.stringify({ type: "reasoning", encrypted_content: "opaque" }),
							},
							{ type: "text", text: "historical answer" },
						],
					}),
				],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as {
			messages: Array<Record<string, unknown> & { role: string; content?: string | null }>;
		};
		const historical = params.messages.find((message) => message.role === "assistant");
		expect(historical?.content).toBe(
			"<reformatted-pre-switch-reasoning>\nreadable summary\n" +
				"</reformatted-pre-switch-reasoning>\n\nhistorical answer",
		);
		expect(historical).not.toHaveProperty("reasoning_content");
		expect(historical).not.toHaveProperty("reasoning");
		expect(historical).not.toHaveProperty("reasoning_text");
		expect(historical).not.toHaveProperty("reasoning_details");
	});

	it("parses reasoning_content deltas into thinking before visible text", async () => {
		mockState.chunks = [
			{
				id: "response-1",
				choices: [{ delta: { reasoning_content: "plan" }, finish_reason: null }],
			},
			{
				id: "response-1",
				choices: [{ delta: { content: "answer" }, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 2,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const result = await streamSimple(
			KIMI_MODEL,
			{ messages: [{ role: "user", content: "Hi", timestamp: 0 }] },
			{ apiKey: "test" },
		).result();

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "plan", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "answer" },
		]);
	});
});
