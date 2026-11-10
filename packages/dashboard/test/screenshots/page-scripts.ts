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

declare const document: {
	readonly title: string;
	readonly body: PageElement & { readonly innerText: string };
	querySelectorAll(selector: string): Iterable<PageElement>;
	readonly fonts: { readonly ready: Promise<unknown>; check(font: string): boolean };
};
declare const window: {
	readonly scrollY: number;
	scrollTo(options: { top: number; behavior: "instant" }): void;
};
declare const localStorage: { clear(): void; setItem(key: string, value: string): void };
declare function getComputedStyle(element: PageElement): { readonly overflowY: string; readonly fontFamily: string };
declare function requestAnimationFrame(callback: () => void): number;

/** Seed the browser-local appearance before any app script runs. */
export function seedAppearance(appearance: { theme: string | null; colorMode: string }): void {
	localStorage.clear();
	localStorage.setItem("dreb.dashboard.colorMode", appearance.colorMode);
	if (appearance.theme) localStorage.setItem("dreb.dashboard.theme", appearance.theme);
}

/** Visible text plus every attribute value in the document (tooltips, hrefs, aria labels…). */
export function collectRenderedSurface(): string {
	const parts: string[] = [document.title, document.body.innerText];
	for (const element of document.querySelectorAll("*")) {
		for (const attribute of element.getAttributeNames()) parts.push(element.getAttribute(attribute) ?? "");
	}
	return parts.join("\n");
}

/** Whether the page body uses `family`, and whether that face finished loading. */
export async function fontState(family: string): Promise<{ usesFamily: boolean; loaded: boolean }> {
	await document.fonts.ready;
	return {
		usesFamily: getComputedStyle(document.body).fontFamily.includes(family),
		loaded: document.fonts.check(`16px "${family}"`),
	};
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
