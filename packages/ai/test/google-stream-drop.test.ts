import { describe, expect, it, vi } from "vitest";

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				yield {
					responseId: "google-response-id",
					candidates: [{ content: { parts: [{ text: "partial" }] } }],
					usageMetadata: {
						promptTokenCount: 1,
						candidatesTokenCount: 1,
						totalTokenCount: 2,
					},
				};
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

import { streamGoogle } from "../src/providers/google.js";
import type { Context, Model } from "../src/types.js";

describe("google stream-drop detection", () => {
	it("reports a retryable error when the stream ends without finishReason", async () => {
		const model: Model<"google-generative-ai"> = {
			id: "gemini-test",
			name: "Gemini Test",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		};
		const context: Context = {
			systemPrompt: "You are helpful.",
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		const result = await streamGoogle(model, context, { apiKey: "test-key" }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Stream ended without finishReason");
		expect(result.errorMessage).toContain("connection likely dropped");
	});
});
