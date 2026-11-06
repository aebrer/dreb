/** Real App/Fleet sorting and filtering, reload and SSE updates in Chromium, not a static DOM replica. */
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
	if (sort.key === "default") {
		await page.getByRole("button", { name: "Reset Fleet sorting", exact: true }).first().click();
		return;
	}
	const section = sort.key === "started" ? ".live-sessions" : ".past-sessions";
	const button = page.locator(`${section} [data-sort-key="${sort.key}"]`);
	await button.click();
	if ((await button.getAttribute("data-sort-direction")) !== sort.direction) await button.click();
}

async function expectPreference(sort: FleetSortPreference): Promise<void> {
	const buttons = page.locator(`.fleet-sort-header[data-sort-key="${sort.key}"]`);
	for (const button of await buttons.all()) {
		expect(await button.getAttribute("aria-pressed")).toBe("true");
		expect(await button.getAttribute("data-sort-direction")).toBe(sort.direction);
	}
	const column = page.locator(".fleet-session-table th[aria-sort]");
	if (["name", "created", "activity"].includes(sort.key)) {
		expect(await column.count()).toBe(1);
		expect(await column.getAttribute("aria-sort")).toBe(sort.direction === "asc" ? "ascending" : "descending");
	} else expect(await column.count()).toBe(0);
}
const expensiveCalls = () => calls.filter((call) => /\/api\/(fleet|sessions)|\/hydrate$/.test(call));

async function emitEvent(event: Record<string, unknown>, key = ""): Promise<void> {
	await page.evaluate(
		({ event, key }) => {
			(window as unknown as { __sse: { emit(event: unknown, key: string): void } }).__sse.emit(event, key);
		},
		{ event, key },
	);
}

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
			await expectPreference(sort);
		},
		60_000,
	);

	it.each([undefined, "broken JSON", '{"key":"unknown","direction":"asc"}'])(
		"retains safe Default on startup with preference %j",
		async (raw) => {
			await open(raw);
			expect(await page.locator('.fleet-sort-header[aria-pressed="true"]').count()).toBe(0);
			expect(await page.getByRole("button", { name: "Reset Fleet sorting", exact: true }).first().isDisabled()).toBe(
				true,
			);
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

	it("moves a new session to its creation position once its first turn saves the file, without reload or disk events", async () => {
		await open(JSON.stringify({ key: "created", direction: "desc" }));
		await expectOrder(".session-card .name", ["Alpha", "Middle", "Zulu"]);
		const base = runtimes;
		const fresh = (messageCount: number, isStreaming: boolean): RuntimeInfoDto => {
			const r = runtime("n", "Newest", 9, 9);
			r.state.messageCount = messageCount;
			r.state.isStreaming = isStreaming;
			return r;
		};
		const snapshot = async (next: RuntimeInfoDto[]) => {
			runtimes = next;
			await page.evaluate((next) => {
				(window as unknown as { __sse: { fleetSnapshot(r: unknown[]): void } }).__sse.fleetSnapshot(next);
			}, next);
		};
		const note = page.locator(".live-sessions .fleet-live-note");

		// A runtime starts. Its creation-time inventory read cannot include the unsaved file.
		await snapshot([...base, fresh(0, false)]);
		await expectOrder(".session-card .name", ["Alpha", "Middle", "Zulu", "Newest"]);
		await note.waitFor();
		expect(await note.textContent()).toBe("1 live session has no known creation date yet, so it is listed last.");
		// The first turn runs; the file may not exist until it ends.
		await snapshot([...base, fresh(1, true)]);
		// The first assistant reply saved the file and the turn ended.
		inventory = [...inventory, disk("n", "/n", "Newest", 9, 9)];
		await snapshot([...base, fresh(2, false)]);
		await expectOrder(".session-card .name", ["Newest", "Alpha", "Middle", "Zulu"]);
		await note.waitFor({ state: "detached" });
		// Startup, the membership change, and one post-turn re-read; no fleet refetch or reload.
		expect(calls.filter((c) => c === "GET /api/sessions")).toHaveLength(3);
		expect(calls.filter((c) => c === "GET /api/fleet/live")).toHaveLength(1);
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
		const activity = page.locator('.past-sessions [data-sort-key="activity"]');
		await activity.focus();
		await select({ key: "activity", direction: "desc" });
		expect(await activity.evaluate((el) => document.activeElement === el)).toBe(true);
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
		"contains integrated table headings and native keyboard navigation at %ipx",
		async (width) => {
			await page.setViewportSize({ width, height: 900 });
			await open();
			const name = page.locator('.live-sessions [data-sort-key="name"]');
			const created = page.locator('.live-sessions [data-sort-key="created"]');
			await name.focus();
			await name.press("Enter");
			await expectOrder(".session-card .name", ["Alpha", "Middle", "Zulu"]);
			await expectPreference({ key: "name", direction: "asc" });
			await name.press("Space");
			await expectOrder(".session-card .name", ["Zulu", "Middle", "Alpha"]);
			await expectPreference({ key: "name", direction: "desc" });
			await name.press("Tab");
			expect(await created.evaluate((el) => document.activeElement === el)).toBe(true);
			await created.press("Enter");
			await expectOrder(".session-card .name", ["Alpha", "Middle", "Zulu"]);
			await expectPreference({ key: "created", direction: "desc" });
			await created.press("Shift+Tab");
			expect(await name.evaluate((el) => document.activeElement === el)).toBe(true);
			await name.press("Space");
			await expectPreference({ key: "name", direction: "asc" });
			const bounds = await page.evaluate(() => {
				const controls = [
					...document.querySelectorAll<HTMLElement>(".fleet-sort-header, .fleet-sort-reset, .fleet-head .btn"),
				];
				const table = document.querySelector<HTMLElement>(".fleet-session-table")!;
				const columns = [...table.querySelectorAll("thead th")];
				const cells = [...table.querySelector(".disk-row")!.children];
				return {
					selectCount: document.querySelectorAll(".fleet-sort, #fleet-sort-key, #fleet-sort-direction").length,
					documentFits: document.documentElement.scrollWidth <= innerWidth + 1,
					controlsFit: controls.every((e) => {
						const r = e.getBoundingClientRect();
						return (
							r.left >= 0 &&
							r.right <= innerWidth + 1 &&
							r.width > 0 &&
							r.height > 0 &&
							e.scrollWidth <= e.clientWidth + 1
						);
					}),
					tableFits: table.getBoundingClientRect().right <= innerWidth + 1,
					headingsSingleLine: [...document.querySelectorAll(".fleet-sort-header")].every(
						(e) => getComputedStyle(e).whiteSpace === "nowrap",
					),
					touchTargets: [
						...document.querySelectorAll(
							".fleet-sort-header, .fleet-sort-reset, .fleet-session-table .disk-row .btn",
						),
					].every((e) => e.getBoundingClientRect().height >= 44),
					columnsAligned: columns.every(
						(column, i) =>
							Math.abs(column.getBoundingClientRect().left - cells[i].getBoundingClientRect().left) <= 1,
					),
				};
			});
			expect(bounds.selectCount).toBe(0);
			expect(bounds.documentFits).toBe(true);
			expect(bounds.controlsFit).toBe(true);
			expect(bounds.tableFits).toBe(true);
			expect(bounds.headingsSingleLine).toBe(true);
			if (width <= 700) expect(bounds.touchTargets).toBe(true);
			else expect(bounds.columnsAligned).toBe(true);
		},
		60_000,
	);

	it("uses one accessible table/header across projects and resets the shared sort", async () => {
		await open();
		const table = page.getByRole("table");
		expect(await table.count()).toBe(1);
		expect(await table.getByRole("columnheader").count()).toBe(5);
		expect(await table.getByRole("columnheader", { name: "Messages", exact: true }).getByRole("button").count()).toBe(
			0,
		);
		expect(await table.locator("thead").count()).toBe(1);
		expect(await table.locator("tbody.project-group").count()).toBe(2);
		expect(await table.locator("tbody .fleet-sort-header").count()).toBe(0);
		const baseline = expensiveCalls();
		await select({ key: "name", direction: "desc" });
		await expectPreference({ key: "name", direction: "desc" });
		await page.locator(".past-sessions .fleet-sort-reset").click();
		await expectOrder(".session-card .name", ["Zulu", "Alpha", "Middle"]);
		expect(await page.locator("th[aria-sort]").count()).toBe(0);
		expect(await page.locator('.fleet-sort-header[aria-pressed="true"]').count()).toBe(0);
		expect(expensiveCalls()).toEqual(baseline);
	});

	it("retains a focused row action when fresh metadata replaces and moves its surviving row", async () => {
		await open();
		await select({ key: "name", direction: "asc" });
		const group = page
			.locator(".project-group")
			.filter({ has: page.getByRole("heading", { name: "/past/a", exact: true }) });
		await group.getByRole("button", { name: "all 4 on disk →", exact: true }).click();
		const action = group
			.locator(".disk-row")
			.filter({ has: page.getByText("Aardvark", { exact: true }) })
			.getByRole("button", { name: "resume", exact: true });
		await action.evaluate((el) => el.setAttribute("data-original-row-action", "true"));
		await action.focus();
		inventory = inventory.map((s) => ({ ...s, name: s.id === "pa-a" ? "ZZZ" : s.name }));
		await page.evaluate(() =>
			(window as unknown as { __sse: { emit(e: unknown): void } }).__sse.emit({ type: "disk_sessions_changed" }),
		);
		await expectOrder(".disk-row .name", ["Beta", "Cedar", "Xylophone", "Yarrow", "Zebra", "ZZZ"]);
		await page.waitForFunction(() => document.activeElement?.getAttribute("data-original-row-action") === "true");
		expect(await page.locator('[data-original-row-action="true"]').count()).toBe(1);
	});

	it("keeps history headers usable when live sessions disappear with Started selected", async () => {
		await open();
		await select({ key: "started", direction: "desc" });
		await page.evaluate(() =>
			(window as unknown as { __sse: { fleetSnapshot(r: unknown[]): void } }).__sse.fleetSnapshot([]),
		);
		await page.waitForFunction(() => !document.querySelector(".live-sessions"));
		expect(await page.locator(".fleet-history-note").textContent()).toContain("Past sessions stay newest first");
		await page.locator('.past-sessions [data-sort-key="name"]').click();
		await expectPreference({ key: "name", direction: "asc" });
		expect(await page.locator(".fleet-history-note").count()).toBe(0);
		await page.locator(".past-sessions .fleet-sort-reset").click();
		expect(await page.locator(".past-sessions .fleet-sort-reset").isDisabled()).toBe(true);
	});

	it.each([320, 701])("contains long actual table values and unavailable paths at %ipx", async (width) => {
		const long = "unbroken-session-and-project-identifier".repeat(12);
		inventory = inventory.map((s) =>
			s.id === "pb-b"
				? {
						...s,
						cwd: `/unavailable/${long}`,
						name: long,
						created: "invalid",
						modified: "invalid",
						cwdAvailable: false,
					}
				: s,
		);
		await page.setViewportSize({ width, height: 900 });
		await open();
		await select({ key: "name", direction: "asc" });
		const row = page.locator(".disk-row").filter({ has: page.getByText(long, { exact: true }) });
		expect(await row.locator("time").count()).toBe(0);
		expect(await row.locator(".disk-created").textContent()).toBe("—");
		expect(await row.locator(".disk-activity").textContent()).toBe("—");
		expect(await row.locator(".disk-path-status").textContent()).toBe("original path unavailable");
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
		for (const action of await row.locator(".actions button").all()) {
			const r = await action.boundingBox();
			expect(r).not.toBeNull();
			expect(r!.x).toBeGreaterThanOrEqual(0);
			expect(r!.x + r!.width).toBeLessThanOrEqual(width + 1);
		}
	});
});

describe("Fleet filtering in the real App", () => {
	it("searches current displayed names and full or shown project paths case-insensitively without fetching", async () => {
		inventory = inventory.map((s) =>
			s.id === "pb-b" ? { ...s, cwd: "/home/alice/Archive/PastRepo", resolvedCwd: "/canonical/resume-target" } : s,
		);
		await open();
		const baseline = expensiveCalls();
		const search = page.getByRole("searchbox", { name: "Search sessions", exact: true });
		await search.fill("  aLPHa  ");
		await expectOrder(".session-card .name", ["Alpha"]);
		await expectOrder(".disk-row .name", []);
		await emitEvent({ type: "session_name_changed", name: "Current Display Label" }, "b");
		await expectOrder(".session-card .name", []); // the stale runtime name is no longer displayed or searchable
		expect(await search.inputValue()).toBe("  aLPHa  ");
		await search.fill("  CURRENT display LABEL  ");
		await expectOrder(".session-card .name", ["Current Display Label"]);

		runtimes = runtimes.map((r) => (r.key === "a" ? { ...r, cwd: "/home/alice/Work/LiveRepo" } : r));
		await emitEvent({ type: "fleet_snapshot", runtimes });
		for (const query of [" /HOME/ALICE/WORK/LIVEREPO ", "~/wORK/liVErepo"]) {
			await search.fill(query);
			await expectOrder(".session-card .name", ["Zulu"]);
			await expectOrder(".session-card .session-project", ["~/Work/LiveRepo"]);
			await expectOrder(".disk-row .name", []);
		}
		for (const query of ["/HOME/ALICE/ARCHIVE/PASTREPO", " ~/aRCHIVE/pASTrepo "]) {
			await search.fill(query);
			await expectOrder(".session-card .name", []);
			await expectOrder(".group-head h3", ["~/Archive/PastRepo"]);
			await expectOrder(".disk-row .name", ["Beta"]);
		}
		await search.fill("canonical/resume-target");
		await expectOrder(".disk-row .name", []); // history searches its original/displayed path, not a resume target
		expect(expensiveCalls()).toEqual(baseline);
	});

	it("searches all history before its three-row preview and uses the displayed unnamed-session fallback", async () => {
		const firstMessage = `Visible fallback ${"x".repeat(60)}hidden-tail`;
		inventory.push({ ...disk("unnamed", "/past/fallback", "", 1, 1), name: undefined, firstMessage });
		await open();
		const baseline = expensiveCalls();
		const search = page.getByRole("searchbox", { name: "Search sessions", exact: true });
		expect(await page.locator(".disk-row .name").allTextContents()).not.toContain("Aardvark");
		await search.fill("  AaRDvArk  ");
		await expectOrder(".group-head h3", ["/past/a"]);
		await expectOrder(".disk-row .name", ["Aardvark"]);
		expect(await page.locator(".fleet-filter-results").textContent()).toContain("1 matching past sessions");
		await search.fill(" /PAST/A ");
		await expectOrder(".disk-row .name", ["Zebra", "Yarrow", "Xylophone"]);
		expect(await page.locator(".fleet-filter-results").textContent()).toContain("4 matching past sessions");
		await page.getByRole("button", { name: "all 4 matches →", exact: true }).click();
		await expectOrder(".disk-row .name", ["Zebra", "Yarrow", "Xylophone", "Aardvark"]);
		await search.fill("“vISIBLE FALLBACK");
		await expectOrder(".disk-row .name", [`“${firstMessage.slice(0, 60)}…”`]);
		await search.fill("hidden-tail");
		await expectOrder(".disk-row .name", []);
		expect(expensiveCalls()).toEqual(baseline);
	});

	it("toggles total attention counts for live sessions only, combines search, and never leaks hidden live files into history", async () => {
		runtimes = runtimes.map((r) => ({
			...r,
			needsAttention: r.key !== "b",
			...(r.key === "c" ? {} : { error: "synthetic failure" }),
		}));
		await open();
		const baseline = expensiveCalls();
		const live = page.getByRole("button", { name: "3 live", exact: true });
		const attention = page.getByRole("button", { name: "2 needs attention", exact: true });
		const search = page.getByRole("searchbox", { name: "Search sessions", exact: true });
		expect(await live.getAttribute("aria-pressed")).toBe("true");
		expect(await attention.getAttribute("aria-pressed")).toBe("false");
		await attention.click();
		await expectOrder(".session-card .name", ["Zulu", "Middle"]); // flagged errors included; unflagged errors excluded
		expect(await attention.getAttribute("aria-pressed")).toBe("true");
		expect(await live.getAttribute("aria-pressed")).toBe("false");
		await expectOrder(".disk-row .name", ["Zebra", "Yarrow", "Xylophone", "Cedar", "Beta"]);
		expect(await page.locator(".fleet-filter-results").textContent()).toContain("live sessions only");
		await search.fill("Middle");
		await expectOrder(".session-card .name", ["Middle"]);
		await search.fill("Alpha");
		await expectOrder(".session-card .name", []);
		await expectOrder(".disk-row .name", []); // Alpha's matching file is live, even though attention hid its card
		await search.fill("/historical/a");
		await expectOrder(".session-card .name", []);
		await expectOrder(".disk-row .name", []); // a search-hidden live file is not historical either
		await search.fill("Cedar");
		await expectOrder(".session-card .name", []);
		await expectOrder(".disk-row .name", ["Cedar"]); // attention never filters past matches
		expect(await live.textContent()).toBe("3 live");
		expect(await attention.textContent()).toBe("2 needs attention");
		expect(await page.locator(".fleet-counts").textContent()).toContain("9 on disk");
		await search.fill("Alpha");
		await live.click();
		await expectOrder(".session-card .name", ["Alpha"]);
		expect(await search.inputValue()).toBe("Alpha");
		await attention.click();
		await expectOrder(".session-card .name", []);
		await attention.click();
		await expectOrder(".session-card .name", ["Alpha"]);
		expect(await attention.getAttribute("aria-pressed")).toBe("false");
		expect(expensiveCalls()).toEqual(baseline);
	});

	it("keeps the query and attention filter active through live name/attention SSE and inventory changes", async () => {
		runtimes = runtimes.map((r) => ({ ...r, needsAttention: r.key === "b" }));
		await open();
		const baseline = expensiveCalls();
		const search = page.getByRole("searchbox", { name: "Search sessions", exact: true });
		await search.fill("  nEeDlE  ");
		await page.getByRole("button", { name: "1 needs attention", exact: true }).click();
		await expectOrder(".session-card .name", []);
		await emitEvent({ type: "session_name_changed", name: "Needle Alpha" }, "b");
		await expectOrder(".session-card .name", ["Needle Alpha"]);
		runtimes = runtimes.map((r) => ({
			...r,
			needsAttention: r.key === "c",
			state: { ...r.state, sessionName: r.key === "c" ? "Needle Middle" : r.state.sessionName },
		}));
		await emitEvent({ type: "fleet_snapshot", runtimes });
		await expectOrder(".session-card .name", ["Needle Middle"]);
		await emitEvent({ type: "session_name_changed", name: "Unrelated" }, "c");
		await expectOrder(".session-card .name", []);
		await emitEvent({ type: "session_name_changed", name: "Needle Zulu" }, "a");
		await expectOrder(".session-card .name", []); // a matching name still requires attention
		runtimes = runtimes.map((r) => ({ ...r, needsAttention: r.key !== "b" }));
		await emitEvent({ type: "fleet_snapshot", runtimes });
		await expectOrder(".session-card .name", ["Needle Zulu"]);
		expect(expensiveCalls()).toEqual(baseline);

		inventory = inventory.map((s) => (s.id === "pa-a" || s.id === "pb-b" ? { ...s, name: `Needle ${s.name}` } : s));
		await emitEvent({ type: "disk_sessions_changed" });
		await expectOrder(".group-head h3", ["/past/b", "/past/a"]); // rank by the first matching member, not hidden previews
		await expectOrder(".disk-row .name", ["Needle Beta", "Needle Aardvark"]);
		expect(await page.locator(".fleet-filter-results").textContent()).toContain(
			"1 matching live sessions · 2 matching past sessions",
		);
		inventory = inventory.map((s) => (s.id === "pb-b" ? { ...s, name: "Unrelated Beta" } : s));
		await emitEvent({ type: "disk_sessions_changed" });
		await expectOrder(".disk-row .name", ["Needle Aardvark"]);
		expect(await search.inputValue()).toBe("  nEeDlE  ");
		expect(
			await page.getByRole("button", { name: "2 needs attention", exact: true }).getAttribute("aria-pressed"),
		).toBe("true");
		expect(expensiveCalls()).toEqual([...baseline, "GET /api/sessions", "GET /api/sessions"]);
		runtimes = runtimes.map((r) => ({ ...r, needsAttention: false }));
		await emitEvent({ type: "fleet_snapshot", runtimes });
		await expectOrder(".session-card .name", []);
		const zeroAttention = page.getByRole("button", { name: "0 needs attention", exact: true });
		expect(await zeroAttention.getAttribute("aria-pressed")).toBe("true");
		expect(await zeroAttention.isEnabled()).toBe(true);
		await zeroAttention.press("Space");
		await expectOrder(".session-card .name", ["Needle Zulu", "Needle Alpha"]);
		expect(await search.inputValue()).toBe("  nEeDlE  ");
		expect(expensiveCalls()).toEqual([...baseline, "GET /api/sessions", "GET /api/sessions"]);
	});

	it("keeps sorting, Clear filters, Reset sorting and expanded project state independent", async () => {
		runtimes = runtimes.map((r) => ({ ...r, needsAttention: r.key === "c" }));
		await open();
		const baseline = expensiveCalls();
		const search = page.getByRole("searchbox", { name: "Search sessions", exact: true });
		const attention = page.getByRole("button", { name: "1 needs attention", exact: true });
		const group = page
			.locator(".project-group")
			.filter({ has: page.getByRole("heading", { name: "/past/a", exact: true }) });
		await group.getByRole("button", { name: "all 4 on disk →", exact: true }).click();
		await select({ key: "path", direction: "desc" });
		await search.fill("/past");
		await attention.click();
		await expectOrder(".group-head h3", ["/past/b", "/past/a"]);
		await expectOrder(".disk-row .name", ["Beta", "Cedar", "Aardvark", "Xylophone", "Yarrow", "Zebra"]);
		await search.fill("Beta");
		await expectOrder(".group-head h3", ["/past/b"]);
		await search.fill("/past");
		await expectOrder(".group-head h3", ["/past/b", "/past/a"]);
		expect(await group.locator(".disk-row").count()).toBe(4);
		await page.getByRole("button", { name: "Reset Fleet sorting", exact: true }).first().click();
		expect(await search.inputValue()).toBe("/past");
		expect(await attention.getAttribute("aria-pressed")).toBe("true");
		await expectOrder(".session-card .name", []);
		await expectOrder(".group-head h3", ["/past/a", "/past/b"]);
		await expectOrder(".disk-row .name", ["Zebra", "Yarrow", "Xylophone", "Aardvark", "Cedar", "Beta"]);
		await select({ key: "name", direction: "asc" });
		await page.getByRole("button", { name: "Clear filters", exact: true }).click();
		expect(await search.inputValue()).toBe("");
		expect(await attention.getAttribute("aria-pressed")).toBe("false");
		await expectPreference({ key: "name", direction: "asc" });
		await expectOrder(".session-card .name", ["Alpha", "Middle", "Zulu"]);
		await expectOrder(".group-head h3", ["/past/a", "/past/b"]);
		await expectOrder(".disk-row .name", ["Aardvark", "Xylophone", "Yarrow", "Zebra", "Beta", "Cedar"]);
		expect(await group.getByRole("button", { name: "show fewer ←", exact: true }).isVisible()).toBe(true);
		expect(await page.getByRole("button", { name: "Clear filters", exact: true }).isDisabled()).toBe(true);
		expect(expensiveCalls()).toEqual(baseline);
	});

	it("resets screen-local filters on reload and route return while persisting sorting and keeping the sidebar unfiltered", async () => {
		runtimes = runtimes.map((r) => ({ ...r, needsAttention: r.key === "c" }));
		await open();
		const baseline = expensiveCalls();
		await select({ key: "name", direction: "asc" });
		const search = page.getByRole("searchbox", { name: "Search sessions", exact: true });
		await search.fill("Middle");
		await page.getByRole("button", { name: "1 needs attention", exact: true }).click();
		await expectOrder(".session-card .name", ["Middle"]);
		expect(expensiveCalls()).toEqual(baseline);
		await page.reload({ waitUntil: "domcontentloaded" });
		await expectOrder(".session-card .name", ["Alpha", "Middle", "Zulu"]);
		await page.locator(".project-group").first().waitFor();
		await expectPreference({ key: "name", direction: "asc" });
		expect(await search.inputValue()).toBe("");
		expect(await page.getByRole("button", { name: "3 live", exact: true }).getAttribute("aria-pressed")).toBe("true");
		expect(await page.getByRole("button", { name: "Clear filters", exact: true }).isDisabled()).toBe(true);
		const reloadedCalls = expensiveCalls();
		await search.fill("Middle");
		await page.getByRole("button", { name: "1 needs attention", exact: true }).click();
		await expectOrder(".session-card .name", ["Middle"]);
		expect(expensiveCalls()).toEqual(reloadedCalls);
		await page.locator(".session-card").getByRole("button", { name: "open", exact: true }).click();
		await expectOrder(".fleet-sidebar-entry .name", ["Zulu", "Alpha"]); // both hidden cards remain in stable path order
		expect(new URL(page.url()).hash).toBe("#/session/c");
		expect(calls.filter((c) => c === "GET /api/runtimes/c/hydrate")).toHaveLength(1);
		await page.getByRole("link", { name: "← fleet", exact: true }).click();
		await expectOrder(".session-card .name", ["Alpha", "Middle", "Zulu"]);
		await expectPreference({ key: "name", direction: "asc" });
		expect(await search.inputValue()).toBe("");
		expect(
			await page.getByRole("button", { name: "1 needs attention", exact: true }).getAttribute("aria-pressed"),
		).toBe("false");
	});

	it.each([320, 390, 700, 701, 1280])(
		"keeps labelled native filter controls usable with no matches and no toolbar at %ipx",
		async (width) => {
			runtimes = runtimes.map((r) => ({ ...r, needsAttention: r.key === "c" }));
			await page.setViewportSize({ width, height: 900 });
			await open();
			const baseline = expensiveCalls();
			const live = page.getByRole("button", { name: "3 live", exact: true });
			const attention = page.getByRole("button", { name: "1 needs attention", exact: true });
			const search = page.getByRole("searchbox", { name: "Search sessions", exact: true });
			const clear = page.getByRole("button", { name: "Clear filters", exact: true });
			await live.focus();
			await live.press("Tab");
			expect(await attention.evaluate((el) => document.activeElement === el)).toBe(true);
			await attention.press("Enter");
			await expectOrder(".session-card .name", ["Middle"]);
			expect(await attention.getAttribute("aria-pressed")).toBe("true");
			await attention.press("Space");
			await expectOrder(".session-card .name", ["Zulu", "Alpha", "Middle"]);
			expect(await live.getAttribute("aria-pressed")).toBe("true");
			await attention.press("Enter");
			await search.focus();
			await search.pressSequentially("no-such-session");
			await expectOrder(".session-card .name", []);
			await expectOrder(".disk-row .name", []);
			expect(await page.getByText("No live sessions match these filters.", { exact: true }).isVisible()).toBe(true);
			expect(await page.getByText("No past sessions match this search.", { exact: true }).isVisible()).toBe(true);
			expect(await page.getByText("No sessions yet.", { exact: true }).count()).toBe(0);
			expect(await page.getByRole("button", { name: "+ create your first session", exact: true }).count()).toBe(0);
			expect(await page.getByRole("button", { name: "+ new session", exact: true }).isEnabled()).toBe(true);
			expect(await page.locator(".fleet-filter-results").textContent()).toContain(
				"0 matching live sessions · 0 matching past sessions",
			);
			const bounds = await page
				.locator(".fleet-count-filter, .fleet-search-field input, .fleet-clear-filters")
				.evaluateAll((controls) => ({
					documentFits: document.documentElement.scrollWidth <= innerWidth + 1,
					controlsFit: controls.every((e) => {
						const r = e.getBoundingClientRect();
						return r.left >= 0 && r.right <= innerWidth + 1 && r.width > 0 && r.height > 0;
					}),
					touchTargets: controls.every((e) => {
						const r = e.getBoundingClientRect();
						return r.width >= 44 && r.height >= 44;
					}),
				}));
			expect(bounds.documentFits).toBe(true);
			expect(bounds.controlsFit).toBe(true);
			if (width <= 700) expect(bounds.touchTargets).toBe(true);
			expect(await page.getByRole("toolbar").count()).toBe(0);
			expect(await page.locator(".fleet-sort, #fleet-sort-key, #fleet-sort-direction").count()).toBe(0);
			await live.press("Space");
			expect(await attention.getAttribute("aria-pressed")).toBe("false");
			expect(await search.inputValue()).toBe("no-such-session");
			await expectOrder(".session-card .name", []);
			const nameSort = page.locator('.live-sessions [data-sort-key="name"]');
			await nameSort.press("Enter"); // sorting stays operable even with no visible rows
			await expectPreference({ key: "name", direction: "asc" });
			await attention.press("Enter");
			await search.focus();
			await search.press("Tab");
			expect(await clear.evaluate((el) => document.activeElement === el)).toBe(true);
			await clear.press("Enter");
			await expectOrder(".session-card .name", ["Alpha", "Middle", "Zulu"]);
			await expectOrder(".disk-row .name", ["Aardvark", "Xylophone", "Yarrow", "Beta", "Cedar"]);
			expect(await search.inputValue()).toBe("");
			expect(await live.getAttribute("aria-pressed")).toBe("true");
			expect(await clear.isDisabled()).toBe(true);
			await expectPreference({ key: "name", direction: "asc" });
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
			expect(expensiveCalls()).toEqual(baseline);
		},
		60_000,
	);
});
