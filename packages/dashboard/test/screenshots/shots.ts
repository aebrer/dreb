/**
 * The README screenshot shot list.
 *
 * Each shot names its route, viewport, appearance, the selectors that prove the
 * screen rendered its fixture content, and any steps that frame the view. Shot
 * names are also the committed file names under `packages/dashboard/docs/screenshots/`.
 */

import type { Page } from "playwright";
import { pinTranscripts, scrollElementToTop } from "./page-scripts.js";
import { FIXTURE_PROJECTS, type LiveRuntimeScenario } from "./scenario.js";

export type ViewportName = "desktop" | "mobile";

export interface ViewportSpec {
	width: number;
	height: number;
	deviceScaleFactor: number;
	isMobile: boolean;
	hasTouch: boolean;
}

const VIEWPORTS: Record<ViewportName, ViewportSpec> = {
	desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
	mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

export type ShotRoute =
	| { screen: "fleet" }
	| { screen: "session"; runtime: LiveRuntimeScenario["slug"] }
	| { screen: "subagent"; runtime: LiveRuntimeScenario["slug"]; agentId: string }
	| { screen: "files"; path: string }
	| { screen: "memories" }
	| { screen: "settings" };

export interface ShotDefinition {
	/** File stem; the image is `<name>.png`. */
	name: string;
	/** Alt text used in the root README. */
	alt: string;
	viewport: ViewportName;
	/** CSS-pixel height override for screens that need more vertical room than the base viewport. */
	height?: number;
	colorMode: "light" | "dark";
	/** Dashboard theme id; omitted means the default theme. */
	theme?: string;
	route: ShotRoute;
	/** Selectors that must all be visible before capture. */
	ready: string[];
	/**
	 * Selectors proving the scenario's live events streamed into the page. When set,
	 * the harness emits those events after `ready` (the SSE stream is connected by then).
	 */
	live?: string[];
	/** Optional framing steps run after `ready`/`live` and before capture. */
	prepare?: (page: Page) => Promise<void>;
}

/** Resolved CSS viewport for a shot. */
export function shotViewport(shot: ShotDefinition): ViewportSpec {
	const base = VIEWPORTS[shot.viewport];
	return { ...base, height: shot.height ?? base.height };
}

/** Pin every scrollable transcript to its newest entry, like a live session. */
async function pinTranscriptToBottom(page: Page): Promise<void> {
	await page.evaluate(pinTranscripts);
}

/** Scroll the window so `selector` (or its closest `ancestor`) sits `gap` px below the top edge. */
function scrollToTop(selector: string, gap: number, ancestor?: string): (page: Page) => Promise<void> {
	return async (page) => {
		await page.locator(selector).first().evaluate(scrollElementToTop, { gap, ancestor });
	};
}

const CONNECTED = ".connection-indicator .chip-idle";
const FLEET_READY = [CONNECTED, "article.session-card", ".disk-row"];
/** The showcase card reports the tool its agent is executing, streamed after connect. */
const FLEET_LIVE = ['article.session-card .activity:has-text("▸ bash")'];
const SESSION_READY = [CONNECTED, ".entry.user", "details.tool", "textarea"];
const SESSION_LIVE = ['.working:has-text("bash")'];

export const SHOTS: ShotDefinition[] = [
	{
		name: "fleet-desktop-dark",
		alt: "dreb dashboard Fleet view in dark mode: live session cards (running, needs attention, idle) with subagents, tasks, model, context, and cost, above past sessions grouped by project",
		viewport: "desktop",
		height: 1280,
		colorMode: "dark",
		route: { screen: "fleet" },
		ready: FLEET_READY,
		live: FLEET_LIVE,
	},
	{
		name: "session-desktop-dark",
		alt: "dreb dashboard session view in dark mode: transcript with tool cards and a running bash command, task list, subagent panel, steering composer, and the fleet sidebar",
		viewport: "desktop",
		height: 1280,
		colorMode: "dark",
		route: { screen: "session", runtime: "tidewatch" },
		ready: SESSION_READY,
		live: SESSION_LIVE,
		prepare: pinTranscriptToBottom,
	},
	{
		name: "fleet-mobile-dark",
		alt: "dreb dashboard Fleet view on a phone in dark mode",
		viewport: "mobile",
		colorMode: "dark",
		route: { screen: "fleet" },
		ready: FLEET_READY,
		live: FLEET_LIVE,
		prepare: scrollToTop("#live-sessions-heading", 16),
	},
	{
		name: "session-mobile-dark",
		alt: "dreb dashboard session view on a phone in dark mode, steering a running agent",
		viewport: "mobile",
		colorMode: "dark",
		route: { screen: "session", runtime: "tidewatch" },
		ready: SESSION_READY,
		live: SESSION_LIVE,
		prepare: async (page) => {
			await page.locator('button[title="hide session details"]').click();
			await pinTranscriptToBottom(page);
		},
	},
	{
		name: "fleet-desktop-light",
		alt: "dreb dashboard Fleet view in light mode",
		viewport: "desktop",
		colorMode: "light",
		route: { screen: "fleet" },
		ready: FLEET_READY,
		live: FLEET_LIVE,
	},
	{
		name: "settings-themes-desktop",
		alt: "dreb dashboard appearance settings in the Gruvbox dark theme: color mode, font picker, and the gallery of eight themes",
		viewport: "desktop",
		colorMode: "dark",
		theme: "gruvbox",
		route: { screen: "settings" },
		ready: [CONNECTED, ".appearance-block"],
		prepare: scrollToTop(".appearance-block", 24, "section"),
	},
	{
		name: "subagent-desktop-dark",
		alt: "dreb dashboard subagent drill-in in dark mode: a running background agent's transcript with its own steering composer and stop control",
		viewport: "desktop",
		colorMode: "dark",
		route: { screen: "subagent", runtime: "tidewatch", agentId: "b83f0c" },
		ready: [".entry.user", "details.tool", "textarea", ':text("steering delivery: one-at-a-time")'],
		prepare: pinTranscriptToBottom,
	},
	{
		name: "files-desktop-dark",
		alt: "dreb dashboard Files view in dark mode: a project folder on the host with places shortcuts, nested-context trust, upload, new folder, and new session here",
		viewport: "desktop",
		colorMode: "dark",
		route: { screen: "files", path: FIXTURE_PROJECTS.tidewatch },
		ready: [CONNECTED, ".file-table tbody tr", ".place-chip", ".context-trust .btn"],
	},
	{
		name: "memories-desktop-dark",
		alt: "dreb dashboard Memories view in dark mode: global and project memory scopes, their entries, and the MEMORY.md index editor with a rendered preview",
		viewport: "desktop",
		colorMode: "dark",
		route: { screen: "memories" },
		ready: [CONNECTED, ".memory-nav-item", ".memory-textarea", ".memory-preview"],
	},
];

/** Resolve a shot-name filter; throws on unknown names so typos fail loudly. */
export function selectShots(names: readonly string[] | undefined): ShotDefinition[] {
	if (!names || names.length === 0) return SHOTS;
	const unknown = names.filter((name) => !SHOTS.some((shot) => shot.name === name));
	if (unknown.length > 0) {
		throw new Error(
			`Unknown screenshot(s): ${unknown.join(", ")}. Available: ${SHOTS.map((shot) => shot.name).join(", ")}`,
		);
	}
	return SHOTS.filter((shot) => names.includes(shot.name));
}
