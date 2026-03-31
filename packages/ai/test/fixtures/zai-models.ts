/**
 * Shared z.ai test model fixtures.
 *
 * Use these instead of inline model objects — single source of truth
 * prevents drift across test files. z.ai is configured via models.json
 * (not built-in), so these fixtures represent the user's custom setup.
 */
import type { Model } from "../../src/types.js";

const ZAI_BASE: Omit<Model<"openai-completions">, "id" | "name" | "reasoning" | "contextWindow" | "maxTokens"> = {
	api: "openai-completions",
	provider: "zai",
	baseUrl: "https://api.z.ai/api/coding/paas/v4",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { supportsDeveloperRole: false, thinkingFormat: "zai" },
};

/** GLM-4.7 Flash — fast non-reasoning model (free tier) */
export const ZAI_GLM_47_FLASH: Model<"openai-completions"> = {
	...ZAI_BASE,
	id: "glm-4.7-flash",
	name: "GLM-4.7 Flash",
	reasoning: false,
	contextWindow: 128000,
	maxTokens: 4096,
};

/** GLM-5 — reasoning model with standard context window */
export const ZAI_GLM_5: Model<"openai-completions"> = {
	...ZAI_BASE,
	id: "glm-5",
	name: "GLM-5",
	reasoning: true,
	contextWindow: 128000,
	maxTokens: 4096,
};

/** GLM-5 — reasoning model with extended context window */
export const ZAI_GLM_5_EXTENDED: Model<"openai-completions"> = {
	...ZAI_BASE,
	id: "glm-5",
	name: "GLM-5",
	reasoning: true,
	contextWindow: 204800,
	maxTokens: 131072,
};
