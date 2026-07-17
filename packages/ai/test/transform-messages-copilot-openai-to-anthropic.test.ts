import { describe, expect, it, vi } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, Message, Model, ToolCall } from "../src/types.js";

// Normalize function matching what anthropic.ts uses
function anthropicNormalizeToolCallId(
	id: string,
	_model: Model<"anthropic-messages">,
	_source: AssistantMessage,
): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function makeCopilotClaudeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4.5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

describe("OpenAI to Anthropic session migration for Copilot Claude", () => {
	it("drops foreign thinking by default and preserves it only when the destination opts in", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: Date.now() },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "Let me think about this...",
						thinkingSignature: "reasoning_content",
					},
					{ type: "text", text: "Hi there!" },
				],
				api: "openai-completions",
				provider: "github-copilot",
				model: "gpt-4o",
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
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const assistantMsg = result.find((m) => m.role === "assistant") as AssistantMessage;

		expect(assistantMsg.content).toEqual([{ type: "text", text: "Hi there!" }]);
		// Transformation must not mutate session history; a later switch back can replay it.
		expect((messages[1] as AssistantMessage).content[0]).toMatchObject({
			type: "thinking",
			thinking: "Let me think about this...",
		});

		const preserved = transformMessages(messages, model, anthropicNormalizeToolCallId, () => true);
		const preservedAssistant = preserved.find((m) => m.role === "assistant") as AssistantMessage;
		expect(preservedAssistant.content).toEqual([
			{
				type: "thinking",
				thinking: "Let me think about this...",
				thinkingSignature: "reasoning_content",
			},
			{ type: "text", text: "Hi there!" },
		]);
	});

	it("preserves opaque and redacted state for exact-model replay", () => {
		const model = makeCopilotClaudeModel();
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: "opaque-signature" },
				{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "redacted-data", redacted: true },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: {}, thoughtSignature: "tool-signature" },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const result = transformMessages([message], model, anthropicNormalizeToolCallId);
		expect((result[0] as AssistantMessage).content).toEqual(message.content);
	});

	it("drops redacted and encrypted-only foreign thinking even when opted in", () => {
		const model = makeCopilotClaudeModel();
		const preserve = vi.fn(() => true);
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "secret", redacted: true },
				{ type: "thinking", thinking: "", thinkingSignature: '{"encrypted_content":"secret"}' },
				{ type: "text", text: "Visible answer" },
			],
			api: "openai-responses",
			provider: "openai",
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
		};

		const result = transformMessages([message], model, anthropicNormalizeToolCallId, preserve);
		expect((result[0] as AssistantMessage).content).toEqual([{ type: "text", text: "Visible answer" }]);
		expect(preserve).not.toHaveBeenCalled();
	});

	it("removes thoughtSignature from tool calls when migrating between models", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "run a command", timestamp: Date.now() },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_123",
						name: "bash",
						arguments: { command: "ls" },
						thoughtSignature: JSON.stringify({ type: "reasoning.encrypted", id: "call_123", data: "encrypted" }),
					},
				],
				api: "openai-responses",
				provider: "github-copilot",
				model: "gpt-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_123",
				toolName: "bash",
				content: [{ type: "text", text: "output" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const assistantMsg = result.find((m) => m.role === "assistant") as AssistantMessage;
		const toolCall = assistantMsg.content.find((b) => b.type === "toolCall") as ToolCall;

		expect(toolCall.thoughtSignature).toBeUndefined();
	});
});
