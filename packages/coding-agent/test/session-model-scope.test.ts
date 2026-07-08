import type { Model } from "@dreb/ai";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import type { ScopedModel } from "../src/core/model-resolver.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { buildSessionOptions } from "../src/main.js";
import { createTestResourceLoader, userMsg } from "./utilities.js";

function model(provider: string, id: string, name = id): Model<any> {
	return {
		provider,
		id,
		name,
		api: "anthropic-messages",
		input: ["text"],
		reasoning: true,
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200_000,
		maxTokens: 8192,
	} as Model<any>;
}

function registry(models: Model<any>[]): ModelRegistry {
	return {
		find: (provider: string, modelId: string) => models.find((m) => m.provider === provider && m.id === modelId),
		getAvailable: async () => models,
		getApiKey: async () => "test-key",
		getApiKeyForProvider: async () => "test-key",
		isUsingOAuth: () => false,
	} as unknown as ModelRegistry;
}

async function createResumedSessionWithOptions(scopedModels: ScopedModel[]) {
	const stored = model("anthropic", "stored-model", "Stored Model");
	const scoped = model("anthropic", "scoped-model", "Scoped Model");
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendModelChange(stored.provider, stored.id);
	sessionManager.appendMessage(userMsg("hello"));

	const modelRegistry = registry([scoped, stored]);
	const settingsManager = SettingsManager.inMemory();
	const parsed = parseArgs(["--session", "/tmp/session.jsonl"]);
	const { options } = buildSessionOptions(parsed, scopedModels, sessionManager, modelRegistry, settingsManager);

	const result = await createAgentSession({
		...options,
		sessionManager,
		modelRegistry,
		settingsManager,
		resourceLoader: createTestResourceLoader(),
		cwd: "/tmp",
	});

	return { session: result.session, stored, scoped };
}

describe("session resume model scoping", () => {
	it("does not let scoped models clobber the stored model for --session resumes", async () => {
		const scoped = model("anthropic", "scoped-model", "Scoped Model");
		const { session, stored } = await createResumedSessionWithOptions([{ model: scoped }]);
		try {
			expect(session.model?.provider).toBe(stored.provider);
			expect(session.model?.id).toBe(stored.id);
		} finally {
			session.dispose();
		}
	});

	it("keeps resume behavior unchanged when no scoped models are configured", async () => {
		const { session, stored } = await createResumedSessionWithOptions([]);
		try {
			expect(session.model?.provider).toBe(stored.provider);
			expect(session.model?.id).toBe(stored.id);
		} finally {
			session.dispose();
		}
	});

	it("passes scoped models to SDK initial model resolution for empty new sessions", async () => {
		const defaultModel = model("anthropic", "default-model", "Default Model");
		const scoped = model("anthropic", "scoped-model", "Scoped Model");
		const sessionManager = SessionManager.inMemory();
		const result = await createAgentSession({
			sessionManager,
			modelRegistry: registry([defaultModel, scoped]),
			settingsManager: SettingsManager.inMemory({
				defaultProvider: defaultModel.provider,
				defaultModel: defaultModel.id,
			}),
			resourceLoader: createTestResourceLoader(),
			cwd: "/tmp",
			scopedModels: [{ model: scoped }],
		});
		try {
			expect(result.session.model?.provider).toBe(scoped.provider);
			expect(result.session.model?.id).toBe(scoped.id);
		} finally {
			result.session.dispose();
		}
	});
});
