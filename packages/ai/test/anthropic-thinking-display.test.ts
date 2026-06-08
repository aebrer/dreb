import { describe, expect, it } from "vitest";
import { findModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";
import type { Context, Model } from "../src/types.js";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
}

function makePayloadCaptureContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

/**
 * Capture the request payload for a model with thinking enabled (reasoning set).
 * Points the model at an unroutable base URL so the request fails after onPayload runs.
 */
async function capturePayload(
	model: Model<"anthropic-messages">,
	options: { reasoning?: "low" | "high"; thinkingDisplay?: "summarized" | "omitted" } = {},
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makePayloadCaptureContext(), {
		apiKey: "fake-key",
		reasoning: options.reasoning ?? "high",
		thinkingDisplay: options.thinkingDisplay,
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			return payload;
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Anthropic thinking display payload", () => {
	it("sends thinking.display=summarized for adaptive models when requested", async () => {
		const payload = await capturePayload(findModel("anthropic", "opus")! as Model<"anthropic-messages">, {
			thinkingDisplay: "summarized",
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
	});

	it("sends thinking.display=omitted for adaptive models when requested", async () => {
		const payload = await capturePayload(findModel("anthropic", "opus")! as Model<"anthropic-messages">, {
			thinkingDisplay: "omitted",
		});

		expect(payload.thinking?.display).toBe("omitted");
	});

	it("omits the display field for adaptive models when thinkingDisplay is unset", async () => {
		const payload = await capturePayload(findModel("anthropic", "opus")! as Model<"anthropic-messages">);

		expect(payload.thinking).toEqual({ type: "adaptive" });
		expect(payload.thinking?.display).toBeUndefined();
	});

	it("never sets display on budget-based models even when thinkingDisplay is requested", async () => {
		// claude-sonnet-4-5 is a reasoning model that uses budget-based (type: "enabled")
		// thinking, NOT adaptive — thinkingDisplay must be gated out for it.
		const model = findModel("anthropic", "claude-sonnet-4-5")! as Model<"anthropic-messages">;
		const payload = await capturePayload(model, { thinkingDisplay: "summarized" });

		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.thinking?.display).toBeUndefined();
	});
});

// Bedrock's adaptive thinking display logic is unit-tested directly in
// bedrock-thinking-display.test.ts, which exercises the exported
// buildAdditionalModelRequestFields function.
