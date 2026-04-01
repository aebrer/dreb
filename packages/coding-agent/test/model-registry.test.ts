import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model, OpenAICompletionsCompat } from "@dreb/ai";
import { getApiProvider, getModels, getProviders } from "@dreb/ai";
import { getOAuthProvider } from "@dreb/ai/oauth";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { clearApiKeyCache, ModelRegistry } from "../src/core/model-registry.js";

describe("ModelRegistry", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `dreb-test-model-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearApiKeyCache();
	});

	/** Create minimal provider config  */
	function providerConfig(
		baseUrl: string,
		models: Array<{ id: string; name?: string }>,
		api: string = "anthropic-messages",
	) {
		return {
			baseUrl,
			apiKey: "TEST_KEY",
			api,
			models: models.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 8000,
			})),
		};
	}

	function writeModelsJson(providers: Record<string, ReturnType<typeof providerConfig>>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function getModelsForProvider(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter((m) => m.provider === provider);
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	/** Create a baseUrl-only override (no custom models) */
	function overrideConfig(baseUrl: string, headers?: Record<string, string>) {
		return { baseUrl, ...(headers && { headers }) };
	}

	/** Write raw providers config (for mixed override/replacement scenarios) */
	function writeRawModelsJson(providers: Record<string, unknown>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	const openAiModel: Model<Api> = {
		id: "test-openai-model",
		name: "Test OpenAI Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};

	const emptyContext: Context = {
		messages: [],
	};

	describe("baseUrl override (no custom models)", () => {
		test("overriding baseUrl keeps all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// Should have multiple built-in models, not just one
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("overriding baseUrl changes URL on all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// All models should have the new baseUrl
			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://my-proxy.example.com/v1");
			}
		});

		test("overriding headers merges with model headers", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1", {
					"X-Custom-Header": "custom-value",
				}),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				expect(model.headers?.["X-Custom-Header"]).toBe("custom-value");
			}
		});

		test("baseUrl-only override does not affect other providers", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const googleModels = getModelsForProvider(registry, "google");

			// Google models should still have their original baseUrl
			expect(googleModels.length).toBeGreaterThan(0);
			expect(googleModels[0].baseUrl).not.toBe("https://my-proxy.example.com/v1");
		});

		test("can mix baseUrl override and models merge", () => {
			writeRawModelsJson({
				// baseUrl-only for anthropic
				anthropic: overrideConfig("https://anthropic-proxy.example.com/v1"),
				// Add custom model for google (merged with built-ins)
				google: providerConfig(
					"https://google-proxy.example.com/v1",
					[{ id: "gemini-custom" }],
					"google-generative-ai",
				),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			// Anthropic: multiple built-in models with new baseUrl
			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels[0].baseUrl).toBe("https://anthropic-proxy.example.com/v1");

			// Google: built-ins plus custom model
			const googleModels = getModelsForProvider(registry, "google");
			expect(googleModels.length).toBeGreaterThan(1);
			expect(googleModels.some((m) => m.id === "gemini-custom")).toBe(true);
		});

		test("refresh() picks up baseUrl override changes", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://first-proxy.example.com/v1"),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://first-proxy.example.com/v1");

			// Update and refresh
			writeRawModelsJson({
				anthropic: overrideConfig("https://second-proxy.example.com/v1"),
			});
			registry.refresh();

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://second-proxy.example.com/v1");
		});
	});

	describe("custom models merge behavior", () => {
		test("custom provider with same name as built-in merges with built-in models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some((m) => m.id === "claude-custom")).toBe(true);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("custom model with same id replaces built-in model by id", () => {
			writeModelsJson({
				openrouter: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: "anthropic/claude-sonnet-4" }],
					"openai-completions",
				),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnetModels = models.filter((m) => m.id === "anthropic/claude-sonnet-4");

			expect(sonnetModels).toHaveLength(1);
			expect(sonnetModels[0].baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom provider with same name as built-in does not affect other built-in providers", () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "google").length).toBeGreaterThan(0);
			expect(getModelsForProvider(registry, "openai").length).toBeGreaterThan(0);
		});

		test("provider-level baseUrl applies to both built-in and custom models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://merged-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://merged-proxy.example.com/v1");
			}
		});

		test("provider-level compat applies to custom models", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(false);
			expect(compat?.maxTokensField).toBe("max_tokens");
		});

		test("model-level compat overrides provider-level compat for custom models", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								supportsUsageInStreaming: true,
								maxTokensField: "max_completion_tokens",
							},
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(true);
			expect(compat?.maxTokensField).toBe("max_completion_tokens");
		});

		test("provider-level compat applies to built-in models", () => {
			writeRawModelsJson({
				openrouter: {
					compat: {
						supportsUsageInStreaming: false,
						supportsStrictMode: false,
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				const compat = model.compat as OpenAICompletionsCompat | undefined;
				expect(compat?.supportsUsageInStreaming).toBe(false);
				expect(compat?.supportsStrictMode).toBe(false);
			}
		});

		test("compat schema accepts reasoningEffortMap and supportsStrictMode", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								reasoningEffortMap: {
									minimal: "default",
									high: "max",
								},
								supportsStrictMode: false,
							},
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(compat?.reasoningEffortMap).toEqual({ minimal: "default", high: "max" });
			expect(compat?.supportsStrictMode).toBe(false);
		});

		test("model-level baseUrl overrides provider-level baseUrl for custom models", () => {
			writeRawModelsJson({
				"opencode-go": {
					baseUrl: "https://opencode.ai/zen/go/v1",
					apiKey: "TEST_KEY",
					models: [
						{
							id: "minimax-m2.5",
							api: "anthropic-messages",
							baseUrl: "https://opencode.ai/zen/go",
							reasoning: true,
							input: ["text"],
							cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
						{
							id: "glm-5",
							api: "openai-completions",
							reasoning: true,
							input: ["text"],
							cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const m25 = registry.find("opencode-go", "minimax-m2.5");
			const glm5 = registry.find("opencode-go", "glm-5");

			expect(m25?.baseUrl).toBe("https://opencode.ai/zen/go");
			expect(glm5?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		});

		test("modelOverrides still apply when provider also defines models", () => {
			writeRawModelsJson({
				[testProvider]: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_API_KEY",
					api: testModel1.api,
					models: [
						{
							id: "custom-test-model",
							name: "Custom Test Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
						},
					],
					modelOverrides: {
						[testModel1.id]: {
							name: "Overridden Built-in Model",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, testProvider);

			expect(models.some((m) => m.id === "custom-test-model")).toBe(true);
			expect(models.some((m) => m.id === testModel1.id && m.name === "Overridden Built-in Model")).toBe(true);
		});

		test("refresh() reloads merged custom models from disk", () => {
			writeModelsJson({
				anthropic: providerConfig("https://first-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "anthropic").some((m) => m.id === "claude-custom")).toBe(true);

			// Update and refresh
			writeModelsJson({
				anthropic: providerConfig("https://second-proxy.example.com/v1", [{ id: "claude-custom-2" }]),
			});
			registry.refresh();

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.some((m) => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some((m) => m.id === "claude-custom-2")).toBe(true);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("removing custom models from models.json keeps built-in provider models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "anthropic").some((m) => m.id === "claude-custom")).toBe(true);

			// Remove custom models and refresh
			writeModelsJson({});
			registry.refresh();

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.some((m) => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});
	});

	// Dynamically find a provider with ≥2 built-in models for override tests.
	// This avoids hardcoding provider/model IDs that may disappear from the generated registry.
	const testProvider = getProviders().find((p) => getModels(p).length >= 2)!;
	const [testModel1, testModel2] = getModels(testProvider);

	describe("modelOverrides (per-model customization)", () => {
		test("model override applies to a single built-in model", () => {
			writeRawModelsJson({
				[testProvider]: {
					modelOverrides: {
						[testModel1.id]: {
							name: "Custom Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, testProvider);

			const overridden = models.find((m) => m.id === testModel1.id);
			expect(overridden?.name).toBe("Custom Name");

			// Other models should be unchanged
			const other = models.find((m) => m.id === testModel2.id);
			expect(other?.name).not.toBe("Custom Name");
		});

		test("model override with compat.openRouterRouting", () => {
			writeRawModelsJson({
				[testProvider]: {
					modelOverrides: {
						[testModel1.id]: {
							compat: {
								openRouterRouting: { only: ["amazon-bedrock"] },
							},
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, testProvider);

			const overridden = models.find((m) => m.id === testModel1.id);
			const compat = overridden?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
		});

		test("model override deep merges compat settings", () => {
			writeRawModelsJson({
				[testProvider]: {
					modelOverrides: {
						[testModel1.id]: {
							compat: {
								openRouterRouting: { order: ["anthropic", "together"] },
							},
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, testProvider);
			const overridden = models.find((m) => m.id === testModel1.id);

			// Should have both the new routing AND preserve other compat settings
			const compat = overridden?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ order: ["anthropic", "together"] });
		});

		test("multiple model overrides on same provider", () => {
			writeRawModelsJson({
				[testProvider]: {
					modelOverrides: {
						[testModel1.id]: {
							compat: { openRouterRouting: { only: ["amazon-bedrock"] } },
						},
						[testModel2.id]: {
							compat: { openRouterRouting: { only: ["anthropic"] } },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, testProvider);

			const m1 = models.find((m) => m.id === testModel1.id);
			const m2 = models.find((m) => m.id === testModel2.id);

			const compat1 = m1?.compat as OpenAICompletionsCompat | undefined;
			const compat2 = m2?.compat as OpenAICompletionsCompat | undefined;
			expect(compat1?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
			expect(compat2?.openRouterRouting).toEqual({ only: ["anthropic"] });
		});

		test("model override combined with baseUrl override", () => {
			writeRawModelsJson({
				[testProvider]: {
					baseUrl: "https://my-proxy.example.com/v1",
					modelOverrides: {
						[testModel1.id]: {
							name: "Proxied Model",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, testProvider);
			const overridden = models.find((m) => m.id === testModel1.id);

			// Both overrides should apply
			expect(overridden?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(overridden?.name).toBe("Proxied Model");

			// Other models should have the baseUrl but not the name override
			const other = models.find((m) => m.id === testModel2.id);
			expect(other?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(other?.name).not.toBe("Proxied Model");
		});

		test("model override for non-existent model ID is ignored", () => {
			writeRawModelsJson({
				[testProvider]: {
					modelOverrides: {
						"nonexistent/model-id": {
							name: "This should not appear",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, testProvider);

			// Should not create a new model
			expect(models.find((m) => m.id === "nonexistent/model-id")).toBeUndefined();
			// Should not crash or show error
			expect(registry.getError()).toBeUndefined();
		});

		test("model override can change cost fields partially", () => {
			writeRawModelsJson({
				[testProvider]: {
					modelOverrides: {
						[testModel1.id]: {
							cost: { input: 99 },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, testProvider);
			const overridden = models.find((m) => m.id === testModel1.id);

			// Input cost should be overridden
			expect(overridden?.cost.input).toBe(99);
			// Other cost fields should be preserved from built-in
			expect(overridden?.cost.output).toBeGreaterThan(0);
		});

		test("model override can add headers", () => {
			writeRawModelsJson({
				[testProvider]: {
					modelOverrides: {
						[testModel1.id]: {
							headers: { "X-Custom-Model-Header": "value" },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, testProvider);
			const overridden = models.find((m) => m.id === testModel1.id);

			expect(overridden?.headers?.["X-Custom-Model-Header"]).toBe("value");
		});

		test("refresh() picks up model override changes", () => {
			writeRawModelsJson({
				[testProvider]: {
					modelOverrides: {
						[testModel1.id]: {
							name: "First Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, testProvider).find((m) => m.id === testModel1.id)?.name).toBe(
				"First Name",
			);

			// Update and refresh
			writeRawModelsJson({
				[testProvider]: {
					modelOverrides: {
						[testModel1.id]: {
							name: "Second Name",
						},
					},
				},
			});
			registry.refresh();

			expect(getModelsForProvider(registry, testProvider).find((m) => m.id === testModel1.id)?.name).toBe(
				"Second Name",
			);
		});

		test("removing model override restores built-in values", () => {
			writeRawModelsJson({
				[testProvider]: {
					modelOverrides: {
						[testModel1.id]: {
							name: "Custom Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const customName = getModelsForProvider(registry, testProvider).find((m) => m.id === testModel1.id)?.name;
			expect(customName).toBe("Custom Name");

			// Remove override and refresh
			writeRawModelsJson({});
			registry.refresh();

			const restoredName = getModelsForProvider(registry, testProvider).find((m) => m.id === testModel1.id)?.name;
			expect(restoredName).not.toBe("Custom Name");
		});
	});

	describe("dynamic provider lifecycle", () => {
		test("failed registerProvider does not persist invalid streamSimple config", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(() =>
				registry.registerProvider("broken-provider", {
					streamSimple: (() => {
						throw new Error("should not run");
					}) as any,
				}),
			).toThrow('Provider broken-provider: "api" is required when registering streamSimple.');

			expect(() => registry.refresh()).not.toThrow();
		});

		test("failed registerProvider does not remove existing provider models", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			registry.registerProvider("demo-provider", {
				baseUrl: "https://provider.test/v1",
				apiKey: "TEST_KEY",
				api: "openai-completions",
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();

			expect(() =>
				registry.registerProvider("demo-provider", {
					baseUrl: "https://provider.test/v2",
					apiKey: "TEST_KEY",
					models: [
						{
							id: "broken-model",
							name: "Broken Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				}),
			).toThrow('Provider demo-provider, model broken-model: no "api" specified.');

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
			expect(() => registry.refresh()).not.toThrow();
			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
		});

		test("unregisterProvider removes custom OAuth provider and restores built-in OAuth provider", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			registry.registerProvider("anthropic", {
				oauth: {
					name: "Custom Anthropic OAuth",
					login: async () => ({
						access: "custom-access-token",
						refresh: "custom-refresh-token",
						expires: Date.now() + 60_000,
					}),
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				},
			});

			expect(getOAuthProvider("anthropic")?.name).toBe("Custom Anthropic OAuth");

			registry.unregisterProvider("anthropic");

			expect(getOAuthProvider("anthropic")?.name).not.toBe("Custom Anthropic OAuth");
		});

		test("unregisterProvider removes custom streamSimple override and restores built-in API stream handler", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			registry.registerProvider("stream-override-provider", {
				api: "openai-completions",
				streamSimple: () => {
					throw new Error("custom streamSimple override");
				},
			});

			let threwCustomOverride = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverride = error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverride).toBe(true);

			registry.unregisterProvider("stream-override-provider");

			let threwCustomOverrideAfterUnregister = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverrideAfterUnregister =
					error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverrideAfterUnregister).toBe(false);
		});
	});

	describe("API key resolution", () => {
		/** Create provider config with custom apiKey */
		function providerWithApiKey(apiKey: string) {
			return {
				baseUrl: "https://example.com/v1",
				apiKey,
				api: "anthropic-messages",
				models: [
					{
						id: "test-model",
						name: "Test Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100000,
						maxTokens: 8000,
					},
				],
			};
		}

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo test-api-key-from-command"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo '  spaced-key  '"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf 'line1\\nline2'"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!exit 1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!nonexistent-command-12345"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf ''"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey as environment variable name resolves to env value", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("TEST_API_KEY_12345"),
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			// Make sure this isn't an env var
			delete process.env.literal_api_key_value;

			writeRawModelsJson({
				"custom-provider": providerWithApiKey("literal_api_key_value"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo 'hello world' | tr ' ' '-'"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("hello-world");
		});

		describe("caching", () => {
			test("command is only executed once per process", async () => {
				// Use a command that writes to a file to count invocations
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				// Call multiple times
				await registry.getApiKeyForProvider("custom-provider");
				await registry.getApiKeyForProvider("custom-provider");
				await registry.getApiKeyForProvider("custom-provider");

				// Command should have only run once
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("cache persists across registry instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				// Create multiple registry instances
				const registry1 = new ModelRegistry(authStorage, modelsJsonPath);
				await registry1.getApiKeyForProvider("custom-provider");

				const registry2 = new ModelRegistry(authStorage, modelsJsonPath);
				await registry2.getApiKeyForProvider("custom-provider");

				// Command should still have only run once
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("clearApiKeyCache allows command to run again", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.getApiKeyForProvider("custom-provider");

				// Clear cache and call again
				clearApiKeyCache();
				await registry.getApiKeyForProvider("custom-provider");

				// Command should have run twice
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("different commands are cached separately", async () => {
				writeRawModelsJson({
					"provider-a": providerWithApiKey("!echo key-a"),
					"provider-b": providerWithApiKey("!echo key-b"),
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				const keyA = await registry.getApiKeyForProvider("provider-a");
				const keyB = await registry.getApiKeyForProvider("provider-b");

				expect(keyA).toBe("key-a");
				expect(keyB).toBe("key-b");
			});

			test("failed commands are cached (not retried)", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				// Call multiple times - all should return undefined
				const key1 = await registry.getApiKeyForProvider("custom-provider");
				const key2 = await registry.getApiKeyForProvider("custom-provider");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				// Command should have only run once despite failures
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_API_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeRawModelsJson({
						"custom-provider": providerWithApiKey(envVarName),
					});

					const registry = new ModelRegistry(authStorage, modelsJsonPath);

					const key1 = await registry.getApiKeyForProvider("custom-provider");
					expect(key1).toBe("first-value");

					// Change env var
					process.env[envVarName] = "second-value";

					const key2 = await registry.getApiKeyForProvider("custom-provider");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});
		});
	});
});
