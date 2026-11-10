/**
 * Functions the screenshot harness runs inside the browser page.
 *
 * Playwright serializes these functions and evaluates them in Chromium, so they
 * must be self-contained (no imports or closures). The repository type-check uses
 * Node libraries only, so the few browser globals they touch are declared here,
 * module-scoped, rather than enabling the DOM library for the whole program.
 */

interface PageElement {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
	querySelector(selector: string): PageElement | null;
	closest(selector: string): PageElement | null;
	getAttributeNames(): string[];
	getAttribute(name: string): string | null;
	getBoundingClientRect(): { top: number };
}

/** An `<input>` or `<textarea>`: its live `value` is painted but is neither text nor an attribute. */
interface PageFormControl extends PageElement {
	readonly value: string;
}

declare const document: {
	readonly title: string;
	readonly body: PageElement & { readonly innerText: string };
	querySelectorAll(selector: "input, textarea"): Iterable<PageFormControl>;
	querySelectorAll(selector: string): Iterable<PageElement>;
	readonly fonts: { readonly ready: Promise<unknown>; load(font: string): Promise<unknown[]> };
};
declare const window: {
	readonly scrollY: number;
	scrollTo(options: { top: number; behavior: "instant" }): void;
};
declare const localStorage: { clear(): void; setItem(key: string, value: string): void };
declare function getComputedStyle(element: PageElement): { readonly overflowY: string };
declare function requestAnimationFrame(callback: () => void): number;

/** Seed the browser-local appearance before any app script runs. */
export function seedAppearance(appearance: { theme: string | null; colorMode: string }): void {
	localStorage.clear();
	localStorage.setItem("dreb.dashboard.colorMode", appearance.colorMode);
	if (appearance.theme) localStorage.setItem("dreb.dashboard.theme", appearance.theme);
}

/**
 * Everything the page can paint as text: visible text, every attribute value (tooltips,
 * hrefs, aria labels…), and the live values of text fields.
 */
export function collectRenderedSurface(): string {
	const parts: string[] = [document.title, document.body.innerText];
	for (const element of document.querySelectorAll("*")) {
		for (const attribute of element.getAttributeNames()) parts.push(element.getAttribute(attribute) ?? "");
	}
	for (const control of document.querySelectorAll("input, textarea")) parts.push(control.value);
	return parts.join("\n");
}

/**
 * Load `family` and report how many of its faces loaded. `document.fonts.check()` cannot
 * be used for this: it returns true when no face of the family is registered at all.
 */
export async function loadFontFamily(family: string): Promise<{ loadedFaces: number; error?: string }> {
	await document.fonts.ready;
	try {
		return { loadedFaces: (await document.fonts.load(`16px "${family}"`)).length };
	} catch (error) {
		// A registered face whose file failed to load rejects the whole load.
		return { loadedFaces: 0, error: String(error) };
	}
}

/** Resolve after webfonts settle. */
export async function fontsReady(): Promise<void> {
	await document.fonts.ready;
}

/** Resolve after two animation frames, so the final layout has painted. */
export function twoFrames(): Promise<void> {
	return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
}

/** Pin every scrollable transcript container to its newest entry, like a live session. */
export function pinTranscripts(): void {
	for (const element of document.querySelectorAll("*")) {
		const scrollable = /(auto|scroll)/.test(getComputedStyle(element).overflowY);
		if (scrollable && element.scrollHeight > element.clientHeight && element.querySelector(".entry")) {
			element.scrollTop = element.scrollHeight;
		}
	}
}

/** Scroll the window so `element` (or its closest `ancestor`) sits `gap` px below the top edge. */
export function scrollElementToTop(element: PageElement, options: { gap: number; ancestor?: string }): void {
	const target = (options.ancestor ? element.closest(options.ancestor) : null) ?? element;
	window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - options.gap, behavior: "instant" });
}
