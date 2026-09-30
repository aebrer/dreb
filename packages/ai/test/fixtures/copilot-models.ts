import { getModels } from "../../src/models.js";
import type { Api, Model } from "../../src/types.js";

/**
 * Preferred, broadly-entitled Copilot models per transport. Copilot gates some catalog
 * entries (e.g. claude-fable-*, claude-haiku-4.5) behind plan/org policy, so picking the
 * first catalog match made live tests fail with "model is not supported".
 */
const PREFERRED: Record<"anthropic-messages" | "openai-completions", readonly string[]> = {
	"anthropic-messages": ["claude-opus-4.8", "claude-opus-4.7"],
	"openai-completions": ["claude-sonnet-5", "claude-opus-5", "gemini-3.8-flash"],
};

/** Provider contract tests should survive catalog retirements without changing transport. */
export function getCopilotTestModel<TApi extends "anthropic-messages" | "openai-completions">(api: TApi): Model<TApi> {
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
