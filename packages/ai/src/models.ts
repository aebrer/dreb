import { MODELS } from "./models.generated.js";
import type { Api, KnownProvider, Model, Usage } from "./types.js";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

type ModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

/**
 * Check if a model ID looks like an alias (no date suffix).
 * Aliases are preferred over dated versions when fuzzy matching.
 *
 * IDs ending with `-latest` are treated as aliases.
 * IDs ending with a date pattern (`-YYYYMMDD`) are treated as dated versions.
 */
export function isModelAlias(id: string): boolean {
	if (id.endsWith("-latest")) return true;
	return !/-\d{8}$/.test(id);
}

/**
 * Find a model by fuzzy matching against the provider's registered models.
 *
 * Resolution order:
 * 1. Exact match by provider + model ID (via registry Map.get)
 * 2. Case-insensitive substring match against model ID and display name
 * 3. Among matches, prefer aliases (non-dated IDs) over dated versions
 * 4. Among ties, pick the lexicographically highest (latest) ID
 *
 * This is the same matching logic used by the CLI, subagent model resolution,
 * and interactive mode — centralised here so tests can exercise the real path.
 *
 * @example
 * findModel("anthropic", "sonnet")  // → latest claude-sonnet alias
 * findModel("anthropic", "haiku")   // → latest claude-haiku alias
 * findModel("openai", "gpt-5")     // → latest gpt-5 alias
 */
export function findModel(provider: string, pattern: string): Model<Api> | undefined {
	const providerModels = modelRegistry.get(provider);
	if (!providerModels) return undefined;

	// Try exact match first
	const exact = providerModels.get(pattern);
	if (exact) return exact;

	// Substring match (case-insensitive)
	const normalizedPattern = pattern.toLowerCase();
	const matches = Array.from(providerModels.values()).filter(
		(m) => m.id.toLowerCase().includes(normalizedPattern) || m.name?.toLowerCase().includes(normalizedPattern),
	);

	if (matches.length === 0) return undefined;
	if (matches.length === 1) return matches[0];

	// Multiple matches — separate into aliases and dated versions
	const aliases = matches.filter((m) => isModelAlias(m.id));
	const datedVersions = matches.filter((m) => !isModelAlias(m.id));

	if (aliases.length > 0) {
		// Prefer alias — if multiple, pick the lexicographically highest
		aliases.sort((a, b) => b.id.localeCompare(a.id));
		return aliases[0];
	}

	// All dated — prefer the latest
	datedVersions.sort((a, b) => b.id.localeCompare(a.id));
	return datedVersions[0];
}

/**
 * Find a model by fuzzy matching against a flat array of models.
 * Same algorithm as findModel() but operates on an arbitrary model list
 * instead of the built-in registry.
 *
 * Used by model-resolver.ts and other code that manages its own model lists.
 */
export function findModelInList(pattern: string, models: Model<Api>[]): Model<Api> | undefined {
	if (models.length === 0) return undefined;

	const normalizedPattern = pattern.toLowerCase();

	// Exact ID match (case-insensitive)
	const exactById = models.find((m) => m.id.toLowerCase() === normalizedPattern);
	if (exactById) return exactById;

	// Substring match (case-insensitive)
	const matches = models.filter(
		(m) => m.id.toLowerCase().includes(normalizedPattern) || m.name?.toLowerCase().includes(normalizedPattern),
	);

	if (matches.length === 0) return undefined;
	if (matches.length === 1) return matches[0];

	// Multiple matches — separate into aliases and dated versions
	const aliases = matches.filter((m) => isModelAlias(m.id));
	const datedVersions = matches.filter((m) => !isModelAlias(m.id));

	if (aliases.length > 0) {
		aliases.sort((a, b) => b.id.localeCompare(a.id));
		return aliases[0];
	}

	datedVersions.sort((a, b) => b.id.localeCompare(a.id));
	return datedVersions[0];
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

/**
 * Check if a model supports xhigh thinking level.
 *
 * Supported today:
 * - GPT-5.2 / GPT-5.3 / GPT-5.4 model families
 * - Opus 4.6 models (xhigh maps to adaptive effort "max" on Anthropic-compatible providers)
 */
export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
	if (model.id.includes("gpt-5.2") || model.id.includes("gpt-5.3") || model.id.includes("gpt-5.4")) {
		return true;
	}

	if (model.id.includes("opus-4-6") || model.id.includes("opus-4.6")) {
		return true;
	}

	return false;
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
