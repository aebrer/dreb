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
		thinkingDisplaySupported: true,
		thinkingDisplay: "summarized",
		collapseChangelog: false,
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 1,
		autocompleteMaxVisible: 7,
		quietStartup: false,
		agentModels: {},
		agentNames: [],
		availableModelIds: [],
		...overrides,
	};
}

function makeCallbacks(): SettingsCallbacks {
	return {
		onAutoCompactChange: vi.fn(),
		onShowImagesChange: vi.fn(),
		onAutoResizeImagesChange: vi.fn(),
		onBlockImagesChange: vi.fn(),
		onEnableSkillCommandsChange: vi.fn(),
		onSteeringModeChange: vi.fn(),
		onFollowUpModeChange: vi.fn(),
		onTransportChange: vi.fn(),
		onThinkingLevelChange: vi.fn(),
		onThemeChange: vi.fn(),
		onThemePreview: vi.fn(),
		onHideThinkingBlockChange: vi.fn(),
		onThinkingDisplayChange: vi.fn(),
		onCollapseChangelogChange: vi.fn(),
		onDoubleEscapeActionChange: vi.fn(),
		onTreeFilterModeChange: vi.fn(),
		onShowHardwareCursorChange: vi.fn(),
		onEditorPaddingXChange: vi.fn(),
		onAutocompleteMaxVisibleChange: vi.fn(),
		onQuietStartupChange: vi.fn(),
		onAgentModelsChange: vi.fn(),
		onCancel: vi.fn(),
	};
}

/**
 * Filter the list down to the thinking-display item using the built-in search,
 * then return the component. After filtering, the (single) match is selected,
 * so ENTER cycles its value.
 */
function focusThinkingDisplay(component: SettingsSelectorComponent): void {
	const list = component.getSettingsList();
	// "summary" uniquely matches the "Show thinking summary" label.
	for (const ch of "summary") {
		list.handleInput(ch);
	}
}

describe("SettingsSelectorComponent — thinking-display toggle", () => {
	test("shows the thinking-display item when the model supports adaptive thinking", () => {
		const component = new SettingsSelectorComponent(makeConfig({ thinkingDisplaySupported: true }), makeCallbacks());
		focusThinkingDisplay(component);

		const output = component.getSettingsList().render(80).join("\n");
		expect(output).toContain("Show thinking summary");
	});

	test("hides the thinking-display item when the model does not support adaptive thinking", () => {
		const component = new SettingsSelectorComponent(makeConfig({ thinkingDisplaySupported: false }), makeCallbacks());
		focusThinkingDisplay(component);

		const output = component.getSettingsList().render(80).join("\n");
		expect(output).not.toContain("Show thinking summary");
		expect(output).toContain("No matching settings");
	});

	test("toggling from summarized fires onThinkingDisplayChange('omitted')", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(
			makeConfig({ thinkingDisplaySupported: true, thinkingDisplay: "summarized" }),
			callbacks,
		);
		focusThinkingDisplay(component);

		// The UI maps the "true"/"false" toggle to summarized/omitted: true -> false here.
		component.getSettingsList().handleInput(ENTER);

		expect(callbacks.onThinkingDisplayChange).toHaveBeenCalledWith("omitted");
	});

	test("toggling from omitted fires onThinkingDisplayChange('summarized')", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(
			makeConfig({ thinkingDisplaySupported: true, thinkingDisplay: "omitted" }),
			callbacks,
		);
		focusThinkingDisplay(component);

		// false -> true maps to "omitted" -> "summarized".
		component.getSettingsList().handleInput(ENTER);

		expect(callbacks.onThinkingDisplayChange).toHaveBeenCalledWith("summarized");
	});
});
