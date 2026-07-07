#!/usr/bin/env node
/**
 * capture.mjs — screenshot every mockup at desktop + mobile viewports.
 *
 * Usage:  node capture.mjs [mockup-name ...]
 *   e.g.  node capture.mjs                  # all mockups
 *         node capture.mjs fleet-overview   # just one
 *
 * Requires playwright (any install resolvable from this directory or a
 * parent — module resolution walks up). Chromium must already be
 * downloaded (npx playwright install chromium).
 *
 * Output: screenshots/<name>-desktop.png      (1440x900, light, full page)
 *         screenshots/<name>-mobile.png       (390x844, light, full page)
 *         screenshots/<name>-desktop-dark.png (1440x900, dark, full page)
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const mockupsDir = join(here, "mockups");
const outDir = join(here, "screenshots");

const viewports = [
	{ suffix: "desktop", width: 1440, height: 900, colorScheme: "light" },
	{ suffix: "mobile", width: 390, height: 844, colorScheme: "light" },
	{ suffix: "desktop-dark", width: 1440, height: 900, colorScheme: "dark" },
];

const requested = process.argv.slice(2);
const all = readdirSync(mockupsDir)
	.filter((f) => f.endsWith(".html"))
	.map((f) => f.replace(/\.html$/, ""));
const names = requested.length > 0 ? requested : all;

const unknown = names.filter((n) => !all.includes(n));
if (unknown.length > 0) {
	console.error(`Unknown mockup(s): ${unknown.join(", ")}`);
	console.error(`Available: ${all.join(", ")}`);
	process.exit(1);
}

const browser = await chromium.launch();
try {
	for (const name of names) {
		const url = pathToFileURL(join(mockupsDir, `${name}.html`)).href;
		for (const { suffix, width, height, colorScheme } of viewports) {
			const page = await browser.newPage({ viewport: { width, height }, colorScheme });
			await page.goto(url, { waitUntil: "networkidle" });
			// Ensure webfonts (IBM Plex Mono) are rendered before capture.
			await page.evaluate(() => document.fonts.ready);
			// Chat panes pin to the newest entry, like a live session would.
			await page.evaluate(() => {
				for (const el of document.querySelectorAll(".chat")) el.scrollTop = el.scrollHeight;
			});
			const out = join(outDir, `${name}-${suffix}.png`);
			await page.screenshot({ path: out, fullPage: true });
			console.log(`captured ${out} (${width}x${height})`);
			await page.close();
		}
	}
} finally {
	await browser.close();
}
