/**
 * Real-browser layout regression coverage for Settings.
 *
 * The agent-context row remains a focused fixture because this suite exercises
 * its unbounded path value. The scoped-model section renders the shipped
 * ScopedModelsEditor source through Vite so JSX, reactive states, and production
 * styles all participate in the browser measurements.
 */

import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const longProvider = "openrouter-provider-with-a-deliberately-long-name";
const longModelId = `organization/${"nested-model-segment/".repeat(4)}reasoning:model`;
const secondModelId = `organization/${"another-long-segment/".repeat(3)}fast:model`;

let vite: ViteDevServer;
let browser: Browser;
let page: Page;
let baseUrl: string;

beforeAll(async () => {
	vite = await createViteServer({
		root: fileURLToPath(new URL("../..", import.meta.url)),
		plugins: [solid({ include: [/src\/client\/.*\.[jt]sx$/, /test\/client\/fixtures\/.*\.tsx$/] })],
		logLevel: "error",
		optimizeDeps: { noDiscovery: true },
		server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
	});
	await vite.listen();
	const address = vite.httpServer?.address();
	if (address === null || address === undefined || typeof address === "string") {
		throw new Error("settings layout Vite server did not bind a TCP port");
	}
	baseUrl = `http://127.0.0.1:${address.port}`;

	browser = await chromium.launch();
	page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
	await page.route("**/api/settings**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/api/settings/models") {
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					models: [
						{
							provider: longProvider,
							id: longModelId,
							name: "A deliberately long model display name that must wrap safely",
							contextWindow: 200_000,
							reasoning: true,
						},
						{
							provider: longProvider,
							id: secondModelId,
							name: "Another long model display name for zero-selection validation",
							contextWindow: 100_000,
							reasoning: false,
						},
					],
				}),
			});
			return;
		}
		if (url.pathname === "/api/settings") {
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					enabledModels: [`${longProvider}/${longModelId}`, `${longProvider}/${secondModelId}`],
					resolvedScopedModels: [
						{ provider: longProvider, id: longModelId },
						{ provider: longProvider, id: secondModelId },
					],
					scopeWarnings: [
						{
							pattern: "missing/*",
							message:
								"A deliberately long resolver warning must wrap inside the viewport without hiding controls or model identifiers.",
						},
					],
					hasProjectEnabledModelsOverride: true,
					enabledModelsSource: "project",
				}),
			});
			return;
		}
		await route.abort();
	});
}, 60_000);

afterAll(async () => {
	await page?.close();
	await browser?.close();
	await vite?.close();
}, 60_000);

beforeEach(async () => {
	await page.setViewportSize({ width: 1024, height: 800 });
	await page.goto(`${baseUrl}/test/client/fixtures/settings-layout.html`, { waitUntil: "domcontentloaded" });
	await page.locator(".scoped-models-grid").waitFor({ state: "visible" });
}, 60_000);

type SettingsMeasurements = {
	documentFits: boolean;
	selectWithinRow: boolean;
	nameOnOneLine: boolean;
	rowIsHorizontal: boolean;
	controlBelowLabel: boolean;
	agentValueClipped: boolean;
	shortSelectWithinRow: boolean;
	shortSelectNaturalSize: boolean;
	scopedContentFitsViewport: boolean;
	scopedTapTargetsUsable: boolean;
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
		const nameStyle = getComputedStyle(name);
		const nameLineHeight = Number.parseFloat(nameStyle.lineHeight);
		const controlRect = control.getBoundingClientRect();
		const labelRect = label.getBoundingClientRect();
		const scopedElements = document.querySelectorAll<HTMLElement>(
			".scoped-models-editor, .scoped-models-editor h2, .scoped-models-editor h3, .scoped-models-editor .settings-warning, .scoped-models-editor .settings-error, .scoped-models-editor select, .scoped-models-editor input, .scoped-models-editor button, .scoped-models-editor .model-id, .scoped-models-editor .model-name, .scoped-model-order-row, .scoped-model-order-row > span",
		);
		const scopedContentFitsViewport = [...scopedElements].every((element) => {
			const rect = element.getBoundingClientRect();
			return rect.left >= -tolerance && rect.right <= window.innerWidth + tolerance;
		});
		const moveButtons = document.querySelectorAll<HTMLElement>(".scoped-model-move-controls button");

		return {
			documentFits: document.documentElement.scrollWidth <= window.innerWidth + tolerance,
			selectWithinRow: rectWithin(select, row),
			nameOnOneLine: name.getBoundingClientRect().height <= nameLineHeight + tolerance,
			rowIsHorizontal:
				controlRect.left > labelRect.left &&
				controlRect.top < labelRect.bottom &&
				controlRect.bottom > labelRect.top,
			controlBelowLabel: controlRect.top > labelRect.top + tolerance,
			agentValueClipped: intrinsicWidth(select) - select.getBoundingClientRect().width > 2,
			shortSelectWithinRow: rectWithin(shortSelect, shortRow),
			shortSelectNaturalSize: Math.abs(shortSelect.getBoundingClientRect().width - intrinsicWidth(shortSelect)) <= 2,
			scopedContentFitsViewport,
			scopedTapTargetsUsable:
				window.innerWidth > 700 ||
				[...moveButtons].every((button) => {
					const rect = button.getBoundingClientRect();
					return rect.width >= 44 && rect.height >= 44;
				}),
		};
	});
}

async function measurementsAt(width: number): Promise<SettingsMeasurements> {
	await page.setViewportSize({ width, height: 800 });
	return measurements();
}

describe("settings agent-context row layout in a real browser", () => {
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
		expect(measured.controlBelowLabel).toBe(true);
		expect(measured.agentValueClipped).toBe(true);
	});

	it.each([360, 1024])("leaves short controls at their natural size at %ipx", async (width) => {
		const measured = await measurementsAt(width);
		expect(measured.shortSelectWithinRow).toBe(true);
		expect(measured.shortSelectNaturalSize).toBe(true);
	});

	it.each([360, 700, 701, 1024])("keeps the shipped scoped-model editor usable at %ipx", async (width) => {
		await page.setViewportSize({ width, height: 800 });
		expect(await page.locator(".scoped-models-editor").isVisible()).toBe(true);
		expect(await page.getByText(longProvider, { exact: true }).isVisible()).toBe(true);
		expect(await page.getByText(longModelId, { exact: true }).first().isVisible()).toBe(true);
		expect(await page.getByText(/deliberately long resolver warning/).isVisible()).toBe(true);
		expect(await page.getByRole("button", { name: "save", exact: true }).isVisible()).toBe(true);
		expect(await page.getByRole("button", { name: "reset", exact: true }).isVisible()).toBe(true);

		let measured = await measurements();
		expect(measured.documentFits).toBe(true);
		expect(measured.scopedContentFitsViewport).toBe(true);
		expect(measured.scopedTapTargetsUsable).toBe(true);

		const choices = page.locator('.scoped-model-choice input[type="checkbox"]');
		await choices.nth(0).uncheck();
		await choices.nth(1).uncheck();
		expect(await page.getByText("At least one model must remain enabled.").isVisible()).toBe(true);
		measured = await measurements();
		expect(measured.documentFits).toBe(true);
		expect(measured.scopedContentFitsViewport).toBe(true);
	});
});
