import { getModels } from "../../src/models.js";
import type { Api, Model } from "../../src/types.js";

/** Provider contract tests should survive catalog retirements without changing transport. */
export function getCopilotTestModel<TApi extends "anthropic-messages" | "openai-completions">(api: TApi): Model<TApi> {
	const models: Model<Api>[] = getModels("github-copilot");
	const model = models.find(
		(candidate): candidate is Model<TApi> =>
			candidate.api === api && candidate.reasoning && candidate.input.includes("image"),
	);
	if (!model) throw new Error(`Expected a reasoning- and image-capable Copilot model using ${api}`);
	return model;
}
