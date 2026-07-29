import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@dreb/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	DispatchArbiter,
	type DispatchArbitrationRequest,
	formatDispatchArbitrationRecord,
} from "../src/core/dispatch-arbiter.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import type { SubagentArbiterSettings } from "../src/core/settings-manager.js";

const REQUIRED_SUBSECTIONS = [
	"Capabilities and thinking support",
	"Strengths",
	"Weaknesses and failure modes",
	"Recommended roles and tasks",
	"Discouraged roles and tasks",
	"Tool use, long context, and vision",
	"Latency and cost",
	"Local evidence",
	"External evidence and contrary findings",
	"Confidence and limitations",
	"Sources",
];

function model(provider: string, id: string, reasoning = true): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "https://example.invalid",
		reasoning,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	} as Model<Api>;
}

function guide(modelIds: string[]): string {
	return `---
schema_version: 1
generated_at: "2026-07-28T00:00:00Z"
covered_model_ids:
${modelIds.map((id) => `  - "${id}"`).join("\n")}
local_evidence: "cold-start"
analyzed_session_directories:
  - "~/.dreb/agent/subagent-sessions/"
session_date_range:
  start: null
  end: null
---
# Model Routing Guide
## Routing safeguards
Use role and cost fit.
${modelIds
	.map((id) => `## Model: ${id}\n${REQUIRED_SUBSECTIONS.map((name) => `### ${name}\nUnknown`).join("\n")}`)
	.join("\n")}
`;
}

function response(value: unknown): AssistantMessage {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return { content: [{ type: "text", text }] } as AssistantMessage;
}

const arbiterModel = model("provider", "router");
const workerModel = model("provider", "worker");
const cheapModel = model("other", "cheap", false);
const allModels = [arbiterModel, workerModel, cheapModel];

let tempDir: string;
let guidePath: string;
let settings: SubagentArbiterSettings | undefined;
let complete: ReturnType<typeof vi.fn>;
let registry: ModelRegistry;

const request: DispatchArbitrationRequest = {
	task: "Implement the feature without changing this task",
	cwd: "/tmp/project",
	proposed: { agent: "Explore", model: "provider/worker", thinking: "high" },
	agents: [
		{ name: "Explore", description: "factual research", tools: ["read", "grep"], modelDefaults: [] },
		{
			name: "feature-dev",
			description: "implementation",
			tools: ["read", "edit", "write"],
			modelDefaults: ["provider/worker"],
		},
	],
	parentSessionFile: "/tmp/parent.jsonl",
};

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "dreb-dispatch-arbiter-"));
	guidePath = join(tempDir, "guide.md");
	writeFileSync(guidePath, guide(["provider/worker", "other/cheap"]));
	settings = { enabled: true, model: "provider/router", thinking: "medium", guidePath };
	complete = vi.fn();
	registry = {
		find: (provider: string, id: string) =>
			allModels.find((candidate) => candidate.provider === provider && candidate.id === id),
		getApiKey: vi.fn().mockResolvedValue("api-key"),
	} as unknown as ModelRegistry;
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function createArbiter(
	candidateModels = [{ model: workerModel }, { model: cheapModel }],
	timeoutMs?: number,
	getSettings: () => SubagentArbiterSettings | undefined = () => settings,
) {
	return new DispatchArbiter({
		getSettings,
		getCandidateModels: () => candidateModels,
		getModelRegistry: () => registry,
		getMessages: () => [
			{ role: "user", content: "Initial request sk-123456789012345678901234567890" },
			{ role: "user", content: "Latest request" },
		],
		getParentModel: () => workerModel,
		getSessionTitle: () => "Implement routing",
		getRepoMetadata: () => ({ repo: "project", cwd: "/tmp/project", branch: "feature/test", dirtyCount: 2 }),
		getExtraSecretPatterns: () => [{ name: "auth_secret", pattern: /AUTH_SECRET_[0-9]+/g }],
		complete: complete as never,
		timeoutMs,
	});
}

describe("DispatchArbiter", () => {
	test("is a true disabled passthrough with no guide read or model call", async () => {
		settings = undefined;
		rmSync(guidePath);
		const result = await createArbiter().arbitrate(request);
		expect(result).toEqual({ enabled: false });
		expect(complete).not.toHaveBeenCalled();
	});

	test("turns global settings refresh errors into actionable fail-closed configuration failures", async () => {
		const result = await createArbiter(undefined, undefined, () => {
			throw new Error("settings file is unreadable");
		}).arbitrate(request);

		expect(result).toMatchObject({
			enabled: true,
			ok: false,
			code: "invalid_config",
			error: expect.stringContaining("settings file is unreadable"),
		});
		expect(complete).not.toHaveBeenCalled();
	});

	test("uses a direct tool-less call with rolling context, scrubbing, and a validated changed route", async () => {
		complete.mockResolvedValue(response({ agent: "feature-dev", model: "other/cheap", thinking: "off" }));
		const arbiter = createArbiter();
		arbiter.onMessageEnd({ role: "assistant", content: [{ type: "text", text: "Inspected source files" }] });
		arbiter.onToolEnd({ toolName: "read", result: { content: "done" } });

		const result = await arbiter.arbitrate(request);
		expect(result).toEqual({
			enabled: true,
			ok: true,
			decision: { agent: "feature-dev", model: "other/cheap", thinking: "off" },
			changed: ["agent", "model", "thinking"],
		});
		expect(complete).toHaveBeenCalledTimes(1);
		const [calledModel, context, options] = complete.mock.calls[0];
		expect(calledModel).toBe(arbiterModel);
		expect(context.tools).toBeUndefined();
		expect(context.messages[0].content).toContain("Inspected source files");
		expect(context.messages[0].content).toContain("Tool read completed");
		expect(context.messages[0].content).not.toContain("sk-123456789012345678901234567890");
		expect(options.apiKey).toBe("api-key");
		expect(options.reasoning).toBe("medium");
	});

	test("retries malformed output once without including raw output in the retry", async () => {
		complete
			.mockResolvedValueOnce(response("```json\n{}\n```"))
			.mockResolvedValueOnce(response({ agent: "Explore", model: "provider/worker", thinking: "high" }));
		const result = await createArbiter().arbitrate(request);
		expect(result).toMatchObject({ enabled: true, ok: true, changed: [] });
		expect(complete).toHaveBeenCalledTimes(2);
		const retryContext = complete.mock.calls[1][1];
		expect(retryContext.messages[1].content).toContain("previous response did not match");
		expect(retryContext.messages[1].content).not.toContain("```json");
	});

	test("rejects otherwise valid decisions containing model-authored extra keys", async () => {
		complete.mockResolvedValue(
			response({
				agent: "Explore",
				model: "provider/worker",
				thinking: "high",
				rationale: "RAW MODEL RATIONALE",
			}),
		);

		const result = await createArbiter().arbitrate(request);

		expect(result).toMatchObject({ enabled: true, ok: false, code: "malformed_output" });
		expect(complete).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(result)).not.toContain("RAW MODEL RATIONALE");
		expect(JSON.stringify(complete.mock.calls[1][1])).not.toContain("RAW MODEL RATIONALE");
	});

	test("bounds injected calls with timeout and parent abort before child spawn", async () => {
		complete.mockImplementation(() => new Promise(() => {}));
		expect(await createArbiter(undefined, 5).arbitrate(request)).toMatchObject({
			enabled: true,
			ok: false,
			code: "timeout",
		});

		complete.mockReset();
		complete.mockImplementation(() => new Promise(() => {}));
		const controller = new AbortController();
		const inFlight = createArbiter().arbitrate(request, controller.signal);
		await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
		controller.abort();
		expect(await inFlight).toMatchObject({
			enabled: true,
			ok: false,
			code: "aborted",
		});
	});

	test("fails closed and scrubs errors when arbiter authentication fails", async () => {
		vi.mocked(registry.getApiKey).mockRejectedValue(new Error("credential lookup failed for AUTH_SECRET_123"));

		const result = await createArbiter().arbitrate(request);

		expect(result).toMatchObject({
			enabled: true,
			ok: false,
			code: "arbiter_model",
			error: expect.stringContaining("<REDACTED:auth_secret>"),
		});
		expect(JSON.stringify(result)).not.toContain("AUTH_SECRET_123");
		expect(complete).not.toHaveBeenCalled();
	});

	test("treats resolved provider error messages as inference failures without retry", async () => {
		complete.mockResolvedValue({ stopReason: "error", errorMessage: "provider unavailable", content: [] });
		const result = await createArbiter().arbitrate(request);
		expect(result).toMatchObject({ enabled: true, ok: false, code: "inference_failed" });
		expect(complete).toHaveBeenCalledTimes(1);
	});

	test("fails closed for malformed output without exposing raw model text", async () => {
		complete.mockResolvedValue(response("SECRET RAW NON-JSON"));
		const result = await createArbiter().arbitrate(request);
		expect(result).toMatchObject({ enabled: true, ok: false, code: "malformed_output" });
		expect(JSON.stringify(result)).not.toContain("SECRET RAW");
	});

	test.each([
		[{ agent: "missing", model: "provider/worker", thinking: "high" }, "unknown_agent"],
		[{ agent: "Explore", model: "provider/router", thinking: "high" }, "out_of_scope_model"],
		[{ agent: "Explore", model: "other/cheap", thinking: "high" }, "unsupported_thinking"],
	] as const)("rejects invalid decision %j", async (decision, code) => {
		complete.mockResolvedValue(response(decision));
		const result = await createArbiter().arbitrate(request);
		expect(result).toMatchObject({ enabled: true, ok: false, code });
	});

	test("rejects an oversized aggregate package before provider inference", async () => {
		const oversizedRequest: DispatchArbitrationRequest = {
			...request,
			agents: Array.from({ length: 200 }, (_, index) => ({
				name: `agent-${index}`,
				description: "x".repeat(1_000),
				tools: ["read", "grep"],
				modelDefaults: ["provider/worker"],
			})),
		};

		const result = await createArbiter().arbitrate(oversizedRequest);
		expect(result).toMatchObject({ enabled: true, ok: false, code: "context_too_large" });
		expect(complete).not.toHaveBeenCalled();
	});

	test("fails before inference for missing scope, guide, model, and unsupported arbiter thinking", async () => {
		expect(await createArbiter([]).arbitrate(request)).toMatchObject({ code: "missing_scope" });

		settings = { ...settings, guidePath: join(tempDir, "missing.md") };
		expect(await createArbiter().arbitrate(request)).toMatchObject({ code: "invalid_guide" });

		settings = { enabled: true, model: "provider/missing", guidePath };
		expect(await createArbiter().arbitrate(request)).toMatchObject({ code: "arbiter_model" });

		settings = { enabled: true, model: "other/cheap", thinking: "high", guidePath };
		expect(await createArbiter().arbitrate(request)).toMatchObject({ code: "arbiter_thinking" });
		expect(complete).not.toHaveBeenCalled();
	});

	test("scrubs provider errors and formats only host-generated action metadata", async () => {
		complete.mockRejectedValue(new Error("provider failed with sk-123456789012345678901234567890"));
		const result = await createArbiter().arbitrate(request);
		expect(result).toMatchObject({ enabled: true, ok: false, code: "inference_failed" });
		expect(JSON.stringify(result)).toContain("<REDACTED:openai_key>");
		expect(
			formatDispatchArbitrationRecord({
				status: "success",
				proposed: request.proposed,
				final: { agent: "feature-dev", model: "other/cheap", thinking: "off" },
				changed: ["agent", "model", "thinking"],
			}),
		).toContain("Explore → feature-dev");
	});
});
