import { createSignal } from "solid-js";

export const EXPAND_THINKING_KEY = "dreb.dashboard.expandThinking";

function readBooleanPreference(key: string): boolean {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(key) === "true";
	} catch {
		return false;
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

const [expandThinkingSignal, setExpandThinkingSignal] = createSignal(readBooleanPreference(EXPAND_THINKING_KEY));

export const expandThinking = expandThinkingSignal;

export function setExpandThinking(value: boolean): void {
	setExpandThinkingSignal(value);
	writeBooleanPreference(EXPAND_THINKING_KEY, value);
}

export function reloadExpandThinkingPreference(): void {
	setExpandThinkingSignal(readBooleanPreference(EXPAND_THINKING_KEY));
}
