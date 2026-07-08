import { createSignal } from "solid-js";

export const EXPAND_THINKING_KEY = "dreb.dashboard.expandThinking";

/** Expanded thinking is opt-OUT: new users see thinking blocks open. */
const EXPAND_THINKING_DEFAULT = true;

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

const [expandThinkingSignal, setExpandThinkingSignal] = createSignal(
	readBooleanPreference(EXPAND_THINKING_KEY, EXPAND_THINKING_DEFAULT),
);

export const expandThinking = expandThinkingSignal;

export function setExpandThinking(value: boolean): void {
	setExpandThinkingSignal(value);
	writeBooleanPreference(EXPAND_THINKING_KEY, value);
}

export function reloadExpandThinkingPreference(): void {
	setExpandThinkingSignal(readBooleanPreference(EXPAND_THINKING_KEY, EXPAND_THINKING_DEFAULT));
}
