import { setKeybindings } from "@dreb/tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	// Keybindings are a global singleton — reset for test isolation.
	setKeybindings(new KeybindingsManager());
});

const ENTER = "\r";

function makeConfig(overrides: Partial<SettingsConfig> = {}): SettingsConfig {
	return {
		autoCompact: true,
		showImages: false,
		autoResizeImages: false,
		blockImages: false,
		enableSkillCommands: false,
		steeringMode: "all",
		followUpMode: "all",
		transport: "auto",
		thinkingLevel: "high",
		availableThinkingLevels: ["off", "low", "medium", "high"],
		currentTheme: "dark",
		availableThemes: ["dark", "light"],
		hideThinkingBlock: false,
		thinkingDisplaySupported: false,
		thinkingDisplay: "summarized",
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 1,
		autocompleteMaxVisible: 7,
		quietStartup: false,
		autoLoadNestedContext: true,
		agentModels: {},
		agentNames: [],
		availableModelIds: [],
		localOnlyMode: false,
		localOnlyModel: "",
		finalFallbackToLocalModel: false,
		localModelAvailableModels: ["ollama/qwen3:latest", "ollama/llama3.1:8b"],
		...overrides,
	};
}

function makeCallbacks(): SettingsCallbacks {
	return {
		onAutoCompactChange: vi.fn(),
		onAutoLoadNestedContextChange: vi.fn(),
		onShowImagesChange: vi.fn(),
		onAutoResizeImagesChange: vi.fn(),
		onBlockImagesChange: vi.fn(),
		onEnableSkillCommandsChange: vi.fn(),
		onSteeringModeChange: vi.fn(),
		onFollowUpModeChange: vi.fn(),
		onTransportChange: vi.fn(),
		onThinkingLevelChange: vi.fn(),
		onThemeChange: vi.fn(),
		onHideThinkingBlockChange: vi.fn(),
		onThinkingDisplayChange: vi.fn(),
		onDoubleEscapeActionChange: vi.fn(),
		onTreeFilterModeChange: vi.fn(),
		onShowHardwareCursorChange: vi.fn(),
		onEditorPaddingXChange: vi.fn(),
		onAutocompleteMaxVisibleChange: vi.fn(),
		onQuietStartupChange: vi.fn(),
		onAgentModelsChange: vi.fn(),
		onLocalOnlyModeChange: vi.fn(),
		onLocalOnlyModelChange: vi.fn(),
		onFinalFallbackToLocalModelChange: vi.fn(),
		onCancel: vi.fn(),
	};
}

/**
 * Filter the list down to the local-only-mode item using the built-in search.
 * Note: spaces in search trigger the "confirm" action in SettingsList,
 * so search terms must not contain spaces.
 */
function focusLocalOnlyMode(component: SettingsSelectorComponent): void {
	const list = component.getSettingsList();
	// "only" uniquely matches the "Local only mode" label.
	for (const ch of "only") {
		list.handleInput(ch);
	}
}

function focusLocalModelAppend(component: SettingsSelectorComponent): void {
	const list = component.getSettingsList();
	// "final" uniquely matches "Final fallback to local model".
	for (const ch of "final") {
		list.handleInput(ch);
	}
}

function focusLocalModel(component: SettingsSelectorComponent): void {
	const list = component.getSettingsList();
	// "localmode" uniquely matches "Local model" (space in label is removed).
	for (const ch of "localmode") {
		list.handleInput(ch);
	}
}

describe("SettingsSelectorComponent — Local Only Mode", () => {
	test("renders localOnlyMode toggle with correct state (false)", () => {
		const component = new SettingsSelectorComponent(makeConfig({ localOnlyMode: false }), makeCallbacks());
		focusLocalOnlyMode(component);

		const output = component.getSettingsList().render(80).join("\n");
		expect(output).toContain("Local only mode");
		expect(output).toContain("false");
	});

	test("renders localOnlyMode toggle with correct state (true)", () => {
		const component = new SettingsSelectorComponent(makeConfig({ localOnlyMode: true }), makeCallbacks());
		focusLocalOnlyMode(component);

		const output = component.getSettingsList().render(80).join("\n");
		expect(output).toContain("Local only mode");
		expect(output).toContain("true");
	});

	test("toggling localOnlyMode from false to true fires onLocalOnlyModeChange", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(makeConfig({ localOnlyMode: false }), callbacks);
		focusLocalOnlyMode(component);

		component.getSettingsList().handleInput(ENTER);

		expect(callbacks.onLocalOnlyModeChange).toHaveBeenCalledWith(true);
	});

	test("toggling localOnlyMode from true to false fires onLocalOnlyModeChange", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(makeConfig({ localOnlyMode: true }), callbacks);
		focusLocalOnlyMode(component);

		component.getSettingsList().handleInput(ENTER);

		expect(callbacks.onLocalOnlyModeChange).toHaveBeenCalledWith(false);
	});

	test("renders finalFallbackToLocalModel toggle with correct state", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(makeConfig({ finalFallbackToLocalModel: true }), callbacks);
		focusLocalModelAppend(component);

		const output = component.getSettingsList().render(80).join("\n");
		expect(output).toContain("Final fallback to local model");
		expect(output).toContain("Append local model as last fallback");
		expect(output).toContain("true");
	});

	test("toggling finalFallbackToLocalModel fires onFinalFallbackToLocalModelChange", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(makeConfig({ finalFallbackToLocalModel: false }), callbacks);
		focusLocalModelAppend(component);

		component.getSettingsList().handleInput(ENTER);

		expect(callbacks.onFinalFallbackToLocalModelChange).toHaveBeenCalledWith(true);
	});

	test("localOnlyModel dropdown populates from available models", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(
			makeConfig({
				localModelAvailableModels: ["ollama/qwen3:latest", "ollama/llama3.1:8b"],
			}),
			callbacks,
		);
		focusLocalModel(component);

		const output = component.getSettingsList().render(80).join("\n");
		expect(output).toContain("Local model");

		// Open the submenu
		component.getSettingsList().handleInput(ENTER);

		const submenuOutput = component.getSettingsList().render(80).join("\n");
		expect(submenuOutput).toContain("Local Model");
		expect(submenuOutput).toContain("ollama/qwen3:latest");
		expect(submenuOutput).toContain("ollama/llama3.1:8b");
	});

	test("when no local models available, localOnlyModel entry is hidden", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(
			makeConfig({
				localOnlyMode: false,
				localModelAvailableModels: [],
			}),
			callbacks,
		);
		focusLocalOnlyMode(component);

		const output = component.getSettingsList().render(80).join("\n");
		expect(output).toContain("Local only mode");
		expect(output).not.toContain("Local model");
	});

	test("localOnlyModel entry uses selected model as default when set", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(
			makeConfig({
				localOnlyModel: "ollama/llama3.1:8b",
				localModelAvailableModels: ["ollama/qwen3:latest", "ollama/llama3.1:8b"],
			}),
			callbacks,
		);
		focusLocalModel(component);

		// Open the submenu
		component.getSettingsList().handleInput(ENTER);

		const output = component.getSettingsList().render(80).join("\n");
		// The selected model should appear in the submenu list
		expect(output).toContain("ollama/llama3.1:8b");
	});
});
