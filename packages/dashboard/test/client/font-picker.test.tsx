// @vitest-environment jsdom
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FontPicker } from "../../src/client/components/font-picker.js";
import {
	__resetAppearanceForTests,
	FONT_STORAGE_KEY,
	FONTS,
	font,
	setFont,
	setTheme,
} from "../../src/client/state/appearance.js";

let host: HTMLDivElement;
let dispose: () => void;
const trigger = () => host.querySelector<HTMLButtonElement>("[role=combobox]")!;
const active = () => document.getElementById(trigger().getAttribute("aria-activedescendant")!);
const key = (value: string, shiftKey = false) =>
	trigger().dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }));

beforeEach(() => {
	const values = new Map<string, string>();
	Object.defineProperty(window, "localStorage", {
		configurable: true,
		value: {
			getItem: (k: string) => values.get(k) ?? null,
			setItem: (k: string, v: string) => values.set(k, v),
			removeItem: (k: string) => values.delete(k),
			clear: () => values.clear(),
		},
	});
	__resetAppearanceForTests();
	host = document.createElement("div");
	document.body.append(host);
	dispose = render(() => <FontPicker />, host);
});
afterEach(() => {
	dispose();
	host.remove();
	__resetAppearanceForTests();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("font picker", () => {
	it("mounts all 37 named choices only when open, with groups and selected/active relationships", () => {
		expect(host.querySelector("[role=listbox]")).toBeNull();
		expect(trigger().getAttribute("aria-expanded")).toBe("false");
		trigger().click();
		const popup = host.querySelector("[role=listbox]")!;
		expect(trigger().getAttribute("aria-controls")).toBe(popup.id);
		expect(
			[...popup.querySelectorAll<HTMLButtonElement>("[role=option]")].map((element) => element.dataset.fontOption),
		).toEqual(FONTS.map((entry) => entry.id));
		expect(popup.querySelectorAll("fieldset")).toHaveLength(3);
		expect(active()?.getAttribute("data-font-option")).toBe("theme");
		expect(popup.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
		key("Escape");
		expect(host.querySelector("[role=listbox]")).toBeNull();
	});
	it("focuses on activation even when the browser does not give button clicks focus", () => {
		const outside = document.createElement("button");
		document.body.append(outside);
		outside.focus();
		const focus = vi.spyOn(trigger(), "focus");
		trigger().click();
		expect(document.activeElement).toBe(trigger());
		expect(focus).toHaveBeenCalledWith({ preventScroll: true });
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
		expect(active()?.getAttribute("data-font-option")).toBe("bodoni-moda");
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(trigger().getAttribute("aria-expanded")).toBe("false");
		expect(localStorage.getItem(FONT_STORAGE_KEY)).toBeNull();
		outside.remove();
	});
	it("separates arrows/Home/End highlight from commitment and preserves theme", () => {
		setTheme("gruvbox");
		trigger().focus();
		key("ArrowDown");
		key("ArrowDown");
		expect(active()?.getAttribute("data-font-option")).toBe("ibm-plex-mono");
		expect(font()).toBe("theme");
		expect(localStorage.getItem(FONT_STORAGE_KEY)).toBeNull();
		key("End");
		expect(active()?.getAttribute("data-font-option")).toBe("bodoni-moda");
		key("Home");
		key("ArrowUp");
		expect(active()?.getAttribute("data-font-option")).toBe("bodoni-moda");
		key("Enter");
		expect(font()).toBe("bodoni-moda");
		expect(localStorage.getItem(FONT_STORAGE_KEY)).toBe("bodoni-moda");
		expect(document.documentElement.dataset.theme).toBe("gruvbox");
		expect(document.activeElement).toBe(trigger());
	});
	it("supports prefix typeahead, repeated-letter cycling, and Space commitment", () => {
		key("n");
		key("o");
		key("t");
		key("o");
		expect(active()?.textContent).toContain("Noto Sans");
		key("Escape");
		key("r");
		const first = active()?.getAttribute("data-font-option");
		key("r");
		expect(active()?.getAttribute("data-font-option")).not.toBe(first);
		key(" ");
		expect(font()).not.toBe("theme");
	});
	it("names restricted derivatives primarily and describes the source before and after commitment", () => {
		for (const entry of FONTS.filter(({ sourceLabel }) => sourceLabel)) {
			trigger().click();
			const option = host.querySelector<HTMLButtonElement>(`[data-font-option="${entry.id}"]`)!;
			expect(option.getAttribute("aria-label")).toBe(entry.label);
			expect(option.querySelector(".font-picker-name")?.textContent).toBe(entry.label);
			expect(document.getElementById(option.getAttribute("aria-describedby")!)?.textContent).toBe(
				`Based on ${entry.sourceLabel}`,
			);
			option.click();
			expect(trigger().querySelector(".font-picker-name")?.textContent).toBe(entry.label);
			expect(document.getElementById(trigger().getAttribute("aria-describedby")!)?.textContent).toBe(
				`Based on ${entry.sourceLabel}`,
			);
			expect(font()).toBe(entry.id);
			expect(localStorage.getItem(FONT_STORAGE_KEY)).toBe(entry.id);
		}
	});
	it("discovers restricted derivatives by source-family typeahead without committing", () => {
		for (const entry of FONTS.filter(({ sourceLabel }) => sourceLabel)) {
			trigger().click();
			for (const character of entry.sourceLabel!.split(" ")[0].toLowerCase()) key(character);
			expect(active()?.getAttribute("data-font-option")).toBe(entry.id);
			key("Escape");
			expect(localStorage.getItem(FONT_STORAGE_KEY)).toBeNull();
		}
	});
	it.each(["above", "below"])(
		"dismisses without committing when page scroll moves the anchor %s the viewport",
		(direction) => {
			trigger().click();
			key("End");
			vi.spyOn(trigger(), "getBoundingClientRect").mockReturnValue(
				new DOMRect(20, direction === "above" ? -100 : window.innerHeight + 20, 200, 40),
			);
			vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
				callback(0);
				return 0;
			});
			document.dispatchEvent(new Event("scroll"));
			expect(trigger().getAttribute("aria-expanded")).toBe("false");
			expect(host.querySelector("[role=listbox]")).toBeNull();
			expect(localStorage.getItem(FONT_STORAGE_KEY)).toBeNull();
		},
	);
	it("cancels Escape without leaking it, exits on Tab/Shift-Tab and dismisses outside pointers", () => {
		const escapedEvent = vi.fn();
		document.addEventListener("keydown", escapedEvent);
		trigger().click();
		key("End");
		escapedEvent.mockClear();
		key("Escape");
		expect(escapedEvent).not.toHaveBeenCalled();
		document.removeEventListener("keydown", escapedEvent);
		expect(font()).toBe("theme");
		for (const shift of [false, true]) {
			trigger().click();
			expect(key("Tab", shift)).toBe(true);
			expect(trigger().getAttribute("aria-expanded")).toBe("false");
		}
		trigger().click();
		document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		expect(trigger().getAttribute("aria-expanded")).toBe("false");
	});
	it("commits pointers, resets the default key, and reacts to external preference/theme changes", () => {
		trigger().click();
		host.querySelector<HTMLButtonElement>('[data-font-option="inter"]')!.click();
		expect(font()).toBe("inter");
		setTheme("gruvbox");
		trigger().click();
		expect(host.querySelector<HTMLElement>('[data-font-option="theme"]')!.style.fontFamily).toContain(
			"JetBrains Mono",
		);
		setFont("lora");
		expect(active()?.getAttribute("data-font-option")).toBe("lora");
		expect(trigger().textContent).toContain("Lora");
		host.querySelector<HTMLButtonElement>('[data-font-option="theme"]')!.click();
		expect(localStorage.getItem(FONT_STORAGE_KEY)).toBeNull();
	});
	it("restores focus after option click but permits ordinary focus to leave without commitment", () => {
		trigger().focus();
		trigger().click();
		const outside = document.createElement("button");
		document.body.append(outside);
		outside.focus();
		expect(trigger().getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(outside);
		expect(font()).toBe("theme");
		outside.remove();
	});
	it("gates font previews on viewport observation and disconnects on close", async () => {
		let callback!: IntersectionObserverCallback;
		const disconnect = vi.fn();
		const observe = vi.fn();
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				constructor(fn: IntersectionObserverCallback) {
					callback = fn;
				}
				observe = observe;
				unobserve = vi.fn();
				disconnect = disconnect;
			},
		);
		dispose();
		dispose = render(() => <FontPicker />, host);
		trigger().click();
		await Promise.resolve();
		expect(observe).toHaveBeenCalledTimes(37);
		const option = host.querySelector<HTMLElement>('[data-font-option="inter"]')!;
		expect(option.style.fontFamily).toBe("");
		callback(
			[{ target: option, isIntersecting: true } as unknown as IntersectionObserverEntry],
			{} as IntersectionObserver,
		);
		expect(option.style.fontFamily).toContain("Dreb Sans 04");
		key("Escape");
		expect(disconnect).toHaveBeenCalledTimes(1);
		trigger().click();
		expect(host.querySelector<HTMLElement>('[data-font-option="inter"]')!.style.fontFamily).toContain("Dreb Sans 04");
	});
	it("removes global listeners on close and unmount", () => {
		const add = vi.spyOn(document, "addEventListener");
		const remove = vi.spyOn(document, "removeEventListener");
		const windowRemove = vi.spyOn(window, "removeEventListener");
		trigger().click();
		const first = add.mock.calls.find(([name]) => name === "pointerdown")![1];
		key("Escape");
		expect(remove).toHaveBeenCalledWith("pointerdown", first);
		trigger().click();
		dispose();
		expect(remove.mock.calls.filter(([name]) => name === "pointerdown")).toHaveLength(2);
		expect(windowRemove.mock.calls.some(([name]) => name === "resize")).toBe(true);
		dispose = () => {};
	});
});
