/**
 * Real-browser mobile layout regression coverage for the session screen.
 *
 * jsdom cannot measure the flex shrinking and nested overflow that keeps the
 * composer visible, so this test loads the production stylesheets in order and
 * measures a hand-built copy of the session chrome in Chromium.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tokensCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/tokens.css", import.meta.url)), "utf8");
const appCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/app.css", import.meta.url)), "utf8");
const themesCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/themes.css", import.meta.url)), "utf8");

const longText = "A deliberately long dashboard message that exercises mobile wrapping and internal scrolling. ".repeat(
	4,
);
const taskItems = Array.from({ length: 15 }, (_, index) => `<li>☐ task ${index + 1} with a long description</li>`).join(
	"",
);
const agentItems = Array.from(
	{ length: 10 },
	(_, index) =>
		`<li><button type="button" class="agent-chip"><span class="live">●</span><span class="task">Explore — background task ${index + 1}</span></button></li>`,
).join("");
const banners = Array.from(
	{ length: 4 },
	(_, index) =>
		`<div class="banner warning"><span class="banner-glyph">◆</span><span class="banner-text">banner ${index + 1}: ${longText}</span><span class="banner-actions"><button type="button" class="btn btn-small">action</button></span><button type="button" class="btn btn-small banner-dismiss">dismiss</button></div>`,
).join("");

interface SessionLayoutState {
	composerMaxed: boolean;
	bannerCount: 0 | 4;
	tasksOpen: boolean;
	subagentsOpen: boolean;
	headerCollapsed: boolean;
	overflowOpen: boolean;
	commandMenuOpen?: boolean;
}

function sessionFixture(state: SessionLayoutState): string {
	const commandMenu = state.commandMenuOpen
		? `<div class="command-popover" role="listbox" id="command-listbox" aria-label="slash commands"><button type="button" class="command-option" role="option">/compact</button></div>`
		: "";
	const headerOverflow = state.overflowOpen
		? `<div class="session-bar-inner" style="justify-content:flex-end;gap:8px"><button type="button" class="btn btn-small">export HTML</button><button type="button" class="btn btn-small">compact now</button><button type="button" class="btn btn-small">expand tools</button><button type="button" class="btn btn-small">rename</button><button type="button" class="btn btn-small">stop runtime</button></div>`
		: "";
	const headerDetails = state.headerCollapsed
		? ""
		: `<div class="session-bar-inner session-info-bar"><span class="session-info-left">/home/test/project</span><button type="button" class="session-info-right stats-trigger"><span>messages 99</span><span>tokens 999k</span></button></div>${headerOverflow}`;
	const tasks = `<details class="tasks"${state.tasksOpen ? " open" : ""}><summary>tasks — 3 of 15 done</summary><ul>${taskItems}</ul></details>`;
	const subagents = `<details class="tasks subagents"${state.subagentsOpen ? " open" : ""}><summary>subagents — 10 running · 0 done</summary><ul class="subagent-list">${agentItems}</ul></details>`;
	const status = `<div class="status-line"><span class="working">● working — ${longText}</span><button type="button" class="btn btn-small btn-danger">stop compaction</button><button type="button" class="btn btn-small btn-danger">■ stop</button></div>`;
	const textarea = state.composerMaxed
		? `<textarea style="height: 600px">${longText.repeat(8)}</textarea>`
		: "<textarea></textarea>";

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${tokensCss}</style>
<style>${appCss}</style>
<style>${themesCss}</style>
</head>
<body>
<div id="root">
	<div class="session-screen">
		<header class="session-bar${state.headerCollapsed ? " collapsed" : ""}">
			<div class="session-bar-inner session-bar-main">
				<a class="back" href="#/">← fleet</a>
				<span class="title">Long running session title</span>
				<span class="project">/home/test/project</span>
				<output class="session-connection-indicator switcher">● live</output>
				<span class="right"><button type="button" class="switcher model-switcher"><span class="label">model</span> provider/long-model</button><button type="button" class="switcher"><span class="label">think</span> high</button><button type="button" class="switcher">⋯</button></span>
				<button type="button" class="chrome-toggle">details ▴</button>
			</div>
			${headerDetails}
		</header>
		${state.bannerCount > 0 ? `<div class="container banner-region" aria-live="polite">${banners}</div>` : ""}
		<div class="session-body">
			<div class="session-main">
		<main class="chat"><div class="chat-inner"><p>${longText}</p><p>${longText}</p><p>${longText}</p></div></main>
		<footer class="dock">
			<div class="dock-collapse-row"><button type="button" class="chrome-toggle">compose ▾</button></div>
			<div class="dock-inner">
				<div class="dock-panels">${tasks}${subagents}${status}</div>
				<div class="composer">
					<div class="queued-message-row"><span class="queued-chip">steer: ${longText}</span><span class="queued-chip">follow-up: ${longText}</span><button type="button" class="btn btn-small">restore to composer</button></div>
					<div class="attachment-strip"><span class="attachment-file">📎 ${longText}</span><span class="attachment-file">📎 ${longText}</span></div>
					${commandMenu}
					${textarea}
					<div class="composer-row">
						<button type="button" class="btn btn-small" data-composer-action>📎 file</button>
						<button type="button" class="btn btn-small" data-composer-action>🖼 photo</button>
						<span class="mode-toggle" role="radiogroup"><button type="button">steer</button><button type="button">follow-up</button></span>
						<button type="button" class="btn btn-primary btn-small send" data-composer-action>send ↵</button>
					</div>
				</div>
			</div>
		</footer>
			</div>
		</div>
	</div>
</div>
</body>
</html>`;
}

function sidebarEntry(name: string, chipClass: string, chipLabel: string): string {
	return `<button type="button" class="fleet-sidebar-entry"><div class="fleet-sidebar-entry-head"><span class="name">${name}</span><span class="chip ${chipClass}"><span class="dot">●</span> ${chipLabel}</span></div><div class="fleet-sidebar-entry-meta"><span>2m ago</span></div></button>`;
}

/** A mobile session with the fleet sidebar drawer open (overlay + scrim). */
function sessionSidebarFixture(): string {
	const entries = [
		sidebarEntry("alpha", "chip-running", "running"),
		sidebarEntry("beta", "chip-attention", "needs attention"),
		sidebarEntry("gamma", "chip-idle", "idle"),
	].join("");

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${tokensCss}</style>
<style>${appCss}</style>
<style>${themesCss}</style>
</head>
<body>
<div id="root">
	<div class="session-screen">
		<header class="session-bar">
			<div class="session-bar-inner session-bar-main">
				<a class="back" href="#/">← fleet</a>
				<span class="title">Session title</span>
				<button type="button" class="chrome-toggle fleet-sidebar-toggle">fleet ◂</button>
				<button type="button" class="chrome-toggle">details ▴</button>
			</div>
		</header>
		<div class="session-body">
			<aside class="fleet-sidebar open">${entries}</aside>
			<div class="fleet-sidebar-scrim"></div>
			<div class="session-main">
		<main class="chat"><div class="chat-inner"><p>${longText}</p><p>${longText}</p></div></main>
		<footer class="dock">
			<div class="dock-collapse-row"><button type="button" class="chrome-toggle">compose ▾</button></div>
			<div class="dock-inner">
				<div class="composer">
					<textarea></textarea>
					<div class="composer-row">
						<button type="button" class="btn btn-small" data-composer-action>📎 file</button>
						<button type="button" class="btn btn-small" data-composer-action>🖼 photo</button>
						<button type="button" class="btn btn-primary btn-small send" data-composer-action>send ↵</button>
					</div>
				</div>
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
	page = await browser.newPage({ viewport: { width: 390, height: 844 } });
}, 60_000);

afterAll(async () => {
	await browser?.close();
});

type SessionMeasurements = {
	documentFits: boolean;
	sendVisible: boolean;
	composerActionsVisible: boolean;
	headerAtViewportTop: boolean;
};

async function measureSession(): Promise<SessionMeasurements> {
	return page.evaluate(() => {
		const tolerance = 1;
		const visibleInViewport = (element: Element) => {
			const rect = element.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0 && rect.top >= -tolerance && rect.bottom <= innerHeight + tolerance;
		};
		const send = document.querySelector(".composer-row .send");
		const actions = [...document.querySelectorAll("[data-composer-action]")];
		const header = document.querySelector(".session-bar");
		return {
			documentFits: document.documentElement.scrollHeight <= innerHeight + tolerance,
			sendVisible: send !== null && visibleInViewport(send),
			composerActionsVisible: actions.length === 3 && actions.every(visibleInViewport),
			headerAtViewportTop: header !== null && header.getBoundingClientRect().top >= -tolerance,
		};
	});
}

const acceptanceStates: SessionLayoutState[] = [];
for (const composerMaxed of [false, true]) {
	for (const bannerCount of [0, 4] as const) {
		for (const tasksOpen of [false, true]) {
			for (const subagentsOpen of [false, true]) {
				for (const headerCollapsed of [false, true]) {
					for (const overflowOpen of [false, true]) {
						acceptanceStates.push({
							composerMaxed,
							bannerCount,
							tasksOpen,
							subagentsOpen,
							headerCollapsed,
							overflowOpen: headerCollapsed ? false : overflowOpen,
						});
					}
				}
			}
		}
	}
}

describe("session layout in a real browser", () => {
	it.each(acceptanceStates)("keeps the composer visible for state %#", async (state) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.setContent(sessionFixture(state));
		const measured = await measureSession();

		expect(measured.documentFits).toBe(true);
		expect(measured.sendVisible).toBe(true);
		expect(measured.composerActionsVisible).toBe(true);
		expect(measured.headerAtViewportTop).toBe(true);
	});

	it("opens the fleet sidebar as a full-height overlay above the session at 700px", async () => {
		await page.setViewportSize({ width: 700, height: 900 });
		await page.setContent(sessionSidebarFixture());
		const measured = await page.evaluate(() => {
			const tolerance = 1;
			const visibleInViewport = (element: Element | null) => {
				if (!element) return false;
				const rect = element.getBoundingClientRect();
				return (
					rect.width > 0 && rect.height > 0 && rect.top >= -tolerance && rect.bottom <= innerHeight + tolerance
				);
			};
			const sidebar = document.querySelector<HTMLElement>(".fleet-sidebar");
			const scrim = document.querySelector<HTMLElement>(".fleet-sidebar-scrim");
			const chat = document.querySelector<HTMLElement>(".session-main main.chat");
			const dock = document.querySelector<HTMLElement>(".session-main footer.dock");
			const sidebarRect = sidebar?.getBoundingClientRect();
			const scrimRect = scrim?.getBoundingClientRect();
			return {
				// The drawer spans the viewport via top/bottom offsets (no vh/dvh).
				sidebarSpansViewport:
					sidebarRect !== undefined &&
					Math.abs(sidebarRect.top) <= tolerance &&
					Math.abs(sidebarRect.bottom - innerHeight) <= tolerance,
				// The session line still fills the screen beneath the header:
				// the transcript has height and the dock ends at the viewport bottom.
				sessionLineFillsScreen:
					chat !== null &&
					dock !== null &&
					chat.getBoundingClientRect().height > 0 &&
					Math.abs(dock.getBoundingClientRect().bottom - innerHeight) <= tolerance,
				// The drawer must stack above the scrim it belongs to.
				sidebarAboveScrim:
					sidebar !== null &&
					scrim !== null &&
					Number.parseInt(getComputedStyle(sidebar).zIndex, 10) >=
						Number.parseInt(getComputedStyle(scrim).zIndex, 10),
				scrimCoversViewport:
					scrimRect !== undefined &&
					Math.abs(scrimRect.width - innerWidth) <= tolerance &&
					Math.abs(scrimRect.height - innerHeight) <= tolerance,
				// The overlay is fixed: the composer underneath keeps its in-flow
				// geometry (nothing is pushed off-screen by the drawer).
				composerStillInFlow: visibleInViewport(document.querySelector(".composer-row .send")),
				documentFits: document.documentElement.scrollHeight <= innerHeight + tolerance,
			};
		});

		expect(measured.sidebarSpansViewport).toBe(true);
		expect(measured.sessionLineFillsScreen).toBe(true);
		expect(measured.sidebarAboveScrim).toBe(true);
		expect(measured.scrimCoversViewport).toBe(true);
		expect(measured.composerStillInFlow).toBe(true);
		expect(measured.documentFits).toBe(true);
	});

	it("keeps the slash-command popover visible on mobile", async () => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.setContent(
			sessionFixture({
				composerMaxed: true,
				bannerCount: 4,
				tasksOpen: true,
				subagentsOpen: true,
				headerCollapsed: false,
				overflowOpen: true,
				commandMenuOpen: true,
			}),
		);
		const visible = await page.evaluate(() => {
			const popover = document.querySelector<HTMLElement>(".command-popover");
			if (!popover) return false;
			const rect = popover.getBoundingClientRect();
			if (rect.bottom <= 0 || rect.top >= innerHeight) return false;
			const x = (rect.left + rect.right) / 2;
			const y = Math.max(0, Math.min(innerHeight - 1, (rect.top + rect.bottom) / 2));
			return popover.contains(document.elementFromPoint(x, y));
		});

		expect(visible).toBe(true);
	});

	it("keeps the composer visible in the worst-case keyboard-sized viewport", async () => {
		await page.setViewportSize({ width: 390, height: 400 });
		await page.setContent(
			sessionFixture({
				composerMaxed: true,
				bannerCount: 4,
				tasksOpen: true,
				subagentsOpen: true,
				headerCollapsed: false,
				overflowOpen: true,
			}),
		);
		const measured = await measureSession();

		expect(measured.documentFits).toBe(true);
		expect(measured.sendVisible).toBe(true);
		expect(measured.composerActionsVisible).toBe(true);
	});
});
