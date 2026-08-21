import { findModel } from "@dreb/ai";
import type { TUI } from "@dreb/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const currentModel = findModel("anthropic", "sonnet-4-5")!;
const malformedTarget = findModel("openai", "gpt-4o-mini")!;

beforeAll(() => {
	initTheme("dark");
});

describe("ModelSelectorComponent", () => {
	it("leaves the persisted default unchanged when target prompt validation rejects", async () => {
		const settingsManager = SettingsManager.inMemory({
			modelSettings: {
				[`${malformedTarget.provider}/${malformedTarget.id}`]: {
					systemPrompt: "REPLACEMENT",
					appendSystemPrompt: "APPEND",
				},
			},
		});
		settingsManager.setDefaultModelAndProvider(currentModel.provider, currentModel.id);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(malformedTarget.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, undefined);
		const requestRender = vi.fn();
		const selector = new ModelSelectorComponent(
			{ requestRender } as unknown as TUI,
			currentModel,
			modelRegistry,
			[{ model: malformedTarget }],
			(model) => settingsManager.getModelPromptSettings(model.provider, model.id),
			vi.fn(),
		);
		await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());

		expect(() => selector.handleInput("\r")).toThrow("cannot define both systemPrompt and appendSystemPrompt");
		expect(settingsManager.getDefaultProvider()).toBe(currentModel.provider);
		expect(settingsManager.getDefaultModel()).toBe(currentModel.id);
	});
});
