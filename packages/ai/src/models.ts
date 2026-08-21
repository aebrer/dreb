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

interface ClaudeFamilyVersion {
	family: "opus" | "sonnet";
	major: number;
	minor?: number;
}

/** Parse Claude family versions without mistaking long date suffixes for versions. */
function claudeFamilyVersion(modelId: string): ClaudeFamilyVersion | undefined {
	const match = modelId.match(/(opus|sonnet)-(\d{1,2})(?:[.-](\d{1,2}))?(?!\d)/);
	if (!match) return undefined;
	return {
		family: match[1] as ClaudeFamilyVersion["family"],
		major: Number.parseInt(match[2], 10),
		minor: match[3] === undefined ? undefined : Number.parseInt(match[3], 10),
	};
}

/**
 * Parse Qwen family versions without mistaking parameter counts for minor versions.
 * Only a dot separates major from minor (qwen3.8-27b, Qwen-3.8); a hyphen after the
 * major version introduces the parameter size (qwen3-32b → 3.0, not 3.32). A capture
 * directly followed by a `b`-suffixed size token is a parameter count, not a version
 * (qwen-32b, Qwen-7B-Chat, deepseek-r1-distill-qwen-32b), and Qwen majors never reach
 * two digits, so only a single digit is accepted.
 */
function qwenFamilyVersion(modelId: string): { major: number; minor: number } | undefined {
	const match = modelId.match(/\bqwen[\s_-]*v?(\d)(?:\.(\d+))?(?![\d.]*b\b)/i);
	if (!match) return undefined;
	return {
		major: Number.parseInt(match[1], 10),
		minor: match[2] === undefined ? 0 : Number.parseInt(match[2], 10),
	};
}

/**
 * Check whether a model id belongs to Qwen 3.8 or a later Qwen generation — the first
 * Qwen family with graded `reasoning_effort` tiers (low/medium/xhigh, default xhigh).
 */
export function isQwen38OrLater(modelId: string): boolean {
	const qwen = qwenFamilyVersion(modelId);
	if (!qwen) return false;
	return qwen.major > 3 || (qwen.major === 3 && qwen.minor >= 8);
}

/**
 * Check if a model supports xhigh thinking level.
 *
 * Supported today:
 * - GPT-5.2 through GPT-5.6 model families
 * - Claude Opus 4.6–4.x and Claude 5 model families
 * - Kimi Code K3 (xhigh maps to its advertised "max" effort)
 * - Qwen 3.8+ model families (xhigh is their top native effort tier)
 */
export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
	if (model.provider === "kimi-coding-oauth" && model.id === "k3") return true;
	if (isQwen38OrLater(model.id)) return true;
	if (
		model.id.includes("gpt-5.2") ||
		model.id.includes("gpt-5.3") ||
		model.id.includes("gpt-5.4") ||
		model.id.includes("gpt-5.5") ||
		model.id.includes("gpt-5.6")
	) {
		return true;
	}

	const claude = claudeFamilyVersion(model.id);
	if (!claude) return false;
	if (claude.family === "opus") {
		return claude.major >= 5 || (claude.major === 4 && (claude.minor ?? 0) >= 6);
	}
	return claude.major >= 5;
}

/**
 * Check if a model uses adaptive thinking (Opus/Sonnet 4.6–4.x and Claude 5
 * families), where the `thinkingDisplay` option is honored. Mirrors the
 * per-provider internal checks.
 */
export function supportsAdaptiveThinking<TApi extends Api>(model: Model<TApi>): boolean {
	const claude = claudeFamilyVersion(model.id);
	return claude != null && (claude.major >= 5 || (claude.major === 4 && (claude.minor ?? 0) >= 6));
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
