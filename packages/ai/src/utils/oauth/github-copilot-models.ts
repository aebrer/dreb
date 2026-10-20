/**
 * GitHub Copilot model discovery.
 *
 * Copilot's authenticated `/models` endpoint reports, per account, which models are
 * available, which API endpoints each one serves, and which reasoning efforts it accepts.
 * dreb stores a compact copy in the OAuth credential (at login and on every token refresh)
 * and overlays it on the built-in catalog, so routing, effort levels, and availability
 * follow Copilot instead of a release-time snapshot.
 */

import { getModels } from "../../models.js";
import type { Api, Model, OpenAICompletionsCompat } from "../../types.js";

/** Compact per-model data from Copilot's `/models` endpoint, persisted in the OAuth credential. */
export interface CopilotModelInfo {
	id: string;
	name?: string;
	/** Advertised API endpoints, e.g. `/v1/messages`, `/responses`, `/chat/completions`. */
	endpoints: string[];
	/** Advertised `reasoning_effort` values, e.g. `["low", "medium", "high", "xhigh", "max"]`. */
	reasoningEfforts?: string[];
	adaptiveThinking?: boolean;
	/** Policy state (`enabled`, `disabled`, `unconfigured`, ...). `disabled` models are hidden. */
	policyState?: string;
	/** Whether Copilot shows the model in its picker. Hidden/internal models are not added. */
	pickerEnabled?: boolean;
	vision?: boolean;
	maxContextWindowTokens?: number;
	maxPromptTokens?: number;
	maxOutputTokens?: number;
}

/** Copilot Claude families served through `/v1/messages` (Fable/Mythos are not handled yet). */
const COPILOT_CLAUDE_MESSAGES_ID = /^claude-(haiku|sonnet|opus)-([4-9]|\d{2,})([.-]|$)/;

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

/** Whether a Copilot model id is a Claude family dreb routes through `/v1/messages`. */
export function isCopilotClaudeMessagesModel(modelId: string): boolean {
	return COPILOT_CLAUDE_MESSAGES_ID.test(modelId);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function strings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result = value.filter((item): item is string => typeof item === "string");
	return result.length > 0 ? result : undefined;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
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
		const capabilities = record(model.capabilities);
		if (typeof capabilities?.type === "string" && capabilities.type !== "chat") continue;
		const supports = record(capabilities?.supports);
		const limits = record(capabilities?.limits);
		const mediaTypes = strings(record(limits?.vision)?.supported_media_types) ?? [];

		const info: CopilotModelInfo = {
			id: model.id,
			endpoints: strings(model.supported_endpoints) ?? [],
		};
		if (typeof model.name === "string") info.name = model.name;
		const efforts = strings(supports?.reasoning_effort);
		if (efforts) info.reasoningEfforts = efforts;
		if (typeof supports?.adaptive_thinking === "boolean") info.adaptiveThinking = supports.adaptive_thinking;
		const policyState = record(model.policy)?.state;
		if (typeof policyState === "string") info.policyState = policyState;
		if (typeof model.model_picker_enabled === "boolean") info.pickerEnabled = model.model_picker_enabled;
		if (supports?.vision === true || mediaTypes.some((type) => type.startsWith("image/"))) info.vision = true;
		const maxContextWindowTokens = positiveNumber(limits?.max_context_window_tokens);
		if (maxContextWindowTokens) info.maxContextWindowTokens = maxContextWindowTokens;
		const maxPromptTokens = positiveNumber(limits?.max_prompt_tokens);
		if (maxPromptTokens) info.maxPromptTokens = maxPromptTokens;
		const maxOutputTokens = positiveNumber(limits?.max_output_tokens);
		if (maxOutputTokens) info.maxOutputTokens = maxOutputTokens;
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

function isAvailable(info: CopilotModelInfo): boolean {
	return info.policyState !== "disabled";
}

/**
 * Pick the API for a Copilot model from its advertised endpoints: Claude Opus/Sonnet/Haiku
 * prefer `/v1/messages`; otherwise the catalog API is kept when its endpoint is advertised,
 * and a model whose catalog endpoint is not served switches to `/responses`, then
 * `/chat/completions`.
 */
function chooseApi(model: Model<Api>, info: CopilotModelInfo): Api {
	const endpoints = info.endpoints ?? [];
	if (endpoints.length === 0) return model.api;
	if (isCopilotClaudeMessagesModel(model.id) && endpoints.includes("/v1/messages")) return "anthropic-messages";
	const current = API_ENDPOINTS[model.api];
	if (current === undefined || endpoints.includes(current)) return model.api;
	if (endpoints.includes("/responses")) return "openai-responses";
	if (endpoints.includes("/chat/completions")) return "openai-completions";
	return model.api;
}

function withApi(model: Model<Api>, api: Api): Model<Api> {
	if (api === model.api) return model;
	const { compat: _compat, ...rest } = model;
	return api === "openai-completions"
		? ({ ...rest, api, compat: COPILOT_COMPLETIONS_COMPAT } as Model<Api>)
		: ({ ...rest, api } as Model<Api>);
}

/**
 * Advertised efforts are applied only where dreb sends an effort to Copilot (Anthropic
 * Messages and Responses); Copilot's OpenAI-completions models never receive one.
 */
function withEfforts(model: Model<Api>, info: CopilotModelInfo): Model<Api> {
	if (!model.reasoning || !info.reasoningEfforts?.length) return model;
	if (model.api !== "anthropic-messages" && model.api !== "openai-responses") return model;
	return { ...model, reasoningEfforts: [...info.reasoningEfforts] };
}

function overlay(model: Model<Api>, info: CopilotModelInfo): Model<Api> {
	return withEfforts(withApi(model, chooseApi(model, info)), info);
}

/** Build a catalog entry for a Copilot Claude model the built-in catalog doesn't know yet. */
function templateClaudeModel(info: CopilotModelInfo, base: Model<Api>): Model<Api> {
	const { compat: _compat, reasoningEfforts: _efforts, ...rest } = base;
	const reasoning = (info.reasoningEfforts?.length ?? 0) > 0 || info.adaptiveThinking === true;
	const model: Model<Api> = {
		...rest,
		id: info.id,
		name: info.name ?? info.id,
		api: "anthropic-messages",
		reasoning,
		input: info.vision ? ["text", "image"] : ["text"],
		// Pricing for an unknown model isn't advertised; report zero rather than guess.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: info.maxContextWindowTokens ?? info.maxPromptTokens ?? base.contextWindow,
		maxTokens: info.maxOutputTokens ?? base.maxTokens,
	};
	return withEfforts(model, info);
}

/**
 * Overlay discovered Copilot models on a model list:
 * - built-in Copilot models the account doesn't list (or lists as `disabled`) are removed;
 *   custom `models.json` entries that are not listed are kept
 * - listed models get endpoint-based routing and advertised reasoning efforts
 * - listed Claude Opus/Sonnet/Haiku models missing from the catalog are added when Copilot
 *   serves them through `/v1/messages` and shows them in its picker
 *
 * Non-Copilot models are returned unchanged. An empty discovery list is ignored.
 */
export function applyCopilotModelDiscovery(models: Model<Api>[], discovered: CopilotModelInfo[]): Model<Api>[] {
	if (discovered.length === 0) return models;
	const builtInIds = new Set(getModels("github-copilot").map((model) => model.id));
	const discoveredById = new Map(discovered.map((info) => [info.id, info]));
	const presentIds = new Set<string>();
	const result: Model<Api>[] = [];
	let lastCopilotIndex = -1;

	for (const model of models) {
		if (model.provider !== "github-copilot") {
			result.push(model);
			continue;
		}
		const info = discoveredById.get(model.id);
		if (!info) {
			if (builtInIds.has(model.id)) continue;
			result.push(model);
		} else {
			if (!isAvailable(info)) continue;
			result.push(overlay(model, info));
		}
		presentIds.add(model.id);
		lastCopilotIndex = result.length - 1;
	}

	const base = models
		.filter((model) => model.provider === "github-copilot" && isCopilotClaudeMessagesModel(model.id))
		.concat(getModels("github-copilot") as Model<Api>[])
		.find((model) => model.provider === "github-copilot" && isCopilotClaudeMessagesModel(model.id));
	if (!base) return result;

	const added = discovered
		.filter(
			(info) =>
				!presentIds.has(info.id) &&
				isAvailable(info) &&
				info.pickerEnabled === true &&
				isCopilotClaudeMessagesModel(info.id) &&
				(info.endpoints ?? []).includes("/v1/messages"),
		)
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((info) => templateClaudeModel(info, base));

	if (added.length === 0) return result;
	const insertAt = lastCopilotIndex === -1 ? result.length : lastCopilotIndex + 1;
	result.splice(insertAt, 0, ...added);
	return result;
}
