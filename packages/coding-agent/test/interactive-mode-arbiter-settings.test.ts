import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@dreb/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SubagentArbiterSettings } from "../src/core/settings-manager.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

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

function model(reasoning = true): Model<Api> {
	return {
		provider: "provider",
		id: "router",
		name: "Router",
		api: "openai-responses",
		baseUrl: "https://example.invalid",
		reasoning,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	} as Model<Api>;
}

function guide(): string {
	return `---
schema_version: 1
generated_at: "2026-07-29T00:00:00Z"
covered_model_ids:
  - "provider/router"
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
## Model: provider/router
${REQUIRED_SUBSECTIONS.map((heading) => `### ${heading}\nUnknown`).join("\n")}
`;
}

function invokeHandler(fakeThis: object, settings: SubagentArbiterSettings): boolean {
	return (InteractiveMode as any).prototype.handleSubagentArbiterSettingsChange.call(fakeThis, settings);
}

async function invokeEvent(fakeThis: object, event: object): Promise<void> {
	await (InteractiveMode as any).prototype.handleEvent.call(fakeThis, event);
}

function makeFakeThis(params: { scopedModels?: Array<{ model: Model<Api> }>; routerModel?: Model<Api> } = {}) {
	const routerModel = params.routerModel ?? model();
	return {
		session: {
			modelRegistry: {
				find: vi.fn((provider: string, id: string) =>
					provider === routerModel.provider && id === routerModel.id ? routerModel : undefined,
				),
			},
			scopedModels: params.scopedModels ?? [{ model: routerModel }],
		},
		settingsManager: { setGlobalSubagentArbiterSettings: vi.fn() },
		showError: vi.fn(),
		showStatus: vi.fn(),
	};
}

let tempDir: string;
let guidePath: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "dreb-interactive-arbiter-settings-"));
	guidePath = join(tempDir, "guide.md");
	writeFileSync(guidePath, guide());
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("InteractiveMode Dispatch Arbiter settings callback", () => {
	test("rejects an invalid guide loudly without persisting enablement", () => {
		const fakeThis = makeFakeThis();

		expect(
			invokeHandler(fakeThis, {
				enabled: true,
				model: "provider/router",
				thinking: "high",
				guidePath: join(tempDir, "missing.md"),
			}),
		).toBe(false);
		expect(fakeThis.showError).toHaveBeenCalledWith(expect.stringContaining("Dispatch Arbiter is not ready"));
		expect(fakeThis.settingsManager.setGlobalSubagentArbiterSettings).not.toHaveBeenCalled();
	});

	test("rejects an empty live scope loudly without persisting enablement", () => {
		const fakeThis = makeFakeThis({ scopedModels: [] });

		expect(
			invokeHandler(fakeThis, {
				enabled: true,
				model: "provider/router",
				thinking: "high",
				guidePath,
			}),
		).toBe(false);
		expect(fakeThis.showError).toHaveBeenCalledWith(expect.stringContaining("non-empty explicit live model scope"));
		expect(fakeThis.settingsManager.setGlobalSubagentArbiterSettings).not.toHaveBeenCalled();
	});

	test("rejects unsupported thinking loudly without persisting enablement", () => {
		const nonReasoningModel = model(false);
		const fakeThis = makeFakeThis({ routerModel: nonReasoningModel, scopedModels: [{ model: nonReasoningModel }] });

		expect(
			invokeHandler(fakeThis, {
				enabled: true,
				model: "provider/router",
				thinking: "high",
				guidePath,
			}),
		).toBe(false);
		expect(fakeThis.showError).toHaveBeenCalledWith(expect.stringContaining("not supported by non-reasoning model"));
		expect(fakeThis.settingsManager.setGlobalSubagentArbiterSettings).not.toHaveBeenCalled();
	});

	test("persists a complete valid global policy and reports readiness", () => {
		const fakeThis = makeFakeThis();
		const settings: SubagentArbiterSettings = {
			enabled: true,
			model: "provider/router",
			thinking: "high",
			guidePath,
		};

		expect(invokeHandler(fakeThis, settings)).toBe(true);
		expect(fakeThis.settingsManager.setGlobalSubagentArbiterSettings).toHaveBeenCalledWith(settings);
		expect(fakeThis.showError).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Dispatch Arbiter enabled (provider/router, thinking high).");
	});
});

describe("InteractiveMode Dispatch Arbiter event rendering", () => {
	function makeEventFake() {
		return {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			updateBackgroundAgentStatus: vi.fn(),
		};
	}

	test("renders changed and unchanged decisions as status updates", async () => {
		const changed = makeEventFake();
		await invokeEvent(changed, {
			type: "subagent_arbitration",
			agentId: "agent-1",
			status: "success",
			proposed: { agent: "Explore", model: "provider/router", thinking: "high" },
			final: { agent: "feature-dev", model: "provider/router", thinking: "high" },
			changed: ["agent"],
		});
		expect(changed.showStatus).toHaveBeenCalledWith("Arbitration changed agent Explore → feature-dev.");
		expect(changed.showWarning).not.toHaveBeenCalled();
		expect(changed.updateBackgroundAgentStatus).toHaveBeenCalledOnce();

		const unchanged = makeEventFake();
		await invokeEvent(unchanged, {
			type: "subagent_arbitration",
			agentId: "agent-2",
			status: "success",
			proposed: { agent: "Explore", model: "provider/router", thinking: "high" },
			final: { agent: "Explore", model: "provider/router", thinking: "high" },
			changed: [],
		});
		expect(unchanged.showStatus).toHaveBeenCalledWith("Arbitration kept the proposed route.");
		expect(unchanged.showWarning).not.toHaveBeenCalled();
		expect(unchanged.updateBackgroundAgentStatus).toHaveBeenCalledOnce();
	});

	test("renders failed decisions as warnings and refreshes background status", async () => {
		const fakeThis = makeEventFake();
		await invokeEvent(fakeThis, {
			type: "subagent_arbitration",
			agentId: "agent-3",
			status: "failure",
			proposed: { agent: "Explore", model: "provider/router", thinking: "high" },
			final: null,
			changed: [],
			errorCode: "invalid_guide",
			errorMessage: "Routing guide coverage is stale.",
		});
		expect(fakeThis.showWarning).toHaveBeenCalledWith("Arbitration failed: Routing guide coverage is stale.");
		expect(fakeThis.showStatus).not.toHaveBeenCalled();
		expect(fakeThis.updateBackgroundAgentStatus).toHaveBeenCalledOnce();
	});
});
