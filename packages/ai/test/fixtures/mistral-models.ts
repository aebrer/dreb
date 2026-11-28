import { getModels } from "../../src/models.js";
import type { Api, Model } from "../../src/types.js";

type TestCapability = "text" | "image" | "reasoning";

const PREFERRED: Record<TestCapability, readonly string[]> = {
	text: ["ministral-8b-latest", "mistral-small-latest"],
	image: ["ministral-8b-latest", "mistral-small-latest"],
	reasoning: ["mistral-small-latest", "mistral-large-latest"],
};

/** Select a current Mistral Conversations model for an opt-in provider test. */
export function getMistralTestModel(capability: TestCapability = "text"): Model<"mistral-conversations"> {
	const models: Model<Api>[] = getModels("mistral");
	const candidates = models.filter(
		(model): model is Model<"mistral-conversations"> =>
			model.api === "mistral-conversations" &&
			model.input.includes("text") &&
			!model.id.startsWith("codestral-") &&
			!model.id.startsWith("voxtral-") &&
			(capability !== "image" || model.input.includes("image")) &&
			(capability !== "reasoning" || model.reasoning),
	);
	const model =
		PREFERRED[capability].map((id) => candidates.find((m) => m.id === id)).find((m) => m !== undefined) ??
		candidates[0];
	if (!model) throw new Error(`Expected a Mistral Conversations model with ${capability} support`);
	return model;
}
