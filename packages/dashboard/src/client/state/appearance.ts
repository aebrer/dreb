/*
 * dreb dashboard — appearance system (dashboard-native).
 *
 * Eight themes, each a *family* with a light and a dark variant. Separate
 * color-mode and font controls select the active variant and typography. This
 * is deliberately independent of the TUI theme system — the dashboard owns its
 * own appearance surface (see styles/themes.css).
 *
 * Persistence mirrors state/preferences.ts: guarded localStorage reads/writes
 * (window-undefined guard + try/catch), an in-memory Solid signal that stays
 * honest even when storage is unavailable, and a "default value ⇒ removeItem"
 * rule so a pristine (default + system + theme-default font) install leaves no
 * keys behind.
 *
 * Catalog ids are FIXED and re-declared as inline literals in index.html's
 * synchronous bootstrap script, which paints the correct appearance before CSS
 * loads. Contract tests assert all three allowlists stay in sync.
 */

import { createSignal } from "solid-js";

export interface ThemeEntry {
	/** Stable id used for the `data-theme` attribute and storage. */
	id: ThemeId;
	/** Human label for pickers. */
	label: string;
}

export interface FontEntry {
	/** Stable id used for the `data-font` attribute and storage. */
	id: FontId;
	/** Human label for pickers. */
	label: string;
}

export type ThemeId = "default" | "dim" | "solarized" | "gruvbox" | "qud" | "vangogh" | "okabe" | "tol";
export type ColorMode = "system" | "light" | "dark";
export type FontId =
	| "theme"
	| "ibm-plex-mono"
	| "jetbrains-mono"
	| "opendyslexic"
	| "fira-code"
	| "iosevka"
	| "atkinson-hyperlegible";

/**
 * FIXED catalog — default first, then dim, solarized, gruvbox, qud, vangogh,
 * then the two colorblind-safe palettes (okabe, tol). The two CVD-safe themes
 * keep running/error on a blue/teal-vs-vermillion/red axis (never green-vs-red),
 * so status stays distinguishable under deutan/protan/tritan color vision.
 */
export const THEMES: readonly ThemeEntry[] = [
	{ id: "default", label: "entropist.ca" },
	{ id: "dim", label: "Dim" },
	{ id: "solarized", label: "Solarized" },
	{ id: "gruvbox", label: "Gruvbox" },
	{ id: "qud", label: "Caves of Qud" },
	{ id: "vangogh", label: "Van Gogh" },
	{ id: "okabe", label: "Colorblind-safe (Okabe-Ito)" },
	{ id: "tol", label: "Colorblind-safe (Paul Tol)" },
] as const;

/** All theme ids in catalog order. */
export const THEME_IDS: readonly ThemeId[] = THEMES.map((t) => t.id);

/** Color modes. `system` follows the OS via prefers-color-scheme. */
export const MODES: readonly ColorMode[] = ["system", "light", "dark"] as const;

/**
 * Fixed font picker catalog. `theme` preserves each theme's built-in family.
 * Monospace families come first, then the explicit accessibility options
 * (OpenDyslexic for dyslexia, Atkinson Hyperlegible for low vision).
 */
export const FONTS: readonly FontEntry[] = [
	{ id: "theme", label: "Theme default" },
	{ id: "ibm-plex-mono", label: "IBM Plex Mono" },
	{ id: "jetbrains-mono", label: "JetBrains Mono" },
	{ id: "fira-code", label: "Fira Code" },
	{ id: "iosevka", label: "Iosevka" },
	{ id: "opendyslexic", label: "OpenDyslexic" },
	{ id: "atkinson-hyperlegible", label: "Atkinson Hyperlegible" },
] as const;

/** All font ids in picker order. */
export const FONT_IDS: readonly FontId[] = FONTS.map((entry) => entry.id);

export const THEME_STORAGE_KEY = "dreb.dashboard.theme";
export const COLOR_MODE_STORAGE_KEY = "dreb.dashboard.colorMode";
export const FONT_STORAGE_KEY = "dreb.dashboard.font";

const DEFAULT_THEME: ThemeId = "default";
const DEFAULT_MODE: ColorMode = "system";
const DEFAULT_FONT: FontId = "theme";

/** Pure validators — also re-declared inline in index.html's bootstrap. */
export function isValidTheme(value: unknown): value is ThemeId {
	return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

export function isValidMode(value: unknown): value is ColorMode {
	return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export function isValidFont(value: unknown): value is FontId {
	return typeof value === "string" && (FONT_IDS as readonly string[]).includes(value);
}

// ------------------------------------------------------------------ storage

function readThemeStorage(): ThemeId {
	if (typeof window === "undefined") return DEFAULT_THEME;
	try {
		const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
		return isValidTheme(raw) ? raw : DEFAULT_THEME;
	} catch {
		return DEFAULT_THEME;
	}
}

function readModeStorage(): ColorMode {
	if (typeof window === "undefined") return DEFAULT_MODE;
	try {
		const raw = window.localStorage.getItem(COLOR_MODE_STORAGE_KEY);
		return isValidMode(raw) ? raw : DEFAULT_MODE;
	} catch {
		return DEFAULT_MODE;
	}
}

function readFontStorage(): FontId {
	if (typeof window === "undefined") return DEFAULT_FONT;
	try {
		const raw = window.localStorage.getItem(FONT_STORAGE_KEY);
		return isValidFont(raw) ? raw : DEFAULT_FONT;
	} catch {
		return DEFAULT_FONT;
	}
}

/**
 * Persist a string setting, removing the key entirely when it equals the
 * default so a pristine install leaves no dashboard keys behind. Never throws —
 * private-mode / disabled storage leaves the in-memory signal authoritative.
 */
function writeSetting(key: string, value: string, defaultValue: string): void {
	if (typeof window === "undefined") return;
	try {
		if (value === defaultValue) window.localStorage.removeItem(key);
		else window.localStorage.setItem(key, value);
	} catch {
		// Storage unavailable; the in-memory signal still drives this page load.
	}
}

// ------------------------------------------------------------------- signals

const [themeSignal, setThemeSignal] = createSignal<ThemeId>(readThemeStorage());
const [colorModeSignal, setColorModeSignal] = createSignal<ColorMode>(readModeStorage());
const [fontSignal, setFontSignal] = createSignal<FontId>(readFontStorage());

/** Accessor for the active theme id. */
export const theme = themeSignal;
/** Accessor for the active color mode. */
export const colorMode = colorModeSignal;
/** Accessor for the active font preference. */
export const font = fontSignal;

// --------------------------------------------------------------------- DOM

function computedBg(doc: Document): string {
	const view = doc.defaultView ?? (typeof window !== "undefined" ? window : undefined);
	if (!view || typeof view.getComputedStyle !== "function") return "";
	return view.getComputedStyle(doc.documentElement).getPropertyValue("--bg").trim();
}

/**
 * Reflect the current signals onto <html>. Attributes are OMITTED for the
 * clean case (default theme / system mode / theme-default font) so the
 * no-attribute selectors keep rendering exactly as they do today.
 *
 * `color-scheme` is set on the root ONLY when a curated theme or a forced mode
 * is active — never in the pristine default+system case — so native form
 * controls / scrollbars aren't retinted out from under a user who hasn't opted
 * into the appearance system.
 */
export function applyAppearance(doc?: Document): void {
	try {
		const d = doc ?? (typeof document !== "undefined" ? document : undefined);
		if (!d) return;
		const root = d.documentElement;
		if (!root) return;
		const t = themeSignal();
		const m = colorModeSignal();
		const f = fontSignal();

		if (t === DEFAULT_THEME) root.removeAttribute("data-theme");
		else root.setAttribute("data-theme", t);

		if (m === DEFAULT_MODE) root.removeAttribute("data-color-mode");
		else root.setAttribute("data-color-mode", m);

		if (f === DEFAULT_FONT) root.removeAttribute("data-font");
		else root.setAttribute("data-font", f);

		const active = t !== DEFAULT_THEME || m !== DEFAULT_MODE;
		if (!active) {
			root.style.removeProperty("color-scheme");
		} else {
			const scheme = m === "light" ? "light" : m === "dark" ? "dark" : "light dark";
			root.style.setProperty("color-scheme", scheme);
		}
	} catch {
		// DOM unavailable — leave the in-memory signals as the source of truth.
	}
}

/**
 * Sync the browser chrome color to the current background. Reads the resolved
 * `--bg` custom property off <html> and writes it into a live (media-less)
 * `<meta name="theme-color">`, creating one at the top of <head> if absent so
 * it wins over the media-based fallbacks in index.html. Robust when no meta or
 * no computed style is available.
 */
export function updateThemeColorMeta(doc?: Document): void {
	try {
		const d = doc ?? (typeof document !== "undefined" ? document : undefined);
		if (!d) return;
		const bg = computedBg(d);
		if (!bg) return;
		let meta = d.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
		if (!meta) {
			meta = d.createElement("meta");
			meta.setAttribute("name", "theme-color");
			const head = d.head ?? d.getElementsByTagName("head")[0];
			if (head) head.insertBefore(meta, head.firstChild);
		}
		meta.setAttribute("content", bg);
	} catch {
		// No document / meta surface — nothing to update.
	}
}

// ------------------------------------------------------------------- setters

/** Set the theme: update signal, persist, reflect to DOM + chrome — all sync. */
export function setTheme(value: ThemeId): void {
	const next = isValidTheme(value) ? value : DEFAULT_THEME;
	setThemeSignal(next);
	writeSetting(THEME_STORAGE_KEY, next, DEFAULT_THEME);
	applyAppearance();
	updateThemeColorMeta();
}

/** Set the color mode: update signal, persist, reflect to DOM + chrome — sync. */
export function setColorMode(value: ColorMode): void {
	const next = isValidMode(value) ? value : DEFAULT_MODE;
	setColorModeSignal(next);
	writeSetting(COLOR_MODE_STORAGE_KEY, next, DEFAULT_MODE);
	applyAppearance();
	updateThemeColorMeta();
}

/** Set the font preference: update signal, persist, and reflect to the DOM. */
export function setFont(value: FontId): void {
	const next = isValidFont(value) ? value : DEFAULT_FONT;
	setFontSignal(next);
	writeSetting(FONT_STORAGE_KEY, next, DEFAULT_FONT);
	applyAppearance();
}

// ------------------------------------------------------- listeners + reconcile

let mediaQuery: MediaQueryList | null = null;
let initialized = false;

/** While in system mode, an OS light/dark flip changes the resolved bg. */
function handleOsChange(): void {
	if (colorModeSignal() === DEFAULT_MODE) updateThemeColorMeta();
}

/** Cross-tab sync: re-read + re-apply when our appearance keys change elsewhere. */
function handleStorage(event: StorageEvent): void {
	// A null key means storage.clear(); otherwise ignore unrelated keys.
	if (
		event.key !== null &&
		event.key !== THEME_STORAGE_KEY &&
		event.key !== COLOR_MODE_STORAGE_KEY &&
		event.key !== FONT_STORAGE_KEY
	) {
		return;
	}
	reloadAppearance();
}

/** Re-read persisted state into the signals and reflect it to DOM + chrome. */
export function reloadAppearance(): void {
	setThemeSignal(readThemeStorage());
	setColorModeSignal(readModeStorage());
	setFontSignal(readFontStorage());
	applyAppearance();
	updateThemeColorMeta();
}

function registerListeners(): void {
	if (typeof window === "undefined") return;
	try {
		if (typeof window.matchMedia === "function") {
			mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
			if (typeof mediaQuery.addEventListener === "function") {
				mediaQuery.addEventListener("change", handleOsChange);
			} else if (typeof mediaQuery.addListener === "function") {
				// Safari < 14 fallback.
				mediaQuery.addListener(handleOsChange);
			}
		}
	} catch {
		// matchMedia unavailable — OS-follow chrome refresh is a best-effort extra.
	}
	try {
		window.addEventListener("storage", handleStorage);
	} catch {
		// No window event target — cross-tab sync is a best-effort extra.
	}
}

/**
 * Reconcile persisted appearance state into the signals + DOM + chrome, and
 * register the matchMedia + storage listeners exactly once (idempotent). Any
 * storage/DOM failure leaves the in-memory default in place and never throws.
 */
export function initAppearance(): void {
	reloadAppearance();
	if (initialized) return;
	initialized = true;
	registerListeners();
}

/** Test helper: tear down listeners + reset signals so init can re-run clean. */
export function __resetAppearanceForTests(): void {
	if (typeof window !== "undefined") {
		try {
			window.removeEventListener("storage", handleStorage);
			if (mediaQuery) {
				if (typeof mediaQuery.removeEventListener === "function") {
					mediaQuery.removeEventListener("change", handleOsChange);
				} else if (typeof mediaQuery.removeListener === "function") {
					mediaQuery.removeListener(handleOsChange);
				}
			}
		} catch {
			// Best-effort teardown.
		}
	}
	mediaQuery = null;
	initialized = false;
	setThemeSignal(DEFAULT_THEME);
	setColorModeSignal(DEFAULT_MODE);
	setFontSignal(DEFAULT_FONT);
}
