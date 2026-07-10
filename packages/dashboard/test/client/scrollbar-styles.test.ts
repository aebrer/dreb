/**
 * Scrollbar styling regression guard.
 *
 * Scrollbar chrome is pure presentational CSS with no unit-testable behavior,
 * so this is an honest guard (not a behavioral test): it asserts the dashboard
 * stylesheet keeps declaring token-driven scrollbar rules and never reintroduces
 * a hardcoded color into them. Visual correctness (thin, hairline, light/dark)
 * is verified manually against the running dashboard.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const TOKENS_PATH = resolve(__dirname, "../../src/client/styles/tokens.css");
const TOKENS_CSS = readFileSync(TOKENS_PATH, "utf-8");

/** Extract the scrollbar section (from the section header to the next header). */
function scrollbarSection(css: string): string {
	const start = css.indexOf("scrollbars */");
	expect(start).toBeGreaterThan(-1);
	const rest = css.slice(start);
	const nextHeader = rest.indexOf("base */");
	expect(nextHeader).toBeGreaterThan(-1);
	return rest.slice(0, nextHeader);
}

describe("dashboard scrollbar styling", () => {
	it("declares the standards (Firefox) scrollbar properties", () => {
		expect(TOKENS_CSS).toMatch(/scrollbar-width:\s*thin/);
		expect(TOKENS_CSS).toMatch(/scrollbar-color:\s*var\(--border\)\s+transparent/);
	});

	it("declares the WebKit/Chromium scrollbar pseudo-elements", () => {
		expect(TOKENS_CSS).toContain("::-webkit-scrollbar");
		expect(TOKENS_CSS).toContain("::-webkit-scrollbar-thumb");
		expect(TOKENS_CSS).toContain("::-webkit-scrollbar-track");
	});

	it("uses tokens for the thumb: --border at rest, --muted on hover", () => {
		const section = scrollbarSection(TOKENS_CSS);
		expect(section).toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--border\)/);
		expect(section).toMatch(/::-webkit-scrollbar-thumb:hover\s*\{[^}]*background:\s*var\(--muted\)/);
	});

	it("never hardcodes a color in the scrollbar section", () => {
		const section = scrollbarSection(TOKENS_CSS);
		// No hex colors and no rgb()/hsl() literals — only var(--token) references.
		expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(section).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/);
	});
});
