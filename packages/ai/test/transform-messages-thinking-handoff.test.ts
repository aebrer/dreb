import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { Api, AssistantMessage, Message, Model, ThinkingContent } from "../src/types.js";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const structuredReasoningFields = new Set(["reasoning_content", "reasoning", "reasoning_text"]);

function model<TApi extends Api>(api: TApi, provider = "kimi-coding-oauth", id = "k3"): Model<TApi> {
	return {
		api,
		provider,
		id,
		name: id,
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

function assistant(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "api" | "provider" | "model">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "kimi-coding-oauth",
		model: "kimi-for-coding",
		usage,
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

function preserveCompatibleThinking<TApi extends Api>(
	thinking: ThinkingContent,
	target: Model<TApi>,
	source: AssistantMessage,
): boolean {
	return (
		source.provider === target.provider &&
		source.api === "openai-completions" &&
		target.api === "openai-completions" &&
		structuredReasoningFields.has(thinking.thinkingSignature ?? "")
	);
}

describe("transformMessages thinking handoff", () => {
	it("replays exact-model plain, signed, redacted, and empty encrypted thinking unchanged", () => {
		const target = model("openai-completions", "kimi-coding-oauth", "kimi-for-coding");
		const message = assistant([
			{ type: "thinking", thinking: "plain reasoning" },
			{ type: "thinking", thinking: "signed reasoning", thinkingSignature: "signed-state" },
			{ type: "thinking", thinking: "", thinkingSignature: "encrypted-state", redacted: true },
			{ type: "thinking", thinking: "", thinkingSignature: "reasoning_content" },
		]);

		const result = transformMessages([message], target, undefined, preserveCompatibleThinking);
		expect((result[0] as AssistantMessage).content).toEqual(message.content);
	});

	it.each(["reasoning_content", "reasoning", "reasoning_text"])(
		"preserves %s structurally for a compatible OpenAI-completions destination",
		(thinkingSignature) => {
			const target = model("openai-completions", "kimi-coding-oauth", "k3");
			const message = assistant([
				{ type: "thinking", thinking: "portable reasoning", thinkingSignature },
				{ type: "text", text: "visible answer" },
			]);

			const result = transformMessages([message], target, undefined, preserveCompatibleThinking);
			expect((result[0] as AssistantMessage).content).toEqual(message.content);
		},
	);

	it.each([
		[model("openai-completions", "other-provider", "other-model"), {}],
		[model("openai-completions", "kimi-coding-oauth", "k3"), { api: "openai-responses" as const }],
	])("uses the labeled fallback across provider or API boundaries", (target, sourceOverride) => {
		const message = assistant(
			[
				{ type: "thinking", thinking: "foreign reasoning", thinkingSignature: "reasoning_content" },
				{ type: "text", text: "visible answer" },
			],
			sourceOverride,
		);

		const result = transformMessages([message], target, undefined, preserveCompatibleThinking);
		expect((result[0] as AssistantMessage).content).toEqual([
			{
				type: "text",
				text: "<reformatted-pre-switch-reasoning>\nforeign reasoning\n" + "</reformatted-pre-switch-reasoning>\n\n",
			},
			{ type: "text", text: "visible answer" },
		]);
	});

	it("separates visible text before foreign thinking without adding a trailing separator", () => {
		const target = model("openai-completions", "kimi-coding-oauth", "k3");
		const message = assistant(
			[
				{ type: "text", text: "visible answer" },
				{ type: "thinking", thinking: "foreign reasoning", thinkingSignature: "reasoning_content" },
			],
			{ provider: "other-provider", model: "other-model" },
		);

		const result = transformMessages([message], target, undefined, preserveCompatibleThinking);
		expect((result[0] as AssistantMessage).content).toEqual([
			{ type: "text", text: "visible answer" },
			{
				type: "text",
				text: "\n\n<reformatted-pre-switch-reasoning>\nforeign reasoning\n</reformatted-pre-switch-reasoning>",
			},
		]);
	});

	it("wraps unknown readable signatures and omits redacted or empty foreign thinking", () => {
		const target = model("openai-completions", "kimi-coding-oauth", "k3");
		const message = assistant([
			{ type: "thinking", thinking: "unknown but readable", thinkingSignature: "private_reasoning" },
			{ type: "thinking", thinking: "secret", thinkingSignature: "reasoning_content", redacted: true },
			{ type: "thinking", thinking: "", thinkingSignature: "reasoning_content" },
		]);

		const result = transformMessages([message], target, undefined, preserveCompatibleThinking);
		expect((result[0] as AssistantMessage).content).toEqual([
			{
				type: "text",
				text: "<reformatted-pre-switch-reasoning>\nunknown but readable\n" + "</reformatted-pre-switch-reasoning>",
			},
		]);
	});

	it("does not mutate history and restores original protocol state when returning to the source", () => {
		const source = model("openai-codex-responses", "openai-codex", "gpt-5.6-sol");
		const target = model("openai-completions", "kimi-coding-oauth", "k3");
		const encryptedSignature = JSON.stringify({
			type: "reasoning",
			id: "rs_original",
			encrypted_content: "opaque",
		});
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: 0 },
			assistant(
				[
					{ type: "thinking", thinking: "readable summary", thinkingSignature: encryptedSignature },
					{ type: "text", text: "visible answer" },
				],
				{ api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol" },
			),
		];
		const original = JSON.parse(JSON.stringify(messages)) as Message[];

		const handedOff = transformMessages(messages, target, undefined, preserveCompatibleThinking);
		expect((handedOff[1] as AssistantMessage).content).toEqual([
			{
				type: "text",
				text: "<reformatted-pre-switch-reasoning>\nreadable summary\n</reformatted-pre-switch-reasoning>\n\n",
			},
			{ type: "text", text: "visible answer" },
		]);
		expect(messages).toEqual(original);

		const returned = transformMessages(messages, source, undefined, preserveCompatibleThinking);
		expect(returned).toEqual(original);
	});
});
