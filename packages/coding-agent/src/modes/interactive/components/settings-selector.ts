import type { ThinkingLevel } from "@dreb/agent-core";
import type { Transport } from "@dreb/ai";
import {
	type Component,
	Container,
	getCapabilities,
	getKeybindings,
	type RankedItem,
	RankedList,
	type RankedListTheme,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@dreb/tui";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

const SETTINGS_SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Maximum reasoning (~32k tokens)",
};

export interface SettingsConfig {
	autoCompact: boolean;
	showImages: boolean;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	currentTheme: string;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	/** Whether the current model supports adaptive thinking (gates the thinking-display toggle). */
	thinkingDisplaySupported: boolean;
	/** Effective thinking-display value for the current model ("summarized" shown as on). */
	thinkingDisplay: "summarized" | "omitted";
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	/** Whether nested AGENTS.md/CLAUDE.md auto-loading is enabled. */
	autoLoadNestedContext: boolean;
	/** Per-agent model overrides from agentModels settings */
	agentModels: Record<string, string[]>;
	/** Known agent names for the mach6 models submenu */
	agentNames: string[];
	/** Available model IDs for selection in the ranked list */
	availableModelIds: string[];
	/** Local Only Mode toggle state */
	localOnlyMode: boolean;
	/** Currently selected local model ID (provider/model) */
	localOnlyModel: string;
	/** When true, append local model as last fallback (final fallback to local model). */
	finalFallbackToLocalModel: boolean;
	/** List of available model IDs for the local model dropdown (ALL models). */
	localModelAvailableModels: string[];
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onThinkingDisplayChange: (display: "summarized" | "omitted") => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onAutoLoadNestedContextChange: (enabled: boolean) => void;
	onAgentModelsChange: (agentName: string, models: string[]) => void;
	onLocalOnlyModeChange: (enabled: boolean) => void;
	onLocalOnlyModelChange: (modelId: string) => void;
	onFinalFallbackToLocalModelChange: (enabled: boolean) => void;
	onCancel: () => void;
}

/**
 * A submenu component for selecting from a list of options.
 */
class SelectSubmenu extends Container {
	private selectList: SelectList;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
	) {
		super();

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			SETTINGS_SUBMENU_SELECT_LIST_LAYOUT,
		);

		// Pre-select current value
		const currentIndex = options.findIndex((o) => o.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				onSelectionChange(item.value);
			};
		}

		this.addChild(this.selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

function getRankedListTheme(): RankedListTheme {
	return {
		selectedText: (t: string) => theme.bold(t),
		rank: (t: string) => theme.fg("muted", t),
		description: (t: string) => theme.fg("dim", t),
		hint: (t: string) => theme.fg("dim", t),
		empty: (t: string) => theme.fg("dim", t),
	};
}

/**
 * Top-level Mach6 Models submenu. Shows a list of agents, selecting one opens
 * a RankedList editor for that agent's model fallback list.
 *
 * Navigation: Agent list → RankedList → (optional) Add Model picker
 */
export class AgentModelsSubmenu implements Component {
	private agentList: SelectList;
	private rankedList: RankedList | null = null;
	private addList: SelectList | null = null;
	private addListSearchQuery = "";
	// Transient notice shown in the ranked view when an add was attempted but no
	// models are available to add. Cleared on the next ranked-view input.
	private rankedNotice: string | null = null;
	private activeView: "agents" | "ranked" | "add" = "agents";
	private currentAgentName: string | null = null;
	private agentNames: string[];
	private agentModels: Record<string, string[]>;
	private availableModelIds: string[];
	private onModelsChange: (agentName: string, models: string[]) => void;
	private onCancel: () => void;

	constructor(
		agentNames: string[],
		agentModels: Record<string, string[]>,
		availableModelIds: string[],
		onModelsChange: (agentName: string, models: string[]) => void,
		onCancel: () => void,
	) {
		this.agentNames = agentNames;
		this.agentModels = agentModels;
		this.availableModelIds = availableModelIds;
		this.onModelsChange = onModelsChange;
		this.onCancel = onCancel;

		this.agentList = this.buildAgentList();
	}

	private buildAgentList(): SelectList {
		const agentItems: SelectItem[] = this.agentNames.map((name) => {
			const models = this.agentModels[name];
			const desc = models && models.length > 0 ? models.join(", ") : "default";
			return { value: name, label: name, description: desc };
		});

		const list = new SelectList(agentItems, Math.min(agentItems.length, 12), getSelectListTheme(), {
			minPrimaryColumnWidth: 20,
			maxPrimaryColumnWidth: 30,
		});

		list.onSelect = (item) => {
			this.openRankedList(item.value);
		};

		list.onCancel = this.onCancel;
		return list;
	}

	private openRankedList(agentName: string): void {
		this.currentAgentName = agentName;
		const currentModels = this.agentModels[agentName] ?? [];
		const items: RankedItem[] = currentModels.map((m) => ({ value: m, label: m }));
		this.rankedList = new RankedList(items, 10, getRankedListTheme());

		this.rankedList.onReorder = (reorderedItems) => {
			this.saveModels(
				agentName,
				reorderedItems.map((i) => i.value),
			);
		};

		this.rankedList.onRemove = (_removed, remaining) => {
			this.saveModels(
				agentName,
				remaining.map((i) => i.value),
			);
		};

		this.rankedList.onSelect = () => {
			this.openAddModelPicker();
		};

		this.rankedList.onCancel = () => {
			this.rankedList = null;
			this.currentAgentName = null;
			this.activeView = "agents";
			// Rebuild agent list so descriptions reflect any changes made
			this.agentList = this.buildAgentList();
		};

		this.activeView = "ranked";
	}

	private openAddModelPicker(): void {
		if (!this.rankedList) return;

		const existingValues = new Set(this.rankedList.getItems().map((i) => i.value));
		const allOptions = this.availableModelIds
			.filter((m) => !existingValues.has(m))
			.map((m) => ({ value: m, label: m }));

		if (allOptions.length === 0) {
			// Don't silently swallow the "add" intent — tell the user why nothing happened.
			this.rankedNotice =
				this.availableModelIds.length === 0
					? "No models available to add (no authenticated providers)"
					: "All available models are already in the list";
			return;
		}

		this.addList = new SelectList(
			allOptions,
			Math.min(allOptions.length, 10),
			getSelectListTheme(),
			SETTINGS_SUBMENU_SELECT_LIST_LAYOUT,
		);

		this.addListSearchQuery = "";

		this.addList.onSelect = (item) => {
			if (!this.rankedList || !this.currentAgentName) return;
			const newItems = [...this.rankedList.getItems(), { value: item.value, label: item.value }];
			this.rankedList.setItems(newItems);
			this.addList = null;
			this.addListSearchQuery = "";
			this.activeView = "ranked";
			this.saveModels(
				this.currentAgentName,
				newItems.map((i) => i.value),
			);
		};

		this.addList.onCancel = () => {
			this.addList = null;
			this.addListSearchQuery = "";
			this.activeView = "ranked";
		};

		this.activeView = "add";
	}

	private saveModels(agentName: string, models: string[]): void {
		this.agentModels[agentName] = models;
		this.onModelsChange(agentName, models);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.activeView === "add" && this.addList) {
			lines.push(theme.bold(theme.fg("accent", "Add Model")));
			lines.push("");
			const searchDisplay = this.addListSearchQuery
				? `  Search: ${this.addListSearchQuery}▋`
				: theme.fg("dim", "  Type to filter · ↑↓: navigate · Enter: add · Esc: back");
			lines.push(searchDisplay);
			lines.push("");
			lines.push(...this.addList.render(width));
			return lines;
		}

		if (this.activeView === "ranked" && this.rankedList && this.currentAgentName) {
			lines.push(theme.bold(theme.fg("accent", `Agent Models › ${this.currentAgentName}`)));
			lines.push("");
			lines.push(theme.fg("muted", "Configure model fallback priority (first = preferred)"));
			lines.push("");
			lines.push(...this.rankedList.render(width));
			if (this.rankedNotice) {
				lines.push("");
				lines.push(theme.fg("warning", `  ${this.rankedNotice}`));
			}
			return lines;
		}

		// Default: agent list
		lines.push(theme.bold(theme.fg("accent", "Agent Models")));
		lines.push("");
		lines.push(theme.fg("muted", "Select an agent to configure its model fallback list"));
		lines.push("");
		lines.push(...this.agentList.render(width));
		lines.push("");
		lines.push(theme.fg("dim", "  Enter to configure · Esc to go back"));
		return lines;
	}

	handleInput(data: string): void {
		if (this.activeView === "add" && this.addList) {
			const kb = getKeybindings();
			if (
				kb.matches(data, "tui.select.cancel") ||
				kb.matches(data, "tui.select.up") ||
				kb.matches(data, "tui.select.down") ||
				kb.matches(data, "tui.select.confirm")
			) {
				this.addList.handleInput(data);
			} else if (data === "\x7f" || data === "\x08") {
				// Backspace — remove last char from search
				this.addListSearchQuery = this.addListSearchQuery.slice(0, -1);
				this.addList.setFilter(this.addListSearchQuery);
			} else if (data.length === 1 && data >= " ") {
				// Printable char — add to search
				this.addListSearchQuery += data;
				this.addList.setFilter(this.addListSearchQuery);
			}
		} else if (this.activeView === "ranked" && this.rankedList) {
			// Clear any stale "nothing to add" notice; openAddModelPicker re-sets it
			// if this input is another failed add attempt.
			this.rankedNotice = null;
			this.rankedList.handleInput(data);
		} else {
			this.agentList.handleInput(data);
		}
	}
}

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		const supportsImages = getCapabilities().images;

		const items: SettingItem[] = [
			{
				id: "autocompact",
				label: "Auto-compact",
				description: "Automatically compact context when it gets too large",
				currentValue: config.autoCompact ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "auto-load-nested-context",
				label: "Auto-load nested context",
				description: "Load a directory's AGENTS.md/CLAUDE.md automatically the first time a tool operates there",
				currentValue: config.autoLoadNestedContext ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "steering-mode",
				label: "Steering mode",
				description:
					"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
				currentValue: config.steeringMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "follow-up-mode",
				label: "Follow-up mode",
				description:
					"Alt+Enter queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
				currentValue: config.followUpMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "transport",
				label: "Transport",
				description: "Preferred transport for providers that support multiple transports",
				currentValue: config.transport,
				values: ["sse", "websocket", "auto"],
			},
			{
				id: "hide-thinking",
				label: "Hide thinking",
				description: "Hide thinking blocks in assistant responses",
				currentValue: config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "quiet-startup",
				label: "Quiet startup",
				description: "Disable verbose printing at startup",
				currentValue: config.quietStartup ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "double-escape-action",
				label: "Double-escape action",
				description: "Action when pressing Escape twice with empty editor",
				currentValue: config.doubleEscapeAction,
				values: ["tree", "fork", "none"],
			},
			{
				id: "tree-filter-mode",
				label: "Tree filter mode",
				description: "Default filter when opening /tree",
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			{
				id: "thinking",
				label: "Thinking level",
				description: "Reasoning depth for thinking-capable models",
				currentValue: config.thinkingLevel,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Thinking Level",
						"Select reasoning depth for thinking-capable models",
						config.availableThinkingLevels.map((level) => ({
							value: level,
							label: level,
							description: THINKING_DESCRIPTIONS[level],
						})),
						currentValue,
						(value) => {
							callbacks.onThinkingLevelChange(value as ThinkingLevel);
							done(value);
						},
						() => done(),
					),
			},
			{
				id: "theme",
				label: "Theme",
				description: "Color theme for the interface",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Theme",
						"Select color theme",
						config.availableThemes.map((t) => ({
							value: t,
							label: t,
						})),
						currentValue,
						(value) => {
							callbacks.onThemeChange(value);
							done(value);
						},
						() => {
							// Restore original theme on cancel
							callbacks.onThemePreview?.(currentValue);
							done();
						},
						(value) => {
							// Preview theme on selection change
							callbacks.onThemePreview?.(value);
						},
					),
			},
		];

		// Thinking-display toggle for the current model. Only adaptive-thinking models
		// (Opus/Sonnet 4.6+) honor this field, so the entry is gated to those models.
		// Shown as on ("summarized") by default; off ("omitted") hides thinking for lower latency.
		if (config.thinkingDisplaySupported) {
			const hideThinkingIndex = items.findIndex((item) => item.id === "hide-thinking");
			items.splice(hideThinkingIndex + 1, 0, {
				id: "thinking-display",
				label: "Show thinking summary",
				description: "Show summarized thinking for this model (off hides it for lower latency)",
				currentValue: config.thinkingDisplay === "summarized" ? "true" : "false",
				values: ["true", "false"],
			});
		}

		// Single "Agent Models" entry that opens the agent picker submenu
		if (config.agentNames.length > 0) {
			items.push({
				id: "agent-models",
				label: "Agent Models",
				description: "Configure model fallback lists for subagents",
				currentValue: "",
				submenu: (_currentValue, done) =>
					new AgentModelsSubmenu(
						config.agentNames,
						config.agentModels,
						config.availableModelIds,
						(agentName, models) => {
							callbacks.onAgentModelsChange(agentName, models);
						},
						() => done(),
					),
			});
		}

		// Local Only Mode section
		items.push({
			id: "local-only-mode",
			label: "Local only mode",
			description: "Prepend a local model to all agent fallback lists",
			currentValue: config.localOnlyMode ? "true" : "false",
			values: ["true", "false"],
		});

		if (config.localModelAvailableModels.length > 0) {
			items.push({
				id: "local-only-model",
				label: "Local model",
				description: "Local model to prepend to agent fallback lists",
				currentValue: config.localOnlyModel || config.localModelAvailableModels[0],
				submenu: (_currentValue, done) =>
					new SelectSubmenu(
						"Local Model",
						"Select a local model for agent fallback lists",
						config.localModelAvailableModels.map((modelId) => ({
							value: modelId,
							label: modelId,
						})),
						config.localOnlyModel || config.localModelAvailableModels[0],
						(modelId) => {
							callbacks.onLocalOnlyModelChange(modelId);
							done(modelId);
						},
						() => done(),
					),
			});
		}

		items.push({
			id: "local-only-append-mode",
			label: "Final fallback to local model",
			description: "Append local model as last fallback instead of first",
			currentValue: config.finalFallbackToLocalModel ? "true" : "false",
			values: ["true", "false"],
		});

		// Only show image toggle if terminal supports it
		if (supportsImages) {
			// Insert after autocompact
			items.splice(1, 0, {
				id: "show-images",
				label: "Show images",
				description: "Render images inline in terminal",
				currentValue: config.showImages ? "true" : "false",
				values: ["true", "false"],
			});
		}

		// Image auto-resize toggle (always available, affects both attached and read images)
		items.splice(supportsImages ? 2 : 1, 0, {
			id: "auto-resize-images",
			label: "Auto-resize images",
			description: "Resize large images to 2000x2000 max for better model compatibility",
			currentValue: config.autoResizeImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Block images toggle (always available, insert after auto-resize-images)
		const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
		items.splice(autoResizeIndex + 1, 0, {
			id: "block-images",
			label: "Block images",
			description: "Prevent images from being sent to LLM providers",
			currentValue: config.blockImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Skill commands toggle (insert after block-images)
		const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
		items.splice(blockImagesIndex + 1, 0, {
			id: "skill-commands",
			label: "Skill commands",
			description: "Register skills as /skill:name commands",
			currentValue: config.enableSkillCommands ? "true" : "false",
			values: ["true", "false"],
		});

		// Hardware cursor toggle (insert after skill-commands)
		const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
		items.splice(skillCommandsIndex + 1, 0, {
			id: "show-hardware-cursor",
			label: "Show hardware cursor",
			description: "Show the terminal cursor while still positioning it for IME support",
			currentValue: config.showHardwareCursor ? "true" : "false",
			values: ["true", "false"],
		});

		// Editor padding toggle (insert after show-hardware-cursor)
		const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
		items.splice(hardwareCursorIndex + 1, 0, {
			id: "editor-padding",
			label: "Editor padding",
			description: "Horizontal padding for input editor (0-3)",
			currentValue: String(config.editorPaddingX),
			values: ["0", "1", "2", "3"],
		});

		// Autocomplete max visible toggle (insert after editor-padding)
		const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
		items.splice(editorPaddingIndex + 1, 0, {
			id: "autocomplete-max-visible",
			label: "Autocomplete max items",
			description: "Max visible items in autocomplete dropdown (3-20)",
			currentValue: String(config.autocompleteMaxVisible),
			values: ["3", "5", "7", "10", "15", "20"],
		});

		// Add borders
		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "autocompact":
						callbacks.onAutoCompactChange(newValue === "true");
						break;
					case "auto-load-nested-context":
						callbacks.onAutoLoadNestedContextChange(newValue === "true");
						break;
					case "show-images":
						callbacks.onShowImagesChange(newValue === "true");
						break;
					case "auto-resize-images":
						callbacks.onAutoResizeImagesChange(newValue === "true");
						break;
					case "block-images":
						callbacks.onBlockImagesChange(newValue === "true");
						break;
					case "skill-commands":
						callbacks.onEnableSkillCommandsChange(newValue === "true");
						break;
					case "steering-mode":
						callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "follow-up-mode":
						callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "transport":
						callbacks.onTransportChange(newValue as Transport);
						break;
					case "hide-thinking":
						callbacks.onHideThinkingBlockChange(newValue === "true");
						break;
					case "thinking-display":
						callbacks.onThinkingDisplayChange(newValue === "true" ? "summarized" : "omitted");
						break;
					case "quiet-startup":
						callbacks.onQuietStartupChange(newValue === "true");
						break;
					case "double-escape-action":
						callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree");
						break;
					case "tree-filter-mode":
						callbacks.onTreeFilterModeChange(
							newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
						);
						break;
					case "show-hardware-cursor":
						callbacks.onShowHardwareCursorChange(newValue === "true");
						break;
					case "editor-padding":
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						break;
					case "autocomplete-max-visible":
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						break;
					case "local-only-mode":
						callbacks.onLocalOnlyModeChange(newValue === "true");
						break;
					case "local-only-append-mode":
						callbacks.onFinalFallbackToLocalModelChange(newValue === "true");
						break;
				}
			},
			callbacks.onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
