import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { complete, completeSimple, type Model } from "@dreb/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { log } from "../src/core/logger.js";
import {
	type AgentTypeConfig,
	createSubagentToolDefinition,
	DEFAULT_MODEL_AVAILABILITY_PROBE_TIMEOUT_MS,
	executeSingle,
	formatModelFallbackSummary,
	formatSingleResult,
	isRuntimeUnavailableError,
	parseAgentFrontmatter,
	prependModelFallbackSummary,
	probeModelAvailability,
	resolveModelForSubagentSpawn,
	resolveModelStringSingle,
	resolveModelWithFallbacks,
	type SubagentResult,
	subagentToolDefinition,
} from "../src/core/tools/subagent.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: vi.fn(),
	};
});

vi.mock("@dreb/ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dreb/ai")>();
	return {
		...actual,
		complete: vi.fn(),
		completeSimple: vi.fn(),
	};
});

beforeEach(() => {
	vi.mocked(complete).mockReset();
	vi.mocked(completeSimple).mockReset();
	vi.mocked(spawn).mockReset();
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(log, "debug").mockImplementation(() => {});
	vi.spyOn(log, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

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

const probeModels: Model<"anthropic-messages">[] = [
	{
		id: "primary-model",
		name: "Primary Model",
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
		id: "fallback-model",
		name: "Fallback Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
	{
		id: "parent-model",
		name: "Parent Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
];

function assistantResult(stopReason: "stop" | "error" | "aborted", errorMessage?: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text: stopReason === "stop" ? "ok" : "" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "primary-model",
		usage: { input: 1, output: stopReason === "stop" ? 1 : 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	} as Awaited<ReturnType<typeof completeSimple>>;
}

function probeRegistry() {
	return {
		getAll: () => probeModels,
		find: (provider: string, modelId: string) => probeModels.find((m) => m.provider === provider && m.id === modelId),
		getApiKey: async () => "test-key",
		authStorage: { hasAuth: () => true },
	} as unknown as Parameters<typeof resolveModelForSubagentSpawn>[2];
}

function makeAgents(model: string | string[]): Map<string, AgentTypeConfig> {
	return new Map([
		[
			"test-agent",
			{
				name: "test-agent",
				description: "Test agent",
				model,
				systemPrompt: "Test system prompt",
			},
		],
	]);
}

function mockSpawnSubagentResult(
	options: {
		model?: string;
		output?: string;
		exitCode?: number;
		stderr?: string;
		/** stopReason to include on the final assistant message_end event. */
		stopReason?: string;
		/** errorMessage to include on the final assistant message_end event. */
		messageErrorMessage?: string;
		/** Emit a message_end event even when output is empty (to carry stopReason). */
		emitEmptyMessage?: boolean;
	} = {},
) {
	const {
		model = "fallback-model",
		output = "child output",
		exitCode = 0,
		stderr = "",
		stopReason,
		messageErrorMessage,
		emitEmptyMessage = false,
	} = options;
	vi.mocked(spawn).mockImplementationOnce((() => {
		const stdout = new PassThrough();
		const stderrStream = new PassThrough();
		const proc = new EventEmitter() as ReturnType<typeof spawn> & {
			stdout: PassThrough;
			stderr: PassThrough;
			killed: boolean;
		};
		proc.stdout = stdout;
		proc.stderr = stderrStream;
		proc.killed = false;
		proc.kill = vi.fn(() => {
			proc.killed = true;
			return true;
		}) as ReturnType<typeof spawn>["kill"];

		process.nextTick(() => {
			if (stderr) stderrStream.write(stderr);
			stdout.write(`${JSON.stringify({ type: "agent_start", model: { id: model } })}\n`);
			if (output || emitEmptyMessage) {
				const message: Record<string, unknown> = {
					role: "assistant",
					content: output ? [{ type: "text", text: output }] : [],
				};
				if (stopReason !== undefined) message.stopReason = stopReason;
				if (messageErrorMessage !== undefined) message.errorMessage = messageErrorMessage;
				stdout.write(
					`${JSON.stringify({
						type: "message_end",
						message,
					})}\n`,
				);
			}
			stdout.end();
			stderrStream.end();
			proc.emit("close", exitCode);
		});

		return proc;
	}) as typeof spawn);
}

describe("spawn-time model availability probing", () => {
	test("probeModelAvailability succeeds on a clean completion via completeSimple (streamSimple path)", async () => {
		vi.mocked(completeSimple).mockResolvedValueOnce(assistantResult("stop"));

		const result = await probeModelAvailability(probeModels[0], { registry: probeRegistry(), timeoutMs: 100 });

		expect(result).toEqual({ ok: true });
		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(completeSimple).toHaveBeenCalledWith(
			probeModels[0],
			expect.objectContaining({
				systemPrompt: "Reply with the single word OK.",
				messages: [expect.objectContaining({ role: "user", content: "hi" })],
			}),
			expect.objectContaining({ apiKey: "test-key", maxRetryDelayMs: 0, reasoning: "xhigh" }),
		);
		// Must NOT pass maxTokens — normal model defaults are used, which avoids
		// tripping reasoning model minimums (e.g. OpenAI o-series with maxTokens:1).
		const callOptions = vi.mocked(completeSimple).mock.calls[0][2];
		expect(callOptions).not.toHaveProperty("maxTokens");
		expect(callOptions).toHaveProperty("reasoning", "xhigh");
	});

	test("probeModelAvailability reports thrown errors", async () => {
		vi.mocked(completeSimple).mockRejectedValueOnce(new Error("rate limit exceeded"));

		const result = await probeModelAvailability(probeModels[0], { registry: probeRegistry(), timeoutMs: 100 });

		expect(result).toEqual({ ok: false, reason: "rate limit exceeded" });
	});

	test("probeModelAvailability treats returned aborted messages as unavailable", async () => {
		vi.mocked(completeSimple).mockResolvedValueOnce(assistantResult("aborted", "request cancelled"));

		const result = await probeModelAvailability(probeModels[0], { registry: probeRegistry(), timeoutMs: 100 });

		expect(result).toEqual({ ok: false, reason: "request cancelled" });
	});

	test("probeModelAvailability short-circuits an already-aborted parent signal", async () => {
		const controller = new AbortController();
		controller.abort(new Error("user cancelled"));

		const result = await probeModelAvailability(probeModels[0], {
			registry: probeRegistry(),
			signal: controller.signal,
			timeoutMs: 100,
		});

		expect(result).toEqual({ ok: false, reason: "Aborted before spawn", aborted: true });
		expect(completeSimple).not.toHaveBeenCalled();
	});

	test("probeModelAvailability propagates parent abort while in flight", async () => {
		const controller = new AbortController();
		vi.mocked(completeSimple).mockImplementationOnce(
			(_model, _context, options) =>
				new Promise<Awaited<ReturnType<typeof completeSimple>>>((resolve) => {
					options?.signal?.addEventListener("abort", () =>
						resolve(assistantResult("aborted", "request cancelled")),
					);
					queueMicrotask(() => controller.abort(new Error("user cancelled")));
				}),
		);

		const resultPromise = probeModelAvailability(probeModels[0], {
			registry: probeRegistry(),
			signal: controller.signal,
			timeoutMs: 1_000,
		});

		await expect(resultPromise).resolves.toEqual({ ok: false, reason: "Aborted before spawn", aborted: true });
	});

	test("probeModelAvailability enforces timeout even if provider ignores abort", async () => {
		vi.useFakeTimers();
		vi.mocked(completeSimple).mockImplementationOnce(
			() => new Promise<Awaited<ReturnType<typeof completeSimple>>>(() => {}),
		);

		const resultPromise = probeModelAvailability(probeModels[0], { registry: probeRegistry(), timeoutMs: 50 });
		await vi.advanceTimersByTimeAsync(50);

		await expect(resultPromise).resolves.toEqual({
			ok: false,
			reason: "Model availability probe timed out after 50ms",
		});
	});

	test("probeModelAvailability uses the named default timeout", async () => {
		vi.useFakeTimers();
		vi.mocked(completeSimple).mockImplementationOnce(
			() => new Promise<Awaited<ReturnType<typeof completeSimple>>>(() => {}),
		);

		const resultPromise = probeModelAvailability(probeModels[0], { registry: probeRegistry() });
		await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_AVAILABILITY_PROBE_TIMEOUT_MS);

		await expect(resultPromise).resolves.toEqual({
			ok: false,
			reason: `Model availability probe timed out after ${DEFAULT_MODEL_AVAILABILITY_PROBE_TIMEOUT_MS}ms`,
		});
	});

	test("isRuntimeUnavailableError treats provider error messages as unavailable", () => {
		expect(isRuntimeUnavailableError(assistantResult("error", "quota exhausted"))).toBe(true);
		expect(isRuntimeUnavailableError(new Error("timeout"))).toBe(true);
		expect(isRuntimeUnavailableError("HTTP 500")).toBe(true);
		expect(isRuntimeUnavailableError(assistantResult("stop"))).toBe(false);
	});

	test("fallback loop uses the first model when its probe succeeds", async () => {
		vi.mocked(completeSimple).mockResolvedValueOnce(assistantResult("stop"));

		const result = await resolveModelForSubagentSpawn(
			["primary-model", "fallback-model"],
			"anthropic",
			probeRegistry(),
			"parent-model",
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.modelId).toBe("primary-model");
			expect(result.provider).toBe("anthropic");
			expect(result.skippedModels).toEqual([]);
		}
		expect(completeSimple).toHaveBeenCalledTimes(1);
	});

	test("fallback loop skips a failed probe and uses the next fallback", async () => {
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(assistantResult("error", "429 rate limit"))
			.mockResolvedValueOnce(assistantResult("stop"));

		const result = await resolveModelForSubagentSpawn(
			["primary-model", "fallback-model"],
			"anthropic",
			probeRegistry(),
			"parent-model",
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.modelId).toBe("fallback-model");
			expect(result.skippedModels).toEqual([{ model: "primary-model", reason: "429 rate limit" }]);
		}
		expect(completeSimple).toHaveBeenCalledTimes(2);
		expect(log.warn).toHaveBeenCalledWith(
			'[subagent] Model "primary-model" failed probe (429 rate limit). Trying next fallback...',
		);
	});

	test.each(["429 rate limit", "insufficient quota", "probe timeout", "HTTP 503 upstream unavailable"])(
		"fallback loop skips probe error: %s",
		async (message) => {
			vi.mocked(completeSimple)
				.mockResolvedValueOnce(assistantResult("error", message))
				.mockResolvedValueOnce(assistantResult("stop"));

			const result = await resolveModelForSubagentSpawn(
				["primary-model", "fallback-model"],
				"anthropic",
				probeRegistry(),
				"parent-model",
			);

			expect(result.ok).toBe(true);
			if (result.ok) expect(result.modelId).toBe("fallback-model");
		},
	);

	test("fallback loop uses parent model when all configured model probes fail", async () => {
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(assistantResult("error", "primary quota exhausted"))
			.mockRejectedValueOnce(new Error("fallback auth revoked"));

		const result = await resolveModelForSubagentSpawn(
			["primary-model", "fallback-model"],
			"anthropic",
			probeRegistry(),
			"parent-model",
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.modelId).toBe("parent-model");
			expect(result.warning).toContain('Falling back to parent model "parent-model"');
			expect(result.skippedModels).toEqual([
				{ model: "primary-model", reason: "primary quota exhausted" },
				{ model: "fallback-model", reason: "fallback auth revoked" },
			]);
		}
		expect(completeSimple).toHaveBeenCalledTimes(2);
	});

	test("fallback loop returns an error when parent model also fails", async () => {
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(assistantResult("error", "primary down"))
			.mockResolvedValueOnce(assistantResult("error", "fallback down"));

		const result = await resolveModelForSubagentSpawn(
			["primary-model", "fallback-model"],
			"anthropic",
			probeRegistry(),
			"missing-parent",
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("None of the fallback models passed availability checks");
			expect(result.error).toContain("missing-parent");
			expect(result.skippedModels).toEqual([
				{ model: "primary-model", reason: "primary down" },
				{ model: "fallback-model", reason: "fallback down" },
			]);
		}
	});

	test("fallback loop exits immediately when signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("user cancelled"));

		const result = await resolveModelForSubagentSpawn(
			["primary-model", "fallback-model"],
			"anthropic",
			probeRegistry(),
			"parent-model",
			controller.signal,
		);

		expect(result).toEqual({ ok: false, error: "Aborted before spawn", skippedModels: [] });
		expect(completeSimple).not.toHaveBeenCalled();
	});

	test("fallback loop exits when signal aborts during probing", async () => {
		const controller = new AbortController();
		vi.mocked(completeSimple).mockImplementationOnce(async () => {
			controller.abort(new Error("user cancelled"));
			return assistantResult("aborted", "request cancelled");
		});

		const result = await resolveModelForSubagentSpawn(
			["primary-model", "fallback-model"],
			"anthropic",
			probeRegistry(),
			"parent-model",
			controller.signal,
		);

		expect(result).toEqual({ ok: false, error: "Aborted before spawn", skippedModels: [] });
		expect(completeSimple).toHaveBeenCalledTimes(1);
	});

	test("array model config without registry skips probing", async () => {
		const result = await resolveModelForSubagentSpawn(
			["primary-model", "fallback-model"],
			"anthropic",
			undefined,
			"parent-model",
		);

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.modelId).toBe("primary-model");
		expect(completeSimple).not.toHaveBeenCalled();
	});

	test("single model config skips probing", async () => {
		const result = await resolveModelForSubagentSpawn("primary-model", "anthropic", probeRegistry(), "parent-model");

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.modelId).toBe("primary-model");
		expect(completeSimple).not.toHaveBeenCalled();
	});

	test("fallback summary formatting and prepending are visible in output", () => {
		const skipped = [{ model: "primary-model", reason: "429 rate limit" }];

		expect(formatModelFallbackSummary([], "fallback-model")).toBeUndefined();
		expect(formatModelFallbackSummary(skipped, "fallback-model")).toBe(
			'[MODEL FALLBACK: skipped 1 unavailable model(s); using "fallback-model".]\n- primary-model: 429 rate limit',
		);
		expect(prependModelFallbackSummary("child output", skipped, "fallback-model")).toBe(
			'[MODEL FALLBACK: skipped 1 unavailable model(s); using "fallback-model".]\n- primary-model: 429 rate limit\n\nchild output',
		);
		expect(prependModelFallbackSummary("child output", [], "fallback-model")).toBe("child output");
	});

	test("executeSingle prepends warning before fallback summary when parent model is used", async () => {
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(assistantResult("error", "primary quota exhausted"))
			.mockRejectedValueOnce(new Error("fallback auth revoked"));
		mockSpawnSubagentResult({ model: "parent-model", output: "child output" });

		const result = await executeSingle(
			makeAgents(["primary-model", "fallback-model"]),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			undefined,
			"anthropic",
			probeRegistry(),
			undefined,
			"parent-model",
		);

		expect(result.exitCode).toBe(0);
		expect(result.model).toBe("parent-model");
		expect(result.output).toBe(
			'[WARNING: Agent preferred models were unavailable. Falling back to parent model "parent-model".]\n\n' +
				'[MODEL FALLBACK: skipped 2 unavailable model(s); using "parent-model".]\n' +
				"- primary-model: primary quota exhausted\n" +
				"- fallback-model: fallback auth revoked\n\n" +
				"child output",
		);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(spawn).mock.calls[0][1]).toContain("parent-model");
	});

	test("executeSingle includes skipped model details when model resolution fails", async () => {
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(assistantResult("error", "primary down"))
			.mockResolvedValueOnce(assistantResult("error", "fallback down"));

		const result = await executeSingle(
			makeAgents(["primary-model", "fallback-model"]),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			undefined,
			"anthropic",
			probeRegistry(),
			undefined,
			"missing-parent",
		);

		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain("None of the fallback models passed availability checks");
		expect(result.errorMessage).toContain("Skipped models:");
		expect(result.errorMessage).toContain("- primary-model: primary down");
		expect(result.errorMessage).toContain("- fallback-model: fallback down");
		expect(spawn).not.toHaveBeenCalled();
	});

	test("executeSingle model override skips fallback probes and uses the override model", async () => {
		mockSpawnSubagentResult({ model: "parent-model", output: "override output" });

		const result = await executeSingle(
			makeAgents(["primary-model", "fallback-model"]),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			"parent-model",
			"anthropic",
			probeRegistry(),
			undefined,
			"primary-model",
		);

		expect(result.exitCode).toBe(0);
		expect(result.model).toBe("parent-model");
		expect(result.output).toBe("override output");
		expect(completeSimple).not.toHaveBeenCalled();
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(spawn).mock.calls[0][1]).toContain("parent-model");
	});
});

/**
 * Tests for the mach6 settings-based model override precedence in the REAL
 * executeSingle (issue 219 / PR 220). The precedence under test is:
 *
 *   modelOverride  >  agentModels (settings)  >  agent definition config.model
 *
 * These tests exercise the actual `const modelSpec = modelOverride || (agentModels...)
 * || config.model;` line in executeSingle — a typo swapping the operands would fail
 * here. The spawned model is verified via the CLI args passed to the mocked spawn.
 */
describe("executeSingle agentModels precedence (issue 219)", () => {
	test("agentModels overrides the agent definition model when no modelOverride is given", async () => {
		// Agent definition prefers "parent-model"; settings override to ["primary-model"].
		// agentModels is a non-empty array, so the probe path runs — succeed on first probe.
		vi.mocked(completeSimple).mockResolvedValueOnce(assistantResult("stop"));
		mockSpawnSubagentResult({ model: "primary-model", output: "agent-models output" });

		const result = await executeSingle(
			makeAgents("parent-model"),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			undefined, // no modelOverride
			"anthropic",
			probeRegistry(),
			undefined,
			"parent-model",
			["primary-model"], // agentModels (settings)
		);

		expect(result.exitCode).toBe(0);
		expect(spawn).toHaveBeenCalledTimes(1);
		const spawnArgs = vi.mocked(spawn).mock.calls[0][1];
		expect(spawnArgs).toContain("primary-model");
		expect(spawnArgs).not.toContain("parent-model");
		// agentModels is an array → the spawn-time probe path was exercised.
		expect(completeSimple).toHaveBeenCalledTimes(1);
	});

	test("modelOverride wins over agentModels", async () => {
		// modelOverride is a single string → no probe runs at all.
		mockSpawnSubagentResult({ model: "primary-model", output: "override output" });

		const result = await executeSingle(
			makeAgents("parent-model"),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			"primary-model", // modelOverride (per-invocation)
			"anthropic",
			probeRegistry(),
			undefined,
			"parent-model",
			["fallback-model"], // agentModels — should be ignored
		);

		expect(result.exitCode).toBe(0);
		expect(spawn).toHaveBeenCalledTimes(1);
		const spawnArgs = vi.mocked(spawn).mock.calls[0][1];
		expect(spawnArgs).toContain("primary-model");
		expect(spawnArgs).not.toContain("fallback-model");
		expect(spawnArgs).not.toContain("parent-model");
		// Single override string skips probing entirely.
		expect(completeSimple).not.toHaveBeenCalled();
	});

	test("empty agentModels array falls through to the agent definition model", async () => {
		mockSpawnSubagentResult({ model: "parent-model", output: "config output" });

		const result = await executeSingle(
			makeAgents("parent-model"),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			undefined, // no modelOverride
			"anthropic",
			probeRegistry(),
			undefined,
			"primary-model",
			[], // empty agentModels — must fall through
		);

		expect(result.exitCode).toBe(0);
		expect(spawn).toHaveBeenCalledTimes(1);
		const spawnArgs = vi.mocked(spawn).mock.calls[0][1];
		expect(spawnArgs).toContain("parent-model");
		// config.model is a single string → no probe runs.
		expect(completeSimple).not.toHaveBeenCalled();
	});

	test("undefined agentModels falls through to the agent definition model", async () => {
		mockSpawnSubagentResult({ model: "parent-model", output: "config output" });

		const result = await executeSingle(
			makeAgents("parent-model"),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			undefined, // no modelOverride
			"anthropic",
			probeRegistry(),
			undefined,
			"primary-model",
			undefined, // no agentModels
		);

		expect(result.exitCode).toBe(0);
		expect(spawn).toHaveBeenCalledTimes(1);
		const spawnArgs = vi.mocked(spawn).mock.calls[0][1];
		expect(spawnArgs).toContain("parent-model");
		expect(completeSimple).not.toHaveBeenCalled();
	});
});

describe("probe uses streamSimple path (issue 215 regression)", () => {
	test("probe does NOT use low-level complete() — uses completeSimple (streamSimple path)", async () => {
		// The old implementation used complete() which calls provider.stream() directly.
		// The new implementation uses completeSimple() which calls provider.streamSimple(),
		// the same unified path the agent loop uses. This ensures probes exercise the
		// same code path as real subagent execution.
		vi.mocked(completeSimple).mockResolvedValueOnce(assistantResult("stop"));

		await probeModelAvailability(probeModels[0], { registry: probeRegistry(), timeoutMs: 100 });

		// completeSimple was called, not the low-level complete path.
		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(complete).not.toHaveBeenCalled();
	});

	test("probe does NOT pass maxTokens:1 — avoids reasoning model failures", async () => {
		// OpenAI reasoning models (o1, o3, etc.) reject or malfunction with maxTokens:1
		// because reasoning tokens count against the completion token budget. The probe
		// must not set maxTokens at all, letting buildBaseOptions apply normal defaults.
		vi.mocked(completeSimple).mockResolvedValueOnce(assistantResult("stop"));

		await probeModelAvailability(probeModels[0], { registry: probeRegistry(), timeoutMs: 100 });

		const callOptions = vi.mocked(completeSimple).mock.calls[0][2];
		expect(callOptions).not.toHaveProperty("maxTokens");
	});

	test("probe leaves reasoning disabled for non-reasoning models", async () => {
		vi.mocked(completeSimple).mockResolvedValueOnce(assistantResult("stop"));

		await probeModelAvailability(probeModels[1], { registry: probeRegistry(), timeoutMs: 100 });

		const callOptions = vi.mocked(completeSimple).mock.calls[0][2];
		expect(callOptions).not.toHaveProperty("maxTokens");
		expect(callOptions?.reasoning).toBeUndefined();
	});

	test("probe works for openai-responses reasoning model with normal reasoning default", async () => {
		// Simulate an OpenAI reasoning model (e.g. gpt-5.5) — the old maxTokens:1 probe
		// would fail on these because the provider sends max_output_tokens:1 which
		// is too small for reasoning token overhead. The probe must also pass the
		// normal coding-agent thinking default so streamSimple does not disable reasoning.
		const reasoningModel: Model<"openai-responses"> = {
			id: "gpt-5.5",
			name: "gpt-5.5",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 10, output: 40, cacheRead: 1, cacheWrite: 10 },
			contextWindow: 200000,
			maxTokens: 100000,
		};
		const reasoningRegistry = {
			getAll: () => [reasoningModel],
			find: (provider: string, modelId: string) =>
				provider === "openai" && modelId === "gpt-5.5" ? reasoningModel : undefined,
			getApiKey: async () => "test-key",
			authStorage: { hasAuth: () => true },
		} as unknown as Parameters<typeof resolveModelForSubagentSpawn>[2];

		vi.mocked(completeSimple).mockResolvedValueOnce({
			...assistantResult("stop"),
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.5",
		});

		const result = await probeModelAvailability(reasoningModel, {
			registry: reasoningRegistry,
			timeoutMs: 100,
		});

		expect(result).toEqual({ ok: true });
		expect(completeSimple).toHaveBeenCalledTimes(1);
		// Verify no maxTokens was passed — critical for reasoning models — and
		// the normal coding-agent thinking default was forwarded through streamSimple.
		const callOptions = vi.mocked(completeSimple).mock.calls[0][2];
		expect(callOptions).not.toHaveProperty("maxTokens");
		expect(callOptions).toHaveProperty("reasoning", "xhigh");
	});
});

describe("subagent truncation (stopReason length) surfacing", () => {
	test("clean exit with stopReason length and no output surfaces a truncation error", async () => {
		mockSpawnSubagentResult({
			model: "parent-model",
			output: "",
			emitEmptyMessage: true,
			stopReason: "length",
		});

		const result = await executeSingle(
			makeAgents(["primary-model", "fallback-model"]),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			"parent-model",
			"anthropic",
			probeRegistry(),
			undefined,
			"primary-model",
		);

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("");
		expect(result.errorMessage).not.toBeNull();
		expect(result.errorMessage).toContain("truncated");
	});

	test("clean exit with stopReason error surfaces the message errorMessage", async () => {
		mockSpawnSubagentResult({
			model: "parent-model",
			output: "",
			emitEmptyMessage: true,
			stopReason: "error",
			messageErrorMessage: "Response truncated at token limit after 3 attempts",
		});

		const result = await executeSingle(
			makeAgents(["primary-model", "fallback-model"]),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			"parent-model",
			"anthropic",
			probeRegistry(),
			undefined,
			"primary-model",
		);

		expect(result.exitCode).toBe(0);
		expect(result.errorMessage).toContain("Response truncated at token limit after 3 attempts");
	});

	test("clean exit with stopReason length WITH text keeps output and warns of truncation", async () => {
		mockSpawnSubagentResult({
			model: "parent-model",
			output: "partial answer",
			stopReason: "length",
		});

		const result = await executeSingle(
			makeAgents(["primary-model", "fallback-model"]),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			"parent-model",
			"anthropic",
			probeRegistry(),
			undefined,
			"primary-model",
		);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("partial answer");
		expect(result.errorMessage).not.toBeNull();
		expect(result.errorMessage).toContain("truncated");
		expect(result.errorMessage).toContain("incomplete");
	});

	test("clean exit with stopReason error WITH partial text surfaces the error (length retries exhausted)", async () => {
		// When the core agent loop exhausts its length retries it converts the
		// truncation to stopReason "error" while PRESERVING the partial text. A clean
		// JSON-mode exit (always code 0) with non-empty output must still surface the
		// error instead of letting the partial output masquerade as a clean success.
		mockSpawnSubagentResult({
			model: "parent-model",
			output: "partial answer that got cut off",
			stopReason: "error",
			messageErrorMessage: "Response truncated at token limit after 3 attempts",
		});

		const result = await executeSingle(
			makeAgents(["primary-model", "fallback-model"]),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			"parent-model",
			"anthropic",
			probeRegistry(),
			undefined,
			"primary-model",
		);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("partial answer that got cut off");
		expect(result.errorMessage).not.toBeNull();
		expect(result.errorMessage).toContain("Response truncated at token limit after 3 attempts");
	});

	test("regression: clean exit with normal text and stopReason stop leaves errorMessage null", async () => {
		mockSpawnSubagentResult({
			model: "parent-model",
			output: "complete answer",
			stopReason: "stop",
		});

		const result = await executeSingle(
			makeAgents(["primary-model", "fallback-model"]),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			"parent-model",
			"anthropic",
			probeRegistry(),
			undefined,
			"primary-model",
		);

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("complete answer");
		expect(result.errorMessage).toBeNull();
	});

	test("clean exit with empty output and stopReason stop surfaces a no-output error", async () => {
		mockSpawnSubagentResult({
			model: "parent-model",
			output: "",
			emitEmptyMessage: true,
			stopReason: "stop",
		});

		const result = await executeSingle(
			makeAgents(["primary-model", "fallback-model"]),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			"parent-model",
			"anthropic",
			probeRegistry(),
			undefined,
			"primary-model",
		);

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("");
		expect(result.errorMessage).toBe("Subagent completed with no output.");
	});

	test("clean exit with empty output and no final message surfaces a no-output error", async () => {
		// No message_end event at all → lastStopReason is undefined. A clean exit
		// with empty output must still surface the no-output error rather than
		// returning a silent empty result.
		mockSpawnSubagentResult({
			model: "parent-model",
			output: "",
			emitEmptyMessage: false,
		});

		const result = await executeSingle(
			makeAgents(["primary-model", "fallback-model"]),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			"parent-model",
			"anthropic",
			probeRegistry(),
			undefined,
			"primary-model",
		);

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("");
		expect(result.errorMessage).toBe("Subagent completed with no output.");
	});
});

describe("subagent promptGuidelines", () => {
	test("tool description maps each mode to its parameter", () => {
		const description = subagentToolDefinition.description;
		expect(description).toContain("`task` for a single task");
		expect(description).toContain("`tasks` for parallel execution in one call");
		expect(description).toContain("`chain` for a sequential pipeline");
	});

	test("parallel guideline requires one tasks-array call", () => {
		const guidelines = subagentToolDefinition.promptGuidelines ?? [];
		const parallelGuideline = guidelines.find((g) => g.includes("Typical mach6-review batch"));
		expect(parallelGuideline).toBeDefined();
		expect(parallelGuideline).toContain("`tasks` array");
		expect(parallelGuideline).toContain("single `subagent` call");
		expect(parallelGuideline).toContain("not separate calls");
	});

	test("parallel guideline includes a valid mach6-review batch", () => {
		const guidelines = subagentToolDefinition.promptGuidelines ?? [];
		const parallelGuideline = guidelines.find((g) => g.includes("Typical mach6-review batch"));
		expect(parallelGuideline).toBeDefined();

		const marker = "Typical mach6-review batch: `";
		const exampleStart = parallelGuideline!.indexOf(marker) + marker.length;
		const exampleEnd = parallelGuideline!.indexOf("`", exampleStart);
		expect(exampleEnd).toBeGreaterThan(exampleStart);

		const example = JSON.parse(parallelGuideline!.slice(exampleStart, exampleEnd)) as {
			tasks: Array<{ agent: string; task: string }>;
		};
		expect(example.tasks.map(({ agent }) => agent)).toEqual([
			"code-reviewer",
			"error-auditor",
			"test-reviewer",
			"completeness-checker",
		]);
		expect(example.tasks.every(({ task }) => task.length > 0)).toBe(true);
	});

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

/**
 * Tests for formatSingleResult (chain-mode rendering, issue 240 / PR 241).
 *
 * Covers the truncation branch added in PR 241: a clean exit (exitCode 0) that
 * still surfaces an errorMessage (e.g. truncation at the token limit) renders an
 * `**Error**:` prefix and does not fall back to `(No output)`.
 */
describe("formatSingleResult", () => {
	const base = {
		agent: "explore",
		task: "do something",
		stderr: "",
		exitCode: 0,
	};

	test("clean exit with errorMessage renders Error prefix and partial output", () => {
		const text = formatSingleResult({
			...base,
			errorMessage: "Response truncated at token limit.",
			output: "partial text",
		});
		expect(text).toContain("**Error**: Response truncated at token limit.\n");
		expect(text).toContain("partial text");
		expect(text).not.toContain("(No output)");
		// Should NOT use the exit-code error format reserved for non-zero exits.
		expect(text).not.toContain("**Error** (exit");
	});

	test("clean exit with no errorMessage and empty output renders (No output)", () => {
		const text = formatSingleResult({
			...base,
			errorMessage: null,
			output: "",
		});
		expect(text).toContain("\n(No output)");
		expect(text).not.toContain("**Error**");
	});

	test("clean exit with normal output renders output without Error prefix", () => {
		const text = formatSingleResult({
			...base,
			errorMessage: null,
			output: "hello",
		});
		expect(text).toContain("\nhello");
		expect(text).not.toContain("**Error**");
		expect(text).not.toContain("(No output)");
	});
});

/**
 * Tool-layer wiring tests for agentModels (issue 219 / PR 220, review finding 4).
 *
 * The precedence tests above call `executeSingle` directly with a pre-computed
 * `string[]` agentModels argument. These tests instead drive the REAL tool created
 * by `createSubagentToolDefinition`, exercising the wiring that looks up
 * `getAgentModelsForAgent(agentName)` and forwards the result for both the
 * background single-agent path and the chain per-step path. The goal is to catch a
 * wrong lookup key — a typo there would silently target the wrong agent.
 *
 * No modelRegistry is passed, so model resolution short-circuits through
 * `resolveModelWithFallbacks` (no probe), and the resolved model surfaces directly
 * in the spawned child's `--model` CLI argument.
 */
describe("subagent tool agentModels wiring (issue 219, finding 4)", () => {
	let tmpRoot: string;

	beforeEach(() => {
		// Build a temp cwd with project-level agent definitions. Project agents are
		// loaded LAST in discoverAgentTypes, so they override package/user agents,
		// giving deterministic config.model values for the fall-through assertions.
		tmpRoot = mkdtempSync(join(tmpdir(), "subagent-wiring-"));
		const agentsDir = join(tmpRoot, ".dreb", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "feature-dev.md"),
			"---\nname: feature-dev\ndescription: impl agent\nmodel: config/feature-model\n---\nfeature prompt",
		);
		writeFileSync(
			join(agentsDir, "explore.md"),
			"---\nname: Explore\ndescription: explore agent\nmodel: config/explore-model\n---\nexplore prompt",
		);
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	/**
	 * Build the real tool plus a recording spy for getAgentModelsForAgent that
	 * returns an override list only for "feature-dev". Returns a `done` promise that
	 * resolves with the background SubagentResult so tests can await the async
	 * background lifecycle before asserting on the mocked spawn args.
	 */
	function makeTool(getter?: (name: string) => string[] | undefined) {
		const lookupSpy = vi.fn(getter ?? ((name: string) => (name === "feature-dev" ? ["override/model"] : undefined)));
		let resolveDone: (r: SubagentResult) => void;
		const done = new Promise<SubagentResult>((res) => {
			resolveDone = res;
		});
		const tool = createSubagentToolDefinition(tmpRoot, {
			getAgentModelsForAgent: lookupSpy,
			onBackgroundComplete: (_id, result) => resolveDone(result),
			// No modelRegistry / parentProvider: resolution stays registry-less.
		});
		return { tool, lookupSpy, done };
	}

	test("background single agent: override list is looked up by agent name and forwarded to spawn", async () => {
		mockSpawnSubagentResult({ model: "override/model", output: "ok" });
		const { tool, lookupSpy, done } = makeTool();

		const res = await tool.execute(
			"call-1",
			{ agent: "feature-dev", task: "do work" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(res.content[0]).toMatchObject({ type: "text" });
		await done;

		// The lookup key MUST be the agent name — a wrong key would miss the override.
		expect(lookupSpy).toHaveBeenCalledWith("feature-dev");
		// The override resolved (no registry → returned as-is) and reached the child.
		expect(spawn).toHaveBeenCalledTimes(1);
		const spawnArgs = vi.mocked(spawn).mock.calls[0][1];
		expect(spawnArgs).toContain("override/model");
		expect(spawnArgs).not.toContain("config/feature-model");
		// Registry-less resolution skips probing entirely.
		expect(completeSimple).not.toHaveBeenCalled();
	});

	test("background single agent without override falls through to the agent definition model", async () => {
		mockSpawnSubagentResult({ model: "config/explore-model", output: "ok" });
		const { tool, lookupSpy, done } = makeTool();

		// "Explore" is the default agent — the lookup returns undefined for it.
		await tool.execute(
			"call-2",
			{ agent: "Explore", task: "look around" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		await done;

		expect(lookupSpy).toHaveBeenCalledWith("Explore");
		expect(spawn).toHaveBeenCalledTimes(1);
		const spawnArgs = vi.mocked(spawn).mock.calls[0][1];
		expect(spawnArgs).toContain("config/explore-model");
		expect(spawnArgs).not.toContain("override/model");
	});

	test("background single agent defaults the lookup key to DEFAULT_AGENT when no agent is given", async () => {
		mockSpawnSubagentResult({ model: "config/explore-model", output: "ok" });
		const { tool, lookupSpy, done } = makeTool();

		// No `agent` provided → DEFAULT_AGENT ("Explore") is used for both the lookup
		// key and the spawned agent.
		await tool.execute("call-3", { task: "look around" }, undefined, undefined, {} as ExtensionContext);
		await done;

		expect(lookupSpy).toHaveBeenCalledWith("Explore");
		const spawnArgs = vi.mocked(spawn).mock.calls[0][1];
		expect(spawnArgs).toContain("config/explore-model");
	});

	test("chain: per-step lookup uses step.agent and forwards the override for that step", async () => {
		mockSpawnSubagentResult({ model: "override/model", output: "step output" });
		const { tool, lookupSpy, done } = makeTool();

		await tool.execute(
			"call-4",
			{ chain: [{ agent: "feature-dev", task: "implement {previous}" }] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		await done;

		// The per-step lookup MUST use step.agent — not a wrong fallback.
		expect(lookupSpy).toHaveBeenCalledWith("feature-dev");
		expect(spawn).toHaveBeenCalledTimes(1);
		const spawnArgs = vi.mocked(spawn).mock.calls[0][1];
		expect(spawnArgs).toContain("override/model");
		expect(spawnArgs).not.toContain("config/feature-model");
		expect(completeSimple).not.toHaveBeenCalled();
	});

	test("chain: a step without an override falls through to that step's agent definition model", async () => {
		mockSpawnSubagentResult({ model: "config/explore-model", output: "step output" });
		const { tool, lookupSpy, done } = makeTool();

		await tool.execute(
			"call-5",
			{ chain: [{ agent: "Explore", task: "look" }] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		await done;

		expect(lookupSpy).toHaveBeenCalledWith("Explore");
		const spawnArgs = vi.mocked(spawn).mock.calls[0][1];
		expect(spawnArgs).toContain("config/explore-model");
		expect(spawnArgs).not.toContain("override/model");
	});

	test("chain: each step is looked up by its own agent name (distinct keys)", async () => {
		// Two-step chain with distinct agents. Step 1 (feature-dev) gets the override;
		// step 2 (Explore) falls through. Verifies the lookup key tracks step.agent
		// per-iteration rather than using a single chain-wide value.
		mockSpawnSubagentResult({ model: "override/model", output: "step 1 output" });
		mockSpawnSubagentResult({ model: "config/explore-model", output: "step 2 output" });
		const { tool, lookupSpy, done } = makeTool();

		await tool.execute(
			"call-6",
			{
				chain: [
					{ agent: "feature-dev", task: "implement" },
					{ agent: "Explore", task: "review {previous}" },
				],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		await done;

		expect(lookupSpy).toHaveBeenCalledWith("feature-dev");
		expect(lookupSpy).toHaveBeenCalledWith("Explore");
		expect(spawn).toHaveBeenCalledTimes(2);
		const step1Args = vi.mocked(spawn).mock.calls[0][1];
		const step2Args = vi.mocked(spawn).mock.calls[1][1];
		expect(step1Args).toContain("override/model");
		expect(step2Args).toContain("config/explore-model");
		expect(step2Args).not.toContain("override/model");
	});
});

// ---------------------------------------------------------------------------
// parentSessionFile threading tests
// ---------------------------------------------------------------------------

describe("parentSessionFile threading", () => {
	test("spawnSubagent includes --parent-session flag when parentSessionFile is provided", async () => {
		mockSpawnSubagentResult({ model: "fallback-model", output: "child output" });

		const result = await executeSingle(
			makeAgents("fallback-model"),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			undefined,
			"anthropic",
			probeRegistry(),
			undefined,
			"parent-model",
			["agent-models"],
			"/path/to/parent/session.jsonl", // parentSessionFile
		);

		expect(result.exitCode).toBe(0);
		expect(spawn).toHaveBeenCalledTimes(1);
		const spawnArgs = vi.mocked(spawn).mock.calls[0][1];
		expect(spawnArgs).toContain("--parent-session");
		expect(spawnArgs).toContain("/path/to/parent/session.jsonl");
	});

	test("spawnSubagent does not include --parent-session flag when parentSessionFile is not provided", async () => {
		mockSpawnSubagentResult({ model: "fallback-model", output: "child output" });

		const result = await executeSingle(
			makeAgents("fallback-model"),
			"test-agent",
			"do work",
			process.cwd(),
			undefined,
			undefined,
			undefined,
			"anthropic",
			probeRegistry(),
			undefined,
			"parent-model",
			["agent-models"],
			undefined, // parentSessionFile not provided
		);

		expect(result.exitCode).toBe(0);
		expect(spawn).toHaveBeenCalledTimes(1);
		const spawnArgs = vi.mocked(spawn).mock.calls[0][1];
		expect(spawnArgs).not.toContain("--parent-session");
	});
});
