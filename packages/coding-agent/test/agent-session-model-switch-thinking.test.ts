import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type ThinkingLevel } from "@dreb/agent-core";
import { findModel } from "@dreb/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const reasoningModel = findModel("anthropic", "sonnet")!;
const nonReasoningModel = findModel("openai", "gpt-4o-mini")!;

// Adaptive-thinking model (Opus/Sonnet 4.6+): thinkingDisplay is honored, defaults to "summarized".
const adaptiveModel = findModel("anthropic", "opus-4-8")!;
// Reasoning model that is NOT adaptive: thinkingDisplay resolves to undefined.
const nonAdaptiveModel = findModel("anthropic", "sonnet-4-5")!;

function createSession({
	thinkingLevel = "high",
	defaultThinkingLevel = thinkingLevel,
	scopedModels,
}: {
	thinkingLevel?: ThinkingLevel;
	defaultThinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: typeof reasoningModel; thinkingLevel?: ThinkingLevel }>;
} = {}) {
	const settingsManager = SettingsManager.inMemory({ defaultThinkingLevel });
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	authStorage.setRuntimeApiKey("openai", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: reasoningModel,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel,
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: new ModelRegistry(authStorage, undefined),
		resourceLoader: createTestResourceLoader(),
		scopedModels,
	});

	return { session, sessionManager, settingsManager };
}

function createThinkingDisplaySession(settingsManager: SettingsManager = SettingsManager.inMemory()) {
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: adaptiveModel,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: new ModelRegistry(authStorage, undefined),
		resourceLoader: createTestResourceLoader(),
		scopedModels: [{ model: adaptiveModel }, { model: nonAdaptiveModel }],
	});

	return { session, settingsManager };
}

describe("AgentSession model switching", () => {
	it("preserves the saved thinking preference through non-reasoning models", async () => {
		const { session, sessionManager, settingsManager } = createSession({
			scopedModels: [{ model: reasoningModel }, { model: nonReasoningModel }],
		});

		try {
			await session.setModel(nonReasoningModel);
			expect(session.thinkingLevel).toBe("off");
			expect(settingsManager.getDefaultThinkingLevel()).toBe("high");

			await session.setModel(reasoningModel);
			expect(session.thinkingLevel).toBe("high");

			await session.cycleModel();
			expect(session.thinkingLevel).toBe("off");
			expect(settingsManager.getDefaultThinkingLevel()).toBe("high");

			await session.cycleModel();
			expect(session.thinkingLevel).toBe("high");
			expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
			expect(
				sessionManager
					.getEntries()
					.filter((entry) => entry.type === "thinking_level_change")
					.map((entry) => entry.thinkingLevel),
			).toEqual(["off", "high", "off", "high"]);
		} finally {
			session.dispose();
		}
	});
});

describe("AgentSession model switching — thinkingDisplay", () => {
	it("refreshes thinkingDisplay when switching between adaptive and non-adaptive models via setModel", async () => {
		const { session } = createThinkingDisplaySession();

		try {
			// (a) Adaptive model with no stored override → default-on "summarized".
			await session.setModel(adaptiveModel);
			expect(session.agent.thinkingDisplay).toBe("summarized");

			// (b) Non-adaptive model → undefined (the AI layer ignores the field).
			await session.setModel(nonAdaptiveModel);
			expect(session.agent.thinkingDisplay).toBeUndefined();

			// (c) Switching back to adaptive restores "summarized".
			await session.setModel(adaptiveModel);
			expect(session.agent.thinkingDisplay).toBe("summarized");
		} finally {
			session.dispose();
		}
	});

	it("preserves a stored omitted override for the adaptive model through a model cycle", async () => {
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setModelThinkingDisplay(adaptiveModel.id, "omitted");
		const { session } = createThinkingDisplaySession(settingsManager);

		try {
			// Start on the adaptive model — the stored override wins over the default.
			await session.setModel(adaptiveModel);
			expect(session.agent.thinkingDisplay).toBe("omitted");

			// Cycle forward to the non-adaptive model → undefined.
			await session.cycleModel();
			expect(session.model?.id).toBe(nonAdaptiveModel.id);
			expect(session.agent.thinkingDisplay).toBeUndefined();

			// Cycle forward back to the adaptive model → override still applies.
			await session.cycleModel();
			expect(session.model?.id).toBe(adaptiveModel.id);
			expect(session.agent.thinkingDisplay).toBe("omitted");
		} finally {
			session.dispose();
		}
	});
});

describe("AgentSession switchSession — thinkingDisplay", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	/** Write a minimal valid session file recording a model_change for the given model. */
	function writeSessionFileWithModel(model: typeof adaptiveModel): string {
		const dir = mkdtempSync(join(tmpdir(), "dreb-switch-session-"));
		tempDirs.push(dir);
		const sessionPath = join(dir, "session.jsonl");
		const timestamp = new Date().toISOString();
		const header = {
			type: "session",
			version: 3,
			id: "test-resume",
			timestamp,
			cwd: process.cwd(),
		};
		const modelChange = {
			type: "model_change",
			id: "mc1",
			parentId: null,
			timestamp,
			provider: model.provider,
			modelId: model.id,
		};
		writeFileSync(sessionPath, `${JSON.stringify(header)}\n${JSON.stringify(modelChange)}\n`);
		return sessionPath;
	}

	it("refreshes thinkingDisplay when resuming a session that saved an adaptive model", async () => {
		// Start on a non-adaptive model so thinkingDisplay begins undefined.
		const settingsManager = SettingsManager.inMemory();
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: nonAdaptiveModel,
					systemPrompt: "You are a helpful assistant.",
					tools: [],
					thinkingLevel: "high",
				},
			}),
			sessionManager,
			settingsManager,
			cwd: process.cwd(),
			modelRegistry: new ModelRegistry(authStorage, undefined),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			await session.setModel(nonAdaptiveModel);
			expect(session.agent.thinkingDisplay).toBeUndefined();

			// Resume a session whose saved model is the adaptive model.
			const sessionPath = writeSessionFileWithModel(adaptiveModel);
			const switched = await session.switchSession(sessionPath);

			expect(switched).toBe(true);
			expect(session.model?.id).toBe(adaptiveModel.id);
			expect(session.agent.thinkingDisplay).toBe("summarized");
		} finally {
			session.dispose();
		}
	});

	it("honors a stored thinkingDisplay override when resuming an adaptive model", async () => {
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setModelThinkingDisplay(adaptiveModel.id, "omitted");
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: nonAdaptiveModel,
					systemPrompt: "You are a helpful assistant.",
					tools: [],
					thinkingLevel: "high",
				},
			}),
			sessionManager,
			settingsManager,
			cwd: process.cwd(),
			modelRegistry: new ModelRegistry(authStorage, undefined),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			const sessionPath = writeSessionFileWithModel(adaptiveModel);
			const switched = await session.switchSession(sessionPath);

			expect(switched).toBe(true);
			expect(session.model?.id).toBe(adaptiveModel.id);
			expect(session.agent.thinkingDisplay).toBe("omitted");
		} finally {
			session.dispose();
		}
	});
});

describe("AgentSession model switching — system prompt identity", () => {
	it("updates the active system prompt to reflect the new model after setModel()", async () => {
		const { session } = createSession();

		try {
			await session.setModel(nonReasoningModel);

			expect(session.systemPrompt).toContain(
				`You are running on: ${nonReasoningModel.provider}/${nonReasoningModel.id}`,
			);
			expect(session.systemPrompt).not.toContain(reasoningModel.id);
		} finally {
			session.dispose();
		}
	});

	it("updates the active system prompt to reflect the new model after cycleModel()", async () => {
		const { session } = createSession({
			scopedModels: [{ model: reasoningModel }, { model: nonReasoningModel }],
		});

		try {
			await session.cycleModel();

			expect(session.model?.id).toBe(nonReasoningModel.id);
			expect(session.systemPrompt).toContain(
				`You are running on: ${nonReasoningModel.provider}/${nonReasoningModel.id}`,
			);
			expect(session.systemPrompt).not.toContain(reasoningModel.id);
		} finally {
			session.dispose();
		}
	});
});
