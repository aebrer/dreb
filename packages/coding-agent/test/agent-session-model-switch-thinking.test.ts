import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type ThinkingLevel } from "@dreb/agent-core";
import { type Api, findModel, type Model } from "@dreb/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	settingsManager: providedSettingsManager,
	initialModel = reasoningModel,
	resourceLoader = createTestResourceLoader(),
}: {
	thinkingLevel?: ThinkingLevel;
	defaultThinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	settingsManager?: SettingsManager;
	initialModel?: Model<Api>;
	resourceLoader?: ReturnType<typeof createTestResourceLoader>;
} = {}) {
	const settingsManager = providedSettingsManager ?? SettingsManager.inMemory({ defaultThinkingLevel });
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	authStorage.setRuntimeApiKey("openai", "test-key");
	authStorage.setRuntimeApiKey(initialModel.provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage, undefined);
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: initialModel,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel,
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry,
		resourceLoader,
		scopedModels,
	});

	return { session, sessionManager, settingsManager, modelRegistry };
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

describe("AgentSession model switching — prompt validation", () => {
	it.each(["setModel", "scoped cycle", "available cycle"] as const)(
		"rejects malformed target prompt settings atomically via %s",
		async (switchPath) => {
			const settingsManager = SettingsManager.inMemory({
				defaultProvider: reasoningModel.provider,
				defaultModel: reasoningModel.id,
				modelSettings: {
					[`${nonReasoningModel.provider}/${nonReasoningModel.id}`]: {
						systemPrompt: "REPLACEMENT",
						appendSystemPrompt: "APPEND",
					},
				},
			});
			const { session, sessionManager, modelRegistry } = createSession({
				settingsManager,
				scopedModels:
					switchPath === "scoped cycle" ? [{ model: reasoningModel }, { model: nonReasoningModel }] : undefined,
			});
			if (switchPath === "available cycle") {
				vi.spyOn(modelRegistry, "getAvailable").mockResolvedValue([reasoningModel, nonReasoningModel]);
			}
			const initialPrompt = session.systemPrompt;
			const initialEntries = sessionManager.getEntries();

			try {
				const switchModel = switchPath === "setModel" ? session.setModel(nonReasoningModel) : session.cycleModel();
				await expect(switchModel).rejects.toThrow("cannot define both systemPrompt and appendSystemPrompt");

				expect(session.model).toMatchObject({
					provider: reasoningModel.provider,
					id: reasoningModel.id,
				});
				expect(session.systemPrompt).toBe(initialPrompt);
				expect(sessionManager.getEntries()).toEqual(initialEntries);
				expect(settingsManager.getDefaultProvider()).toBe(reasoningModel.provider);
				expect(settingsManager.getDefaultModel()).toBe(reasoningModel.id);
			} finally {
				session.dispose();
			}
		},
	);
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

	it("honors stored model settings when resuming an adaptive model", async () => {
		const resumedModelAppend = "RESUMED MODEL APPEND";
		const settingsManager = SettingsManager.inMemory({
			modelSettings: {
				[`${adaptiveModel.provider}/${adaptiveModel.id}`]: { appendSystemPrompt: resumedModelAppend },
			},
		});
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
			expect(session.systemPrompt).toContain(resumedModelAppend);
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

describe("AgentSession model-specific system prompts", () => {
	it("uses a canonical model replacement prompt while retaining runtime context", () => {
		const settingsManager = SettingsManager.inMemory({
			modelSettings: {
				[`${reasoningModel.provider}/${reasoningModel.id}`]: {
					systemPrompt: "MODEL REPLACEMENT",
				},
			},
		});
		const { session } = createSession({ settingsManager });

		try {
			expect(session.systemPrompt).toMatch(/^MODEL REPLACEMENT/);
			expect(session.systemPrompt).toContain(`You are running on: ${reasoningModel.provider}/${reasoningModel.id}`);
		} finally {
			session.dispose();
		}
	});

	it("keeps an explicit session replacement ahead of the model replacement", () => {
		const settingsManager = SettingsManager.inMemory({
			modelSettings: {
				[`${reasoningModel.provider}/${reasoningModel.id}`]: {
					systemPrompt: "MODEL REPLACEMENT",
				},
			},
		});
		const { session } = createSession({
			settingsManager,
			resourceLoader: createTestResourceLoader({ systemPrompt: "EXPLICIT REPLACEMENT" }),
		});

		try {
			expect(session.systemPrompt).toMatch(/^EXPLICIT REPLACEMENT/);
			expect(session.systemPrompt).not.toContain("MODEL REPLACEMENT");
		} finally {
			session.dispose();
		}
	});

	it("appends after loader prompts and replaces model instructions when cycling", async () => {
		const firstAppend = "FIRST MODEL APPEND";
		const secondAppend = "SECOND MODEL APPEND";
		const loaderAppend = "LOADER APPEND";
		const settingsManager = SettingsManager.inMemory({
			modelSettings: {
				[`${reasoningModel.provider}/${reasoningModel.id}`]: { appendSystemPrompt: firstAppend },
				[`${nonReasoningModel.provider}/${nonReasoningModel.id}`]: { appendSystemPrompt: secondAppend },
			},
		});
		const { session } = createSession({
			settingsManager,
			resourceLoader: createTestResourceLoader({ appendSystemPrompt: [loaderAppend] }),
			scopedModels: [{ model: reasoningModel }, { model: nonReasoningModel }],
		});

		try {
			expect(session.systemPrompt.indexOf(loaderAppend)).toBeLessThan(session.systemPrompt.indexOf(firstAppend));
			expect(session.systemPrompt).not.toContain(secondAppend);

			await session.cycleModel();

			expect(session.systemPrompt).toContain(loaderAppend);
			expect(session.systemPrompt).not.toContain(firstAppend);
			expect(session.systemPrompt).toContain(secondAppend);
		} finally {
			session.dispose();
		}
	});

	it("reloads externally edited model prompt settings", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "dreb-model-prompt-project-"));
		const agentDir = mkdtempSync(join(tmpdir(), "dreb-model-prompt-agent-"));
		const settingsPath = join(agentDir, "settings.json");
		const modelRef = `${reasoningModel.provider}/${reasoningModel.id}`;
		writeFileSync(
			settingsPath,
			JSON.stringify({ modelSettings: { [modelRef]: { appendSystemPrompt: "BEFORE RELOAD" } } }),
		);
		const settingsManager = SettingsManager.create(projectDir, agentDir);
		const { session } = createSession({ settingsManager });

		try {
			expect(session.systemPrompt).toContain("BEFORE RELOAD");
			writeFileSync(
				settingsPath,
				JSON.stringify({ modelSettings: { [modelRef]: { appendSystemPrompt: "AFTER RELOAD" } } }),
			);

			await session.reload();

			expect(session.systemPrompt).not.toContain("BEFORE RELOAD");
			expect(session.systemPrompt).toContain("AFTER RELOAD");
		} finally {
			session.dispose();
			rmSync(projectDir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("applies prompt settings to a custom model whose ID contains slashes", () => {
		const customModel: Model<Api> = {
			...nonReasoningModel,
			provider: "ollama",
			id: "team/qwen-local",
			name: "Qwen Local",
			baseUrl: "http://localhost:11434/v1",
		};
		const customAppend = "CUSTOM LOCAL MODEL APPEND";
		const settingsManager = SettingsManager.inMemory({
			modelSettings: {
				[`${customModel.provider}/${customModel.id}`]: { appendSystemPrompt: customAppend },
			},
		});
		const { session } = createSession({ settingsManager, initialModel: customModel });

		try {
			expect(session.systemPrompt).toContain(customAppend);
			expect(session.systemPrompt).toContain("You are running on: ollama/team/qwen-local");
		} finally {
			session.dispose();
		}
	});
});
