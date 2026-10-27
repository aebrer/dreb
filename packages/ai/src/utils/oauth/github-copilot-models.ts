/**
 * GitHub Copilot model discovery.
 *
 * Copilot's authenticated `/models` endpoint reports, per account, which models are
 * available and which API endpoints each one serves. dreb stores a compact copy in the
 * OAuth credential (at login and on every token refresh) and overlays it on the built-in
 * catalog: models the account can't use are hidden, and a model whose catalog endpoint
 * is not served switches to one that is. Capabilities (thinking levels, limits) still
 * come from the catalog.
 */

import { getModels } from "../../models.js";
import type { Api, Model, OpenAICompletionsCompat } from "../../types.js";

/** Compact per-model data from Copilot's `/models` endpoint, persisted in the OAuth credential. */
export interface CopilotModelInfo {
	id: string;
	/** Advertised API endpoints, e.g. `/v1/messages`, `/responses`, `/chat/completions`. */
	endpoints: string[];
	/** Policy state (`enabled`, `disabled`, `unconfigured`, ...). `disabled` models are hidden. */
	policyState?: string;
}

/** OpenAI-completions settings for Copilot (matches the generated catalog). */
const COPILOT_COMPLETIONS_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
};

const API_ENDPOINTS: Partial<Record<Api, string>> = {
	"anthropic-messages": "/v1/messages",
	"openai-responses": "/responses",
	"openai-completions": "/chat/completions",
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Parse Copilot's `/models` response into compact entries. Non-chat models (embeddings)
 * and malformed entries are skipped. Throws when the response has no `data` array.
 */
export function parseCopilotModels(raw: unknown): CopilotModelInfo[] {
	const data = record(raw)?.data;
	if (!Array.isArray(data)) {
		throw new Error("Invalid Copilot /models response: missing data array");
	}

	const models: CopilotModelInfo[] = [];
	for (const entry of data) {
		const model = record(entry);
		if (!model || typeof model.id !== "string" || model.id.length === 0) continue;
		const type = record(model.capabilities)?.type;
		if (typeof type === "string" && type !== "chat") continue;
		const endpoints = Array.isArray(model.supported_endpoints) ? model.supported_endpoints : [];
		const info: CopilotModelInfo = {
			id: model.id,
			endpoints: endpoints.filter((endpoint): endpoint is string => typeof endpoint === "string"),
		};
		const policyState = record(model.policy)?.state;
		if (typeof policyState === "string") info.policyState = policyState;
		models.push(info);
	}
	return models;
}

/** Fetch and parse the account's Copilot models. Throws on HTTP or shape errors. */
export async function listGitHubCopilotModels(
	token: string,
	baseUrl: string,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<CopilotModelInfo[]> {
	const response = await fetch(`${baseUrl}/models`, {
		headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...headers },
		signal,
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Copilot /models failed: ${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
	}
	return parseCopilotModels(await response.json());
}

/**
 * Pick the API for a Copilot model from its advertised endpoints: the catalog API is kept
 * when its endpoint is advertised (or nothing is advertised); otherwise the model switches
 * to `/responses`, then `/chat/completions`.
 */
function chooseApi(model: Model<Api>, endpoints: string[]): Api {
	const current = API_ENDPOINTS[model.api];
	if (endpoints.length === 0 || current === undefined || endpoints.includes(current)) return model.api;
	if (endpoints.includes("/responses")) return "openai-responses";
	return endpoints.includes("/chat/completions") ? "openai-completions" : model.api;
}

function withApi(model: Model<Api>, api: Api): Model<Api> {
	if (api === model.api) return model;
	const { compat: _compat, ...rest } = model;
	return api === "openai-completions"
		? ({ ...rest, api, compat: COPILOT_COMPLETIONS_COMPAT } as Model<Api>)
		: ({ ...rest, api } as Model<Api>);
}

/**
 * Overlay discovered Copilot models on a model list:
 * - built-in Copilot models the account doesn't list (or lists as `disabled`) are removed;
 *   custom `models.json` entries that are not listed are kept
 * - listed models switch API when their catalog endpoint is not advertised
 *
 * Non-Copilot models are returned unchanged. An empty discovery list is ignored.
 */
export function applyCopilotModelDiscovery(models: Model<Api>[], discovered: CopilotModelInfo[]): Model<Api>[] {
	if (discovered.length === 0) return models;
	const builtInIds = new Set(getModels("github-copilot").map((model) => model.id));
	const discoveredById = new Map(discovered.map((info) => [info.id, info]));

	return models.flatMap((model) => {
		if (model.provider !== "github-copilot") return [model];
		const info = discoveredById.get(model.id);
		if (!info) return builtInIds.has(model.id) ? [] : [model];
		if (info.policyState === "disabled") return [];
		return [withApi(model, chooseApi(model, info.endpoints))];
	});
}
