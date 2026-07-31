/**
 * Kimi K3 auto context tier.
 *
 * The Kimi coding endpoint serves K3 under two model IDs:
 * - `k3-256k`: 256k context window (cheaper)
 * - `k3`:      1M context window (stated to consume 2x the quota)
 *
 * The pricing/quota terms are as stated by the Kimi team and not
 * independently verified, but they are the rationale for auto-switching:
 * 256k is still large enough for most tasks, so the first 256k of every
 * session can run on the cheaper model and only sessions that genuinely
 * outgrow it pay the 1M premium.
 *
 * `k3-256k` is exclusive to the Kimi for Coding OAuth endpoint — the
 * pay-per-token Moonshot AI Platform does not expose the cheaper variant —
 * so this applies solely to the `kimi-coding-oauth` provider.
 *
 * Per the Kimi backend team, switching from `k3-256k` to `k3` does not
 * invalidate the prompt cache — the cache seamlessly upgrades from 256k to
 * 1M. dreb therefore exposes a single user-selectable `k3` model and
 * automatically upgrades the wire model ID once the session context grows
 * past the 256k cutoff, avoiding context compaction on long-horizon tasks.
 *
 * The upgrade cutoff is the 256k window minus the DEFAULT compaction reserve,
 * i.e. the point where auto-compaction would trigger under default settings
 * for a 256k-window model. Users who lower their compaction threshold compact
 * before the cutoff is ever reached, which effectively disables the upgrade.
 */

import type { Api, Model } from "@dreb/ai";
import { DEFAULT_COMPACTION_SETTINGS } from "./compaction/compaction.js";

/** Provider and user-facing model ID the tier logic applies to. */
export const K3_PROVIDER = "kimi-coding-oauth";
export const K3_MODEL_ID = "k3";

/** Wire model ID sent while in the cheaper 256k tier. */
export const K3_256K_WIRE_MODEL_ID = "k3-256k";

/** Context window of the 256k tier. */
export const K3_256K_CONTEXT_WINDOW = 262144;

/** Context window of the 1M tier. */
export const K3_1M_CONTEXT_WINDOW = 1048576;

/**
 * Context token count at which the wire model ID upgrades from `k3-256k` to
 * `k3`: the 256k window minus the default compaction reserve.
 */
export const K3_UPGRADE_CUTOFF_TOKENS = K3_256K_CONTEXT_WINDOW - DEFAULT_COMPACTION_SETTINGS.reserveTokens;

/** Whether the model is the user-facing Kimi K3 model subject to auto context tiers. */
export function isK3Model(model: Model<any> | null | undefined): boolean {
	return model?.provider === K3_PROVIDER && model?.id === K3_MODEL_ID;
}

/** Whether the model is currently in the 256k tier (wire model ID `k3-256k`). */
export function isK3256kTier(model: Model<any> | null | undefined): boolean {
	return isK3Model(model) && model?.wireModelId === K3_256K_WIRE_MODEL_ID;
}

/**
 * Derive the effective model for the current context size.
 *
 * At or below the cutoff: 256k context window with wire model ID `k3-256k`.
 * Above the cutoff: 1M context window with the registry model ID `k3` sent
 * on the wire (the Kimi backend upgrades the cache seamlessly).
 *
 * Returns the input unchanged for non-K3 models and is idempotent for
 * already-derived models. A K3 model whose context window was customized
 * (e.g. a models.json override) is also returned unchanged — automatic
 * tiering never silently replaces user-configured limits.
 */
export function deriveK3ContextTierModel<TApi extends Api>(model: Model<TApi>, contextTokens: number): Model<TApi>;
export function deriveK3ContextTierModel<TApi extends Api>(
	model: Model<TApi> | undefined,
	contextTokens: number,
): Model<TApi> | undefined;
export function deriveK3ContextTierModel<TApi extends Api>(
	model: Model<TApi> | undefined,
	contextTokens: number,
): Model<TApi> | undefined {
	if (!model || !isK3Model(model)) return model;
	const isStock = model.contextWindow === K3_1M_CONTEXT_WINDOW && model.wireModelId === undefined;
	const isDerived256k = model.contextWindow === K3_256K_CONTEXT_WINDOW && model.wireModelId === K3_256K_WIRE_MODEL_ID;
	if (!isStock && !isDerived256k) return model;
	if (contextTokens > K3_UPGRADE_CUTOFF_TOKENS) {
		if (isStock) return model;
		const { wireModelId: _droppedWireModelId, ...rest } = model;
		return { ...rest, contextWindow: K3_1M_CONTEXT_WINDOW };
	}
	if (isDerived256k) return model;
	return { ...model, contextWindow: K3_256K_CONTEXT_WINDOW, wireModelId: K3_256K_WIRE_MODEL_ID };
}

/**
 * Whether the session should upgrade from the 256k tier to the 1M tier.
 * Only true while in the 256k tier and past the cutoff.
 */
export function shouldUpgradeK3Tier(model: Model<any> | null | undefined, contextTokens: number): boolean {
	return isK3256kTier(model) && contextTokens > K3_UPGRADE_CUTOFF_TOKENS;
}
