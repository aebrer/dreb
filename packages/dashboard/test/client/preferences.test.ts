/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FLEET_SORT, FLEET_SORT_OPTIONS } from "../../src/client/state/fleet-sorting.js";
import {
	FLEET_SORT_KEY,
	fleetSort,
	IMAGE_DISPLAY_MODE_KEY,
	imageDisplayMode,
	reloadFleetSortPreference,
	reloadImageDisplayModePreference,
	reloadSessionSidebarCollapsedPreference,
	reloadSessionSidebarWidthPreference,
	SESSION_SIDEBAR_COLLAPSED_KEY,
	SESSION_SIDEBAR_WIDTH_KEY,
	sessionSidebarCollapsed,
	sessionSidebarWidth,
	setFleetSort,
	setImageDisplayMode,
	setSessionSidebarCollapsed,
	setSessionSidebarWidth,
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

describe("Fleet sorting preference", () => {
	beforeEach(() => {
		const values = new Map<string, string>();
		Object.defineProperty(window, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => values.set(key, String(value)),
			},
		});
		reloadFleetSortPreference();
	});

	it("defaults without writing or changing unrelated preferences", () => {
		expect(fleetSort()).toEqual(DEFAULT_FLEET_SORT);
		expect(window.localStorage.getItem(FLEET_SORT_KEY)).toBeNull();
		window.localStorage.setItem(IMAGE_DISPLAY_MODE_KEY, "originals");
		setFleetSort({ key: "created", direction: "asc" });
		expect(window.localStorage.getItem(IMAGE_DISPLAY_MODE_KEY)).toBe("originals");
	});

	it.each(FLEET_SORT_OPTIONS.map(({ key }) => key))(
		"round-trips both directions for %s and restores the whole pair",
		(key) => {
			for (const direction of ["asc", "desc"] as const) {
				const value = { key, direction };
				setFleetSort(value);
				expect(fleetSort()).toEqual(value);
				expect(JSON.parse(window.localStorage.getItem(FLEET_SORT_KEY)!)).toEqual(value);
				window.localStorage.setItem(FLEET_SORT_KEY, JSON.stringify({ key: "activity", direction: "desc" }));
				reloadFleetSortPreference();
				expect(fleetSort()).toEqual({ key: "activity", direction: "desc" });
				window.localStorage.setItem(FLEET_SORT_KEY, JSON.stringify(value));
				reloadFleetSortPreference();
				expect(fleetSort()).toEqual(value);
			}
		},
	);

	it.each([
		"",
		"bad JSON",
		"null",
		"[]",
		"{}",
		"true",
		'"name"',
		'{"key":"name"}',
		'{"key":"unknown","direction":"asc"}',
		'{"key":"created","direction":"up"}',
		'{"key":"path","direction":null}',
	])("rejects malformed/unknown stored preference %j", (raw) => {
		setFleetSort({ key: "started", direction: "desc" });
		window.localStorage.setItem(FLEET_SORT_KEY, raw);
		reloadFleetSortPreference();
		expect(fleetSort()).toEqual(DEFAULT_FLEET_SORT);
	});

	it("uses safe defaults on thrown reads and keeps both controls honest on thrown writes", () => {
		const read = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
			throw new Error("unavailable");
		});
		reloadFleetSortPreference();
		expect(fleetSort()).toEqual(DEFAULT_FLEET_SORT);
		read.mockRestore();
		const write = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
			throw new Error("unavailable");
		});
		setFleetSort({ key: "name", direction: "desc" });
		expect(fleetSort()).toEqual({ key: "name", direction: "desc" });
		write.mockRestore();
	});
});

describe("session sidebar width preference", () => {
	beforeEach(() => {
		const values = new Map<string, string>();
		Object.defineProperty(window, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => values.set(key, String(value)),
			},
		});
		reloadSessionSidebarWidthPreference();
	});

	it("defaults to 260 and round-trips the preferred width", () => {
		expect(sessionSidebarWidth()).toBe(260);
		setSessionSidebarWidth(420);
		expect(window.localStorage.getItem(SESSION_SIDEBAR_WIDTH_KEY)).toBe("420");
		reloadSessionSidebarWidthPreference();
		expect(sessionSidebarWidth()).toBe(420);
	});

	it.each(["", " ", "NaN", "Infinity", "-Infinity", "wide", "300px", "{}"])(
		"defaults malformed stored width %j",
		(raw) => {
			window.localStorage.setItem(SESSION_SIDEBAR_WIDTH_KEY, raw);
			reloadSessionSidebarWidthPreference();
			expect(sessionSidebarWidth()).toBe(260);
		},
	);

	it.each([
		[100, 240],
		[900, 560],
		[300.6, 301],
		[Number.NaN, 260],
		[Infinity, 260],
	])("normalizes width %s to %s on write and reload", (input, expected) => {
		setSessionSidebarWidth(input);
		expect(sessionSidebarWidth()).toBe(expected);
		expect(window.localStorage.getItem(SESSION_SIDEBAR_WIDTH_KEY)).toBe(String(expected));
		window.localStorage.setItem(SESSION_SIDEBAR_WIDTH_KEY, String(input));
		reloadSessionSidebarWidthPreference();
		expect(sessionSidebarWidth()).toBe(expected);
	});

	it("keeps resizing usable when storage reads or writes fail", () => {
		const read = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
			throw new Error("unavailable");
		});
		reloadSessionSidebarWidthPreference();
		expect(sessionSidebarWidth()).toBe(260);
		const write = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
			throw new Error("unavailable");
		});
		setSessionSidebarWidth(480);
		expect(sessionSidebarWidth()).toBe(480);
		read.mockRestore();
		write.mockRestore();
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
