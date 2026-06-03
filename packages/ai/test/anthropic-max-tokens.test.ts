import { describe, expect, it } from "vitest";
import { findModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context, Model } from "../src/types.js";

interface AnthropicParams {
	max_tokens: number;
	thinking?: { type: string; budget_tokens?: number };
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

// streamAnthropic routes straight through buildParams; onPayload exposes the
// fully-built request params (including max_tokens and thinking.budget_tokens)
// before the request leaves the process. Pointing baseUrl at a closed port makes
// the request fail fast after the payload is captured.
async function captureParams(
	model: Model<"anthropic-messages">,
	options: Record<string, unknown>,
): Promise<AnthropicParams> {
	let captured: AnthropicParams | undefined;
	const captureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamAnthropic(captureModel, makeContext(), {
		apiKey: "fake-key",
		onPayload: (payload: unknown) => {
			captured = payload as AnthropicParams;
			return payload;
		},
		...options,
	} as never);

	await s.result();

	if (!captured) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return captured;
}

describe("Anthropic max_tokens default", () => {
	it("defaults max_tokens to the model's full output ceiling (not maxTokens/3)", async () => {
		const model = findModel("anthropic", "sonnet")! as Model<"anthropic-messages">;

		const params = await captureParams(model, {});

		// Previously this defaulted to (model.maxTokens / 3) | 0, which truncated
		// output. It must now use the full model.maxTokens ceiling.
		expect(params.max_tokens).toBe(model.maxTokens);
		expect(params.max_tokens).not.toBe((model.maxTokens / 3) | 0);
	});

	it("respects an explicit maxTokens when provided", async () => {
		const model = findModel("anthropic", "sonnet")! as Model<"anthropic-messages">;

		const params = await captureParams(model, { maxTokens: 1234 });

		expect(params.max_tokens).toBe(1234);
	});

	it("keeps the budget-based thinking budget strictly below max_tokens with text headroom", async () => {
		// haiku-4-5 uses budget-based thinking (not adaptive), so thinkingBudgetTokens applies.
		const model = findModel("anthropic", "haiku")! as Model<"anthropic-messages">;

		// Request a huge thinking budget at/above the default full max_tokens to
		// exercise the headroom guard.
		const params = await captureParams(model, {
			thinkingEnabled: true,
			thinkingBudgetTokens: model.maxTokens,
		});

		expect(params.thinking?.type).toBe("enabled");
		const budget = params.thinking?.budget_tokens ?? 0;

		// Invariant required by the Anthropic API: budget_tokens < max_tokens.
		expect(budget).toBeLessThan(params.max_tokens);

		// Headroom guarantee: at least 1/4 of max_tokens (floor 4096) is reserved
		// for visible text output.
		const expectedHeadroom = Math.max(4096, Math.floor(params.max_tokens / 4));
		expect(params.max_tokens - budget).toBeGreaterThanOrEqual(expectedHeadroom);
	});

	it("passes through a modest thinking budget unchanged when there is ample headroom", async () => {
		const model = findModel("anthropic", "haiku")! as Model<"anthropic-messages">;

		const params = await captureParams(model, {
			thinkingEnabled: true,
			thinkingBudgetTokens: 8192,
		});

		expect(params.thinking?.budget_tokens).toBe(8192);
		expect(params.thinking?.budget_tokens).toBeLessThan(params.max_tokens);
	});
});
