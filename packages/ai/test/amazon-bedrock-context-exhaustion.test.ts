import { describe, expect, it, vi } from "vitest";

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeClient {
		async send() {
			return {
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } };
					yield { messageStop: { stopReason: "model_context_window_exceeded" } };
				})(),
			};
		}
	}

	class ConverseStreamCommand {}

	return {
		BedrockRuntimeClient,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "one_hour" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: {},
		ToolResultStatus: {},
	};
});

import { streamSimple } from "../src/stream.js";
import type { Context, Model } from "../src/types.js";
import { isContextOverflow } from "../src/utils/overflow.js";

const model: Model<"bedrock-converse-stream"> = {
	id: "bedrock-test",
	name: "Bedrock test",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

describe("Amazon Bedrock context exhaustion", () => {
	it("preserves the explicit context-window stop signal for overflow recovery", async () => {
		const result = await streamSimple(model, context, { apiKey: "test-key" }).result();

		expect(result.stopReason).toBe("length");
		expect(result.errorMessage).toBe("model_context_window_exceeded");

		const exhausted = {
			...result,
			stopReason: "error" as const,
			errorMessage:
				"Response truncated at the configured output token limit after 3 attempts\nProvider detail: model_context_window_exceeded",
		};
		expect(isContextOverflow(exhausted, model.contextWindow)).toBe(true);
	});
});
