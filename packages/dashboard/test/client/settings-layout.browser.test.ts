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
 *
 * Scope: this test is LAYOUT-ONLY. The harness mirrors the production markup
 * from settings.tsx (home-relative option text, title tooltip) as a static
 * fixture; it intentionally does not assert option semantics. The production
 * markup contract (classes/structure/title binding this fixture depends on)
 * and all option/tooltip semantics are covered in screens.test.tsx (jsdom) —
 * drift there fails loudly. Chromium's opened select popup is a native window
 * outside the DOM and cannot be measured; it also stays control-width and
 * clips long options on Linux, which is why production shortens the display
 * text in the first place.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const tokensCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/tokens.css", import.meta.url)), "utf8");
const appCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/app.css", import.meta.url)), "utf8");
const themesCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/themes.css", import.meta.url)), "utf8");

// ~125 chars: long enough that the select's intrinsic width exceeds the space
// available beside the label even on a wide viewport. Options render
// home-relative in production (Chromium's opened popup stays control-width
// and clips); the full path lives in the option value and the select's title.
const longPath = `/home/acters/${"deeply-nested/project-layer/".repeat(4)}dreb`;
const longPathDisplay = `~/${"deeply-nested/project-layer/".repeat(4)}dreb`;

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
					<select data-agent-select title="${longPath}">
						<option value="">global/home only</option>
						<option value="${longPath}" selected>${longPathDisplay}</option>
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
			<div class="setting-row" data-checkbox-row>
				<span class="setting-label">
					<span class="name">always expand thinking</span>
					<span class="hint">checkbox control regression guard</span>
				</span>
				<span class="setting-control">
					<label class="checkbox-control">
						<input type="checkbox" checked data-checkbox />
						<span>open by default</span>
					</label>
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
	rowIsHorizontal: boolean;
	controlBelowLabel: boolean;
	agentValueClipped: boolean;
	shortSelectNaturalSize: boolean;
	checkboxWithinRow: boolean;
	checkboxNaturalSize: boolean;
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
		// Width the element would take with no max-width constraint — the
		// baseline for "natural size" and "is the value clipped" checks. The
		// clone is appended to the SAME PARENT so scoped rules (e.g.
		// .setting-control select padding/font-size) apply identically.
		const intrinsicWidth = (element: HTMLElement) => {
			const clone = element.cloneNode(true) as HTMLElement;
			clone.style.maxWidth = "none";
			clone.style.position = "absolute";
			clone.style.visibility = "hidden";
			element.parentElement!.appendChild(clone);
			const width = clone.getBoundingClientRect().width;
			clone.remove();
			return width;
		};
		const row = document.querySelector<HTMLElement>("[data-agent-row]")!;
		const label = row.querySelector<HTMLElement>("[data-agent-label]")!;
		const name = label.querySelector<HTMLElement>(".name")!;
		const control = row.querySelector<HTMLElement>("[data-agent-control]")!;
		const select = row.querySelector<HTMLSelectElement>("[data-agent-select]")!;
		const shortRow = document.querySelector<HTMLElement>("[data-short-row]")!;
		const shortSelect = shortRow.querySelector<HTMLElement>("[data-short-select]")!;
		const checkboxRow = document.querySelector<HTMLElement>("[data-checkbox-row]")!;
		const checkbox = checkboxRow.querySelector<HTMLElement>("[data-checkbox]")!;
		const nameStyle = getComputedStyle(name);
		const nameLineHeight = Number.parseFloat(nameStyle.lineHeight);
		const controlRect = control.getBoundingClientRect();
		const labelRect = label.getBoundingClientRect();

		return {
			documentFits: document.documentElement.scrollWidth <= window.innerWidth + tolerance,
			selectWithinRow: rectWithin(select, row),
			// The setting's primary text must not wrap; the hint may wrap (it is
			// secondary and wraps in narrow layouts elsewhere by design). Pre-fix
			// the unshrinkable select crushes the label until even the name wraps.
			nameOnOneLine: name.getBoundingClientRect().height <= nameLineHeight + tolerance,
			// Row layout is active above the 700px breakpoint: the control sits
			// beside the label, not below it.
			rowIsHorizontal:
				controlRect.left > labelRect.left &&
				controlRect.top < labelRect.bottom &&
				controlRect.bottom > labelRect.top,
			controlBelowLabel: controlRect.top > labelRect.top + tolerance,
			// The capped select must visibly clip its value: rendered width is
			// smaller than the unconstrained intrinsic width. Pre-fix the wide
			// layout renders the select AT intrinsic width (no clipping, label
			// squished instead).
			agentValueClipped: intrinsicWidth(select) - select.getBoundingClientRect().width > 2,
			// Natural size = rendered width matches the unconstrained baseline:
			// neither stretched nor clipped by the new constraints.
			shortSelectNaturalSize: Math.abs(shortSelect.getBoundingClientRect().width - intrinsicWidth(shortSelect)) <= 2,
			checkboxWithinRow: rectWithin(checkbox, checkboxRow),
			checkboxNaturalSize: Math.abs(checkbox.getBoundingClientRect().width - intrinsicWidth(checkbox)) <= 2,
		};
	});
}

async function measurementsAt(width: number): Promise<SettingsMeasurements> {
	await page.setViewportSize({ width, height: 800 });
	return measurements();
}

describe("settings agent-context row layout in a real browser", () => {
	// 701px is the first viewport where the desktop row layout applies; 1024px
	// exercises the same layout with slack. (.settings-wrap caps at 720px, so
	// intermediate widths add no new geometry.)
	it.each([701, 1024])("keeps the label readable and the row horizontal at %ipx", async (width) => {
		const measured = await measurementsAt(width);

		expect(measured.documentFits).toBe(true);
		expect(measured.selectWithinRow).toBe(true);
		expect(measured.nameOnOneLine).toBe(true);
		expect(measured.rowIsHorizontal).toBe(true);
		expect(measured.agentValueClipped).toBe(true);
	});

	it.each([360, 700])("caps the select to the container at %ipx without horizontal overflow", async (width) => {
		const measured = await measurementsAt(width);

		expect(measured.documentFits).toBe(true);
		expect(measured.selectWithinRow).toBe(true);
		// Column layout is active at these widths: the control stacks below the label.
		expect(measured.controlBelowLabel).toBe(true);
		expect(measured.agentValueClipped).toBe(true);
	});

	it.each([360, 1024])("leaves short controls and checkboxes at their natural size at %ipx", async (width) => {
		const measured = await measurementsAt(width);

		expect(measured.shortSelectNaturalSize).toBe(true);
		expect(measured.checkboxWithinRow).toBe(true);
		expect(measured.checkboxNaturalSize).toBe(true);
	});
});
