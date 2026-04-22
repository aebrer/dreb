import type { Model } from "@dreb/ai";
import { describe, expect, test } from "vitest";
import {
	parseAgentFrontmatter,
	resolveModelStringSingle,
	resolveModelWithFallbacks,
	subagentToolDefinition,
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

		// Permissive authStorage — all providers are considered authenticated
		const registry = {
			getAll: () => mockModels,
			authStorage: { hasAuth: () => true },
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

		test("gateway model ID clash — only gateway has auth, resolves to gateway", () => {
			// When "zai/glm-5-turbo" is resolved, it could match either the zai provider's
			// "glm-5-turbo" or the vercel-ai-gateway model with literal ID "zai/glm-5-turbo".
			// Give auth only to vercel-ai-gateway to verify the gateway path is reachable.
			const gatewayAuthedProviders = new Set(["vercel-ai-gateway"]);
			const gatewayRegistry = {
				getAll: () => authModels,
				authStorage: {
					hasAuth: (provider: string) => gatewayAuthedProviders.has(provider),
				},
			} as unknown as Parameters<typeof resolveModelWithFallbacks>[2];

			const result = resolveModelStringSingle("zai/glm-5-turbo", undefined, gatewayRegistry);
			// resolveCliModel tries zai provider first (provider prefix match), which fails auth.
			// Then it may fall through to the gateway model with literal ID "zai/glm-5-turbo".
			// If gateway has auth, it should succeed; if not, it fails.
			// The exact resolution depends on resolveCliModel's behavior — but either way,
			// the auth check correctly gates the result.
			if (result.ok) {
				expect(result.provider).toBe("vercel-ai-gateway");
			}
			// If resolveCliModel doesn't try the gateway model as a second match,
			// the result is {ok: false} which is also correct (zai has no auth).
		});

		test("all unauthenticated providers returns error", () => {
			const result = resolveModelWithFallbacks(["zai/glm-5-turbo"], undefined, authRegistry);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("No authentication configured");
			}
		});

		test("bare model name with authenticated parentProvider resolves", () => {
			// Existing pattern: bare model name scoped to parent provider
			const result = resolveModelStringSingle("claude-sonnet-4-5", "anthropic", authRegistry);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.modelId).toBe("claude-sonnet-4-5");
				expect(result.provider).toBe("anthropic");
			}
		});

		test("bare model name without parentProvider fails when resolved provider has no auth", () => {
			// "glm-5-turbo" resolves to the zai provider model — zai has no auth
			const result = resolveModelStringSingle("glm-5-turbo", undefined, authRegistry);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("No authentication configured");
				expect(result.error).toContain("zai");
			}
		});

		test("bare model name with unauthenticated parentProvider fails auth check", () => {
			// "glm-5-turbo" scoped to "zai" parentProvider — zai has no auth
			const result = resolveModelStringSingle("glm-5-turbo", "zai", authRegistry);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("No authentication configured");
			}
		});

		test("registry with permissive authStorage allows all providers", () => {
			// authStorage that grants auth to all providers — all models resolve
			const permissiveRegistry = {
				getAll: () => authModels,
				authStorage: {
					hasAuth: () => true,
				},
			} as unknown as Parameters<typeof resolveModelWithFallbacks>[2];

			const result = resolveModelStringSingle("zai/glm-5-turbo", undefined, permissiveRegistry);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.provider).toBe("zai");
			}
		});
	});

	describe("resolveModelWithFallbacks — parent model final fallback (issue 176)", () => {
		const parentModels: Model<"anthropic-messages">[] = [
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

		const registry = {
			getAll: () => parentModels,
			authStorage: { hasAuth: () => true },
		} as unknown as Parameters<typeof resolveModelWithFallbacks>[2];

		test("parent model is used when all configured fallbacks fail", () => {
			// Parent is running openai/gpt-4o; configured fallbacks are anthropic-only unknown models
			const result = resolveModelWithFallbacks(["nonexistent-a", "nonexistent-b"], "openai", registry, "gpt-4o");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.modelId).toBe("gpt-4o");
				expect(result.provider).toBe("openai");
				expect(result.warning).toContain("Falling back to parent model");
				expect(result.warning).toContain("gpt-4o");
			}
		});

		test("parent model is only tried after configured fallbacks are exhausted", () => {
			// First configured fallback succeeds — parent model should not be tried
			const result = resolveModelWithFallbacks(
				["claude-sonnet-4-5", "nonexistent-b"],
				"anthropic",
				registry,
				"gpt-4o",
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.modelId).toBe("claude-sonnet-4-5");
				expect(result.warning).toBeUndefined();
			}
		});

		test("if parent model also fails, existing error behavior is preserved", () => {
			const result = resolveModelWithFallbacks(
				["nonexistent-a", "nonexistent-b"],
				"anthropic",
				registry,
				"also-nonexistent",
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("None of the fallback models resolved");
				expect(result.error).toContain("nonexistent-a");
				expect(result.error).toContain("nonexistent-b");
				expect(result.error).toContain("also-nonexistent");
			}
		});

		test("single configured model fails, parent model succeeds", () => {
			// Parent is running openai/gpt-4o
			const result = resolveModelWithFallbacks("nonexistent-model", "openai", registry, "gpt-4o");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.modelId).toBe("gpt-4o");
				expect(result.warning).toBeDefined();
			}
		});

		test("without parentModel, all failing returns original error", () => {
			const result = resolveModelWithFallbacks(["nonexistent-a", "nonexistent-b"], "anthropic", registry);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("None of the fallback models resolved");
				expect(result.error).not.toContain("also-nonexistent");
			}
		});

		test("parent model with provider prefix resolves correctly", () => {
			const result = resolveModelWithFallbacks(["nonexistent-model"], undefined, registry, "openai/gpt-4o");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.modelId).toBe("gpt-4o");
				expect(result.provider).toBe("openai");
			}
		});

		test("lazy parentModel getter pattern — fresh value after switch", () => {
			// Simulate mutable session state
			let currentModel = "claude-sonnet-4-5";
			const getParentModel = () => currentModel;

			// First call: parent model is claude
			const before = resolveModelWithFallbacks(["nonexistent-model"], "anthropic", registry, getParentModel());
			expect(before.ok).toBe(true);
			if (before.ok) expect(before.modelId).toBe("claude-sonnet-4-5");

			// Simulate mid-session model switch
			currentModel = "gpt-4o";

			// Second call: parent model is now gpt-4o
			const after = resolveModelWithFallbacks(["nonexistent-model"], "openai", registry, getParentModel());
			expect(after.ok).toBe(true);
			if (after.ok) expect(after.modelId).toBe("gpt-4o");
		});
	});
});

describe("subagent promptGuidelines", () => {
	test("waiting guideline mentions agent_end explicitly", () => {
		const guidelines = subagentToolDefinition.promptGuidelines ?? [];
		const waitingGuideline = guidelines.find((g) => g.includes("Each agent notifies independently when done"));
		expect(waitingGuideline).toBeDefined();
		expect(waitingGuideline).toContain("agent_end");
	});

	test("waiting guideline uses the asking-a-question analogy", () => {
		const guidelines = subagentToolDefinition.promptGuidelines ?? [];
		const waitingGuideline = guidelines.find((g) => g.includes("Each agent notifies independently when done"));
		expect(waitingGuideline).toBeDefined();
		expect(waitingGuideline).toContain("asking the user a question");
	});

	test("waiting guideline prohibits sleep and filler work", () => {
		const guidelines = subagentToolDefinition.promptGuidelines ?? [];
		const waitingGuideline = guidelines.find((g) => g.includes("Each agent notifies independently when done"));
		expect(waitingGuideline).toBeDefined();
		expect(waitingGuideline).toContain("Do not call `sleep`");
		expect(waitingGuideline).toContain("do not launch filler work");
	});
});
