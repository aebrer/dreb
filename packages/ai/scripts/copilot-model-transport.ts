import type { Api, Model } from "../src/types.js";

export function getCopilotModelTransport(modelId: string): Pick<Model<Api>, "api" | "compat"> {
	// Native Claude uses /v1/messages for adaptive thinking and effort. Fable and
	// Mythos stay on completions until dreb models their thinking rules.
	if (/^claude-(haiku|sonnet|opus)-([4-9]|\d{2,})([.\-]|$)/.test(modelId)) {
		return { api: "anthropic-messages" };
	}
	if (modelId.startsWith("gpt-5") || modelId.startsWith("gpt-6") || modelId.startsWith("oswe")) {
		return { api: "openai-responses" };
	}
	return {
		api: "openai-completions",
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
	};
}
