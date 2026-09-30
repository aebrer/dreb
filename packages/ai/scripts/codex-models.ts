import type { Model } from "../src/types.js";

// models.dev does not track the Codex surface (chatgpt.com backend-api + ChatGPT OAuth),
// so we derive it from the OpenAI Platform catalog: every frontier GPT model (5.5+, plus
// the gpt-daybreak-* previews) is mirrored onto openai-codex. This keeps Codex in sync
// with new OpenAI releases automatically. Availability of a given model on Codex depends
// on the user's ChatGPT plan/workspace (enterprise workspaces enable models later), so we
// do not filter by what one account can reach.
// Excluded: -pro / -mini / -nano / -chat* / -codex* variants (not Codex-surface models),
// dated snapshots, and bare family ids (e.g. gpt-5.6) when Codex-eligible named variants
// (sol/terra/luna) exist.
// Context: all Codex models use 272k, matching Codex CLI's default context_window and Pi.
// The models support ~1M, but prompts above 272k input are billed at 2x input / 1.5x output.
// Users can raise it per model via modelOverrides in models.json.
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const CODEX_CONTEXT = 272000;
export const CODEX_MAX_TOKENS = 128000;
/** Older models still served on Codex that fall outside the derivation rule. */
export const CODEX_EXTRA_IDS = ["gpt-5.4-mini"];
/**
 * Codex models that must survive derivation. If the OpenAI catalog drops or renames any of
 * these, generation fails loudly instead of silently shrinking the Codex list. Removing a
 * model from Codex therefore requires an explicit edit here.
 */
export const CODEX_EXPECTED_IDS = [
	...CODEX_EXTRA_IDS,
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-daybreak-blue-latest",
	"gpt-daybreak-red-latest",
];

const CODEX_EXCLUDED_SUFFIX = /-(pro|mini|nano|chat|codex|spark|realtime|audio|search)(-|$)/;

export function isCodexFrontier(id: string): boolean {
	if (CODEX_EXTRA_IDS.includes(id)) return true;
	if (/^gpt-daybreak-[a-z]+-latest$/.test(id)) return true;
	const m = /^gpt-(\d+)(?:\.(\d+))?(-[a-z]+)?$/.exec(id);
	if (!m || CODEX_EXCLUDED_SUFFIX.test(id)) return false;
	const version = Number(m[1]) + Number(m[2] ?? 0) / 10;
	return version >= 5.5;
}

/**
 * Derive the openai-codex model list from OpenAI Platform catalog entries.
 * Throws if an expected model is missing or a source entry lacks the limits Codex needs.
 */
export function deriveCodexModels(
	openaiModels: Model<any>[],
	expectedIds: readonly string[] = CODEX_EXPECTED_IDS,
): Model<"openai-codex-responses">[] {
	const eligible = openaiModels.filter((m) => m.provider === "openai" && isCodexFrontier(m.id));
	const eligibleIds = new Set(eligible.map((m) => m.id));
	// A bare family id (gpt-5.6) is dropped only when a Codex-eligible named variant exists;
	// dated snapshots and excluded variants do not count.
	const hasNamedVariants = (id: string): boolean =>
		[...eligibleIds].some((other) => other.startsWith(`${id}-`));
	const codexModels = eligible
		.filter((m) => !(/^gpt-\d+(\.\d+)?$/.test(m.id) && hasNamedVariants(m.id)))
		.map((m): Model<"openai-codex-responses"> => {
			if (m.contextWindow < CODEX_CONTEXT || m.maxTokens < CODEX_MAX_TOKENS) {
				throw new Error(
					`openai-codex derivation: ${m.id} has catalog limits ${m.contextWindow}/${m.maxTokens}, ` +
						`below Codex ${CODEX_CONTEXT}/${CODEX_MAX_TOKENS} — missing or changed models.dev metadata?`,
				);
			}
			return {
				id: m.id,
				name: m.name,
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: CODEX_BASE_URL,
				reasoning: true,
				input: ["text", "image"],
				cost: { ...m.cost },
				contextWindow: CODEX_CONTEXT,
				maxTokens: CODEX_MAX_TOKENS,
			};
		});
	for (const id of expectedIds) {
		if (!codexModels.some((m) => m.id === id)) {
			throw new Error(`openai-codex derivation lost expected model ${id} — OpenAI catalog changed?`);
		}
	}
	return codexModels;
}
