import { MODELS } from "./models.generated.js";
import type { Api, KnownProvider, Model, ThinkingLevel, Usage } from "./types.js";

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
	family: "opus" | "sonnet" | "haiku";
	major: number;
	minor?: number;
}

/** Parse Claude family versions without mistaking long date suffixes for versions. */
function claudeFamilyVersion(modelId: string): ClaudeFamilyVersion | undefined {
	const match = modelId.match(/(opus|sonnet|haiku)-(\d{1,2})(?:[.-](\d{1,2}))?(?!\d)/);
	if (!match) return undefined;
	return {
		family: match[1] as ClaudeFamilyVersion["family"],
		major: Number.parseInt(match[2], 10),
		minor: match[3] === undefined ? undefined : Number.parseInt(match[3], 10),
	};
}

/** True when a parsed Claude version is at least `major.minor`. */
function claudeAtLeast(claude: ClaudeFamilyVersion, major: number, minor = 0): boolean {
	return claude.major > major || (claude.major === major && (claude.minor ?? 0) >= minor);
}

/**
 * Anthropic-native transports, where dreb controls the Anthropic `thinking` /
 * `output_config.effort` request fields directly: the Anthropic Messages API
 * (Anthropic, GitHub Copilot's `/v1/messages`, opencode, custom Anthropic-compatible
 * endpoints) and Amazon Bedrock. Claude served through OpenAI-compatible APIs
 * (OpenRouter, Copilot Fable, ...) keeps the legacy capability rules because those
 * transports map effort themselves.
 */
function isAnthropicNativeTransport<TApi extends Api>(model: Model<TApi>): boolean {
	return model.api === "anthropic-messages" || model.api === "bedrock-converse-stream";
}

/** Claude model on an Anthropic-native transport, or undefined. */
function nativeClaude<TApi extends Api>(model: Model<TApi>): ClaudeFamilyVersion | undefined {
	return isAnthropicNativeTransport(model) ? claudeFamilyVersion(model.id) : undefined;
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
 * Check if a model supports the native `max` reasoning tier.
 *
 * Supported today:
 * - GPT-5.6 model families (Sol, Terra, Luna, and the alias)
 * - GPT-6 model families (Astra and future variants)
 * - On Anthropic-native transports (Anthropic Messages, including GitHub Copilot, and
 *   Bedrock): Claude Opus/Sonnet 4.6+ (including the Claude 5 families) and Haiku 5.5+
 *
 * A model's advertised `reasoningEfforts` (provider discovery) take precedence.
 */
export function supportsMax<TApi extends Api>(model: Model<TApi>): boolean {
	if (model.reasoningEfforts) return model.reasoningEfforts.includes("max");
	const id = model.id.toLowerCase();
	// Anchored to the id start or a gateway "/" prefix so unrelated ids
	// (e.g. "gpt-60") do not match.
	if (/(?:^|\/)gpt-5\.6(?:$|[-.])/.test(id) || /(?:^|\/)gpt-6(?:$|[-.])/.test(id)) return true;

	const claude = nativeClaude(model);
	if (!claude) return false;
	if (claude.family === "haiku") return claudeAtLeast(claude, 5, 5);
	return claudeAtLeast(claude, 4, 6);
}

/**
 * Check if a model supports xhigh thinking level.
 *
 * Supported today:
 * - GPT-5.2 through GPT-5.6 model families
 * - GPT-6 model families (Astra and future variants)
 * - Claude on Anthropic-native transports: Opus 4.7+, Sonnet 5+, Haiku 5.5+
 *   (Opus 4.6 and Sonnet 4.6 have `max` but no native `xhigh`)
 * - Claude on OpenAI-compatible transports (OpenRouter, ...): Opus 4.6+ and Sonnet 5+
 *   (the legacy rule; those transports map effort themselves)
 * - Kimi Code K3 (xhigh maps to its advertised "max" effort)
 * - Qwen 3.8+ model families (xhigh is their top native effort tier)
 *
 * A model's advertised `reasoningEfforts` (provider discovery) take precedence.
 */
export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
	if (model.reasoningEfforts) return model.reasoningEfforts.includes("xhigh");
	if (model.provider === "kimi-coding-oauth" && model.id === "k3") return true;
	if (isQwen38OrLater(model.id)) return true;
	if (
		model.id.includes("gpt-5.2") ||
		model.id.includes("gpt-5.3") ||
		model.id.includes("gpt-5.4") ||
		model.id.includes("gpt-5.5") ||
		model.id.includes("gpt-5.6") ||
		model.id.includes("gpt-6")
	) {
		return true;
	}

	const claude = claudeFamilyVersion(model.id);
	if (!claude) return false;
	if (isAnthropicNativeTransport(model)) {
		if (claude.family === "opus") return claudeAtLeast(claude, 4, 7);
		if (claude.family === "sonnet") return claudeAtLeast(claude, 5);
		return claudeAtLeast(claude, 5, 5);
	}
	// Legacy rule for proxied Claude transports (unchanged; Haiku never qualified).
	if (claude.family === "opus") return claudeAtLeast(claude, 4, 6);
	if (claude.family === "sonnet") return claudeAtLeast(claude, 5);
	return false;
}

/**
 * Check if a model uses adaptive thinking (Opus/Sonnet 4.6+, Haiku 5+, including the
 * Claude 5 families), where `output_config.effort` and the `thinkingDisplay` option
 * are honored. Mirrors the per-provider internal checks.
 */
export function supportsAdaptiveThinking<TApi extends Api>(model: Model<TApi>): boolean {
	const claude = claudeFamilyVersion(model.id);
	if (!claude) return false;
	if (claude.family === "haiku") return claudeAtLeast(claude, 5);
	return claudeAtLeast(claude, 4, 6);
}

/**
 * Check whether thinking can be turned off for a model (dreb level `off`).
 *
 * False only for Claude Opus 5.5+ on Anthropic-native transports, where adaptive
 * thinking is always on and `thinking: {type: "disabled"}` is rejected. Callers that
 * offer selectable levels should hide `off` for such models; {@link clampThinkingLevel}
 * maps a requested `off` to `minimal`.
 */
export function supportsThinkingOff<TApi extends Api>(model: Model<TApi>): boolean {
	const claude = nativeClaude(model);
	return !(claude?.family === "opus" && claudeAtLeast(claude, 5, 5));
}

/** How a request turns Claude thinking off on an Anthropic-native transport. */
export type ClaudeThinkingOffMode = "disabled" | "between_tools" | "omit";

/**
 * Select the request shape that turns thinking off for a Claude model:
 * - `"omit"`: send neither a `thinking` field nor an effort (Opus 5.5+, where thinking
 *   cannot be disabled; the model default effort applies)
 * - `"between_tools"`: `thinking: {type: "between_tools"}` (Sonnet 5.5+, where
 *   `disabled` is rejected)
 * - `"disabled"`: `thinking: {type: "disabled"}` (every other model, and every model on
 *   non-native transports)
 */
export function getClaudeThinkingOffMode<TApi extends Api>(model: Model<TApi>): ClaudeThinkingOffMode {
	const claude = nativeClaude(model);
	if (!claude) return "disabled";
	if (claude.family === "opus" && claudeAtLeast(claude, 5, 5)) return "omit";
	if (claude.family === "sonnet" && claudeAtLeast(claude, 5, 5)) return "between_tools";
	return "disabled";
}

/**
 * Check whether a Claude model thinks by default when a request omits the `thinking`
 * field (the Claude 5 generation). Transports that otherwise omit the field to turn
 * thinking off (Bedrock) must send an explicit off config for these models.
 */
export function claudeThinksByDefault<TApi extends Api>(model: Model<TApi>): boolean {
	const claude = claudeFamilyVersion(model.id);
	return claude !== undefined && claude.major >= 5;
}

/**
 * Clamp a requested thinking level to what a model supports. This is the single
 * source of truth for thinking-level fallback across dreb:
 * - non-reasoning models → `off`
 * - `off` on models where thinking cannot be turned off → `minimal`
 * - unsupported `xhigh` → `max` when the model has `max` (Opus/Sonnet 4.6), else `high`
 * - unsupported `max` → `xhigh` when supported, else `high`
 */
export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi> | undefined,
	level: ThinkingLevel | "off",
): ThinkingLevel | "off" {
	if (!model?.reasoning) return "off";
	switch (level) {
		case "off":
			return supportsThinkingOff(model) ? "off" : "minimal";
		case "xhigh":
			if (supportsXhigh(model)) return "xhigh";
			return supportsMax(model) ? "max" : "high";
		case "max":
			if (supportsMax(model)) return "max";
			return supportsXhigh(model) ? "xhigh" : "high";
		default:
			return level;
	}
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
