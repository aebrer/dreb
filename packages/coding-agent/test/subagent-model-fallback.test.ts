import type { Model } from "@dreb/ai";
import { describe, expect, test } from "vitest";
import {
	parseAgentFrontmatter,
	resolveModelStringSingle,
	resolveModelWithFallbacks,
} from "../src/core/tools/subagent.js";

/**
 * Tests for agent model fallback lists (issue 80).
 *
 * Tests the real parseAgentFrontmatter and resolveModelWithFallbacks functions
 * exported from subagent.ts.
 */

describe("model fallback lists", () => {
	describe("parseAgentFrontmatter — model parsing", () => {
		test("single model string", () => {
			const result = parseAgentFrontmatter("---\nname: test\nmodel: glm-5-turbo\n---\nprompt");
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.config.model).toBe("glm-5-turbo");
		});

		test("no model field", () => {
			const result = parseAgentFrontmatter("---\nname: test\ndescription: no model\n---\nprompt");
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.config.model).toBeUndefined();
		});

		test("comma-separated list", () => {
			const result = parseAgentFrontmatter("---\nname: test\nmodel: glm-5.1, claude-opus-4-6\n---\nprompt");
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.config.model).toEqual(["glm-5.1", "claude-opus-4-6"]);
		});

		test("comma-separated list with three models", () => {
			const result = parseAgentFrontmatter("---\nname: test\nmodel: glm-5.1, claude-opus-4-6, gpt-4o\n---\nprompt");
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.config.model).toEqual(["glm-5.1", "claude-opus-4-6", "gpt-4o"]);
		});

		test("single item comma-separated returns string", () => {
			const result = parseAgentFrontmatter("---\nname: test\nmodel: glm-5-turbo,\n---\nprompt");
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.config.model).toBe("glm-5-turbo");
		});

		test("YAML list syntax", () => {
			const result = parseAgentFrontmatter("---\nname: test\nmodel:\n  - glm-5.1\n  - claude-opus-4-6\n---\nprompt");
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.config.model).toEqual(["glm-5.1", "claude-opus-4-6"]);
		});

		test("YAML list with single item returns string", () => {
			const result = parseAgentFrontmatter("---\nname: test\nmodel:\n  - glm-5-turbo\n---\nprompt");
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.config.model).toBe("glm-5-turbo");
		});

		test("model with provider prefix", () => {
			const result = parseAgentFrontmatter(
				"---\nname: test\nmodel: anthropic/claude-opus-4-6, openai/gpt-4o\n---\nprompt",
			);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.config.model).toEqual(["anthropic/claude-opus-4-6", "openai/gpt-4o"]);
		});
	});

	describe("parseAgentFrontmatter — error paths", () => {
		test("missing frontmatter delimiters returns error", () => {
			const result = parseAgentFrontmatter("no delimiters here\njust text");
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain("missing --- frontmatter delimiters");
		});

		test("missing name field returns error", () => {
			const result = parseAgentFrontmatter("---\ndescription: no name\nmodel: glm-5-turbo\n---\nprompt");
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain("missing required 'name' field");
		});

		test("empty frontmatter returns error", () => {
			const result = parseAgentFrontmatter("---\n\n---\nprompt");
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain("missing required 'name' field");
		});
	});

	describe("parseAgentFrontmatter — full config", () => {
		test("parses all fields correctly", () => {
			const result = parseAgentFrontmatter(
				"---\nname: my-agent\ndescription: Does things\ntools: read, bash\nmodel: glm-5.1, sonnet\n---\nYou are a helpful agent.",
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.name).toBe("my-agent");
				expect(result.config.description).toBe("Does things");
				expect(result.config.tools).toBe("read, bash");
				expect(result.config.model).toEqual(["glm-5.1", "sonnet"]);
				expect(result.config.systemPrompt).toBe("You are a helpful agent.");
			}
		});
	});

	describe("resolveModelWithFallbacks — without registry", () => {
		// Without a registry, resolveModelWithFallbacks returns the model as-is
		test("single model resolves without registry", () => {
			const result = resolveModelWithFallbacks("glm-5.1", undefined, undefined);
			expect(result).toEqual({ ok: true, modelId: "glm-5.1" });
		});

		test("first model in list resolves without registry", () => {
			const result = resolveModelWithFallbacks(["glm-5.1", "gpt-4o"], undefined, undefined);
			expect(result).toEqual({ ok: true, modelId: "glm-5.1" });
		});

		test("string input treated as single-element list", () => {
			const result = resolveModelWithFallbacks("glm-5-turbo", undefined, undefined);
			expect(result).toEqual({ ok: true, modelId: "glm-5-turbo" });
		});
	});

	describe("resolveModelWithFallbacks — with registry", () => {
		const mockModels: Model<"anthropic-messages">[] = [
			{
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
			},
			{
				id: "gpt-4o",
				name: "GPT-4o",
				api: "anthropic-messages",
				provider: "openai",
				baseUrl: "https://api.openai.com",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		];

		// Registry without authStorage — existing tests remain unchanged
		const registry = {
			getAll: () => mockModels,
		} as unknown as Parameters<typeof resolveModelWithFallbacks>[2];

		test("known model resolves successfully", () => {
			const result = resolveModelWithFallbacks("claude-sonnet-4-5", "anthropic", registry);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.modelId).toBe("claude-sonnet-4-5");
				expect(result.provider).toBe("anthropic");
			}
		});

		test("unknown model with known provider fails (synthetic fallback rejected)", () => {
			const result = resolveModelStringSingle("nonexistent-model-xyz", "anthropic", registry);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("not found for provider");
			}
		});

		test("fallback to second model when first is unknown", () => {
			// First model is unknown for anthropic, second is a known model
			const result = resolveModelWithFallbacks(
				["nonexistent-model-xyz", "claude-sonnet-4-5"],
				"anthropic",
				registry,
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.modelId).toBe("claude-sonnet-4-5");
				expect(result.provider).toBe("anthropic");
			}
		});

		test("all models failing returns combined error", () => {
			const result = resolveModelWithFallbacks(["nonexistent-a", "nonexistent-b"], "anthropic", registry);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("None of the fallback models resolved");
				expect(result.error).toContain("nonexistent-a");
				expect(result.error).toContain("nonexistent-b");
			}
		});

		test("single unknown model returns specific error", () => {
			const result = resolveModelWithFallbacks("nonexistent-model", "anthropic", registry);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("not found for provider");
				// Should NOT contain "None of the fallback models" for single model
				expect(result.error).not.toContain("None of the fallback");
			}
		});
	});

	describe("resolveModelWithFallbacks — auth-aware fallback", () => {
		// Models from multiple providers, including a gateway model whose ID
		// contains a slash (simulates vercel-ai-gateway proxying zai models)
		const authModels: Model<"anthropic-messages">[] = [
			{
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
			},
			{
				id: "glm-5-turbo",
				name: "GLM-5 Turbo",
				api: "anthropic-messages",
				provider: "zai",
				baseUrl: "https://api.z.ai",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
			{
				// Gateway model whose ID literally contains "zai/" — this is the
				// model that resolveCliModel can match when "zai" isn't a known provider
				id: "zai/glm-5-turbo",
				name: "GLM-5 Turbo (via gateway)",
				api: "anthropic-messages",
				provider: "vercel-ai-gateway",
				baseUrl: "https://gateway.vercel.ai",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		];

		// Only anthropic has auth configured
		const authedProviders = new Set(["anthropic"]);
		const authRegistry = {
			getAll: () => authModels,
			authStorage: {
				hasAuth: (provider: string) => authedProviders.has(provider),
			},
		} as unknown as Parameters<typeof resolveModelWithFallbacks>[2];

		test("provider-prefixed model resolves when provider has auth", () => {
			const result = resolveModelStringSingle("anthropic/claude-sonnet-4-5", undefined, authRegistry);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.modelId).toBe("claude-sonnet-4-5");
				expect(result.provider).toBe("anthropic");
			}
		});

		test("provider-prefixed model fails when provider has no auth", () => {
			const result = resolveModelStringSingle("zai/glm-5-turbo", undefined, authRegistry);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("No authentication configured");
			}
		});

		test("fallback list skips unauthenticated provider and resolves to authenticated one", () => {
			const result = resolveModelWithFallbacks(
				["zai/glm-5-turbo", "anthropic/claude-sonnet-4-5"],
				undefined,
				authRegistry,
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.modelId).toBe("claude-sonnet-4-5");
				expect(result.provider).toBe("anthropic");
			}
		});

		test("gateway model ID clash resolved via auth check", () => {
			// "zai/glm-5-turbo" could match the vercel-ai-gateway model with that literal ID.
			// Either way (zai or gateway), neither has auth — fallback should continue.
			const result = resolveModelWithFallbacks(
				["zai/glm-5-turbo", "anthropic/claude-sonnet-4-5"],
				undefined,
				authRegistry,
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				// Must resolve to anthropic, not zai or vercel-ai-gateway
				expect(result.provider).toBe("anthropic");
			}
		});

		test("all unauthenticated providers returns error", () => {
			const result = resolveModelWithFallbacks(["zai/glm-5-turbo"], undefined, authRegistry);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("No authentication configured");
			}
		});

		test("bare model name with parentProvider still works (no authStorage regression)", () => {
			// Existing pattern: bare model name scoped to parent provider
			const result = resolveModelStringSingle("claude-sonnet-4-5", "anthropic", authRegistry);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.modelId).toBe("claude-sonnet-4-5");
				expect(result.provider).toBe("anthropic");
			}
		});

		test("registry without authStorage skips auth check (backward compat)", () => {
			// Old-style mock without authStorage — should still work
			const noAuthRegistry = {
				getAll: () => authModels,
			} as unknown as Parameters<typeof resolveModelWithFallbacks>[2];

			const result = resolveModelStringSingle("zai/glm-5-turbo", undefined, noAuthRegistry);
			// Without authStorage, the auth check is skipped — resolves successfully
			expect(result.ok).toBe(true);
		});
	});
});
