/**
 * Real-browser mobile layout regression coverage for fleet cards.
 *
 * jsdom does not perform flex line collection, text wrapping, line clamping, or
 * document overflow layout. This test loads the production stylesheets in their
 * production order and measures the fleet DOM in real Chromium.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const tokensCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/tokens.css", import.meta.url)), "utf8");
const appCss = readFileSync(fileURLToPath(new URL("../../src/client/styles/app.css", import.meta.url)), "utf8");

const prose =
	"This deliberately long prose describes a live fleet session whose details must remain readable on a narrow mobile screen ";
const unbroken = "unbrokenfleetidentifierwithnospacesandmanycharacters".repeat(3);

function sessionCard(status: "running" | "attention" | "idle" | "error"): string {
	const statuses = {
		running: { glyph: "●", label: "running" },
		attention: { glyph: "◆", label: "needs attention" },
		idle: { glyph: "○", label: "idle" },
		error: { glyph: "✕", label: "error" },
	};
	const statusDisplay = statuses[status];
	const conditional =
		status === "attention"
			? `<p class="attention-reason" data-critical data-wrap>${prose}${unbroken}</p>`
			: status === "error"
				? `<p class="error-reason" data-critical data-wrap>${prose}${unbroken}</p>`
				: "";

	return `<article class="session-card ${status}" data-card="${status}" data-no-overflow>
		<div class="session-title" data-no-overflow>
			<span class="name" data-critical data-wrap>${prose}${unbroken}</span>
			<span class="chip chip-${status}" data-chip="${status}" data-critical><span class="dot">${statusDisplay.glyph}</span> ${statusDisplay.label}</span>
		</div>
		<p class="session-project" data-critical data-wrap>${prose}${unbroken}</p>
		${conditional}
		<p class="activity" data-critical data-wrap>${prose}${unbroken}</p>
		<div class="subagents" data-critical data-no-overflow>
			<span data-wrap>${prose}${unbroken}</span>
			<span class="agent-line" data-critical data-wrap>● ${prose}${unbroken}</span>
		</div>
		<div class="session-meta" data-critical data-no-overflow>
			<span>tasks 1/100</span><span>·</span>
			<span class="model-id" data-critical data-wrap>provider/${prose}${unbroken}</span><span>·</span>
			<span>ctx 95%</span><span>·</span><span>999 msgs</span><span>·</span><span>just now</span>
		</div>
		<div class="session-actions" data-critical data-no-overflow>
			<button type="button" class="btn btn-small btn-primary">open</button>
			<button type="button" class="btn btn-small btn-danger">stop runtime</button>
		</div>
	</article>`;
}

const HARNESS_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${tokensCss}</style>
<style>${appCss}</style>
</head>
<body>
	<main class="container">
		<section class="live-sessions">
			<div class="session-grid">
				${sessionCard("running")}
				${sessionCard("attention")}
				${sessionCard("idle")}
				${sessionCard("error")}
			</div>
		</section>
		<section class="past-sessions">
			<section class="project-group">
				<div class="group-head" data-no-overflow>
					<h3 data-critical data-wrap>${prose}${unbroken}</h3>
					<span class="muted small">100 on disk</span>
					<button type="button" class="btn btn-small">+ new</button>
				</div>
				<div class="disk-row" data-disk-row data-no-overflow>
					<span class="name" data-critical data-wrap>${prose}${unbroken}</span>
					<span class="meta" data-critical>${prose}${unbroken}</span>
					<span class="actions" data-critical data-no-overflow>
						<button type="button" class="btn btn-small" data-disk-action>resume</button>
						<button type="button" class="btn btn-small btn-danger" data-disk-action>delete</button>
					</span>
				</div>
			</section>
		</section>
	</main>
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

type MobileMeasurements = {
	documentFits: boolean;
	criticalWithinParents: boolean;
	internalOverflowFree: boolean;
	allWrapped: boolean;
	activitiesClampedToTwoLines: boolean;
	chipsContained: boolean;
	diskMetadataAndActionsVisible: boolean;
	attentionChipMoved: boolean;
};

async function mobileMeasurements(): Promise<MobileMeasurements> {
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
		const isMultiline = (element: HTMLElement) => {
			const style = getComputedStyle(element);
			const lineHeight = Number.parseFloat(style.lineHeight);
			return style.whiteSpace === "normal" && element.getBoundingClientRect().height > lineHeight + tolerance;
		};
		const critical = [...document.querySelectorAll<HTMLElement>("[data-critical]")];
		const overflowChecked = [...document.querySelectorAll<HTMLElement>("[data-no-overflow]")];
		const wrapped = [...document.querySelectorAll<HTMLElement>("[data-wrap]")];
		const activities = [...document.querySelectorAll<HTMLElement>(".activity")];
		const chips = [...document.querySelectorAll<HTMLElement>("[data-chip]")];
		const diskRow = document.querySelector<HTMLElement>("[data-disk-row]")!;
		const diskMeta = diskRow.querySelector<HTMLElement>(".meta")!;
		const diskActions = [...diskRow.querySelectorAll<HTMLElement>("[data-disk-action]")];
		const attentionName = document.querySelector<HTMLElement>('[data-card="attention"] .name')!;
		const attentionChip = document.querySelector<HTMLElement>('[data-chip="attention"]')!;

		return {
			documentFits: document.documentElement.scrollWidth <= window.innerWidth + tolerance,
			criticalWithinParents: critical.every((element) => {
				const parent = element.closest(".session-card, .disk-row, .group-head");
				return parent !== null && rectWithin(element, parent);
			}),
			internalOverflowFree: [...new Set([...overflowChecked, ...critical])].every(
				(element) => element.scrollWidth <= element.clientWidth + tolerance,
			),
			allWrapped: wrapped.every(isMultiline),
			activitiesClampedToTwoLines: activities.every((activity) => {
				const style = getComputedStyle(activity);
				const lineHeight = Number.parseFloat(style.lineHeight);
				const height = activity.getBoundingClientRect().height;
				return (
					style.webkitLineClamp === "2" &&
					Math.abs(height - 2 * lineHeight) <= tolerance &&
					activity.scrollHeight > activity.clientHeight + tolerance
				);
			}),
			chipsContained: chips.every((chip) => {
				const card = chip.closest(".session-card")!;
				return rectWithin(chip, card) && chip.scrollWidth <= chip.clientWidth + tolerance;
			}),
			diskMetadataAndActionsVisible:
				rectWithin(diskMeta, diskRow) &&
				diskActions.every(
					(action) => rectWithin(action, diskRow) && action.offsetWidth > 0 && action.offsetHeight > 0,
				),
			attentionChipMoved:
				attentionChip.getBoundingClientRect().top > attentionName.getBoundingClientRect().top + tolerance,
		};
	});
}

describe("fleet layout in a real browser", () => {
	it.each([320, 390, 700])(
		"contains every live and disk-card value at %ipx without horizontal overflow",
		async (width) => {
			await page.setViewportSize({ width, height: 1600 });
			const measured = await mobileMeasurements();

			expect(measured.documentFits).toBe(true);
			expect(measured.criticalWithinParents).toBe(true);
			expect(measured.internalOverflowFree).toBe(true);
			expect(measured.allWrapped).toBe(true);
			expect(measured.activitiesClampedToTwoLines).toBe(true);
			expect(measured.chipsContained).toBe(true);
			expect(measured.diskMetadataAndActionsVisible).toBe(true);
			if (width === 320) expect(measured.attentionChipMoved).toBe(true);
		},
	);

	it("turns the mobile wrapping rules off at 701px and preserves desktop ellipsis", async () => {
		await page.setViewportSize({ width: 701, height: 1000 });
		const desktop = await page.evaluate(() => {
			const name = document.querySelector<HTMLElement>('[data-card="running"] .name')!;
			const project = document.querySelector<HTMLElement>('[data-card="running"] .session-project')!;
			const agent = document.querySelector<HTMLElement>('[data-card="running"] .agent-line')!;
			const diskName = document.querySelector<HTMLElement>(".disk-row .name")!;
			const title = document.querySelector<HTMLElement>(".session-title")!;
			const activity = document.querySelector<HTMLElement>('[data-card="running"] .activity')!;
			const desktopEllipsis = [name, project, agent, diskName].every((element) => {
				const style = getComputedStyle(element);
				return (
					style.whiteSpace === "nowrap" &&
					style.overflow === "hidden" &&
					style.textOverflow === "ellipsis" &&
					element.scrollWidth > element.clientWidth
				);
			});
			const activityStyle = getComputedStyle(activity);
			const activityLineHeight = Number.parseFloat(activityStyle.lineHeight);
			const activityHeight = activity.getBoundingClientRect().height;
			const activityClampedToTwoLines =
				activityStyle.webkitLineClamp === "2" &&
				Math.abs(activityHeight - 2 * activityLineHeight) <= 1 &&
				activity.scrollHeight > activity.clientHeight + 1;
			return {
				desktopEllipsis,
				titleWrap: getComputedStyle(title).flexWrap,
				activityClampedToTwoLines,
			};
		});

		expect(desktop.desktopEllipsis).toBe(true);
		expect(desktop.titleWrap).toBe("nowrap");
		expect(desktop.activityClampedToTwoLines).toBe(true);
	});
});
