/**
 * Real-browser notification layout regression coverage.
 *
 * jsdom cannot validate wrapping, capped overflow, fixed positioning, or whether
 * controls remain inside the viewport. Load the production styles in Chromium
 * and measure the same banner/toast DOM emitted by the shared components.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const tokensCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/tokens.css", import.meta.url)), "utf8");
const appCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/app.css", import.meta.url)), "utf8");
const themesCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/themes.css", import.meta.url)), "utf8");

const longBannerText = Array.from(
	{ length: 80 },
	(_, index) => `A deliberately long banner line ${index + 1} that must scroll without pushing its controls away.`,
).join("\n");

const HARNESS_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${tokensCss}</style>
<style>${appCss}</style>
<style>${themesCss}</style>
</head>
<body>
	<div class="container banner-region" aria-live="polite">
		<div class="banner warning" data-banner-key="layout">
			<span class="banner-glyph" aria-hidden="true">◆</span>
			<span class="banner-text">${longBannerText}</span>
			<span class="banner-actions">
				<button type="button" class="btn btn-small">Resume session</button>
				<button type="button" class="btn btn-small">Return to fleet</button>
			</span>
			<button type="button" class="btn btn-small banner-dismiss">dismiss</button>
		</div>
	</div>
	<div class="toast-region">
		<div class="toast error">
			<span>Global notice remains fixed at the top center.</span>
			<button type="button" class="btn btn-small">✕</button>
		</div>
	</div>
</body>
</html>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
	browser = await chromium.launch();
	page = await browser.newPage({ viewport: { width: 800, height: 800 } });
}, 60_000);

afterAll(async () => {
	await browser?.close();
});

beforeEach(async () => {
	await page.setContent(HARNESS_HTML);
});

describe("notification layout in a real browser", () => {
	it("caps long banner text at 390px while keeping actions and dismiss in the viewport", async () => {
		await page.setViewportSize({ width: 390, height: 800 });
		const measured = await page.evaluate(() => {
			const tolerance = 1;
			const text = document.querySelector<HTMLElement>(".banner-text")!;
			const controls = [...document.querySelectorAll<HTMLElement>(".banner-actions button, .banner-dismiss")];
			const inViewport = (element: HTMLElement) => {
				const rect = element.getBoundingClientRect();
				return (
					rect.left >= -tolerance &&
					rect.right <= window.innerWidth + tolerance &&
					rect.top >= -tolerance &&
					rect.bottom <= window.innerHeight + tolerance
				);
			};
			return {
				documentFits: document.documentElement.scrollWidth <= window.innerWidth + tolerance,
				textScrolls: text.scrollHeight > text.clientHeight + tolerance,
				textIsCapped: text.clientHeight <= window.innerHeight * 0.4 + tolerance,
				textOverflowY: getComputedStyle(text).overflowY,
				controlsVisible: controls.length === 3 && controls.every(inViewport),
			};
		});

		expect(measured.documentFits).toBe(true);
		expect(measured.textScrolls).toBe(true);
		expect(measured.textIsCapped).toBe(true);
		expect(measured.textOverflowY).toBe("auto");
		expect(measured.controlsVisible).toBe(true);
	});

	it.each([390, 1200])("keeps the global toast fixed at top-center at %ipx", async (width) => {
		await page.setViewportSize({ width, height: 800 });
		const measured = await page.evaluate(() => {
			const region = document.querySelector<HTMLElement>(".toast-region")!;
			const rect = region.getBoundingClientRect();
			return {
				position: getComputedStyle(region).position,
				top: rect.top,
				centerDelta: Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2),
				withinViewport: rect.left >= -1 && rect.right <= window.innerWidth + 1,
			};
		});

		expect(measured.position).toBe("fixed");
		expect(measured.top).toBeGreaterThanOrEqual(0);
		expect(measured.top).toBeLessThan(20);
		expect(measured.centerDelta).toBeLessThanOrEqual(1);
		expect(measured.withinViewport).toBe(true);
	});
});
