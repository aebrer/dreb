/** Real App/Fleet controls, reload and SSE ordering in Chromium, not a static DOM replica. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FleetSortPreference } from "../../src/client/state/fleet-sorting.js";
import type { RuntimeInfoDto, SessionInfoDto } from "../../src/shared/protocol.js";

const STORAGE_KEY = "dreb.dashboard.fleetSort";
const day = (n: number) => `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`;
function runtime(key: string, name: string, started: number, activity: number): RuntimeInfoDto {
	return {
		key,
		cwd: `/${key}`,
		state: {
			sessionId: `${key}-id`,
			sessionFile: `/sessions/${key}.jsonl`,
			sessionName: name,
			tasks: [],
			thinkingLevel: "off",
			availableThinkingLevels: ["off"],
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			autoCompactionEnabled: true,
			messageCount: 1,
			pendingMessageCount: 0,
		},
		backgroundAgents: [],
		needsAttention: false,
		createdAt: day(started),
		lastActivity: day(activity),
	};
}
function disk(id: string, cwd: string, name: string, created: number, modified: number): SessionInfoDto {
	return {
		id,
		path: `/sessions/${id}.jsonl`,
		cwd,
		name,
		created: day(created),
		modified: day(modified),
		messageCount: 1,
		firstMessage: name,
	};
}

let vite: ViteDevServer;
let cache: string;
let browser: Browser;
let page: Page;
let fixtureUrl: string;
let runtimes: RuntimeInfoDto[];
let inventory: SessionInfoDto[];
let calls: string[];
let unexpected: string[];
let errors: string[];
let inventoryGate: Promise<void> | undefined;
let releaseInventory: (() => void) | undefined;

beforeAll(async () => {
	cache = await mkdtemp(join(tmpdir(), "dreb-fleet-sort-vite-"));
	vite = await createViteServer({
		cacheDir: cache,
		root: fileURLToPath(new URL("../..", import.meta.url)),
		plugins: [solid({ include: [/src\/client\/.*\.[jt]sx$/, /test\/client\/fixtures\/.*\.tsx$/] })],
		logLevel: "error",
		optimizeDeps: { noDiscovery: true, include: ["dompurify", "highlight.js/lib/common", "marked"] },
		server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
	});
	await vite.listen();
	const address = vite.httpServer?.address();
	if (!address || typeof address === "string") throw new Error("Fleet sort Vite fixture did not bind");
	// Reuse the existing real-App/SSE fixture unchanged, at its Fleet route.
	fixtureUrl = `http://127.0.0.1:${address.port}/test/client/fixtures/session-sidebar.html`;
	browser = await chromium.launch();
}, 90_000);

afterAll(async () => {
	await browser?.close();
	await vite?.close();
	if (cache) await rm(cache, { recursive: true, force: true });
});

beforeEach(async () => {
	runtimes = [runtime("c", "Middle", 2, 1), runtime("b", "Alpha", 1, 3), runtime("a", "Zulu", 3, 2)];
	inventory = [
		disk("a", "/historical/a", "Zulu", 1, 2),
		disk("b", "/b", "Alpha", 3, 3),
		disk("c", "/c", "Middle", 2, 1),
		disk("pa-z", "/past/a", "Zebra", 3, 8),
		disk("pa-y", "/past/a", "Yarrow", 4, 7),
		disk("pa-x", "/past/a", "Xylophone", 5, 6),
		disk("pa-a", "/past/a", "Aardvark", 6, 1),
		disk("pb-b", "/past/b", "Beta", 1, 4),
		disk("pb-c", "/past/b", "Cedar", 2, 5),
	];
	calls = [];
	unexpected = [];
	errors = [];
	inventoryGate = undefined;
	releaseInventory = undefined;
	page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		calls.push(`${request.method()} ${path}`);
		const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
		if (path === "/api/auth") return json({ mode: "local", needsPairing: false });
		if (path === "/api/fleet/live") return json({ runtimes, diskSessions: [], diskSessionsComplete: false });
		if (path === "/api/sessions" && request.method() === "GET") {
			await inventoryGate;
			return json({ sessions: inventory });
		}
		if (path === "/api/daily-cost") return json({ cost: 0 });
		if (path === "/api/version") return json({ version: "test" });
		if (path === "/api/events/diagnostic") return json({ ok: true });
		const match = path.match(/^\/api\/runtimes\/([^/]+)\/(.+)$/);
		if (match) {
			const r = runtimes.find((r) => r.key === match[1]);
			const action = match[2];
			if (r && action === "hydrate")
				return json({ key: r.key, state: r.state, messages: [], backgroundAgents: [], barrierSeq: 0 });
			if (r && action === "stats")
				return json({
					sessionId: r.state.sessionId,
					userMessages: 1,
					assistantMessages: 0,
					toolCalls: 0,
					toolResults: 0,
					totalMessages: 1,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
				});
			if (action === "performance") return json({ models: [] });
			if (action === "branch") return json({ branch: "test" });
			if (action === "commands") return json({ commands: [] });
			if (action === "pending") return json({ steering: [], followUp: [] });
			if (action === "background-agents") return json({ agents: [] });
		}
		unexpected.push(`${request.method()} ${path}`);
		return route.fulfill({
			status: 404,
			contentType: "application/json",
			body: JSON.stringify({ error: `Unmocked ${path}` }),
		});
	});
});

afterEach(async () => {
	releaseInventory?.();
	await page?.close();
	expect(errors).toEqual([]);
	expect(unexpected).toEqual([]);
});

async function expectOrder(selector: string, expected: string[]): Promise<void> {
	await page.waitForFunction(
		({ selector, expected }) =>
			JSON.stringify([...document.querySelectorAll(selector)].map((e) => e.textContent)) ===
			JSON.stringify(expected),
		{ selector, expected },
	);
	expect(await page.locator(selector).allTextContents()).toEqual(expected);
}

async function open(rawPreference?: string, delayed = false): Promise<void> {
	await page.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
	await expectOrder(".session-card .name", ["Zulu", "Alpha", "Middle"]);
	await page.locator(".project-group").first().waitFor();
	await page.evaluate(
		({ key, raw }) => {
			localStorage.clear();
			if (raw !== undefined) localStorage.setItem(key, raw);
		},
		{ key: STORAGE_KEY, raw: rawPreference },
	);
	if (delayed)
		inventoryGate = new Promise<void>((resolve) => {
			releaseInventory = resolve;
		});
	calls = [];
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.locator(".session-card").first().waitFor();
	if (!delayed) await page.locator(".project-group").first().waitFor();
}

async function select(sort: FleetSortPreference): Promise<void> {
	await page.getByLabel("Sort by", { exact: true }).selectOption(sort.key);
	if (sort.key !== "default") await page.getByLabel("Order", { exact: true }).selectOption(sort.direction);
}
const expensiveCalls = () => calls.filter((call) => /\/api\/(fleet|sessions)|\/hydrate$/.test(call));

// Matrix deliberately separates the three timestamps and uses >3 rows/project.
const cases: Array<[FleetSortPreference, string[], string[], string[]]> = [
	[
		{ key: "activity", direction: "asc" },
		["Middle", "Zulu", "Alpha"],
		["/past/a", "/past/b"],
		["Aardvark", "Xylophone", "Yarrow", "Beta", "Cedar"],
	],
	[
		{ key: "activity", direction: "desc" },
		["Alpha", "Zulu", "Middle"],
		["/past/a", "/past/b"],
		["Zebra", "Yarrow", "Xylophone", "Cedar", "Beta"],
	],
	[
		{ key: "created", direction: "asc" },
		["Zulu", "Middle", "Alpha"],
		["/past/b", "/past/a"],
		["Beta", "Cedar", "Zebra", "Yarrow", "Xylophone"],
	],
	[
		{ key: "created", direction: "desc" },
		["Alpha", "Middle", "Zulu"],
		["/past/a", "/past/b"],
		["Aardvark", "Xylophone", "Yarrow", "Cedar", "Beta"],
	],
	[
		{ key: "started", direction: "asc" },
		["Alpha", "Middle", "Zulu"],
		["/past/a", "/past/b"],
		["Zebra", "Yarrow", "Xylophone", "Cedar", "Beta"],
	],
	[
		{ key: "started", direction: "desc" },
		["Zulu", "Middle", "Alpha"],
		["/past/a", "/past/b"],
		["Zebra", "Yarrow", "Xylophone", "Cedar", "Beta"],
	],
	[
		{ key: "name", direction: "asc" },
		["Alpha", "Middle", "Zulu"],
		["/past/a", "/past/b"],
		["Aardvark", "Xylophone", "Yarrow", "Beta", "Cedar"],
	],
	[
		{ key: "name", direction: "desc" },
		["Zulu", "Middle", "Alpha"],
		["/past/a", "/past/b"],
		["Zebra", "Yarrow", "Xylophone", "Cedar", "Beta"],
	],
	[
		{ key: "path", direction: "asc" },
		["Zulu", "Alpha", "Middle"],
		["/past/a", "/past/b"],
		["Aardvark", "Xylophone", "Yarrow", "Beta", "Cedar"],
	],
	[
		{ key: "path", direction: "desc" },
		["Middle", "Alpha", "Zulu"],
		["/past/b", "/past/a"],
		["Beta", "Cedar", "Aardvark", "Xylophone", "Yarrow"],
	],
];

describe("Fleet sorting in the real App", () => {
	it.each(cases)(
		"sorts and restores %j across an actual page reload",
		async (sort, liveNames, projects, rows) => {
			await open();
			const baseline = expensiveCalls();
			await select(sort);
			await expectOrder(".session-card .name", liveNames);
			await expectOrder(".group-head h3", projects);
			await expectOrder(".disk-row .name", rows);
			expect(expensiveCalls()).toEqual(baseline); // sort changes never hydrate or reload inventory
			expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), STORAGE_KEY)).toEqual(sort);
			await page.reload({ waitUntil: "domcontentloaded" });
			await expectOrder(".session-card .name", liveNames);
			await expectOrder(".group-head h3", projects);
			await expectOrder(".disk-row .name", rows);
			expect(await page.getByLabel("Sort by", { exact: true }).inputValue()).toBe(sort.key);
			expect(await page.getByLabel("Order", { exact: true }).inputValue()).toBe(sort.direction);
		},
		60_000,
	);

	it.each([undefined, "broken JSON", '{"key":"unknown","direction":"asc"}'])(
		"retains safe Default on startup with preference %j",
		async (raw) => {
			await open(raw);
			expect(await page.getByLabel("Sort by", { exact: true }).inputValue()).toBe("default");
			expect(await page.getByLabel("Order", { exact: true }).isDisabled()).toBe(true);
			await expectOrder(".session-card .name", ["Zulu", "Alpha", "Middle"]);
			await expectOrder(".disk-row .name", ["Zebra", "Yarrow", "Xylophone", "Cedar", "Beta"]);
		},
	);

	it("renders live cards without inventory and resolves unknown original dates only when metadata arrives", async () => {
		await open(JSON.stringify({ key: "created", direction: "asc" }), true);
		await expectOrder(".session-card .name", ["Zulu", "Alpha", "Middle"]); // all original dates unknown: stable path tie
		expect(await page.locator(".project-group").count()).toBe(0);
		expect(await page.locator("#fleet-sort-help").textContent()).toContain("Unknown dates sort last");
		releaseInventory!();
		await expectOrder(".session-card .name", ["Zulu", "Middle", "Alpha"]);
		await expectOrder(".group-head h3", ["/past/b", "/past/a"]);
		expect(calls.filter((c) => c === "GET /api/fleet/live")).toHaveLength(1);
		expect(calls.filter((c) => c === "GET /api/sessions")).toHaveLength(1);
	});

	it("updates explicit activity order while preserving focused card identity and without a fleet refetch", async () => {
		await open();
		const emit = async (next: RuntimeInfoDto[]) =>
			page.evaluate((next) => {
				(window as unknown as { __sse: { fleetSnapshot(r: unknown[]): void } }).__sse.fleetSnapshot(next);
			}, next);
		await emit(
			runtimes.map((r) => ({
				...r,
				lastActivity: r.key === "c" ? day(30) : r.lastActivity,
				needsAttention: r.key === "c",
			})),
		);
		await expectOrder(".session-card .name", ["Zulu", "Alpha", "Middle"]); // Default is unchanged
		await select({ key: "activity", direction: "desc" });
		await expectOrder(".session-card .name", ["Middle", "Alpha", "Zulu"]);
		const openMiddle = page
			.locator(".session-card")
			.filter({ has: page.getByText("Middle", { exact: true }) })
			.getByRole("button", { name: "open", exact: true });
		await openMiddle.evaluate((button) => {
			button.setAttribute("data-original-focus", "true");
		});
		await openMiddle.focus();
		const baseline = expensiveCalls();
		await emit(runtimes.map((r) => ({ ...r, lastActivity: r.key === "a" ? day(31) : r.lastActivity })));
		await expectOrder(".session-card .name", ["Zulu", "Alpha", "Middle"]);
		await page.waitForFunction(() => document.activeElement?.getAttribute("data-original-focus") === "true");
		expect(await page.locator('[data-original-focus="true"]').count()).toBe(1);
		expect(expensiveCalls()).toEqual(baseline);
	});

	it("keeps expanded project state and focused controls when groups move, without stealing deliberate new focus", async () => {
		await open();
		await select({ key: "name", direction: "asc" });
		const group = page
			.locator(".project-group")
			.filter({ has: page.getByRole("heading", { name: "/past/a", exact: true }) });
		await group.getByRole("button", { name: "all 4 on disk →", exact: true }).click();
		expect(await group.locator(".disk-row").count()).toBe(4);
		// A metadata update can move groups without a pointer/keyboard selection.
		await group.getByRole("button", { name: "show fewer ←", exact: true }).focus();
		inventory = inventory.map((s) => (s.id === "pb-b" ? { ...s, name: "AAAA" } : s));
		await page.evaluate(() =>
			(window as unknown as { __sse: { emit(e: unknown): void } }).__sse.emit({ type: "disk_sessions_changed" }),
		);
		await expectOrder(".group-head h3", ["/past/b", "/past/a"]);
		expect(await group.locator(".disk-row").count()).toBe(4);
		await page.waitForFunction(() => document.activeElement?.textContent === "show fewer ←");
		await page.getByLabel("Sort by", { exact: true }).focus();
		await select({ key: "activity", direction: "desc" });
		expect(await page.getByLabel("Sort by", { exact: true }).evaluate((el) => document.activeElement === el)).toBe(
			true,
		);
	});

	it("keeps the session sidebar stable regardless of the saved Fleet order", async () => {
		await open(JSON.stringify({ key: "name", direction: "asc" }));
		const card = page.locator(".session-card").filter({ has: page.getByText("Middle", { exact: true }) });
		await card.getByRole("button", { name: "open", exact: true }).click();
		await expectOrder(".fleet-sidebar-entry .name", ["Zulu", "Alpha"]);
		expect(new URL(page.url()).hash).toBe("#/session/c");
		expect(calls.filter((c) => c === "GET /api/runtimes/c/hydrate")).toHaveLength(1);
	});

	it.each([320, 390, 700, 701, 1024])(
		"contains real native controls and keyboard focus navigation at %ipx",
		async (width) => {
			await page.setViewportSize({ width, height: 900 });
			await open();
			const key = page.getByLabel("Sort by", { exact: true });
			await key.focus();
			// macOS headless Chromium does not drive native select options with keys
			// (also reproducible with a standalone select, outside this App). Exercise
			// native change wiring there; Linux CI additionally drives option keys.
			if (process.platform === "darwin") {
				await key.selectOption("activity");
			} else {
				await key.press("Space");
				await key.press("Home");
				await key.press("ArrowDown");
				await key.press("Enter");
			}
			expect(await key.inputValue()).toBe("activity");
			await expectOrder(".session-card .name", ["Alpha", "Zulu", "Middle"]);
			const order = page.getByLabel("Order", { exact: true });
			await key.press("Tab");
			expect(await order.evaluate((el) => document.activeElement === el)).toBe(true);
			await order.press("Shift+Tab");
			expect(await key.evaluate((el) => document.activeElement === el)).toBe(true);
			await key.press("Tab");
			if (process.platform === "darwin") {
				await order.selectOption("asc");
			} else {
				await order.press("Space");
				await order.press("Home");
				await order.press("Enter");
			}
			await expectOrder(".session-card .name", ["Middle", "Zulu", "Alpha"]);
			const bounds = await page.evaluate(() => {
				const controls = [
					...document.querySelectorAll<HTMLElement>(
						".fleet-sort select, .fleet-sort label, #fleet-sort-help, .fleet-head .btn",
					),
				];
				return {
					selectCount: document.querySelectorAll(".fleet-sort select").length,
					documentFits: document.documentElement.scrollWidth <= window.innerWidth,
					controlsFit: controls.every((e) => {
						const r = e.getBoundingClientRect();
						return r.left >= 0 && r.right <= window.innerWidth && r.width > 0 && r.height > 0;
					}),
					touchTargets: [...document.querySelectorAll(".fleet-sort select")].every(
						(e) => e.getBoundingClientRect().height >= 44,
					),
					focused: document.activeElement?.id,
				};
			});
			expect(bounds.selectCount).toBe(2);
			expect(bounds.documentFits).toBe(true);
			expect(bounds.controlsFit).toBe(true);
			if (width <= 700) expect(bounds.touchTargets).toBe(true);
			expect(bounds.focused).toBe("fleet-sort-direction");
		},
		60_000,
	);
});
