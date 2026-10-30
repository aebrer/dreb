import { getModels } from "../../src/models.js";
import type { Api, Model } from "../../src/types.js";

/**
 * Preferred, broadly-entitled Copilot models per transport. Copilot gates some catalog
 * entries (e.g. claude-fable-*, claude-haiku-4.5) behind plan/org policy, so picking the
 * first catalog match made live tests fail with "model is not supported".
 */
const PREFERRED: Record<"anthropic-messages" | "openai-completions" | "openai-responses", readonly string[]> = {
	"anthropic-messages": ["claude-sonnet-5", "claude-opus-5", "claude-opus-4.8", "claude-opus-4.7"],
	// Copilot Claude now uses Anthropic Messages; Gemini is the broadly entitled completions model.
	"openai-completions": ["gemini-3.8-flash", "gemini-3.7-flash"],
	"openai-responses": ["gpt-6-luna", "gpt-6-astra", "gpt-6.1-sol", "gpt-5.3-codex"],
};

/** Provider contract tests should survive catalog retirements without changing transport. */
export function getCopilotTestModel<TApi extends "anthropic-messages" | "openai-completions" | "openai-responses">(
	api: TApi,
): Model<TApi> {
	const models: Model<Api>[] = getModels("github-copilot");
	const candidates = models.filter(
		(candidate): candidate is Model<TApi> =>
			candidate.api === api && candidate.reasoning && candidate.input.includes("image"),
	);
	const model =
		PREFERRED[api].map((id) => candidates.find((c) => c.id === id)).find((c) => c !== undefined) ?? candidates[0];
	if (!model) throw new Error(`Expected a reasoning- and image-capable Copilot model using ${api}`);
	return model;
}
