import { createSignal } from "solid-js";
import type { DashboardImageDisplayMode } from "../../shared/protocol.js";

export const EXPAND_THINKING_KEY = "dreb.dashboard.expandThinking";
export const IMAGE_DISPLAY_MODE_KEY = "dreb.dashboard.imageDisplayMode";
export const TOOL_AUTO_EXPAND_KEY = "dreb.dashboard.toolAutoExpand";
export const TOOL_AUTO_EXPAND_TOOLS = ["read", "edit", "write", "suggest_next", "bash"] as const;

export type ToolAutoExpandTool = (typeof TOOL_AUTO_EXPAND_TOOLS)[number];
export type ToolAutoExpandPreferences = Record<ToolAutoExpandTool, boolean>;

/** Expanded thinking is opt-OUT: new users see thinking blocks open. */
const EXPAND_THINKING_DEFAULT = true;
const TOOL_AUTO_EXPAND_DEFAULT_OPEN_TOOLS = new Set<string>(TOOL_AUTO_EXPAND_TOOLS);
const TOOL_AUTO_EXPAND_DEFAULT = Object.fromEntries(
	TOOL_AUTO_EXPAND_TOOLS.map((toolName) => [toolName, true]),
) as ToolAutoExpandPreferences;

function readBooleanPreference(key: string, defaultValue: boolean): boolean {
	if (typeof window === "undefined") return defaultValue;
	try {
		const raw = window.localStorage.getItem(key);
		if (raw === null) return defaultValue;
		return raw === "true";
	} catch {
		return defaultValue;
	}
}

function writeBooleanPreference(key: string, value: boolean): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(key, value ? "true" : "false");
	} catch {
		// Browser storage can be unavailable in private modes; the in-memory signal
		// still updates so the control remains honest for this page load.
	}
}

function readImageDisplayMode(): DashboardImageDisplayMode {
	if (typeof window === "undefined") return "previews";
	try {
		const value = window.localStorage.getItem(IMAGE_DISPLAY_MODE_KEY);
		return value === "placeholders" || value === "previews" || value === "originals" ? value : "previews";
	} catch {
		return "previews";
	}
}

function writeImageDisplayMode(value: DashboardImageDisplayMode): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(IMAGE_DISPLAY_MODE_KEY, value);
	} catch {
		// Keep the in-memory selection usable when persistent browser storage fails.
	}
}

function readToolAutoExpandPreference(): ToolAutoExpandPreferences {
	if (typeof window === "undefined") return { ...TOOL_AUTO_EXPAND_DEFAULT };
	try {
		const raw = window.localStorage.getItem(TOOL_AUTO_EXPAND_KEY);
		if (raw === null) return { ...TOOL_AUTO_EXPAND_DEFAULT };
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const next = { ...TOOL_AUTO_EXPAND_DEFAULT };
		for (const toolName of TOOL_AUTO_EXPAND_TOOLS) {
			if (typeof parsed[toolName] === "boolean") next[toolName] = parsed[toolName];
		}
		return next;
	} catch {
		return { ...TOOL_AUTO_EXPAND_DEFAULT };
	}
}

function writeToolAutoExpandPreference(value: ToolAutoExpandPreferences): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(TOOL_AUTO_EXPAND_KEY, JSON.stringify(value));
	} catch {
		// Browser storage can be unavailable in private modes; the in-memory signal
		// still updates so the control remains honest for this page load.
	}
}

const [expandThinkingSignal, setExpandThinkingSignal] = createSignal(
	readBooleanPreference(EXPAND_THINKING_KEY, EXPAND_THINKING_DEFAULT),
);
const [imageDisplayModeSignal, setImageDisplayModeSignal] = createSignal<DashboardImageDisplayMode>(
	readImageDisplayMode(),
);
const [toolAutoExpandSignal, setToolAutoExpandSignal] = createSignal(readToolAutoExpandPreference());

export const expandThinking = expandThinkingSignal;
export const imageDisplayMode = imageDisplayModeSignal;
export const toolAutoExpand = toolAutoExpandSignal;

export function setExpandThinking(value: boolean): void {
	setExpandThinkingSignal(value);
	writeBooleanPreference(EXPAND_THINKING_KEY, value);
}

export function setImageDisplayMode(value: DashboardImageDisplayMode): void {
	setImageDisplayModeSignal(value);
	writeImageDisplayMode(value);
}

export function setToolAutoExpand(toolName: ToolAutoExpandTool, value: boolean): void {
	const next = { ...toolAutoExpandSignal(), [toolName]: value };
	setToolAutoExpandSignal(next);
	writeToolAutoExpandPreference(next);
}

export function isToolAutoOpen(toolName: string): boolean {
	const value = (toolAutoExpandSignal() as Record<string, boolean>)[toolName];
	return value ?? TOOL_AUTO_EXPAND_DEFAULT_OPEN_TOOLS.has(toolName);
}

export function reloadExpandThinkingPreference(): void {
	setExpandThinkingSignal(readBooleanPreference(EXPAND_THINKING_KEY, EXPAND_THINKING_DEFAULT));
}

export function reloadImageDisplayModePreference(): void {
	setImageDisplayModeSignal(readImageDisplayMode());
}

export function reloadToolAutoExpandPreference(): void {
	setToolAutoExpandSignal(readToolAutoExpandPreference());
}
