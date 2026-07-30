import type { Model } from "@dreb/ai";
import { describe, expect, it } from "vitest";
import {
	deriveK3ContextTierModel,
	isK3Model,
	isK3256kTier,
	K3_1M_CONTEXT_WINDOW,
	K3_256K_CONTEXT_WINDOW,
	K3_256K_WIRE_MODEL_ID,
	K3_UPGRADE_CUTOFF_TOKENS,
	shouldUpgradeK3Tier,
} from "../src/core/k3-context-tier.js";

function k3Model(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "k3",
		name: "Kimi K3",
		api: "openai-completions",
		provider: "kimi-coding-oauth",
		baseUrl: "https://api.kimi.com/coding/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: K3_1M_CONTEXT_WINDOW,
		maxTokens: 32768,
		...overrides,
	};
}

describe("k3-context-tier", () => {
	it("anchors the upgrade cutoff to the default compaction threshold of the 256k window", () => {
		expect(K3_256K_CONTEXT_WINDOW).toBe(262144);
		expect(K3_1M_CONTEXT_WINDOW).toBe(1048576);
		expect(K3_UPGRADE_CUTOFF_TOKENS).toBe(262144 - 16384);
	});

	it("identifies only the user-facing kimi-coding-oauth k3 model", () => {
		expect(isK3Model(k3Model())).toBe(true);
		expect(isK3Model(k3Model({ id: "kimi-for-coding" }))).toBe(false);
		expect(isK3Model(k3Model({ provider: "kimi-coding" as Model<"openai-completions">["provider"] }))).toBe(false);
		expect(isK3Model(undefined)).toBe(false);
	});

	it("passes non-K3 models through unchanged", () => {
		const other = k3Model({ id: "kimi-for-coding", contextWindow: 262144 });
		expect(deriveK3ContextTierModel(other, 0)).toBe(other);
		expect(deriveK3ContextTierModel(other, K3_UPGRADE_CUTOFF_TOKENS + 1)).toBe(other);
		expect(shouldUpgradeK3Tier(other, K3_UPGRADE_CUTOFF_TOKENS + 1)).toBe(false);
	});

	it("derives the 256k tier for small contexts", () => {
		const derived = deriveK3ContextTierModel(k3Model(), 1000);
		expect(derived.id).toBe("k3");
		expect(derived.wireModelId).toBe(K3_256K_WIRE_MODEL_ID);
		expect(derived.contextWindow).toBe(K3_256K_CONTEXT_WINDOW);
		expect(isK3256kTier(derived)).toBe(true);
	});

	it("derives the 1M tier past the cutoff", () => {
		const derived = deriveK3ContextTierModel(k3Model(), K3_UPGRADE_CUTOFF_TOKENS + 1);
		expect(derived.id).toBe("k3");
		expect(derived.wireModelId).toBeUndefined();
		expect(derived.contextWindow).toBe(K3_1M_CONTEXT_WINDOW);
		expect(isK3256kTier(derived)).toBe(false);
	});

	it("treats the cutoff as inclusive of the cheaper tier", () => {
		const atCutoff = deriveK3ContextTierModel(k3Model(), K3_UPGRADE_CUTOFF_TOKENS);
		expect(isK3256kTier(atCutoff)).toBe(true);
		expect(shouldUpgradeK3Tier(atCutoff, K3_UPGRADE_CUTOFF_TOKENS)).toBe(false);
	});

	it("upgrades a derived 256k-tier model to the 1M tier", () => {
		const tier256k = deriveK3ContextTierModel(k3Model(), 0);
		expect(shouldUpgradeK3Tier(tier256k, K3_UPGRADE_CUTOFF_TOKENS + 1)).toBe(true);

		const upgraded = deriveK3ContextTierModel(tier256k, K3_UPGRADE_CUTOFF_TOKENS + 1);
		expect(upgraded.wireModelId).toBeUndefined();
		expect(upgraded.contextWindow).toBe(K3_1M_CONTEXT_WINDOW);
	});

	it("does not upgrade the 1M tier or other models", () => {
		const tier1m = deriveK3ContextTierModel(k3Model(), K3_UPGRADE_CUTOFF_TOKENS + 1);
		expect(shouldUpgradeK3Tier(tier1m, K3_UPGRADE_CUTOFF_TOKENS + 1)).toBe(false);
		expect(shouldUpgradeK3Tier(undefined, K3_UPGRADE_CUTOFF_TOKENS + 1)).toBe(false);
	});

	it("derives the 256k tier again when context drops below the cutoff (fresh session / post-compaction)", () => {
		const tier1m = deriveK3ContextTierModel(k3Model(), K3_UPGRADE_CUTOFF_TOKENS + 1);
		const redegraded = deriveK3ContextTierModel(tier1m, 5000);
		expect(redegraded.wireModelId).toBe(K3_256K_WIRE_MODEL_ID);
		expect(redegraded.contextWindow).toBe(K3_256K_CONTEXT_WINDOW);
	});

	it("is idempotent for already-derived models", () => {
		const once256k = deriveK3ContextTierModel(k3Model(), 0);
		expect(deriveK3ContextTierModel(once256k, 0)).toBe(once256k);

		const once1m = deriveK3ContextTierModel(k3Model(), K3_UPGRADE_CUTOFF_TOKENS + 1);
		expect(deriveK3ContextTierModel(once1m, K3_UPGRADE_CUTOFF_TOKENS + 1)).toBe(once1m);
	});

	it("passes undefined through", () => {
		expect(deriveK3ContextTierModel(undefined, 0)).toBeUndefined();
	});

	it("never replaces a user-customized context window (models.json override)", () => {
		const overridden = k3Model({ contextWindow: 131072 });
		expect(deriveK3ContextTierModel(overridden, 0)).toBe(overridden);
		expect(deriveK3ContextTierModel(overridden, K3_UPGRADE_CUTOFF_TOKENS + 1)).toBe(overridden);
		expect(shouldUpgradeK3Tier(overridden, K3_UPGRADE_CUTOFF_TOKENS + 1)).toBe(false);
	});

	it("resumes tiering after a derived model returns to the stock 1M shape", () => {
		const tier256k = deriveK3ContextTierModel(k3Model(), 0);
		const backTo1m = deriveK3ContextTierModel(tier256k, K3_UPGRADE_CUTOFF_TOKENS + 1);
		// The 1M tier is the stock shape again, so a fresh derivation keeps working.
		const redegraded = deriveK3ContextTierModel(backTo1m, 100);
		expect(redegraded.wireModelId).toBe(K3_256K_WIRE_MODEL_ID);
	});
});
