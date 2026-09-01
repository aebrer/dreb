/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	IMAGE_DISPLAY_MODE_KEY,
	imageDisplayMode,
	reloadImageDisplayModePreference,
	reloadSessionSidebarCollapsedPreference,
	SESSION_SIDEBAR_COLLAPSED_KEY,
	sessionSidebarCollapsed,
	setImageDisplayMode,
	setSessionSidebarCollapsed,
} from "../../src/client/state/preferences.js";

describe("dashboard image display preference", () => {
	beforeEach(() => {
		const values = new Map<string, string>();
		Object.defineProperty(window, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => values.set(key, String(value)),
				removeItem: (key: string) => values.delete(key),
				clear: () => values.clear(),
			},
		});
		reloadImageDisplayModePreference();
	});

	it("defaults missing and invalid values to bounded previews", () => {
		expect(imageDisplayMode()).toBe("previews");
		window.localStorage.setItem(IMAGE_DISPLAY_MODE_KEY, "mobile-magic");
		reloadImageDisplayModePreference();
		expect(imageDisplayMode()).toBe("previews");
	});

	it("persists each supported browser-local mode", () => {
		for (const mode of ["placeholders", "previews", "originals"] as const) {
			setImageDisplayMode(mode);
			expect(imageDisplayMode()).toBe(mode);
			expect(window.localStorage.getItem(IMAGE_DISPLAY_MODE_KEY)).toBe(mode);
		}
	});

	it("keeps the in-memory control usable when browser storage throws", () => {
		const failure = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
			throw new Error("private storage unavailable");
		});
		setImageDisplayMode("originals");
		expect(imageDisplayMode()).toBe("originals");
		failure.mockRestore();
	});
});

describe("session sidebar collapse preference", () => {
	beforeEach(() => {
		const values = new Map<string, string>();
		Object.defineProperty(window, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => values.set(key, String(value)),
				removeItem: (key: string) => values.delete(key),
				clear: () => values.clear(),
			},
		});
		reloadSessionSidebarCollapsedPreference();
	});

	it("defaults to expanded when nothing is stored", () => {
		expect(sessionSidebarCollapsed()).toBe(false);
	});

	it("persists the collapsed state and reads it back after a reload", () => {
		expect(window.localStorage.getItem(SESSION_SIDEBAR_COLLAPSED_KEY)).toBeNull();
		setSessionSidebarCollapsed(true);
		expect(sessionSidebarCollapsed()).toBe(true);
		expect(window.localStorage.getItem(SESSION_SIDEBAR_COLLAPSED_KEY)).toBe("true");
		reloadSessionSidebarCollapsedPreference();
		expect(sessionSidebarCollapsed()).toBe(true);
		setSessionSidebarCollapsed(false);
		expect(sessionSidebarCollapsed()).toBe(false);
		expect(window.localStorage.getItem(SESSION_SIDEBAR_COLLAPSED_KEY)).toBe("false");
		reloadSessionSidebarCollapsedPreference();
		expect(sessionSidebarCollapsed()).toBe(false);
	});

	it("treats an invalid stored value as expanded", () => {
		window.localStorage.setItem(SESSION_SIDEBAR_COLLAPSED_KEY, "not-a-boolean");
		reloadSessionSidebarCollapsedPreference();
		expect(sessionSidebarCollapsed()).toBe(false);
	});

	it("keeps the in-memory control usable when browser storage throws", () => {
		const failure = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
			throw new Error("private storage unavailable");
		});
		setSessionSidebarCollapsed(true);
		expect(sessionSidebarCollapsed()).toBe(true);
		failure.mockRestore();
	});
});
