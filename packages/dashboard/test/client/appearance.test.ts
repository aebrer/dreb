// @vitest-environment jsdom
/**
 * Appearance system tests — the dashboard-native theme + color-mode foundation
 * (state/appearance.ts) plus the index.html bootstrap contract.
 *
 * Mirrors the localStorage + jsdom shim pattern from pwa.test.tsx. matchMedia
 * is not implemented by jsdom, so tests that exercise the OS-follow refresh
 * install a controllable mock.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	__resetAppearanceForTests,
	applyAppearance,
	COLOR_MODE_STORAGE_KEY,
	type ColorMode,
	colorMode,
	initAppearance,
	isValidMode,
	isValidTheme,
	MODES,
	reloadAppearance,
	setColorMode,
	setTheme,
	THEME_IDS,
	THEME_STORAGE_KEY,
	THEMES,
	type ThemeId,
	theme,
	updateThemeColorMeta,
} from "../../src/client/state/appearance.js";

function resetDom(): void {
	const root = document.documentElement;
	root.removeAttribute("data-theme");
	root.removeAttribute("data-color-mode");
	root.style.removeProperty("color-scheme");
	root.style.removeProperty("--bg");
	for (const meta of Array.from(document.querySelectorAll('meta[name="theme-color"]'))) {
		meta.remove();
	}
}

beforeEach(() => {
	// localStorage shim — jsdom's built-in Storage is unreliable here (it warns
	// about `--localstorage-file` and its methods can be missing), so always
	// install a Map-backed implementation for deterministic behavior.
	const values = new Map<string, string>();
	Object.defineProperty(window, "localStorage", {
		configurable: true,
		value: {
			getItem: (k: string) => values.get(k) ?? null,
			setItem: (k: string, v: string) => values.set(k, String(v)),
			removeItem: (k: string) => values.delete(k),
			clear: () => values.clear(),
			key: (i: number) => [...values.keys()][i] ?? null,
			get length() {
				return values.size;
			},
		},
	});
	resetDom();
	__resetAppearanceForTests();
});

afterEach(() => {
	__resetAppearanceForTests();
	window.localStorage.clear();
	resetDom();
	vi.restoreAllMocks();
});

describe("appearance — catalog", () => {
	it("orders default first, then dim, solarized, gruvbox with sequential order fields", () => {
		expect(THEMES.map((t) => t.id)).toEqual(["default", "dim", "solarized", "gruvbox"]);
		expect(THEMES[0].id).toBe("default");
		expect(THEMES.map((t) => t.order)).toEqual([0, 1, 2, 3]);
	});

	it("has unique, valid ids and matching THEME_IDS", () => {
		const ids = THEMES.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(THEME_IDS).toEqual(ids);
		for (const id of ids) expect(isValidTheme(id)).toBe(true);
	});

	it("exposes system/light/dark modes with system first", () => {
		expect(MODES).toEqual(["system", "light", "dark"]);
		for (const m of MODES) expect(isValidMode(m)).toBe(true);
	});

	it("rejects unknown theme / mode values", () => {
		expect(isValidTheme("nope")).toBe(false);
		expect(isValidTheme(null)).toBe(false);
		expect(isValidMode("sepia")).toBe(false);
		expect(isValidMode(undefined)).toBe(false);
	});
});

describe("appearance — reading persisted state", () => {
	it("defaults to default/system when keys are missing", () => {
		reloadAppearance();
		expect(theme()).toBe("default");
		expect(colorMode()).toBe("system");
	});

	it("restores valid persisted values", () => {
		window.localStorage.setItem(THEME_STORAGE_KEY, "solarized");
		window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, "dark");
		reloadAppearance();
		expect(theme()).toBe("solarized");
		expect(colorMode()).toBe("dark");
		expect(document.documentElement.getAttribute("data-theme")).toBe("solarized");
		expect(document.documentElement.getAttribute("data-color-mode")).toBe("dark");
	});

	it("normalizes invalid/retired persisted values to default/system", () => {
		window.localStorage.setItem(THEME_STORAGE_KEY, "retired-theme");
		window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, "sepia");
		reloadAppearance();
		expect(theme()).toBe("default");
		expect(colorMode()).toBe("system");
		expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
		expect(document.documentElement.hasAttribute("data-color-mode")).toBe(false);
	});
});

describe("appearance — setters", () => {
	it("setTheme updates signal, storage, and the data-theme attribute", () => {
		setTheme("gruvbox");
		expect(theme()).toBe("gruvbox");
		expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("gruvbox");
		expect(document.documentElement.getAttribute("data-theme")).toBe("gruvbox");
	});

	it("setColorMode updates signal, storage, attribute, and color-scheme", () => {
		setColorMode("dark");
		expect(colorMode()).toBe("dark");
		expect(window.localStorage.getItem(COLOR_MODE_STORAGE_KEY)).toBe("dark");
		expect(document.documentElement.getAttribute("data-color-mode")).toBe("dark");
		expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("dark");
	});

	it("sets color-scheme to 'light dark' for a curated theme in system mode", () => {
		setTheme("dim");
		expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("light dark");
	});

	it("selecting the default theme REMOVES the key and the attribute", () => {
		setTheme("dim");
		expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dim");
		setTheme("default");
		expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
		expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
	});

	it("selecting system mode REMOVES the key and the attribute", () => {
		setColorMode("light");
		expect(window.localStorage.getItem(COLOR_MODE_STORAGE_KEY)).toBe("light");
		setColorMode("system");
		expect(window.localStorage.getItem(COLOR_MODE_STORAGE_KEY)).toBeNull();
		expect(document.documentElement.hasAttribute("data-color-mode")).toBe(false);
	});

	it("removes color-scheme entirely in the pristine default+system case", () => {
		setColorMode("dark");
		setTheme("dim");
		expect(document.documentElement.style.getPropertyValue("color-scheme")).not.toBe("");
		setTheme("default");
		setColorMode("system");
		expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("");
	});

	it("normalizes an invalid setter argument to the default", () => {
		setTheme("bogus" as ThemeId);
		expect(theme()).toBe("default");
		setColorMode("bogus" as ColorMode);
		expect(colorMode()).toBe("system");
	});
});

describe("appearance — storage resilience", () => {
	it("falls back to defaults and does not throw when reads fail", () => {
		const spy = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(() => reloadAppearance()).not.toThrow();
		expect(theme()).toBe("default");
		expect(colorMode()).toBe("system");
		spy.mockRestore();
	});

	it("keeps the in-memory signal honest when writes fail", () => {
		const spy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
			throw new Error("quota exceeded");
		});
		expect(() => setTheme("gruvbox")).not.toThrow();
		expect(theme()).toBe("gruvbox");
		expect(document.documentElement.getAttribute("data-theme")).toBe("gruvbox");
		spy.mockRestore();
	});
});

describe("appearance — cross-tab storage sync", () => {
	it("re-reads and applies when our keys change in another tab", () => {
		initAppearance();
		window.localStorage.setItem(THEME_STORAGE_KEY, "solarized");
		window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "solarized" }));
		expect(theme()).toBe("solarized");
		expect(document.documentElement.getAttribute("data-theme")).toBe("solarized");
	});

	it("ignores storage events for unrelated keys", () => {
		initAppearance();
		setTheme("dim");
		window.localStorage.setItem("some.other.key", "value");
		window.dispatchEvent(new StorageEvent("storage", { key: "some.other.key", newValue: "value" }));
		expect(theme()).toBe("dim");
	});

	it("reconciles on a null-key storage event (another tab's localStorage.clear())", () => {
		initAppearance();
		setTheme("solarized");
		setColorMode("dark");
		expect(document.documentElement.getAttribute("data-theme")).toBe("solarized");

		// Another tab called localStorage.clear(): the store empties and the
		// storage event carries a null key, which handleStorage must treat as a
		// reconcile (NOT an unrelated-key early-return) so this tab resets too.
		window.localStorage.clear();
		window.dispatchEvent(new StorageEvent("storage", { key: null }));

		expect(theme()).toBe("default");
		expect(colorMode()).toBe("system");
		expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
		expect(document.documentElement.hasAttribute("data-color-mode")).toBe(false);
	});
});

describe("appearance — initAppearance idempotency", () => {
	it("registers the storage listener only once across repeated init calls", () => {
		const addSpy = vi.spyOn(window, "addEventListener");
		initAppearance();
		initAppearance();
		initAppearance();
		const storageRegs = addSpy.mock.calls.filter(([type]) => type === "storage");
		expect(storageRegs.length).toBe(1);
		addSpy.mockRestore();
	});

	it("registers the matchMedia OS listener only once across repeated init calls", () => {
		let addCount = 0;
		const matchMediaMock = vi.fn().mockImplementation((query: string) => ({
			matches: false,
			media: query,
			addEventListener: () => {
				addCount += 1;
			},
			removeEventListener: () => {},
			addListener: () => {
				addCount += 1;
			},
			removeListener: () => {},
		}));
		Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMediaMock });

		initAppearance();
		initAppearance();
		initAppearance();
		expect(addCount).toBe(1);
	});

	it("fires the reconcile handler once per storage event after repeated init calls", () => {
		initAppearance();
		initAppearance();
		// A duplicated storage listener would reconcile N times; the observable
		// result is identical, but the single-registration guard above pins it.
		window.localStorage.setItem(THEME_STORAGE_KEY, "gruvbox");
		window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "gruvbox" }));
		expect(theme()).toBe("gruvbox");
		expect(document.documentElement.getAttribute("data-theme")).toBe("gruvbox");
	});
});

describe("appearance — theme-color meta", () => {
	it("writes the computed --bg into a live theme-color meta", () => {
		document.documentElement.style.setProperty("--bg", "#123456");
		updateThemeColorMeta();
		const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
		expect(meta).not.toBeNull();
		expect(meta?.getAttribute("content")).toBe("#123456");
	});

	it("does not throw when no computed --bg is available", () => {
		document.documentElement.style.removeProperty("--bg");
		expect(() => updateThemeColorMeta()).not.toThrow();
	});

	it("setColorMode live-updates the theme-color meta from the resolved --bg", () => {
		// The setters must refresh the live meta so browser chrome tracks the new
		// background at runtime (real cascade coverage lives in the browser suite;
		// here we prove the setter path wires updateThemeColorMeta at all).
		document.documentElement.style.setProperty("--bg", "#abcdef");
		setColorMode("dark");
		const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
		expect(meta?.getAttribute("content")).toBe("#abcdef");
	});

	it("refreshes the theme-color meta on an OS change while in system mode", () => {
		let changeHandler: (() => void) | undefined;
		const matchMediaMock = vi.fn().mockImplementation((query: string) => ({
			matches: false,
			media: query,
			addEventListener: (_type: string, cb: () => void) => {
				changeHandler = cb;
			},
			removeEventListener: () => {},
			addListener: (cb: () => void) => {
				changeHandler = cb;
			},
			removeListener: () => {},
		}));
		Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMediaMock });

		initAppearance(); // system mode by default → registers the OS listener
		expect(typeof changeHandler).toBe("function");

		document.documentElement.style.setProperty("--bg", "#0a0b0c");
		changeHandler?.();
		const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
		expect(meta?.getAttribute("content")).toBe("#0a0b0c");
	});
});

describe("appearance — applyAppearance direct", () => {
	it("targets the documentElement of a provided document", () => {
		setTheme("dim");
		applyAppearance(document);
		expect(document.documentElement.getAttribute("data-theme")).toBe("dim");
	});
});

function readIndexHtml(): string {
	// The jsdom environment gives import.meta.url an http scheme, so resolve the
	// file against the working directory. Tests may run from the package root
	// (per-package vitest) or the monorepo root (`npm test`), so try both.
	const candidates = [
		resolve(process.cwd(), "src/client/index.html"),
		resolve(process.cwd(), "packages/dashboard/src/client/index.html"),
	];
	const found = candidates.find((p) => existsSync(p));
	if (!found) throw new Error(`appearance.test: index.html not found (tried ${candidates.join(", ")})`);
	return readFileSync(found, "utf-8");
}

describe("appearance — index.html bootstrap contract", () => {
	const html = readIndexHtml();

	it("declares the exact storage keys the module uses", () => {
		expect(html).toContain(THEME_STORAGE_KEY);
		expect(html).toContain(COLOR_MODE_STORAGE_KEY);
	});

	it("inline allowlist includes every non-default theme id", () => {
		for (const id of THEME_IDS.filter((t) => t !== "default")) {
			expect(html).toContain(`"${id}"`);
		}
	});

	it("inline allowlist includes every non-system mode", () => {
		for (const m of MODES.filter((mode) => mode !== "system")) {
			expect(html).toContain(`"${m}"`);
		}
	});

	it("does not list the default theme or system mode in the bootstrap allowlists", () => {
		// The bootstrap only sets attributes for non-default/non-system values.
		// The literal arrays must NOT contain them (guards against drift).
		expect(html).toContain('["dim", "solarized", "gruvbox"]');
		expect(html).toContain('["light", "dark"]');
	});
});
