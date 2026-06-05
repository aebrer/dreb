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
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	supportsStrictMode: true,
};

function buildToolResult(toolCallId: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
		],
		isError: false,
		timestamp,
	};
}

function buildKimiOAuthModel(input: ("text" | "image")[]): Model<"openai-completions"> {
	return {
		id: "kimi-for-coding",
		name: "Kimi For Coding",
		api: "openai-completions",
		provider: "kimi-coding-oauth",
		baseUrl: "https://api.kimi.com/coding/v1",
		reasoning: true,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
		compat: { thinkingFormat: "kimi", supportsDeveloperRole: false },
	};
}

describe("openai-completions convertMessages", () => {
	it("batches tool-result images after consecutive tool results", () => {
		const baseModel = getModel("openai", "gpt-4o-mini");
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text", "image"],
		};

		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "img-1.png" } },
				{ type: "toolCall", id: "tool-2", name: "read", arguments: { path: "img-2.png" } },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Read the images", timestamp: now - 2 },
				assistantMessage,
				buildToolResult("tool-1", now + 1),
				buildToolResult("tool-2", now + 2),
			],
		};

		const messages = convertMessages(model, context, compat);
		const roles = messages.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "tool", "tool", "user"]);

		const imageMessage = messages[messages.length - 1];
		expect(imageMessage.role).toBe("user");
		expect(Array.isArray(imageMessage.content)).toBe(true);

		const imageParts = (imageMessage.content as Array<{ type?: string }>).filter(
			(part) => part?.type === "image_url",
		);
		expect(imageParts.length).toBe(2);
	});

	it("preserves Kimi OAuth user images as OpenAI-style image_url data URLs", () => {
		const model = buildKimiOAuthModel(["text", "image"]);
		const messages = convertMessages(
			model,
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Describe this image" },
							{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
						],
						timestamp: Date.now(),
					},
				],
			},
			compat,
		);

		expect(messages).toHaveLength(1);
		const content = messages[0].content as Array<{ type?: string; image_url?: { url?: string } }>;
		expect(content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "image_url",
					image_url: { url: "data:image/png;base64,ZmFrZQ==" },
				}),
			]),
		);
	});

	it("preserves Kimi OAuth tool-result images as OpenAI-style image_url data URLs", () => {
		const model = buildKimiOAuthModel(["text", "image"]);
		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "img.png" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};
		const messages = convertMessages(
			model,
			{
				messages: [
					{ role: "user", content: "Read the image", timestamp: now - 2 },
					assistantMessage,
					buildToolResult("tool-1", now + 1),
				],
			},
			compat,
		);

		const imageMessage = messages[messages.length - 1];
		expect(imageMessage.role).toBe("user");
		const content = imageMessage.content as Array<{ type?: string; image_url?: { url?: string } }>;
		expect(content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "image_url",
					image_url: { url: "data:image/png;base64,ZmFrZQ==" },
				}),
			]),
		);
	});

	it("marks omitted user images for text-only models", () => {
		const model = buildKimiOAuthModel(["text"]);
		const messages = convertMessages(
			model,
			{
				messages: [
					{
						role: "user",
						content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }],
						timestamp: Date.now(),
					},
				],
			},
			compat,
		);

		expect(messages).toHaveLength(1);
		const content = messages[0].content as Array<{ type?: string; text?: string }>;
		expect(content).toEqual([{ type: "text", text: "[image omitted: model does not support images]" }]);
	});

	it("marks omitted tool-result images for text-only models", () => {
		const model = buildKimiOAuthModel(["text"]);
		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "img.png" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};
		const messages = convertMessages(
			model,
			{
				messages: [
					{ role: "user", content: "Read the image", timestamp: now - 2 },
					assistantMessage,
					buildToolResult("tool-1", now + 1),
				],
			},
			compat,
		);

		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
		expect(messages[2].content).toBe(
			"Read image file [image/png]\n[tool image omitted: model does not support images]",
		);
	});
});
