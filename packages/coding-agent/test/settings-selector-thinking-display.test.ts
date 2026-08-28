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
		continueAfterAutoCompaction: false,
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
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 1,
		autocompleteMaxVisible: 7,
		quietStartup: false,
		autoLoadNestedContext: false,
		maxConcurrentSubagents: 4,
		agentModels: {},
		agentNames: [],
		availableModelIds: [],
		subagentArbiter: {},
		...overrides,
	};
}

function makeCallbacks(): SettingsCallbacks {
	return {
		onAutoCompactChange: vi.fn(),
		onContinueAfterAutoCompactionChange: vi.fn(),
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
		onThemePreview: vi.fn(),
		onHideThinkingBlockChange: vi.fn(),
		onThinkingDisplayChange: vi.fn(),
		onDoubleEscapeActionChange: vi.fn(),
		onTreeFilterModeChange: vi.fn(),
		onShowHardwareCursorChange: vi.fn(),
		onEditorPaddingXChange: vi.fn(),
		onAutocompleteMaxVisibleChange: vi.fn(),
		onQuietStartupChange: vi.fn(),
		onMaxConcurrentSubagentsChange: vi.fn(() => true),
		onAgentModelsChange: vi.fn(),
		onSubagentArbiterChange: vi.fn(() => true),
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

describe("SettingsSelectorComponent — subagent concurrency", () => {
	test("shows the effective value and emits a validated numeric edit", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(makeConfig({ maxConcurrentSubagents: 4 }), callbacks);
		const list = component.getSettingsList();
		for (const ch of "maxconcurrent") list.handleInput(ch);
		expect(list.render(120).join("\n")).toContain("Max concurrent subagents");
		expect(list.render(120).join("\n")).toContain("0 removes the subagent tool");

		list.handleInput(ENTER);
		list.handleInput("\x1b[3~");
		list.handleInput("1");
		list.handleInput(ENTER);
		expect(callbacks.onMaxConcurrentSubagentsChange).toHaveBeenCalledWith(1);
	});

	test("keeps the submenu open when validation rejects an edit", () => {
		const callbacks = makeCallbacks();
		vi.mocked(callbacks.onMaxConcurrentSubagentsChange).mockReturnValue(false);
		const component = new SettingsSelectorComponent(makeConfig(), callbacks);
		const list = component.getSettingsList();
		for (const ch of "maxconcurrent") list.handleInput(ch);
		list.handleInput(ENTER);
		list.handleInput("\x1b[3~");
		list.handleInput("-");
		list.handleInput("1");
		list.handleInput(ENTER);
		expect(callbacks.onMaxConcurrentSubagentsChange).toHaveBeenCalledWith(-1);
	});
});

describe("SettingsSelectorComponent — Dispatch Arbiter controls", () => {
	test("shows enable, model, thinking, and guide controls with global fail-closed guidance", () => {
		const component = new SettingsSelectorComponent(
			makeConfig({
				subagentArbiter: { enabled: false, model: "provider/router", thinking: "medium" },
				availableModelIds: ["provider/router"],
			}),
			makeCallbacks(),
		);
		const list = component.getSettingsList();
		for (const ch of "arbiter") list.handleInput(ch);
		const output = list.render(180).join("\n");
		expect(output).toContain("Dispatch Arbiter");
		expect(output).toContain("Dispatch Arbiter model");
		expect(output).toContain("Dispatch Arbiter thinking");
		expect(output).toContain("Dispatch Arbiter guide");
		expect(output).toContain("Global-only");
	});

	test("model, thinking, and guide submenus emit complete global arbiter policies", () => {
		const modelCallbacks = makeCallbacks();
		const modelComponent = new SettingsSelectorComponent(
			makeConfig({ subagentArbiter: { enabled: false }, availableModelIds: ["provider/router"] }),
			modelCallbacks,
		);
		for (const ch of "arbitermodel") modelComponent.getSettingsList().handleInput(ch);
		modelComponent.getSettingsList().handleInput(ENTER);
		modelComponent.getSettingsList().handleInput(ENTER);
		expect(modelCallbacks.onSubagentArbiterChange).toHaveBeenCalledWith({
			enabled: false,
			model: "provider/router",
		});

		const thinkingCallbacks = makeCallbacks();
		const thinkingComponent = new SettingsSelectorComponent(
			makeConfig({ subagentArbiter: { enabled: false, model: "provider/router", thinking: "off" } }),
			thinkingCallbacks,
		);
		for (const ch of "arbiterthinking") thinkingComponent.getSettingsList().handleInput(ch);
		thinkingComponent.getSettingsList().handleInput(ENTER);
		thinkingComponent.getSettingsList().handleInput("\x1b[B");
		thinkingComponent.getSettingsList().handleInput(ENTER);
		expect(thinkingCallbacks.onSubagentArbiterChange).toHaveBeenCalledWith({
			enabled: false,
			model: "provider/router",
			thinking: "minimal",
		});

		const guideCallbacks = makeCallbacks();
		const guideComponent = new SettingsSelectorComponent(
			makeConfig({ subagentArbiter: { enabled: false, model: "provider/router" } }),
			guideCallbacks,
		);
		for (const ch of "arbiterguide") guideComponent.getSettingsList().handleInput(ch);
		guideComponent.getSettingsList().handleInput(ENTER);
		for (const ch of "~/custom-guide.md") guideComponent.getSettingsList().handleInput(ch);
		guideComponent.getSettingsList().handleInput(ENTER);
		expect(guideCallbacks.onSubagentArbiterChange).toHaveBeenCalledWith({
			enabled: false,
			model: "provider/router",
			guidePath: "~/custom-guide.md",
		});
	});

	test("rejected enablement stays off instead of presenting an unpersisted state", async () => {
		const callbacks = makeCallbacks();
		vi.mocked(callbacks.onSubagentArbiterChange).mockReturnValue(false);
		const component = new SettingsSelectorComponent(
			makeConfig({ subagentArbiter: { enabled: false, model: "provider/router" } }),
			callbacks,
		);
		const list = component.getSettingsList();
		for (const ch of "arbiter") list.handleInput(ch);
		list.handleInput(ENTER);
		list.handleInput("\x1b[B");
		list.handleInput(ENTER);
		expect(callbacks.onSubagentArbiterChange).toHaveBeenCalledWith({ enabled: true, model: "provider/router" });
		await vi.waitFor(() => expect(list.render(120).join("\n")).toContain("false"));
	});

	test("enable toggle emits the complete current global arbiter policy", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(
			makeConfig({
				subagentArbiter: { enabled: false, model: "provider/router", thinking: "medium", guidePath: "~/guide.md" },
			}),
			callbacks,
		);
		const list = component.getSettingsList();
		for (const ch of "arbiter") list.handleInput(ch);
		list.handleInput(ENTER);
		list.handleInput("\x1b[B");
		list.handleInput(ENTER);
		expect(callbacks.onSubagentArbiterChange).toHaveBeenCalledWith({
			enabled: true,
			model: "provider/router",
			thinking: "medium",
			guidePath: "~/guide.md",
		});
	});
});

describe("SettingsSelectorComponent — auto-compaction continuation", () => {
	test("shows the persisted value and explains the automatic-only behavior", () => {
		const component = new SettingsSelectorComponent(
			makeConfig({ continueAfterAutoCompaction: true }),
			makeCallbacks(),
		);
		const list = component.getSettingsList();
		for (const ch of "continueafterauto") list.handleInput(ch);

		const output = list.render(120).join("\n");
		expect(output).toContain("Continue after auto-compaction");
		expect(output).toContain("can run and incur cost indefinitely");
		expect(output).toContain("true");
	});

	test("toggling the setting invokes its dedicated callback", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(makeConfig({ continueAfterAutoCompaction: false }), callbacks);
		const list = component.getSettingsList();
		for (const ch of "continueafterauto") list.handleInput(ch);
		list.handleInput(ENTER);

		expect(callbacks.onContinueAfterAutoCompactionChange).toHaveBeenCalledWith(true);
	});
});

describe("SettingsSelectorComponent — thinking-display toggle", () => {
	test("labels unrestricted nested loading as a default-off prompt-injection risk", () => {
		const component = new SettingsSelectorComponent(makeConfig(), makeCallbacks());
		const list = component.getSettingsList();
		for (const ch of "unrestricted") list.handleInput(ch);
		const output = list.render(160).join("\n");
		expect(output).toContain("Unrestricted nested context loading (expert)");
		expect(output).toContain("OFF by default");
		expect(output).toContain("prompt injection");
	});

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
