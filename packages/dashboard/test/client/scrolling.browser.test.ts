/**
 * Real-browser regression tests for the stick-to-bottom follow controller.
 *
 * jsdom cannot model the mechanisms this bug lives in: scrollTop clamping,
 * scroll anchoring, DOM-replacement reflow, async scroll event ordering, and
 * real wheel/keyboard/touch input routing (including nested-scroller wheel
 * consumption). These tests run the REAL `createStickToBottom` +
 * `bindStickToBottom` production wiring inside headless Chromium against a
 * page that replicates the dashboard's scroll geometry (.chat outer scroller,
 * nested max-height tool-output <pre>), and drive genuine input through
 * Playwright's mouse/keyboard/CDP touch.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const scrollingSource = fileURLToPath(new URL("../../src/client/scrolling.ts", import.meta.url));

let browser: Browser;
let page: Page;
let pageUrl: string;
let tempDir: string;

const HARNESS_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
	* { margin: 0; padding: 0; box-sizing: border-box; }
	html, body { height: 100%; }
	body { display: flex; flex-direction: column; overflow: hidden; }
	.chat { flex: 1; overflow-y: auto; }
	.chat-inner { padding: 16px; }
	.entry { margin-bottom: 12px; }
	.tool-result pre { max-height: 340px; overflow-y: auto; background: #eee; }
	textarea { height: 60px; }
</style>
</head>
<body>
	<main class="chat"><div class="chat-inner"></div></main>
	<textarea class="composer"></textarea>
	<script src="./harness.js"></script>
</body>
</html>`;

const HARNESS_SETUP = String.raw`
	const chat = document.querySelector(".chat");
	const inner = document.querySelector(".chat-inner");
	const controller = Scrolling.createStickToBottom({ scroller: () => chat });
	controller.observeContent(inner);
	controller.observeViewport(chat);
	Scrolling.bindStickToBottom(controller, chat, { keyboard: "window" });

	window.harness = {
		controller,
		isFollowing: () => controller.isFollowing(),
		atBottom: () => Math.abs(chat.scrollTop - (chat.scrollHeight - chat.clientHeight)) <= 2,
		scrollTop: () => chat.scrollTop,
		addAssistantMarkdown(lines) {
			const div = document.createElement("div");
			div.className = "entry assistant";
			div.textContent = Array.from({ length: lines }, (_, i) => "assistant line " + i).join("\n");
			div.style.whiteSpace = "pre";
			inner.appendChild(div);
			controller.notifyContentChanged();
			return div;
		},
		// The assistant→tool boundary reflow: the streamed assistant DOM is
		// destroyed and recreated (message_end replaces streamed blocks with the
		// authoritative render) and a tool card is appended below — all in one
		// synchronous mutation batch, which is what lowers scrollTop in the wild.
		assistantToolBoundary(el, preLines) {
			const replacement = document.createElement("div");
			replacement.className = "entry assistant";
			replacement.style.whiteSpace = "pre";
			replacement.textContent = el.textContent;
			el.replaceWith(replacement);
			const tool = document.createElement("div");
			tool.className = "entry tool";
			const result = document.createElement("div");
			result.className = "tool-result";
			const pre = document.createElement("pre");
			pre.textContent = Array.from({ length: preLines }, (_, i) => "tool output " + i).join("\n");
			result.appendChild(pre);
			tool.appendChild(result);
			inner.appendChild(tool);
			// The production tool-output pre has its own stick-to-bottom controller
			// pinning it while output streams; replicate its resting state.
			pre.scrollTop = pre.scrollHeight;
			controller.notifyContentChanged();
			return pre;
		},
		streamIntoPre(pre, lines) {
			pre.textContent += "\n" + Array.from({ length: lines }, (_, i) => "more " + i).join("\n");
			controller.notifyContentChanged();
		},
	};
`;

async function settleFrames(count = 4): Promise<void> {
	for (let i = 0; i < count; i++) {
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
	}
}

/** Wait until the outer scroller's scrollTop has been stable for ~20 frames
 * (smooth keyboard scrolling / touch inertia continue after the input ends). */
async function waitForScrollSettle(): Promise<void> {
	await page.evaluate(() => {
		const w = window as unknown as { lastY?: number; stableFrames?: number };
		w.lastY = undefined;
		w.stableFrames = 0;
	});
	await page.waitForFunction(() => {
		const w = window as unknown as { lastY?: number; stableFrames?: number };
		const chat = document.querySelector(".chat") as HTMLElement;
		if (w.lastY === chat.scrollTop) w.stableFrames = (w.stableFrames ?? 0) + 1;
		else w.stableFrames = 0;
		w.lastY = chat.scrollTop;
		return (w.stableFrames ?? 0) > 20;
	});
}

beforeAll(async () => {
	tempDir = mkdtempSync(join(tmpdir(), "dreb-scroll-browser-"));
	const bundle = await build({
		entryPoints: [scrollingSource],
		bundle: true,
		format: "iife",
		globalName: "Scrolling",
		write: false,
	});
	writeFileSync(join(tempDir, "harness.js"), `${bundle.outputFiles[0]!.text}\n${HARNESS_SETUP}`);
	writeFileSync(join(tempDir, "index.html"), HARNESS_HTML);
	pageUrl = `file://${join(tempDir, "index.html")}`;
	browser = await chromium.launch();
	page = await browser.newPage({ viewport: { width: 800, height: 600 }, hasTouch: true });
}, 60_000);

afterAll(async () => {
	await browser?.close();
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
	await page.goto(pageUrl);
	await page.waitForFunction(() => (window as unknown as { harness?: unknown }).harness !== undefined);
});

type Harness = {
	isFollowing: () => boolean;
	atBottom: () => boolean;
	scrollTop: () => number;
	addAssistantMarkdown: (lines: number) => HTMLElement;
	assistantToolBoundary: (el: HTMLElement, preLines: number) => HTMLElement;
	streamIntoPre: (pre: HTMLElement, lines: number) => void;
};
declare const window: { harness: Harness } & typeof globalThis;

async function harness<T>(fn: (h: Harness) => T): Promise<T> {
	// Serialize the callback and invoke it with the page's harness object —
	// page.evaluate(fn) alone would call fn(undefined).
	return page.evaluate(`(${fn.toString()})(window.harness)`) as Promise<T>;
}

describe("stick-to-bottom in a real browser", () => {
	it("survives the assistant→tool boundary reflow and keeps pinning (the original drop-out)", async () => {
		// Stream a long assistant message so the transcript scrolls; the pin keeps
		// the view at the bottom.
		await harness((h) => {
			const el = h.addAssistantMarkdown(200);
			(window as unknown as { el: HTMLElement }).el = el;
		});
		await settleFrames();
		expect(await harness((h) => h.atBottom())).toBe(true);
		expect(await harness((h) => h.isFollowing())).toBe(true);

		// The boundary: assistant DOM destroyed+recreated, tool card with a long
		// nested pre appended — the browser reflows and may lower scrollTop with
		// no user input. Follow must survive and the view must pin to the new
		// bottom.
		await harness((h) => {
			const el = (window as unknown as { el: HTMLElement }).el;
			const pre = h.assistantToolBoundary(el, 400);
			(window as unknown as { pre: HTMLElement }).pre = pre;
		});
		await settleFrames();
		expect(await harness((h) => h.isFollowing())).toBe(true);
		expect(await harness((h) => h.atBottom())).toBe(true);

		// Continued streaming into the nested pre keeps the outer view pinned.
		await harness((h) => h.streamIntoPre((window as unknown as { pre: HTMLElement }).pre, 200));
		await settleFrames();
		expect(await harness((h) => h.atBottom())).toBe(true);
	});

	it("a real wheel-up releases follow and later growth does not yank the view back", async () => {
		await harness((h) => h.addAssistantMarkdown(300));
		await settleFrames();
		expect(await harness((h) => h.atBottom())).toBe(true);

		// Genuine mouse wheel up over the transcript (not over the nested pre).
		await page.mouse.move(400, 100);
		await page.mouse.wheel(0, -600);
		await page.waitForFunction(() => !window.harness.isFollowing());
		await waitForScrollSettle();
		const parkedAt = await harness((h) => h.scrollTop());

		// New content grows the transcript — the released view must not move.
		await harness((h) => h.addAssistantMarkdown(100));
		await settleFrames();
		expect(await harness((h) => h.scrollTop())).toBe(parkedAt);

		// Scrolling back to the bottom re-engages follow.
		await harness(() => {
			const chat = document.querySelector(".chat") as HTMLElement;
			chat.scrollTop = chat.scrollHeight;
		});
		await settleFrames();
		expect(await harness((h) => h.isFollowing())).toBe(true);
	});

	it("wheeling up over the nested tool pre scrolls the pre without releasing the outer follow", async () => {
		await harness((h) => {
			const el = h.addAssistantMarkdown(50);
			const pre = h.assistantToolBoundary(el, 400);
			(window as unknown as { pre: HTMLElement }).pre = pre;
		});
		await settleFrames();
		expect(await harness((h) => h.atBottom())).toBe(true);

		// The nested pre is pinned to ITS bottom (scrollTop > 0), so an upward
		// wheel over it is consumed by the pre. The outer controller must stay
		// following — including through a subsequent boundary-style reflow within
		// what used to be the vulnerable intent window.
		const preBox = await page.evaluate(() => {
			const pre = (window as unknown as { pre: HTMLElement }).pre;
			const rect = pre.getBoundingClientRect();
			return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, scrollTop: pre.scrollTop };
		});
		expect(preBox.scrollTop).toBeGreaterThan(0);
		await page.mouse.move(preBox.x, preBox.y);
		await page.mouse.wheel(0, -200);
		await settleFrames();
		const preScrolled = await page.evaluate(() => (window as unknown as { pre: HTMLElement }).pre.scrollTop);
		expect(preScrolled).toBeLessThan(preBox.scrollTop);
		expect(await harness((h) => h.isFollowing())).toBe(true);

		// Immediately (inside any fallback window) grow content below — the outer
		// view must pin to the new bottom, not falsely release.
		await harness((h) => h.addAssistantMarkdown(80));
		await settleFrames();
		expect(await harness((h) => h.isFollowing())).toBe(true);
		expect(await harness((h) => h.atBottom())).toBe(true);
	});

	it("a real keyboard PageUp releases follow; keys in the composer never do", async () => {
		await harness((h) => h.addAssistantMarkdown(300));
		await settleFrames();

		// Keys typed into the composer (an editable target) are excluded.
		await page.focus(".composer");
		await page.keyboard.press("PageUp");
		await settleFrames();
		expect(await harness((h) => h.isFollowing())).toBe(true);
		expect(await harness((h) => h.atBottom())).toBe(true);

		// PageUp with focus on the page body scrolls the transcript and releases.
		await page.click(".chat", { position: { x: 400, y: 100 } });
		await harness(() => (document.activeElement as HTMLElement | null)?.blur?.());
		await page.keyboard.press("PageUp");
		await page.waitForFunction(() => !window.harness.isFollowing());
		await waitForScrollSettle();
		expect(await harness((h) => h.atBottom())).toBe(false);

		// Growth while released must not yank the view down.
		const parkedAt = await harness((h) => h.scrollTop());
		await harness((h) => h.addAssistantMarkdown(50));
		await settleFrames();
		expect(await harness((h) => h.scrollTop())).toBe(parkedAt);
	});

	it("a real touch up-drag releases follow; a stationary touch hold during growth does not", async () => {
		await harness((h) => h.addAssistantMarkdown(300));
		await settleFrames();

		// Stationary hold while content grows: pinning is suspended during the
		// contact, and follow must survive (no release) once it ends.
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ x: 400, y: 300 }],
		});
		await harness((h) => h.addAssistantMarkdown(50));
		await settleFrames();
		await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await settleFrames();
		expect(await harness((h) => h.isFollowing())).toBe(true);
		expect(await harness((h) => h.atBottom())).toBe(true);

		// Upward drag: finger moves DOWN the screen, content scrolls up → release.
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ x: 400, y: 200 }],
		});
		for (let y = 200; y <= 440; y += 40) {
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [{ x: 400, y }],
			});
		}
		await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await page.waitForFunction(() => !window.harness.isFollowing());
		// The fling's inertial scrolling continues after touchend — wait for the
		// scroll position to settle before sampling the parked position.
		await waitForScrollSettle();
		const parkedAt = await harness((h) => h.scrollTop());
		expect(await harness((h) => h.atBottom())).toBe(false);

		// Growth while released must not yank the view down.
		await harness((h) => h.addAssistantMarkdown(60));
		await settleFrames();
		expect(await harness((h) => h.scrollTop())).toBe(parkedAt);
	});
});
