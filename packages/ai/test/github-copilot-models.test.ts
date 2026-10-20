import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel, getModels, supportsMax, supportsThinkingOff, supportsXhigh } from "../src/models.js";
import type { Api, Model } from "../src/types.js";
import { githubCopilotOAuthProvider } from "../src/utils/oauth/github-copilot.js";
import {
	applyCopilotModelDiscovery,
	type CopilotModelInfo,
	isCopilotClaudeMessagesModel,
	parseCopilotModels,
} from "../src/utils/oauth/github-copilot-models.js";

const BUSINESS_TOKEN = "tid=test;exp=9999999999;proxy-ep=proxy.business.githubcopilot.com;";
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Trimmed shape of a real Copilot `/models` response (business account, 2026-10-19). */
function copilotModel(
	id: string,
	options: {
		endpoints?: string[];
		efforts?: string[];
		adaptive?: boolean;
		policy?: string;
		picker?: boolean;
		type?: string;
		limits?: Record<string, unknown>;
	} = {},
): Record<string, unknown> {
	return {
		id,
		name: `Name ${id}`,
		object: "model",
		vendor: "Anthropic",
		model_picker_enabled: options.picker ?? true,
		...(options.policy ? { policy: { state: options.policy } } : {}),
		supported_endpoints: options.endpoints ?? ["/v1/messages", "/chat/completions"],
		capabilities: {
			type: options.type ?? "chat",
			limits: options.limits ?? {
				max_context_window_tokens: 328000,
				max_prompt_tokens: 200000,
				max_output_tokens: 128000,
				vision: { supported_media_types: ["image/png", "application/pdf"] },
			},
			supports: {
				...(options.adaptive === false ? {} : { adaptive_thinking: true }),
				...(options.efforts ? { reasoning_effort: options.efforts } : {}),
				tool_calls: true,
				streaming: true,
			},
		},
	};
}

const LIVE_RESPONSE = {
	data: [
		copilotModel("claude-opus-5.5", { efforts: CLAUDE_EFFORTS, policy: "enabled" }),
		copilotModel("claude-sonnet-5.5", { efforts: CLAUDE_EFFORTS, policy: "enabled" }),
		copilotModel("claude-haiku-5.5", { efforts: CLAUDE_EFFORTS, policy: "enabled" }),
		copilotModel("gpt-6-sol", {
			endpoints: ["/responses", "ws:/responses"],
			efforts: ["none", "low", "medium", "high", "xhigh", "max"],
			adaptive: false,
		}),
		copilotModel("gemini-3.8-flash", { endpoints: ["/chat/completions"], efforts: ["low", "medium", "high"] }),
		copilotModel("mai-code-1.1-flash", { endpoints: ["/responses", "ws:/responses"], efforts: ["low", "medium"] }),
		copilotModel("text-embedding-3-small", { endpoints: [], type: "embeddings", picker: false }),
		copilotModel("gpt-4o", { endpoints: [], picker: false }),
	],
};

function copilotIds(models: Model<Api>[]): string[] {
	return models.filter((model) => model.provider === "github-copilot").map((model) => model.id);
}

describe("parseCopilotModels", () => {
	it("keeps chat models with endpoints, efforts, policy, picker, vision, and limits", () => {
		const parsed = parseCopilotModels(LIVE_RESPONSE);

		expect(parsed.map((model) => model.id)).not.toContain("text-embedding-3-small");
		expect(parsed.find((model) => model.id === "claude-opus-5.5")).toEqual({
			id: "claude-opus-5.5",
			name: "Name claude-opus-5.5",
			endpoints: ["/v1/messages", "/chat/completions"],
			reasoningEfforts: CLAUDE_EFFORTS,
			adaptiveThinking: true,
			policyState: "enabled",
			pickerEnabled: true,
			vision: true,
			maxContextWindowTokens: 328000,
			maxPromptTokens: 200000,
			maxOutputTokens: 128000,
		});
	});

	it("skips malformed entries and tolerates missing capabilities", () => {
		const parsed = parseCopilotModels({ data: [null, { name: "no id" }, { id: "bare" }] });
		expect(parsed).toEqual([{ id: "bare", endpoints: [] }]);
	});

	it("throws when the response has no data array", () => {
		expect(() => parseCopilotModels({ models: [] })).toThrow("missing data array");
	});
});

describe("isCopilotClaudeMessagesModel", () => {
	it.each(["claude-haiku-4.5", "claude-sonnet-4.6", "claude-opus-5.5", "claude-haiku-5.5", "claude-opus-10"])(
		"accepts %s",
		(id) => expect(isCopilotClaudeMessagesModel(id)).toBe(true),
	);
	it.each(["claude-fable-5", "claude-3-5-sonnet", "claude-sonnet-3.7", "gpt-6-sol"])("rejects %s", (id) =>
		expect(isCopilotClaudeMessagesModel(id)).toBe(false),
	);
});

describe("applyCopilotModelDiscovery", () => {
	const builtIn = getModels("github-copilot") as Model<Api>[];
	const other = getModel("anthropic", "claude-opus-5-5") as Model<Api>;
	const discovered = parseCopilotModels(LIVE_RESPONSE);
	// Synthetic catalog entries so these cases survive catalog churn.
	const completionsBase = builtIn.find((model) => model.api === "openai-completions")!;
	const responsesBase = builtIn.find((model) => model.api === "openai-responses")!;
	const asCompletions = (id: string): Model<Api> => ({ ...completionsBase, id, reasoning: true });
	const asResponses = (id: string): Model<Api> => ({ ...responsesBase, id, reasoning: true });

	it("hides built-in Copilot models the account does not list", () => {
		const result = applyCopilotModelDiscovery([other, ...builtIn], discovered);
		const listed = new Set(discovered.map((model) => model.id));

		expect(copilotIds(result).every((id) => listed.has(id))).toBe(true);
		expect(copilotIds(result)).toEqual(copilotIds(builtIn).filter((id) => listed.has(id)));
		expect(builtIn.some((model) => !listed.has(model.id))).toBe(true);
		expect(result[0]).toBe(other);
	});

	it("hides models whose policy is disabled", () => {
		const result = applyCopilotModelDiscovery(builtIn, [
			...discovered.filter((model) => model.id !== "claude-sonnet-5.5"),
			{ id: "claude-sonnet-5.5", endpoints: ["/v1/messages"], policyState: "disabled" },
		]);
		expect(copilotIds(result)).not.toContain("claude-sonnet-5.5");
	});

	it("keeps unlisted custom models.json entries", () => {
		const custom = { ...builtIn[0], id: "my-custom-copilot-model" };
		const result = applyCopilotModelDiscovery([...builtIn, custom], discovered);
		expect(copilotIds(result)).toContain("my-custom-copilot-model");
	});

	it("routes Claude to Anthropic Messages and applies advertised efforts", () => {
		const stale = { ...getModel("github-copilot", "claude-opus-5.5"), api: "openai-completions" } as Model<Api>;
		stale.compat = { supportsReasoningEffort: false } as Model<Api>["compat"];
		const [opus] = applyCopilotModelDiscovery([stale], discovered);

		expect(opus.api).toBe("anthropic-messages");
		expect(opus.compat).toBeUndefined();
		expect(opus.reasoningEfforts).toEqual(CLAUDE_EFFORTS);
		expect(supportsXhigh(opus)).toBe(true);
		expect(supportsMax(opus)).toBe(true);
		expect(supportsThinkingOff(opus)).toBe(false);
	});

	it("switches a model whose catalog endpoint is not served to the advertised one", () => {
		const mai = asCompletions("mai-code-1.1-flash");
		const [routed] = applyCopilotModelDiscovery([mai], discovered);
		expect(routed.api).toBe("openai-responses");
		expect(routed.compat).toBeUndefined();
	});

	it("keeps the catalog API when its endpoint is advertised and skips efforts on completions", () => {
		const gemini = asCompletions("gemini-3.8-flash");
		const [result] = applyCopilotModelDiscovery([gemini], discovered);

		expect(result.api).toBe("openai-completions");
		expect(result.compat).toEqual(gemini.compat);
		expect(result.reasoningEfforts).toBeUndefined();
	});

	it("applies advertised efforts to Responses models", () => {
		const gpt = asResponses("gpt-6-sol");
		const [result] = applyCopilotModelDiscovery([gpt], discovered);
		expect(result.reasoningEfforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
	});

	it("adds listed Claude models missing from the catalog, based on a Copilot Claude entry", () => {
		const future: CopilotModelInfo = {
			id: "claude-opus-6",
			name: "Claude Opus 6",
			endpoints: ["/v1/messages", "/chat/completions"],
			reasoningEfforts: CLAUDE_EFFORTS,
			adaptiveThinking: true,
			pickerEnabled: true,
			vision: true,
			maxContextWindowTokens: 400000,
			maxOutputTokens: 128000,
		};
		const result = applyCopilotModelDiscovery([other, ...builtIn], [...discovered, future]);
		const added = result.find((model) => model.id === "claude-opus-6")!;

		expect(added).toMatchObject({
			provider: "github-copilot",
			api: "anthropic-messages",
			name: "Claude Opus 6",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 400000,
			maxTokens: 128000,
			reasoningEfforts: CLAUDE_EFFORTS,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(added.headers?.["Copilot-Integration-Id"]).toBe("vscode-chat");
		expect(added.compat).toBeUndefined();
		// Added next to the other Copilot models, not after unrelated providers.
		const copilotIndexes = result.flatMap((model, index) => (model.provider === "github-copilot" ? [index] : []));
		expect(copilotIndexes).toEqual(copilotIndexes.map((_, i) => copilotIndexes[0] + i));
	});

	it.each<[string, Partial<CopilotModelInfo>]>([
		["not in the picker", { pickerEnabled: false }],
		["without /v1/messages", { endpoints: ["/chat/completions"] }],
		["disabled", { policyState: "disabled" }],
	])("does not add an unknown Claude model that is %s", (_label, overrides) => {
		const future: CopilotModelInfo = {
			id: "claude-opus-6",
			endpoints: ["/v1/messages"],
			pickerEnabled: true,
			...overrides,
		};
		const result = applyCopilotModelDiscovery(builtIn, [...discovered, future]);
		expect(copilotIds(result)).not.toContain("claude-opus-6");
	});

	it("does not add unknown non-Claude or Fable models", () => {
		const result = applyCopilotModelDiscovery(builtIn, [
			...discovered,
			{ id: "claude-fable-6", endpoints: ["/v1/messages"], pickerEnabled: true },
			{ id: "grok-9", endpoints: ["/chat/completions"], pickerEnabled: true },
		]);
		expect(copilotIds(result)).not.toContain("claude-fable-6");
		expect(copilotIds(result)).not.toContain("grok-9");
	});

	it("ignores an empty discovery list", () => {
		const models = [other, ...builtIn];
		expect(applyCopilotModelDiscovery(models, [])).toBe(models);
	});
});

describe("githubCopilotOAuthProvider model discovery", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubCopilotFetch(modelsResponse: () => Response): string[] {
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = String(input);
				urls.push(url);
				if (url.endsWith("/copilot_internal/v2/token")) {
					return new Response(JSON.stringify({ token: BUSINESS_TOKEN, expires_at: 9999999999 }), { status: 200 });
				}
				if (url.endsWith("/models")) return modelsResponse();
				throw new Error(`unexpected fetch ${url}`);
			}),
		);
		return urls;
	}

	it("stores discovered models on token refresh, from the token's endpoint", async () => {
		const urls = stubCopilotFetch(() => new Response(JSON.stringify(LIVE_RESPONSE), { status: 200 }));

		const refreshed = (await githubCopilotOAuthProvider.refreshToken({
			refresh: "gho_test",
			access: "old",
			expires: 0,
		})) as { access: string; models?: CopilotModelInfo[] };

		expect(refreshed.access).toBe(BUSINESS_TOKEN);
		expect(refreshed.models?.map((model) => model.id)).toContain("claude-opus-5.5");
		expect(urls).toContain("https://api.business.githubcopilot.com/models");
	});

	it("keeps the previous list when discovery fails during refresh", async () => {
		stubCopilotFetch(() => new Response("boom", { status: 500 }));
		const previous: CopilotModelInfo[] = [{ id: "claude-opus-5.5", endpoints: ["/v1/messages"] }];

		const refreshed = (await githubCopilotOAuthProvider.refreshToken({
			refresh: "gho_test",
			access: "old",
			expires: 0,
			models: previous,
		})) as { models?: CopilotModelInfo[] };

		expect(refreshed.models).toEqual(previous);
	});

	it("leaves models unset when discovery never succeeded", async () => {
		stubCopilotFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));

		const refreshed = (await githubCopilotOAuthProvider.refreshToken({
			refresh: "gho_test",
			access: "old",
			expires: 0,
		})) as { models?: CopilotModelInfo[] };

		expect(refreshed.models).toBeUndefined();
	});

	it("modifyModels only rewrites baseUrl without discovered models", () => {
		const builtIn = getModels("github-copilot") as Model<Api>[];
		const result = githubCopilotOAuthProvider.modifyModels!(builtIn, {
			refresh: "r",
			access: BUSINESS_TOKEN,
			expires: 0,
		});

		expect(copilotIds(result)).toEqual(builtIn.map((model) => model.id));
		expect(new Set(result.map((model) => model.baseUrl))).toEqual(
			new Set(["https://api.business.githubcopilot.com"]),
		);
	});

	it("modifyModels applies stored discovery and the token's baseUrl", () => {
		const builtIn = getModels("github-copilot") as Model<Api>[];
		const result = githubCopilotOAuthProvider.modifyModels!(builtIn, {
			refresh: "r",
			access: BUSINESS_TOKEN,
			expires: 0,
			models: parseCopilotModels(LIVE_RESPONSE),
		});

		const listed = new Set(parseCopilotModels(LIVE_RESPONSE).map((model) => model.id));
		expect(copilotIds(result)).toEqual(copilotIds(builtIn).filter((id) => listed.has(id)));
		expect(new Set(result.map((model) => model.baseUrl))).toEqual(
			new Set(["https://api.business.githubcopilot.com"]),
		);
		expect(result.find((model) => model.id === "claude-opus-5.5")?.reasoningEfforts).toEqual(CLAUDE_EFFORTS);
	});
});
