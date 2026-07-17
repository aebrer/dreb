import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { convertMessages } from "../src/providers/openai-completions.js";
import type {
	AssistantMessage,
	Context,
	Model,
	OpenAICompletionsCompat,
	ToolResultMessage,
	Usage,
} from "../src/types.js";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat: Required<OpenAICompletionsCompat> = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	reasoningEffortMap: {},
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	supportsStrictMode: true,
};

describe("openai-completions NUL sanitization", () => {
	it("removes NUL from every model-bound text role", () => {
		const model: Model<"openai-completions"> = {
			...getModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		const now = Date.now();
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "think\0ing", thinkingSignature: "reasoning_content" },
				{ type: "text", text: "ans\0wer" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.txt" } },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "tool\0result" }],
			isError: false,
			timestamp: now + 1,
		};
		const context: Context = {
			systemPrompt: "sys\0tem",
			messages: [{ role: "user", content: "us\0er", timestamp: now - 1 }, assistant, toolResult],
		};

		const messages = convertMessages(model, context, compat);

		expect(messages).toHaveLength(4);
		expect(messages[0]).toMatchObject({ role: "system", content: "system" });
		expect(messages[1]).toMatchObject({ role: "user", content: "user" });
		expect(messages[2]).toMatchObject({
			role: "assistant",
			content: "answer",
			reasoning_content: "thinking",
		});
		expect(messages[3]).toMatchObject({ role: "tool", content: "toolresult" });
		expect(JSON.stringify(messages)).not.toContain("\\u0000");
	});
});
