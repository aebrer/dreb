import type { Model } from "@dreb/ai";
import { describe, expect, test } from "vitest";
import { resolveModelStringSingle, resolveModelWithFallbacks } from "../src/core/tools/subagent.js";

/**
 * Tests for mid-session provider switching (issue 76).
 *
 * Verifies that the lazy `parentProvider` getter pattern works correctly:
 * the subagent tool should read the current provider at each invocation,
 * not a stale value captured at construction time.
 */

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const zaiModel: Model<"anthropic-messages"> = {
	id: "glm-5-turbo",
	name: "GLM-5 Turbo",
	api: "anthropic-messages",
	provider: "z.ai",
	baseUrl: "https://api.z.ai",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 },
	contextWindow: 128000,
	maxTokens: 8192,
};

const registry = {
	getAll: () => [anthropicModel, zaiModel],
} as unknown as Parameters<typeof resolveModelWithFallbacks>[2];

describe("mid-session provider switch (issue 76)", () => {
	describe("resolveModelStringSingle respects current provider", () => {
		test("resolves anthropic model when provider is anthropic", () => {
			const result = resolveModelStringSingle("claude-sonnet-4-5", "anthropic", registry);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.modelId).toBe("claude-sonnet-4-5");
				expect(result.provider).toBe("anthropic");
			}
		});

		test("resolves z.ai model when provider is z.ai", () => {
			const result = resolveModelStringSingle("glm-5-turbo", "z.ai", registry);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.modelId).toBe("glm-5-turbo");
				expect(result.provider).toBe("z.ai");
			}
		});

		test("fails to resolve z.ai model when provider is anthropic", () => {
			const result = resolveModelStringSingle("glm-5-turbo", "anthropic", registry);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("not found for provider");
			}
		});

		test("fails to resolve anthropic model when provider is z.ai", () => {
			const result = resolveModelStringSingle("claude-sonnet-4-5", "z.ai", registry);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("not found for provider");
			}
		});
	});

	describe("lazy parentProvider getter pattern", () => {
		test("getter returns fresh value after simulated model switch", () => {
			// Simulate the mutable session state
			let currentProvider: string | undefined = "anthropic";
			const getParentProvider = () => currentProvider;

			// Before switch: resolves against anthropic
			const before = resolveModelWithFallbacks("claude-sonnet-4-5", getParentProvider(), registry);
			expect(before.ok).toBe(true);
			if (before.ok) expect(before.provider).toBe("anthropic");

			// Simulate mid-session model switch
			currentProvider = "z.ai";

			// After switch: resolves against z.ai
			const after = resolveModelWithFallbacks("glm-5-turbo", getParentProvider(), registry);
			expect(after.ok).toBe(true);
			if (after.ok) expect(after.provider).toBe("z.ai");
		});

		test("static capture would fail after provider switch", () => {
			// This demonstrates the bug: capturing the provider as a string at init time
			const capturedProvider = "anthropic"; // frozen at init

			// After switching to z.ai, trying to resolve a z.ai model against
			// the stale "anthropic" provider fails
			const result = resolveModelWithFallbacks("glm-5-turbo", capturedProvider, registry);
			expect(result.ok).toBe(false);
		});

		test("getter handles undefined provider (no model set)", () => {
			const getParentProvider = () => undefined;

			// Without a provider constraint, resolution should still work
			// (matches any provider in registry)
			const result = resolveModelWithFallbacks("glm-5-turbo", getParentProvider(), registry);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.modelId).toBe("glm-5-turbo");
		});
	});

	describe("fallback list with provider switch", () => {
		test("fallback list resolves correctly after provider switch", () => {
			const currentProvider: string | undefined = "z.ai";
			const getParentProvider = () => currentProvider;

			// With z.ai provider, anthropic model fails but z.ai model succeeds
			const result = resolveModelWithFallbacks(["claude-sonnet-4-5", "glm-5-turbo"], getParentProvider(), registry);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.modelId).toBe("glm-5-turbo");
				expect(result.provider).toBe("z.ai");
			}
		});
	});
});
