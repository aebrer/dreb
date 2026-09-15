import { describe, expect, it, vi } from "vitest";

vi.mock("openai", () => {
	class AzureOpenAI {
		responses = {
			create: async () => {
				throw new Error("Azure request blocked by test mock");
			},
		};
	}

	return { AzureOpenAI };
});

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async () => {
				throw new Error("Google request blocked by test mock");
			},
		};
	}

	return {
		GoogleGenAI,
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeClient {
		async send() {
			throw new Error("Bedrock request blocked by test mock");
		}
	}

	class ConverseStreamCommand {}

	return {
		BedrockRuntimeClient,
		ConverseStreamCommand,
		StopReason: {},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "one_hour" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: {},
		ToolResultStatus: {},
	};
});

vi.mock("@mistralai/mistralai", () => {
	class Mistral {
		chat = {
			stream: async () => {
				throw new Error("Mistral request blocked by test mock");
			},
		};
	}

	return { Mistral };
});

import { streamSimple } from "../src/stream.js";
import type { Api, Context, Model } from "../src/types.js";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function model<TApi extends Api>(api: TApi, provider: string): Model<TApi> {
	return {
		id: `${provider}-test`,
		name: `${provider} test`,
		api,
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

async function capturePayload<TApi extends Api>(
	model: Model<TApi>,
	options: { maxTokens?: number; reasoning?: "minimal" | "low" | "medium" | "high" } = {},
): Promise<Record<string, unknown>> {
	let captured: Record<string, unknown> | undefined;

	await streamSimple(model, context, {
		apiKey: "test-key",
		...options,
		onPayload: (payload) => {
			captured = payload as Record<string, unknown>;
		},
	}).result();

	if (!captured) throw new Error("Expected payload to be captured before the mocked request failed");
	return captured;
}

describe("provider max output budget payloads", () => {
	it("uses the model maximum for Azure OpenAI Responses", async () => {
		const providerModel = model("azure-openai-responses", "azure-openai-responses");

		const payload = await capturePayload(providerModel);

		expect(payload.max_output_tokens).toBe(providerModel.maxTokens);
	});

	it("uses the model maximum for Google Generative AI", async () => {
		const providerModel = model("google-generative-ai", "google");

		const payload = await capturePayload(providerModel);

		expect((payload.config as Record<string, unknown>).maxOutputTokens).toBe(providerModel.maxTokens);
	});

	it("uses the model maximum for Google Vertex", async () => {
		const providerModel = model("google-vertex", "google-vertex");

		const payload = await capturePayload(providerModel);

		expect((payload.config as Record<string, unknown>).maxOutputTokens).toBe(providerModel.maxTokens);
	});

	it("uses the model maximum for Amazon Bedrock", async () => {
		const providerModel = model("bedrock-converse-stream", "amazon-bedrock");

		const payload = await capturePayload(providerModel);

		expect((payload.inferenceConfig as Record<string, unknown>).maxTokens).toBe(providerModel.maxTokens);
	});

	it("uses the model maximum for Mistral", async () => {
		const providerModel = model("mistral-conversations", "mistral");

		const payload = await capturePayload(providerModel);

		expect(payload.maxTokens).toBe(providerModel.maxTokens);
	});

	it("preserves an explicit smaller maxTokens value", async () => {
		const payload = await capturePayload(model("azure-openai-responses", "azure-openai-responses"), {
			maxTokens: 1234,
		});

		expect(payload.max_output_tokens).toBe(1234);
	});

	it("fits Google thinking inside an explicit bounded output limit", async () => {
		const providerModel = {
			...model("google-generative-ai", "google"),
			id: "gemini-2.5-pro",
			reasoning: true,
		};
		const payload = await capturePayload(providerModel, { maxTokens: 8192, reasoning: "high" });
		const config = payload.config as Record<string, unknown>;
		const thinking = config.thinkingConfig as Record<string, unknown>;

		expect(config.maxOutputTokens).toBe(8192);
		expect(thinking.thinkingBudget).toBe(7168);
	});
});
