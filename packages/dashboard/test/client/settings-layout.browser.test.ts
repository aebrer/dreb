/**
 * Real-browser layout regression coverage for the settings "agent definition
 * context" row (issue 378).
 *
 * The row's <select> holds absolute project paths — unbounded-length user
 * data — and a select's intrinsic width equals its longest option. Without
 * min-width: 0 on the .setting-control flex item the control cannot shrink
 * below that min-content width, so it squishes the label on wide screens;
 * without max-width: 100% it overflows the container in the narrow column
 * layout. jsdom performs no flex layout or document overflow measurement, so
 * this loads the production stylesheets in production order and measures the
 * DOM in real Chromium, mirroring fleet-layout.browser.test.ts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const tokensCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/tokens.css", import.meta.url)), "utf8");
const appCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/app.css", import.meta.url)), "utf8");
const themesCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/themes.css", import.meta.url)), "utf8");

// ~125 chars: long enough that the select's intrinsic width exceeds the space
// available beside the label even on a wide viewport.
const longPath = `/home/acters/${"deeply-nested/project-layer/".repeat(4)}dreb`;

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
	<main class="container settings-wrap">
		<section class="settings-section">
			<h2>agent models</h2>
			<div class="setting-row agent-context-row" data-agent-row>
				<span class="setting-label" data-agent-label>
					<span class="name">agent definition context</span>
					<span class="hint">choose a project to include its .dreb/agents definitions</span>
				</span>
				<span class="setting-control" data-agent-control>
					<select data-agent-select>
						<option value="">global/home only</option>
						<option value="${longPath}" selected>${longPath}</option>
					</select>
				</span>
			</div>
			<div class="setting-row" data-short-row>
				<span class="setting-label">
					<span class="name">appearance</span>
					<span class="hint">short control regression guard</span>
				</span>
				<span class="setting-control">
					<select data-short-select>
						<option selected>system</option>
						<option>light</option>
						<option>dark</option>
					</select>
				</span>
			</div>
		</section>
	</main>
</body>
</html>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
	browser = await chromium.launch();
	page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
}, 60_000);

afterAll(async () => {
	await browser?.close();
});

beforeEach(async () => {
	await page.setContent(HARNESS_HTML);
});

type SettingsMeasurements = {
	documentFits: boolean;
	selectWithinRow: boolean;
	nameOnOneLine: boolean;
	controlBelowLabel: boolean;
	shortSelectWithinRow: boolean;
	shortSelectNotStretched: boolean;
};

async function measurements(): Promise<SettingsMeasurements> {
	return page.evaluate(() => {
		const tolerance = 1;
		const rectWithin = (child: Element, parent: Element) => {
			const childRect = child.getBoundingClientRect();
			const parentRect = parent.getBoundingClientRect();
			return (
				childRect.left >= parentRect.left - tolerance &&
				childRect.right <= parentRect.right + tolerance &&
				childRect.top >= parentRect.top - tolerance &&
				childRect.bottom <= parentRect.bottom + tolerance
			);
		};
		const row = document.querySelector<HTMLElement>("[data-agent-row]")!;
		const label = row.querySelector<HTMLElement>("[data-agent-label]")!;
		const name = label.querySelector<HTMLElement>(".name")!;
		const control = row.querySelector<HTMLElement>("[data-agent-control]")!;
		const select = row.querySelector<HTMLElement>("[data-agent-select]")!;
		const shortRow = document.querySelector<HTMLElement>("[data-short-row]")!;
		const shortSelect = shortRow.querySelector<HTMLElement>("[data-short-select]")!;
		const nameStyle = getComputedStyle(name);
		const nameLineHeight = Number.parseFloat(nameStyle.lineHeight);

		return {
			documentFits: document.documentElement.scrollWidth <= window.innerWidth + tolerance,
			selectWithinRow: rectWithin(select, row),
			// The setting's primary text must not wrap; the hint may wrap (it is
			// secondary and wraps in narrow layouts elsewhere by design). Pre-fix
			// the unshrinkable select crushes the label until even the name wraps.
			nameOnOneLine: name.getBoundingClientRect().height <= nameLineHeight + tolerance,
			controlBelowLabel: control.getBoundingClientRect().top > label.getBoundingClientRect().top + tolerance,
			shortSelectWithinRow: rectWithin(shortSelect, shortRow),
			shortSelectNotStretched:
				shortSelect.getBoundingClientRect().width <= shortRow.getBoundingClientRect().width / 2 + tolerance,
		};
	});
}

describe("settings agent-context row layout in a real browser", () => {
	it.each([760, 1024])("keeps the label readable at %ipx instead of squishing it", async (width) => {
		await page.setViewportSize({ width, height: 800 });
		const measured = await measurements();

		expect(measured.documentFits).toBe(true);
		expect(measured.selectWithinRow).toBe(true);
		expect(measured.nameOnOneLine).toBe(true);
	});

	it.each([360, 700])("caps the select to the container at %ipx without horizontal overflow", async (width) => {
		await page.setViewportSize({ width, height: 800 });
		const measured = await measurements();

		expect(measured.documentFits).toBe(true);
		expect(measured.selectWithinRow).toBe(true);
		// Column layout is active at these widths: the control stacks below the label.
		expect(measured.controlBelowLabel).toBe(true);
	});

	it.each([360, 1024])("leaves short controls at their natural size at %ipx", async (width) => {
		await page.setViewportSize({ width, height: 800 });
		const measured = await measurements();

		expect(measured.shortSelectWithinRow).toBe(true);
		expect(measured.shortSelectNotStretched).toBe(true);
	});
});
