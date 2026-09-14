/**
 * Real-component browser regression coverage for the session fleet sidebar.
 *
 * The shipped `App` runs through Vite + solid in Chromium against production
 * CSS. Route lifecycle, store hydration, the reducer, the shared
 * `SessionCardSummary`, the desktop resize hook/handle, and the mobile drawer
 * are all real: the only test seam is a synthetic EventSource plus a network
 * layer that fakes every REST response. No runtime is ever created or stopped,
 * and nothing here re-implements the components' interactions.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Locator, type Page } from "playwright";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/** vitest's expect lacks Playwright's DOM matchers, so assert on waited states. */
async function expectVisible(locator: Locator): Promise<void> {
	await locator.first().waitFor({ state: "visible", timeout: 30_000 });
	expect(await locator.first().isVisible()).toBe(true);
}

async function expectAttached(locator: Locator): Promise<void> {
	await locator.first().waitFor({ state: "attached", timeout: 30_000 });
	expect(await locator.count()).toBeGreaterThan(0);
}

async function expectDetached(locator: Locator): Promise<void> {
	await locator.first().waitFor({ state: "detached", timeout: 30_000 });
	expect(await locator.count()).toBe(0);
}

const LONG = "unbrokenidentifierwithnospaces".repeat(4);
const PROSE = "This deliberately long prose keeps a live session summary readable in a narrow sidebar ";

type StatusOverride = "idle" | "running" | "attention" | "error";

interface RuntimeOverride {
	cwd?: string;
	sessionName?: string;
	isStreaming?: boolean;
	needsAttention?: boolean;
	error?: string;
	lastAssistantText?: string;
	model?: { provider: string; id: string };
	createdAt?: string;
	backgroundAgents?: unknown[];
	messageCount?: number;
}

function runtime(key: string, over: RuntimeOverride = {}) {
	return {
		key,
		cwd: over.cwd ?? `/home/user/projects/${key}`,
		state: {
			sessionId: `${key}-session-id`,
			sessionName: over.sessionName ?? `${key} session`,
			tasks: [{ id: "t1", title: "task one", status: "completed" }],
			thinkingLevel: "medium",
			availableThinkingLevels: ["off", "low", "medium", "high"],
			isStreaming: over.isStreaming ?? false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			autoCompactionEnabled: true,
			messageCount: over.messageCount ?? 3,
			pendingMessageCount: 0,
			model: over.model ?? { provider: "anthropic", id: "claude-sonnet" },
			contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 5 },
		},
		settingsRevision: 1,
		stats: { tokensTotal: 150, cost: 0.01 },
		backgroundAgents: over.backgroundAgents ?? [],
		needsAttention: over.needsAttention ?? false,
		...(over.error ? { error: over.error } : {}),
		lastAssistantText: over.lastAssistantText ?? `${key} last assistant text`,
		createdAt: over.createdAt ?? "2020-01-01T00:00:00.000Z",
		lastActivity: "2020-01-02T00:00:00.000Z",
	};
}

function statusRuntime(key: string, status: StatusOverride) {
	switch (status) {
		case "error":
			return runtime(key, { error: "runtime failed" });
		case "attention":
			return runtime(key, { needsAttention: true });
		case "running":
			return runtime(key, { isStreaming: true });
		default:
			return runtime(key, {});
	}
}

function hydrationFor(key: string) {
	return {
		key,
		state: runtime(key).state,
		messages: [
			{ role: "user", content: [{ type: "text", text: `${key.toUpperCase()} transcript question` }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: `${key.toUpperCase()} transcript answer` }],
				timestamp: 2,
			},
		],
		backgroundAgents: [],
		barrierSeq: 0,
	};
}

function statsFor(key: string) {
	return {
		sessionId: `${key}-session-id`,
		userMessages: 1,
		assistantMessages: 1,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 3,
		tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
		cost: 0.01,
		contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 5 },
	};
}

let vite: ViteDevServer;
let viteCacheDir: string;
let browser: Browser;
let page: Page;
let baseUrl: string;
let fixtureUrl: string;

/** Live REST fleet the fake network serves at /api/fleet. */
let fleetRuntimes: ReturnType<typeof runtime>[] = [];
/** Ordered record of intercepted API request identities (method + path). */
let apiCalls: string[] = [];
let pageErrors: string[] = [];

beforeAll(async () => {
	// Other browser suites run independent Vite servers concurrently. Sharing
	// their optimizer cache can invalidate this App's module URLs mid-load.
	viteCacheDir = await mkdtemp(join(tmpdir(), "dreb-sidebar-vite-"));
	vite = await createViteServer({
		cacheDir: viteCacheDir,
		root: fileURLToPath(new URL("../..", import.meta.url)),
		plugins: [solid({ include: [/src\/client\/.*\.[jt]sx$/, /test\/client\/fixtures\/.*\.tsx$/] })],
		logLevel: "error",
		optimizeDeps: { noDiscovery: true, include: ["dompurify", "highlight.js/lib/common", "marked"] },
		server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
	});
	await vite.listen();
	const address = vite.httpServer?.address();
	if (address === null || address === undefined || typeof address === "string") {
		throw new Error("session-sidebar Vite server did not bind a TCP port");
	}
	baseUrl = `http://127.0.0.1:${address.port}`;
	fixtureUrl = `${baseUrl}/test/client/fixtures/session-sidebar.html`;

	browser = await chromium.launch();
	page = await browser.newPage({ viewport: { width: 1024, height: 900 } });

	page.on("pageerror", (error) => pageErrors.push(error.message));

	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		apiCalls.push(`${request.method()} ${path}`);
		const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

		if (path === "/api/auth") return json({ mode: "local", needsPairing: false });
		if (path === "/api/fleet") return json({ runtimes: fleetRuntimes, diskSessions: [] });
		if (path === "/api/sessions") return json({ sessions: [] });
		if (path === "/api/daily-cost") return json({ cost: 0 });
		if (path === "/api/version") return json({ version: "test" });
		if (path === "/api/events/diagnostic") return json({ ok: true });

		const runtimeMatch = path.match(/^\/api\/runtimes\/([^/]+)\/(.+)$/);
		if (runtimeMatch) {
			const key = decodeURIComponent(runtimeMatch[1]);
			const sub = runtimeMatch[2];
			if (sub === "hydrate") return json(hydrationFor(key));
			if (sub === "stats") return json(statsFor(key));
			if (sub === "performance") return json({ models: [] });
			if (sub === "branch") return json({ branch: "main" });
			if (sub === "commands") return json({ commands: [] });
			if (sub === "pending") return json({ steering: [], followUp: [] });
			if (sub === "background-agents") return json({ agents: [] });
			const subagentMatch = sub.match(/^subagents\/([^/]+)\/(.+)$/);
			if (subagentMatch) {
				const agentId = decodeURIComponent(subagentMatch[1]);
				if (subagentMatch[2] === "messages") {
					return json({
						agent: {
							agentId,
							agentType: "worker",
							taskSummary: "subagent task",
							startedAt: "2020-01-01T00:00:00.000Z",
							status: "running",
						},
						messages: [
							{
								role: "assistant",
								content: [{ type: "text", text: `${agentId} subagent transcript` }],
								timestamp: 3,
							},
						],
					});
				}
				if (subagentMatch[2] === "pending") {
					return json({ steeringMode: "all", pending: { steering: [], followUp: [] } });
				}
			}
		}

		return route.fulfill({
			status: 404,
			contentType: "application/json",
			body: JSON.stringify({ error: `unrouted ${path}` }),
		});
	});
}, 90_000);

afterAll(async () => {
	await page?.close();
	await browser?.close();
	await vite?.close();
	if (viteCacheDir) await rm(viteCacheDir, { recursive: true, force: true });
}, 60_000);

beforeEach(() => {
	apiCalls = [];
	pageErrors = [];
});

const SIDEBAR = ".fleet-sidebar";
const HANDLE = ".fleet-sidebar-resize";
const TOGGLE = ".fleet-sidebar-toggle";

/**
 * Boot the real App at a session route with a clean localStorage. `prefWidth`
 * seeds the persisted numeric width before the client reads it so first-paint
 * reflects a saved preference.
 */
async function openSession(
	key: string,
	options: { width?: number; height?: number; prefWidth?: number; runtimes?: ReturnType<typeof runtime>[] } = {},
): Promise<void> {
	fleetRuntimes = options.runtimes ?? [runtime("alpha"), runtime("bravo"), runtime("charlie")];
	await page.setViewportSize({ width: options.width ?? 1024, height: options.height ?? 900 });
	// Load the fleet, seed localStorage, then RELOAD so the real preferences
	// module reads the seeded width. Only after the reload do we route to the
	// session via a hash change, so the keyed SessionScreen mounts (and hydrates)
	// exactly once — routing before the reload would double-hydrate.
	await page.goto(fixtureUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
	await page.evaluate((prefWidth) => {
		localStorage.clear();
		if (prefWidth != null) localStorage.setItem("dreb.dashboard.sessionSidebarWidth", String(prefWidth));
	}, options.prefWidth ?? null);
	await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
	await page.evaluate((key) => {
		window.location.hash = `#/session/${key}`;
	}, key);
	try {
		await page.locator(SIDEBAR).first().waitFor({ state: "attached", timeout: 5_000 });
	} catch (error) {
		throw new Error(
			`Sidebar did not mount; page errors: ${pageErrors.join("; ")}; API calls: ${apiCalls.join(", ")}`,
			{ cause: error },
		);
	}
}

async function sidebarWidth(): Promise<number> {
	return page
		.locator(SIDEBAR)
		.first()
		.evaluate((el) => Math.round(el.getBoundingClientRect().width));
}

/** Wait for the reactive width clamp to settle after a viewport change. */
async function waitForSidebarWidth(expected: number): Promise<void> {
	await page.waitForFunction(
		(exp) => {
			const el = document.querySelector(".fleet-sidebar");
			return !!el && Math.round(el.getBoundingClientRect().width) === exp;
		},
		expected,
		{ timeout: 15_000 },
	);
}

async function savedWidth(): Promise<string | null> {
	return page.evaluate(() => localStorage.getItem("dreb.dashboard.sessionSidebarWidth"));
}

async function dragging(): Promise<boolean> {
	return page.locator(HANDLE).evaluate((el) => el.classList.contains("dragging"));
}

/** Begin a genuine pointer drag on the resize handle and report the pointerId. */
async function startHandleDrag(deltaX: number): Promise<number> {
	await page.evaluate(() => {
		(window as unknown as { __pid?: number }).__pid = undefined;
		document.querySelector(".fleet-sidebar-resize")?.addEventListener(
			"pointerdown",
			(e) => {
				(window as unknown as { __pid?: number }).__pid = (e as PointerEvent).pointerId;
			},
			{ once: true },
		);
	});
	const box = await page.locator(HANDLE).boundingBox();
	if (!box) throw new Error("resize handle has no bounding box");
	const centerX = box.x + box.width / 2;
	const centerY = box.y + box.height / 2;
	await page.mouse.move(centerX, centerY);
	await page.mouse.down();
	await page.mouse.move(centerX + deltaX, centerY, { steps: 6 });
	return page.evaluate(() => (window as unknown as { __pid: number }).__pid);
}

async function dispatchPointer(type: string, pointerId: number): Promise<void> {
	await page.evaluate(
		({ type, pointerId }) => {
			document
				.querySelector(".fleet-sidebar-resize")
				?.dispatchEvent(new PointerEvent(type, { pointerId, bubbles: true }));
		},
		{ type, pointerId },
	);
}

describe("session fleet sidebar — routing, hydration & transcript", () => {
	it.each([
		["desktop", 1024],
		["mobile", 390],
	])(
		"shows the other sessions and the routed transcript on %s (A→B)",
		async (mode, width) => {
			const mobile = mode === "mobile";
			// On mobile the sidebar is a drawer, hidden until the toggle opens it.
			const revealSidebar = async () => {
				if (mobile) {
					await page.locator(TOGGLE).click();
					await page.locator(`${SIDEBAR}.open`).waitFor({ state: "visible", timeout: 30_000 });
				}
			};

			await openSession("alpha", { width });
			await expectVisible(page.locator(".chat").getByText(/ALPHA transcript answer/));
			await revealSidebar();

			// The sidebar excludes the viewed session and lists the others.
			await expectVisible(page.locator(SIDEBAR).getByText("bravo session"));
			await expectVisible(page.locator(SIDEBAR).getByText("charlie session"));
			expect(await page.locator(SIDEBAR).getByText("alpha session").count()).toBe(0);

			// Exercise the actual card click, not just a programmatic hash change.
			await page.locator(".fleet-sidebar-entry").filter({ hasText: "bravo session" }).click();
			await page.waitForFunction(() => window.location.hash === "#/session/bravo");
			await expectVisible(page.locator(".chat").getByText(/BRAVO transcript answer/));
			expect(apiCalls.filter((call) => call === "GET /api/runtimes/bravo/hydrate")).toHaveLength(1);
			if (mobile) expect(await page.locator(`${SIDEBAR}.open`).count()).toBe(0);
			await revealSidebar();
			await expectVisible(page.locator(SIDEBAR).getByText("alpha session"));
			expect(await page.locator(SIDEBAR).getByText("bravo session").count()).toBe(0);

			expect(pageErrors).toEqual([]);
		},
		60_000,
	);

	it("keeps a stable route identity on a duplicate same-key hash event (no remount)", async () => {
		await openSession("alpha");
		await expectVisible(page.locator(".chat").getByText(/ALPHA transcript answer/));
		const hydrateCalls = () => apiCalls.filter((c) => c === "GET /api/runtimes/alpha/hydrate").length;
		expect(hydrateCalls()).toBe(1);

		// A duplicate hashchange for the same key must not re-run onMount hydration.
		await page.evaluate(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
		await page.waitForTimeout(150);
		expect(hydrateCalls()).toBe(1);
		expect(pageErrors).toEqual([]);
	});

	it("re-hydrates each distinct identity across back/forward navigation", async () => {
		await openSession("alpha");
		await expectVisible(page.locator(".chat").getByText(/ALPHA transcript answer/));
		await page.evaluate(() => {
			window.location.hash = "#/session/bravo";
		});
		await expectVisible(page.locator(".chat").getByText(/BRAVO transcript answer/));

		await page.goBack();
		await page.waitForFunction(() => window.location.hash === "#/session/alpha");
		await expectVisible(page.locator(".chat").getByText(/ALPHA transcript answer/));
		await page.goForward();
		await page.waitForFunction(() => window.location.hash === "#/session/bravo");
		await expectVisible(page.locator(".chat").getByText(/BRAVO transcript answer/));

		expect(apiCalls.filter((c) => c === "GET /api/runtimes/alpha/hydrate").length).toBe(2);
		expect(apiCalls.filter((c) => c === "GET /api/runtimes/bravo/hydrate").length).toBe(2);
		expect(pageErrors).toEqual([]);
	}, 90_000);

	it("renders a closed banner in the transcript column after runtime_removed (A→B)", async () => {
		await openSession("alpha");
		await expectVisible(page.locator(".chat").getByText(/ALPHA transcript answer/));

		await page.evaluate(() =>
			(window as unknown as { __sse: { runtimeRemoved(k: string): void } }).__sse.runtimeRemoved("alpha"),
		);
		const banner = page.locator(".session-main .banner-region").getByText(/was closed/);
		await expectVisible(banner);
		// The banner belongs to the transcript column, never the sidebar.
		expect(await page.locator(`${SIDEBAR} .banner-region`).count()).toBe(0);

		await page.locator(".fleet-sidebar-entry").filter({ hasText: "bravo session" }).click();
		await expectVisible(page.locator(".chat").getByText(/BRAVO transcript answer/));
		expect(
			await page
				.locator(".session-main .banner-region")
				.getByText(/was closed/)
				.count(),
		).toBe(0);
		expect(await page.locator(".composer textarea").isEnabled()).toBe(true);
		expect(apiCalls.filter((call) => call === "GET /api/runtimes/bravo/hydrate")).toHaveLength(1);
		expect(pageErrors).toEqual([]);
	});
});

describe("session fleet sidebar — desktop resize", () => {
	it("defaults to 260px, persists a pointer drag across reload, collapse and subagent", async () => {
		await openSession("alpha");
		expect(await sidebarWidth()).toBe(260);

		const pointerId = await startHandleDrag(120);
		expect(await dragging()).toBe(true);
		await page.mouse.up();
		expect(await dragging()).toBe(false);
		const dragged = await sidebarWidth();
		expect(dragged).toBe(380);
		expect(await savedWidth()).toBe("380");
		expect(pointerId).toBeGreaterThanOrEqual(0);

		// Persist across a full reload of the real preferences module.
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.locator(SIDEBAR).first().waitFor({ state: "attached" });
		expect(await sidebarWidth()).toBe(380);

		// Collapse then reopen keeps the persisted width.
		await page.locator(TOGGLE).click();
		await expectAttached(page.locator(`${SIDEBAR}.collapsed`));
		await page.locator(TOGGLE).click();
		await expectVisible(page.locator(`${SIDEBAR}:not(.collapsed)`));
		expect(await sidebarWidth()).toBe(380);

		// The subagent drill-in shares the same persisted width.
		await page.evaluate(() => {
			window.location.hash = "#/session/alpha/subagent/agent-1";
		});
		await page.waitForFunction(() => window.location.hash === "#/session/alpha/subagent/agent-1");
		await page.locator(SIDEBAR).first().waitFor({ state: "attached" });
		expect(await sidebarWidth()).toBe(380);
		expect(pageErrors).toEqual([]);
	}, 90_000);

	it("honors Arrow/Home/End bounds and preserves a ≥360px transcript at 701px", async () => {
		await openSession("alpha");
		const handle = page.locator(HANDLE);
		await handle.focus();

		await handle.press("ArrowRight");
		expect(await sidebarWidth()).toBe(270);
		await handle.press("ArrowLeft");
		expect(await sidebarWidth()).toBe(260);
		await handle.press("Home");
		expect(await sidebarWidth()).toBe(240); // SESSION_SIDEBAR_WIDTH_MIN
		await handle.press("End");
		expect(await sidebarWidth()).toBe(560); // SESSION_SIDEBAR_WIDTH_MAX at a wide viewport

		// At 701px the max clamps so the transcript never drops below 360px.
		await page.setViewportSize({ width: 701, height: 900 });
		await waitForSidebarWidth(701 - 360 - 6); // saved 560 reactively clamps
		await handle.press("End");
		const width701 = await sidebarWidth();
		expect(width701).toBe(701 - 360 - 6);
		const transcriptWidth = await page
			.locator(".session-main")
			.evaluate((el) => Math.round(el.getBoundingClientRect().width));
		expect(transcriptWidth).toBeGreaterThanOrEqual(360);
		await handle.press("Home");
		expect(await sidebarWidth()).toBe(240);
		expect(pageErrors).toEqual([]);
	});

	it("clamps a saved 560px to the viewport but restores it on expand", async () => {
		await openSession("alpha", { width: 1024, prefWidth: 560 });
		await waitForSidebarWidth(560);

		await page.setViewportSize({ width: 800, height: 900 });
		await waitForSidebarWidth(800 - 360 - 6);
		const clamped = await sidebarWidth();
		expect(clamped).toBe(800 - 360 - 6);
		expect(clamped).toBeLessThan(560);
		// Viewport clamping or simply focusing the splitter must not overwrite
		// the preferred width when the user has not actually resized it.
		expect(await savedWidth()).toBe("560");
		await page.locator(HANDLE).click();
		expect(await savedWidth()).toBe("560");

		await page.setViewportSize({ width: 1024, height: 900 });
		await waitForSidebarWidth(560);
		expect(await savedWidth()).toBe("560");
		expect(pageErrors).toEqual([]);
	});

	it("stays live through a fleet SSE update mid-drag, then commits", async () => {
		await openSession("alpha");
		await startHandleDrag(80);
		expect(await dragging()).toBe(true);

		await page.evaluate(
			(runtimes) =>
				(window as unknown as { __sse: { fleetSnapshot(r: unknown[]): void } }).__sse.fleetSnapshot(runtimes),
			[runtime("alpha"), runtime("bravo", { isStreaming: true, messageCount: 9 }), runtime("charlie")],
		);
		// The drag survives the reactive fleet update.
		expect(await dragging()).toBe(true);
		await page.mouse.up();
		expect(await dragging()).toBe(false);
		expect(await savedWidth()).toBe("340");
		expect(pageErrors).toEqual([]);
	});

	it.each(["pointercancel", "lostpointercapture"])(
		"discards an in-flight drag on %s without committing",
		async (eventType) => {
			await openSession("alpha");
			const pointerId = await startHandleDrag(120);
			expect(await dragging()).toBe(true);

			await dispatchPointer(eventType, pointerId);
			expect(await dragging()).toBe(false);
			expect(await sidebarWidth()).toBe(260); // reverted to the saved width
			expect(await savedWidth()).toBeNull(); // never committed
			await page.mouse.up();
			expect(pageErrors).toEqual([]);
		},
	);

	it("cleans up an in-flight drag on navigation, collapse and breakpoint crossing", async () => {
		// Navigation mid-drag.
		await openSession("alpha");
		await startHandleDrag(120);
		expect(await dragging()).toBe(true);
		await page.evaluate(() => {
			window.location.hash = "#/session/bravo";
		});
		await page.waitForFunction(() => window.location.hash === "#/session/bravo");
		await page.locator(SIDEBAR).first().waitFor({ state: "attached" });
		expect(await sidebarWidth()).toBe(260); // fresh sidebar at saved width
		expect(await savedWidth()).toBeNull();
		await page.mouse.up();

		// Collapse mid-drag.
		await openSession("alpha");
		await startHandleDrag(120);
		expect(await dragging()).toBe(true);
		await page.evaluate(() => document.querySelector<HTMLButtonElement>(".fleet-sidebar-toggle")?.click());
		await expectAttached(page.locator(`${SIDEBAR}.collapsed`));
		expect(await savedWidth()).toBeNull();
		await page.mouse.up();

		// Breakpoint crossing mid-drag (desktop → mobile).
		await openSession("alpha");
		await startHandleDrag(120);
		expect(await dragging()).toBe(true);
		await page.setViewportSize({ width: 600, height: 900 });
		await page.locator(HANDLE).waitFor({ state: "detached", timeout: 15_000 });
		expect(await page.locator(HANDLE).count()).toBe(0); // no handle on mobile
		expect(await savedWidth()).toBeNull();
		await page.mouse.up();
		expect(pageErrors).toEqual([]);
	}, 90_000);
});

describe("session fleet sidebar — mobile", () => {
	it("renders a min(280,80vw) drawer with no resize handle", async () => {
		await openSession("alpha", { width: 390 });
		expect(await page.locator(HANDLE).count()).toBe(0);
		await page.locator(TOGGLE).click();
		await expectVisible(page.locator(`${SIDEBAR}.open`));
		const width = await sidebarWidth();
		expect(width).toBe(Math.round(Math.min(280, 390 * 0.8)));
		expect(pageErrors).toEqual([]);
	});

	it("focuses the close button, traps Tab and closes on Escape without a window abort", async () => {
		await openSession("alpha", { width: 390 });
		await page.evaluate(() => {
			(window as unknown as { __escapes: number }).__escapes = 0;
			window.addEventListener("keydown", (e) => {
				if (e.key === "Escape") (window as unknown as { __escapes: number }).__escapes += 1;
			});
		});
		await page.locator(TOGGLE).click();
		await expectVisible(page.locator(`${SIDEBAR}.open`));

		// The stable close button receives focus, not a fleet-snapshot-replaced entry.
		await page.locator(".fleet-sidebar-close").waitFor({ state: "visible", timeout: 30_000 });
		expect(await page.evaluate(() => document.activeElement?.classList.contains("fleet-sidebar-close"))).toBe(true);

		// Tab stays inside the drawer (focus trap).
		await page.keyboard.press("Tab");
		expect(await page.evaluate(() => document.activeElement?.closest(".fleet-sidebar") !== null)).toBe(true);
		await page.keyboard.press("Shift+Tab");
		expect(await page.evaluate(() => document.activeElement?.closest(".fleet-sidebar") !== null)).toBe(true);

		// Escape closes the drawer and stops before any window-level abort listener.
		await page.keyboard.press("Escape");
		await expectDetached(page.locator(`${SIDEBAR}.open`));
		expect(await page.evaluate(() => (window as unknown as { __escapes: number }).__escapes)).toBe(0);
		expect(pageErrors).toEqual([]);
	});
});

describe("session fleet sidebar — rich summaries & live toggle severity", () => {
	it("contains very long summary text at min width and on mobile without horizontal overflow", async () => {
		const rich = [
			runtime("alpha"),
			runtime("bravo", {
				sessionName: `bravo ${LONG}`,
				cwd: `/home/user/${"deeply/nested/".repeat(4)}${LONG}`,
				error: `${PROSE}${LONG}`,
				lastAssistantText: `${PROSE}${LONG}`,
				model: { provider: `provider${LONG}`, id: `model/${LONG}` },
			}),
			runtime("charlie", {
				sessionName: `charlie ${LONG}`,
				needsAttention: true,
				lastAssistantText: `${PROSE}${LONG}`,
				backgroundAgents: [
					{
						agentId: "a1",
						agentType: `agenttype${LONG}`,
						taskSummary: `${PROSE}${LONG}`,
						startedAt: "2020-01-01T00:00:00.000Z",
						status: "running",
					},
				],
			}),
		];

		// Desktop, dragged to the minimum width.
		await openSession("alpha", { width: 1024, runtimes: rich });
		await page.locator(HANDLE).focus();
		await page.locator(HANDLE).press("Home");
		expect(await sidebarWidth()).toBe(240);
		expect(await noHorizontalOverflow()).toBe(true);

		// Mobile drawer.
		await openSession("alpha", { width: 360, runtimes: rich });
		await page.locator(TOGGLE).click();
		await expectVisible(page.locator(`${SIDEBAR}.open`));
		expect(await noHorizontalOverflow()).toBe(true);
		expect(pageErrors).toEqual([]);
	}, 90_000);

	it("escalates and de-escalates the hidden toggle severity from real store updates, using tokens", async () => {
		await openSession("alpha", {
			runtimes: [runtime("alpha"), statusRuntime("bravo", "idle"), statusRuntime("charlie", "running")],
		});
		// Collapse so the toggle exposes the hidden-state severity indicator.
		await page.locator(TOGGLE).click();
		await expectAttached(page.locator(`${SIDEBAR}.collapsed`));
		expect(await page.locator(TOGGLE).getAttribute("data-status")).toBe("running");

		const emit = (statuses: Record<string, StatusOverride>) =>
			page.evaluate(
				(runtimes) => {
					(window as unknown as { __sse: { fleetSnapshot(r: unknown[]): void } }).__sse.fleetSnapshot(runtimes);
				},
				[
					runtime("alpha"),
					statusRuntime("bravo", statuses.bravo),
					statusRuntime("charlie", statuses.charlie),
				] as unknown[],
			);

		await emit({ bravo: "attention", charlie: "running" });
		await expectAttached(page.locator(`${TOGGLE}[data-status="attention"]`));
		await emit({ bravo: "attention", charlie: "error" });
		await expectAttached(page.locator(`${TOGGLE}[data-status="error"]`));
		// De-escalate.
		await emit({ bravo: "idle", charlie: "idle" });
		await expectAttached(page.locator(`${TOGGLE}[data-status="idle"]`));

		// The severity border resolves through the --status-* design tokens.
		const usesToken = await page.evaluate(() => {
			const toggle = document.querySelector<HTMLElement>(".fleet-sidebar-toggle");
			if (!toggle) return false;
			const probe = document.createElement("div");
			probe.style.borderStyle = "solid";
			probe.style.borderColor = "var(--status-idle)";
			document.body.appendChild(probe);
			const expected = getComputedStyle(probe).borderTopColor;
			const actual = getComputedStyle(toggle).borderTopColor;
			probe.remove();
			return expected === actual;
		});
		expect(usesToken).toBe(true);
		expect(pageErrors).toEqual([]);
	}, 90_000);
});

async function noHorizontalOverflow(): Promise<boolean> {
	return page.evaluate((sidebarSelector) => {
		const tolerance = 1;
		if (document.documentElement.scrollWidth > window.innerWidth + tolerance) return false;
		const sidebar = document.querySelector<HTMLElement>(sidebarSelector);
		if (!sidebar) return false;
		const sidebarRect = sidebar.getBoundingClientRect();
		const elements = sidebar.querySelectorAll<HTMLElement>(
			".name, .session-project, .error-reason, .attention-reason, .activity, .agent-line, .session-meta > span",
		);
		for (const element of elements) {
			if (element.scrollWidth > element.clientWidth + tolerance) return false;
			const rect = element.getBoundingClientRect();
			if (rect.right > sidebarRect.right + tolerance || rect.left < sidebarRect.left - tolerance) return false;
		}
		return true;
	}, SIDEBAR);
}
