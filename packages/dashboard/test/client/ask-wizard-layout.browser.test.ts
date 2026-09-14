/**
 * Real-browser layout regression coverage for the inline ask_user wizard.
 *
 * The wizard contains absolutely positioned accessibility controls inside the
 * nested transcript scroller. jsdom does not perform containing-block layout or
 * browser focus scrolling, so this fixture mirrors the relevant production DOM,
 * loads the production stylesheets in order, and exercises it in real Chromium.
 * Answer semantics and SolidJS tab behavior remain covered by screens.test.tsx.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tokensCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/tokens.css", import.meta.url)), "utf8");
const appCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/app.css", import.meta.url)), "utf8");
const themesCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/themes.css", import.meta.url)), "utf8");

const transcript = Array.from(
	{ length: 120 },
	(_, index) =>
		`<p>Transcript line ${index + 1}: enough existing content to keep the chat independently scrollable.</p>`,
).join("");

function options(kind: "single" | "multi", names: string[]): string {
	return names
		.map(
			(name, index) => `<label class="ask-option" data-option="${kind}-${index}">
			<span class="ask-option-index">${index + 1}</span>
			<input
				type="${kind === "multi" ? "checkbox" : "radio"}"
				${kind === "single" ? 'class="ask-option-input--hidden" name="single-choice"' : ""}
			/>
			<span class="ask-option-label">${name}</span>
		</label>`,
		)
		.join("");
}

function questionPanel(id: string, kind: "single" | "multi", names: string[], hidden = false): string {
	return `<div class="ask-tab-panel${hidden ? " hidden" : ""}" data-panel="${id}">
		<div class="ask-question" role="tabpanel">
			<h4 class="ask-question-title">${kind === "single" ? "Choose one" : "Choose several"}</h4>
			<p class="ask-question-body">Select the options that answer this question.</p>
			<fieldset class="ask-options">
				<legend class="ask-options-legend">Answer options</legend>
				${options(kind, names)}
			</fieldset>
		</div>
	</div>`;
}

const singleWizard = `<section class="ask-wizard" aria-label="Single question">
	<header class="ask-wizard-header"><span class="ask-wizard-title">Question</span></header>
	${questionPanel("single", "single", ["Continue", "Stop"])}
</section>`;

const multiWizard = `<section class="ask-wizard" aria-label="Multiple questions">
	<header class="ask-wizard-header"><span class="ask-wizard-title">Questions</span></header>
	<div class="ask-tab-strip" role="tablist" aria-label="questions">
		<button type="button" role="tab" class="ask-tab selected" aria-selected="true" data-tab="one">1. Direction</button>
		<button type="button" role="tab" class="ask-tab" aria-selected="false" data-tab="two">2. Constraints</button>
		<button type="button" role="tab" class="ask-tab ask-tab-submit" aria-selected="false" data-tab="review">Submit</button>
	</div>
	${questionPanel("one", "single", ["Continue", "Stop"])}
	${questionPanel("two", "multi", ["Fast", "Safe", "Small", "Documented", "Tested", "Reversible"], true)}
	<div class="ask-tab-panel hidden" data-panel="review">
		<div class="ask-review" role="tabpanel">
			<ul class="ask-review-list">
				<li class="ask-review-item"><span class="ask-review-question">Direction</span></li>
				<li class="ask-review-item"><span class="ask-review-question">Constraints</span></li>
			</ul>
			<div class="ask-actions"><button type="button" class="btn btn-small btn-primary">Submit all</button></div>
		</div>
	</div>
</section>`;

function harnessHtml(wizard: string): string {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${tokensCss}</style>
<style>${appCss}</style>
<style>${themesCss}</style>
<style>.transcript-fixture { display: flex; flex-direction: column; gap: var(--space-2); }</style>
</head>
<body>
	<div id="root">
		<div class="session-screen">
			<header class="session-bar"><div class="session-bar-inner">long transcript session</div></header>
			<div class="session-body">
				<div class="session-main">
					<main class="chat">
						<div class="chat-inner">
							<div class="transcript-fixture">${transcript}</div>
							${wizard}
						</div>
					</main>
					<footer class="dock">
						<div class="dock-inner">
							<div class="composer"><textarea aria-label="composer">compose</textarea></div>
						</div>
					</footer>
				</div>
			</div>
		</div>
	</div>
</body>
</html>`;
}

let browser: Browser;
let page: Page;

beforeAll(async () => {
	browser = await chromium.launch();
	page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
}, 60_000);

afterAll(async () => {
	await browser?.close();
});

async function loadWizard(width: number, wizard: "single" | "multi"): Promise<void> {
	await page.setViewportSize({ width, height: 800 });
	await page.setContent(harnessHtml(wizard === "single" ? singleWizard : multiWizard));
	await page.evaluate(() => {
		for (const input of document.querySelectorAll<HTMLInputElement>(".ask-option input")) {
			input.addEventListener("change", () => {
				for (const candidate of document.querySelectorAll<HTMLInputElement>(`input[name="${input.name}"]`)) {
					candidate.closest(".ask-option")?.classList.toggle("selected", candidate.checked);
				}
				if (!input.name) input.closest(".ask-option")?.classList.toggle("selected", input.checked);
			});
		}
		for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
			tab.addEventListener("click", () => {
				const target = tab.dataset.tab;
				for (const candidate of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
					const selected = candidate === tab;
					candidate.classList.toggle("selected", selected);
					candidate.setAttribute("aria-selected", String(selected));
				}
				for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) {
					panel.classList.toggle("hidden", panel.dataset.panel !== target);
				}
			});
		}
		const chat = document.querySelector<HTMLElement>(".chat")!;
		chat.scrollTop = chat.scrollHeight;
	});
}

type Measurements = {
	viewportHeight: number;
	documentHeight: number;
	windowScrollY: number;
	chatScrollable: boolean;
	dockTop: number;
	dockBottom: number;
	activeTabId: string | null;
	visiblePanelIds: string[];
	activeTabIntersectsChat: boolean;
	activePanelIntersectsChat: boolean;
};

async function measurements(): Promise<Measurements> {
	return page.evaluate(() => {
		const chat = document.querySelector<HTMLElement>(".chat")!;
		const dock = document.querySelector<HTMLElement>(".dock")!;
		const activeTab = document.querySelector<HTMLElement>('[data-tab][aria-selected="true"]');
		const activePanel = document.querySelector<HTMLElement>("[data-panel]:not(.hidden)")!;
		const chatRect = chat.getBoundingClientRect();
		const dockRect = dock.getBoundingClientRect();
		const intersectsChat = (element: HTMLElement | null) => {
			if (!element) return true;
			const rect = element.getBoundingClientRect();
			return rect.bottom > chatRect.top + 1 && rect.top < chatRect.bottom - 1;
		};
		return {
			viewportHeight: window.innerHeight,
			documentHeight: document.documentElement.scrollHeight,
			windowScrollY: window.scrollY,
			chatScrollable: chat.scrollHeight > chat.clientHeight + 1,
			dockTop: dockRect.top,
			dockBottom: dockRect.bottom,
			activeTabId: activeTab?.dataset.tab ?? null,
			visiblePanelIds: [...document.querySelectorAll<HTMLElement>("[data-panel]:not(.hidden)")].map(
				(panel) => panel.dataset.panel!,
			),
			activeTabIntersectsChat: intersectsChat(activeTab),
			activePanelIntersectsChat: intersectsChat(activePanel),
		};
	});
}

function expectStable(measured: Measurements, expectedPanel: string): void {
	const tolerance = 1;
	expect(measured.chatScrollable).toBe(true);
	expect(measured.documentHeight).toBeLessThanOrEqual(measured.viewportHeight + tolerance);
	expect(measured.windowScrollY).toBe(0);
	expect(measured.dockTop).toBeGreaterThanOrEqual(-tolerance);
	expect(measured.dockBottom).toBeLessThanOrEqual(measured.viewportHeight + tolerance);
	expect(Math.abs(measured.dockBottom - measured.viewportHeight)).toBeLessThanOrEqual(tolerance);
	expect(measured.visiblePanelIds).toEqual([expectedPanel]);
	expect(measured.activeTabId).toBe(expectedPanel === "single" ? null : expectedPanel);
	expect(measured.activeTabIntersectsChat).toBe(true);
	expect(measured.activePanelIntersectsChat).toBe(true);
}

describe("ask_user wizard layout in a real browser", () => {
	it.each([390, 1024])("keeps a single-question wizard in the session viewport at %ipx", async (width) => {
		await loadWizard(width, "single");
		expectStable(await measurements(), "single");

		await page.locator('[data-option="single-0"]').click();

		expect(
			await page.locator('[data-option="single-0"] input').evaluate((input) => document.activeElement === input),
		).toBe(true);
		expectStable(await measurements(), "single");
	});

	it.each([390, 1024])(
		"keeps multi-question option and tab interactions in the chat viewport at %ipx",
		async (width) => {
			await loadWizard(width, "multi");
			expectStable(await measurements(), "one");

			await page.locator('[data-option="single-0"]').click();
			expectStable(await measurements(), "one");

			await page.locator('[data-tab="two"]').click();
			expectStable(await measurements(), "two");

			const checkbox = page.locator('[data-option="multi-0"] input');
			await page.locator('[data-option="multi-0"]').click();
			expect(await checkbox.isChecked()).toBe(true);
			expectStable(await measurements(), "two");
			await page.locator('[data-option="multi-0"]').click();
			expect(await checkbox.isChecked()).toBe(false);
			expectStable(await measurements(), "two");

			await page.locator('[data-tab="review"]').click();
			expectStable(await measurements(), "review");
			await page.locator('[data-tab="one"]').click();
			expectStable(await measurements(), "one");
		},
	);
});
