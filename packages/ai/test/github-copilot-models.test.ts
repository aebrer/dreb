import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel, getModels } from "../src/models.js";
import type { Api, Model } from "../src/types.js";
import { githubCopilotOAuthProvider } from "../src/utils/oauth/github-copilot.js";
import {
	applyCopilotModelDiscovery,
	type CopilotModelInfo,
	parseCopilotModels,
} from "../src/utils/oauth/github-copilot-models.js";

const BUSINESS_TOKEN = "tid=test;exp=9999999999;proxy-ep=proxy.business.githubcopilot.com;";

/** Trimmed shape of a real Copilot `/models` response (business account, 2026-10-19). */
function copilotModel(
	id: string,
	options: { endpoints?: string[]; policy?: string; type?: string } = {},
): Record<string, unknown> {
	return {
		id,
		name: `Name ${id}`,
		object: "model",
		vendor: "Anthropic",
		model_picker_enabled: true,
		...(options.policy ? { policy: { state: options.policy } } : {}),
		supported_endpoints: options.endpoints ?? ["/v1/messages", "/chat/completions"],
		capabilities: {
			type: options.type ?? "chat",
			limits: { max_context_window_tokens: 328000, max_prompt_tokens: 200000, max_output_tokens: 128000 },
			supports: {
				adaptive_thinking: true,
				reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
				tool_calls: true,
				streaming: true,
			},
		},
	};
}

const LIVE_RESPONSE = {
	data: [
		copilotModel("claude-opus-5.5", { policy: "enabled" }),
		copilotModel("claude-sonnet-5.5", { policy: "enabled" }),
		copilotModel("claude-haiku-5.5", { policy: "enabled" }),
		copilotModel("gpt-6-sol", { endpoints: ["/responses", "ws:/responses"] }),
		copilotModel("gemini-3.8-flash", { endpoints: ["/chat/completions"] }),
		copilotModel("mai-code-1.1-flash", { endpoints: ["/responses", "ws:/responses"] }),
		copilotModel("text-embedding-3-small", { endpoints: [], type: "embeddings" }),
		copilotModel("gpt-4o", { endpoints: [] }),
	],
};

function copilotIds(models: Model<Api>[]): string[] {
	return models.filter((model) => model.provider === "github-copilot").map((model) => model.id);
}

describe("parseCopilotModels", () => {
	it("keeps chat models with their endpoints and policy state", () => {
		const parsed = parseCopilotModels(LIVE_RESPONSE);

		expect(parsed.map((model) => model.id)).not.toContain("text-embedding-3-small");
		expect(parsed.find((model) => model.id === "claude-opus-5.5")).toEqual({
			id: "claude-opus-5.5",
			endpoints: ["/v1/messages", "/chat/completions"],
			policyState: "enabled",
		});
	});

	it("skips malformed entries and tolerates missing capabilities", () => {
		const parsed = parseCopilotModels({
			data: [null, { name: "no id" }, { id: "bare" }, { id: "mixed", supported_endpoints: ["/responses", 7] }],
		});
		expect(parsed).toEqual([
			{ id: "bare", endpoints: [] },
			{ id: "mixed", endpoints: ["/responses"] },
		]);
	});

	it("throws when the response has no data array", () => {
		expect(() => parseCopilotModels({ models: [] })).toThrow("missing data array");
	});
});

describe("applyCopilotModelDiscovery", () => {
	const builtIn = getModels("github-copilot") as Model<Api>[];
	const other = getModel("anthropic", "claude-opus-5-5") as Model<Api>;
	const discovered = parseCopilotModels(LIVE_RESPONSE);
	// Synthetic catalog entries so these cases survive catalog churn.
	const completionsBase = builtIn.find((model) => model.api === "openai-completions")!;
	const asCompletions = (id: string): Model<Api> => ({ ...completionsBase, id, reasoning: true });

	it("hides built-in Copilot models the account does not list", () => {
		const result = applyCopilotModelDiscovery([other, ...builtIn], discovered);
		const listed = new Set(discovered.map((model) => model.id));

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

	it("keeps catalog Claude models on Anthropic Messages when /v1/messages is advertised", () => {
		const catalogOpus = getModel("github-copilot", "claude-opus-5.5") as Model<Api>;
		const [opus] = applyCopilotModelDiscovery([catalogOpus], discovered);
		expect(opus.api).toBe("anthropic-messages");
		expect(opus.compat).toBeUndefined();
	});

	it("does not add listed models that are missing from the catalog", () => {
		const result = applyCopilotModelDiscovery(builtIn, [
			...discovered,
			{ id: "claude-opus-6", endpoints: ["/v1/messages"], policyState: "enabled" },
		]);
		expect(copilotIds(result)).not.toContain("claude-opus-6");
	});

	it("switches a model whose catalog endpoint is not served to the advertised one", () => {
		const mai = asCompletions("mai-code-1.1-flash");
		const [routed] = applyCopilotModelDiscovery([mai], discovered);
		expect(routed.api).toBe("openai-responses");
		expect(routed.compat).toBeUndefined();
	});

	it("switches to completions with Copilot's compat when only /chat/completions is served", () => {
		const responsesBase = builtIn.find((model) => model.api === "openai-responses")!;
		const gemini = { ...responsesBase, id: "gemini-3.8-flash" } as Model<Api>;
		const [routed] = applyCopilotModelDiscovery([gemini], discovered);
		expect(routed.api).toBe("openai-completions");
		expect(routed.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		});
	});

	it("keeps the catalog API when its endpoint is advertised", () => {
		const gemini = asCompletions("gemini-3.8-flash");
		const [result] = applyCopilotModelDiscovery([gemini], discovered);
		expect(result).toBe(gemini);
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

	it("replaces a previously stored list when discovery succeeds", async () => {
		stubCopilotFetch(() => new Response(JSON.stringify(LIVE_RESPONSE), { status: 200 }));

		const refreshed = (await githubCopilotOAuthProvider.refreshToken({
			refresh: "gho_test",
			access: "old",
			expires: 0,
			models: [{ id: "old-model", endpoints: [] }],
		})) as { models?: CopilotModelInfo[] };

		expect(refreshed.models).toEqual(parseCopilotModels(LIVE_RESPONSE));
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
	});
});
