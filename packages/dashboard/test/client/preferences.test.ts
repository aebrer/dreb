/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	IMAGE_DISPLAY_MODE_KEY,
	imageDisplayMode,
	reloadImageDisplayModePreference,
	setImageDisplayMode,
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
