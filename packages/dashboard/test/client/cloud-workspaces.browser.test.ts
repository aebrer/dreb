/** PR566 acceptance against the shipped App, production CSS and unchanged SSE fixture in Chromium.
 * All host state is synthetic. This does not certify native touch, Safari or general accessibility.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Locator, type Page } from "playwright";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CloudProjectDto, CloudWorkspacesDto, RuntimeInfoDto, SessionInfoDto } from "../../src/shared/protocol.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const SECOND_PROJECT = "33333333-3333-4333-8333-333333333333";
const PARENT = "44444444-4444-4444-8444-444444444444";
const CREATED = "55555555-5555-4555-8555-555555555555";
const SESSION = "66666666-6666-4666-8666-666666666666";
const LONG_PATH = `/synthetic-host/${"unbroken-project-path-".repeat(22)}/project`;
const LONG_ERROR = `Host directory unavailable: ${"synthetic-storage-error-".repeat(24)}`;
const CLOUD_ROUTE = "#/settings/cloud-workspaces";
const emptyOverview = (): CloudWorkspacesDto => ({ version: 1, pathStyle: "posix", workspaces: [], projects: [] });
function project(id = PROJECT, path = LONG_PATH): CloudProjectDto {
	return { id, location: { kind: "local", path }, markerRequired: false, status: { available: true, path } };
}
function populatedOverview(): CloudWorkspacesDto {
	return {
		...emptyOverview(),
		workspaces: [{ id: WORKSPACE, path: LONG_PATH, status: { available: true, path: LONG_PATH } }],
		projects: [
			project(),
			{
				...project(SECOND_PROJECT),
				status: { available: false, error: { code: "UNAVAILABLE", message: LONG_ERROR } },
			},
		],
	};
}
function runtime(key: string): RuntimeInfoDto {
	return {
		key,
		cwd: "/synthetic-host/local",
		state: {
			sessionId: SESSION,
			sessionFile: `/synthetic-sessions/${SESSION}.jsonl`,
			sessionName: "Synthetic parent",
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
		createdAt: "2026-01-01T00:00:00.000Z",
		lastActivity: "2026-01-02T00:00:00.000Z",
	};
}
function unavailableSession(): SessionInfoDto {
	return {
		id: "77777777-7777-4777-8777-777777777777",
		path: "/synthetic-sessions/77777777-7777-4777-8777-777777777777.jsonl",
		cwd: LONG_PATH,
		cwdAvailable: false,
		name: "Unavailable disk session",
		created: "2026-01-01T00:00:00.000Z",
		modified: "2026-01-02T00:00:00.000Z",
		messageCount: 1,
		firstMessage: "Synthetic history",
	};
}
interface Call {
	method: string;
	path: string;
	body: Record<string, unknown> | undefined;
}
interface Failure {
	code: string;
	error: string;
}
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
let vite: ViteDevServer;
let cache: string;
let browser: Browser;
let page: Page;
let fixtureUrl: string;
let overview: CloudWorkspacesDto;
let runtimes: RuntimeInfoDto[];
let inventory: SessionInfoDto[];
let calls: Call[];
let unexpected: string[];
let pageErrors: string[];
let overviewFailure: Failure | undefined;
let mutationFailure: Failure | undefined;
let createFailure: Failure | undefined;
let inventoryFails: boolean;
let mutationGate: ReturnType<typeof gate> | undefined;
let createGate: ReturnType<typeof gate> | undefined;
let permitCreate: boolean;
let permitSession: boolean;
let permitSettings: boolean;
let settingsFail: boolean;

beforeAll(async () => {
	cache = await mkdtemp(join(tmpdir(), "dreb-cloud-workspaces-vite-"));
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
	if (!address || typeof address === "string") throw new Error("Cloud workspace Vite fixture did not bind");
	fixtureUrl = `http://127.0.0.1:${address.port}/test/client/fixtures/session-sidebar.html`;
	browser = await chromium.launch();
}, 90_000);
afterAll(async () => {
	await browser?.close();
	await vite?.close();
	if (cache) await rm(cache, { recursive: true, force: true });
}, 60_000);
beforeEach(async () => {
	overview = populatedOverview();
	runtimes = [runtime(PARENT)];
	inventory = [];
	calls = [];
	unexpected = [];
	pageErrors = [];
	overviewFailure = undefined;
	mutationFailure = undefined;
	createFailure = undefined;
	inventoryFails = false;
	mutationGate = undefined;
	createGate = undefined;
	permitCreate = false;
	permitSession = false;
	permitSettings = false;
	settingsFail = false;
	page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
	page.setDefaultTimeout(10_000);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		const method = request.method();
		const body = request.postData() ? (request.postDataJSON() as Record<string, unknown>) : undefined;
		calls.push({ method, path, body });
		const json = (value: unknown, status = 200) =>
			route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
		if (method === "GET" && path === "/api/auth") return json({ mode: "local", needsPairing: false });
		if (method === "GET" && path === "/api/fleet/live")
			return json({ runtimes, diskSessions: [], diskSessionsComplete: false });
		if (method === "GET" && path === "/api/sessions")
			return inventoryFails
				? json({ error: "Synthetic inventory refresh failed" }, 500)
				: json({ sessions: inventory });
		if (method === "POST" && path === "/api/events/diagnostic") return json({ ok: true });
		if (method === "GET" && path === "/api/cloud-workspaces")
			return overviewFailure ? json(overviewFailure, 500) : json(overview);
		// Only explicit Settings discovery tests permit its existing resource loaders.
		// Keep the cold Cloud route's strict metadata-only allowlist unchanged.
		if (permitSettings && method === "GET") {
			if (path === "/api/settings")
				return settingsFail ? json({ error: "Synthetic settings failure" }, 500) : json({});
			if (path === "/api/settings/models") return json({ models: [] });
			if (path === "/api/settings/agent-types") return json({ agentTypes: [] });
			if (path === "/api/devices")
				return json({
					devices: [
						{
							id: "synthetic-device",
							device: "Synthetic phone",
							identity: "synthetic@host",
							createdAt: "2026-01-01T00:00:00Z",
							expiresAt: "2099-01-01T00:00:00Z",
						},
					],
				});
			if (path === "/api/pairing-code") return json({ enabled: false });
			if (path === "/api/pairing-settings")
				return settingsFail ? json({ error: "Synthetic pairing failure" }, 500) : json({ pairingTtlDays: 180 });
			if (path === "/api/server/info")
				return json({ version: "test", startedAt: "2026-01-01T00:00:00Z", supervised: false, restartable: false });
		}
		// Fleet owns these lightweight statistics; a cold Cloud route must not request them.
		if (method === "GET" && !page.url().endsWith(CLOUD_ROUTE)) {
			if (path === "/api/daily-cost") return json({ cost: 0 });
			if (path === "/api/version") return json({ version: "test" });
		}
		const workspaceMatch = path.match(/^\/api\/cloud-workspaces\/workspaces\/([\da-f-]+)$/);
		const projectMatch = path.match(/^\/api\/cloud-workspaces\/projects\/([\da-f-]+)$/);
		const connect = method === "POST" && path === "/api/cloud-workspaces/connect";
		const link = method === "POST" && path === "/api/cloud-workspaces/link";
		const knownWorkspace = workspaceMatch && overview.workspaces.some((w) => w.id === workspaceMatch[1]);
		const knownProject = projectMatch && overview.projects.some((p) => p.id === projectMatch[1]);
		if (connect || link || ((method === "PUT" || method === "DELETE") && (knownWorkspace || knownProject))) {
			await mutationGate?.promise;
			if (mutationFailure) return json(mutationFailure, 500);
			if (connect) {
				const path = String(body?.path);
				overview.workspaces = [{ id: WORKSPACE, path, status: { available: true, path } }];
				return json({ id: WORKSPACE, path });
			}
			if (link) {
				const id = String(body?.projectId ?? SECOND_PROJECT);
				const next = project(id, String(body?.path));
				if (body?.workspaceId)
					next.location = { kind: "workspace", workspaceId: String(body.workspaceId), relativePath: "project" };
				overview.projects = [...overview.projects.filter((p) => p.id !== id), next];
				return json({ id });
			}
			if (knownWorkspace && workspaceMatch) {
				const id = workspaceMatch[1];
				if (method === "DELETE") {
					overview.workspaces = overview.workspaces.filter((w) => w.id !== id);
					overview.projects = overview.projects.map((p) =>
						p.location.kind === "workspace" && p.location.workspaceId === id
							? { ...p, status: { available: false, error: { code: "UNAVAILABLE", message: LONG_ERROR } } }
							: p,
					);
					return json({ removed: true });
				}
				const path = String(body?.path);
				overview.workspaces = overview.workspaces.map((w) =>
					w.id === id ? { id, path, status: { available: true, path } } : w,
				);
				return json({ id, path });
			}
			if (knownProject && projectMatch) {
				const id = projectMatch[1];
				if (method === "DELETE") {
					overview.projects = overview.projects.filter((p) => p.id !== id);
					return json({ removed: true });
				}
				const next = project(id, String(body?.path));
				if (body?.workspaceId)
					next.location = { kind: "workspace", workspaceId: String(body.workspaceId), relativePath: "project" };
				overview.projects = overview.projects.map((p) => (p.id === id ? next : p));
				return json({ id });
			}
		}
		if (permitCreate && method === "POST" && path === "/api/runtimes") {
			await createGate?.promise;
			if (createFailure) return json(createFailure, 409);
			const created = runtime(CREATED);
			runtimes = [...runtimes, created];
			return json(created);
		}
		// Only actual session navigation enables this exact fallout allowlist.
		const match = path.match(
			/^\/api\/runtimes\/([^/]+)\/(hydrate|stats|performance|branch|commands|pending|background-agents)$/,
		);
		if (permitSession && method === "GET" && match) {
			// A pending read can already be in flight when SSE removes the viewed
			// runtime. Preserve that exact known runtime response, not arbitrary keys.
			const r =
				runtimes.find((candidate) => candidate.key === match[1]) ??
				(match[1] === PARENT && match[2] === "pending" ? runtime(PARENT) : undefined);
			if (r) {
				if (match[2] === "hydrate")
					return json({ key: r.key, state: r.state, messages: [], backgroundAgents: [], barrierSeq: 0 });
				if (match[2] === "stats")
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
				if (match[2] === "performance") return json({ models: [] });
				if (match[2] === "branch") return json({ branch: "synthetic" });
				if (match[2] === "commands") return json({ commands: [] });
				if (match[2] === "pending") return json({ steering: [], followUp: [] });
				if (match[2] === "background-agents") return json({ agents: [] });
			}
		}
		unexpected.push(`${method} ${path}`);
		return json({ error: `Unexpected ${method} ${path}` }, 404);
	});
});
afterEach(async () => {
	mutationGate?.release();
	createGate?.release();
	await page?.close();
	expect(pageErrors, "real App page errors").toEqual([]);
	expect(unexpected, "strict API allowlist").toEqual([]);
});

const writes = () => calls.filter((c) => c.path.startsWith("/api/cloud-workspaces") && c.method !== "GET");
const creates = () => calls.filter((c) => c.path === "/api/runtimes" && c.method === "POST");
const cloudReads = () => calls.filter((c) => c.path === "/api/cloud-workspaces");
function compactProjects(): void {
	overview = { ...emptyOverview(), projects: [project(PROJECT, "/synthetic-host/linked")] };
}
async function open(width: number, hash = "#/"): Promise<void> {
	await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
	await page.goto(`${fixtureUrl}${hash}`, { waitUntil: "domcontentloaded" });
	await page.locator(hash === CLOUD_ROUTE ? ".cloud-workspaces" : ".session-card").waitFor();
	if (hash === CLOUD_ROUTE) await page.getByRole("button", { name: "Connect workspace", exact: true }).waitFor();
}
async function waitText(selector: string, text: string): Promise<void> {
	await page.waitForFunction(
		({ selector, text }) => [...document.querySelectorAll(selector)].some((e) => e.textContent?.includes(text)),
		{ selector, text },
	);
}
async function openNew(): Promise<Locator> {
	await page.getByRole("button", { name: "+ new session", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "new session", exact: true });
	await dialog.waitFor();
	return dialog;
}
async function chooseProject(dialog: Locator): Promise<void> {
	await dialog.getByLabel("directory source", { exact: true }).selectOption("project");
	await dialog.getByRole("option", { name: new RegExp(`^${PROJECT}`) }).waitFor({ state: "attached" });
	expect(await dialog.getByLabel("linked project", { exact: true }).inputValue()).toBe("");
	expect(await dialog.getByRole("button", { name: /^(start|resume) session$/ }).isDisabled()).toBe(true);
	await dialog.getByLabel("linked project", { exact: true }).selectOption(PROJECT);
}
async function expectLayout(scope: string, mobile: boolean): Promise<void> {
	const measured = await page.locator(scope).evaluate((root) => {
		const visible = (e: Element) => e.getClientRects().length > 0;
		const controls = [...root.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]")].filter(
			visible,
		);
		const fitsViewport = (e: HTMLElement) => {
			const r = e.getBoundingClientRect();
			return r.left >= -1 && r.right <= innerWidth + 1 && r.width > 0;
		};
		const promisedTouch = [
			...root.querySelectorAll<HTMLElement>(
				".cloud-workspaces button, .cloud-workspaces input, .cloud-workspaces select, .project-directory-selector input, .project-directory-selector select, .project-directory-selector button, .project-directory-selector a",
			),
		].filter(visible);
		const text = [
			...root.querySelectorAll<HTMLElement>(
				".cloud-row p, .cloud-row h3, .cloud-error, .project-directory-identity, .project-directory-selector [role=alert]",
			),
		].filter(visible);
		return {
			documentWidth: document.documentElement.scrollWidth,
			viewport: innerWidth,
			badControls: controls
				.filter((e) => !fitsViewport(e))
				.map((e) => ({ text: e.textContent?.slice(0, 80), rect: e.getBoundingClientRect().toJSON() })),
			badText: text
				.filter((e) => !fitsViewport(e) || e.scrollWidth > e.clientWidth + 1)
				.map((e) => e.textContent?.slice(0, 80)),
			shortTargets: promisedTouch
				.filter((e) => e.getBoundingClientRect().height < 44)
				.map((e) => e.textContent?.slice(0, 80)),
		};
	});
	expect.soft(measured.documentWidth, JSON.stringify(measured)).toBeLessThanOrEqual(measured.viewport + 1);
	expect.soft(measured.badControls).toEqual([]);
	expect.soft(measured.badText).toEqual([]);
	if (mobile) expect.soft(measured.shortTargets).toEqual([]);
}
async function expectModalActionsReachable(dialog: Locator): Promise<void> {
	for (const action of await dialog.locator(".modal-actions button").all()) {
		await action.scrollIntoViewIfNeeded();
		const rect = await action.boundingBox();
		expect.soft(rect, "modal action must have layout").not.toBeNull();
		if (rect) {
			expect.soft(rect.y, JSON.stringify(rect)).toBeGreaterThanOrEqual(0);
			expect.soft(rect.y + rect.height, JSON.stringify(rect)).toBeLessThanOrEqual(page.viewportSize()!.height);
		}
	}
}
async function emit(event: Record<string, unknown>, key = PARENT): Promise<void> {
	await page.evaluate(
		({ event, key }) => {
			(window as unknown as { __sse: { emit(e: unknown, key: string): void } }).__sse.emit(event, key);
		},
		{ event, key },
	);
}

describe("Cloud Workspaces discovery within Settings Devices", () => {
	for (const width of [360, 390, 701, 1024]) {
		it.each([false, true])(
			`keeps the categorized link usable at ${width}px with settings failure=%s`,
			async (fail) => {
				permitSettings = true;
				settingsFail = fail;
				await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
				await page.goto(`${fixtureUrl}#/settings`, { waitUntil: "domcontentloaded" });
				const devices = page.getByRole("region", { name: "devices", exact: true });
				const cloud = devices.getByRole("region", { name: "cloud workspaces", exact: true });
				const link = cloud.getByRole("link", { name: "manage cloud workspaces", exact: true });
				await link.waitFor();
				await devices.getByText("Synthetic phone", { exact: true }).waitFor();
				if (fail) {
					await waitText(".settings-error", "Synthetic settings failure");
					await waitText(".settings-error", "Synthetic pairing failure");
				} else {
					await page.getByRole("heading", { name: "model", exact: true, level: 2 }).waitFor();
				}
				expect(await page.locator('main a[href="#/settings/cloud-workspaces"]').count()).toBe(1);
				expect(
					await cloud.getByRole("heading", { name: "cloud workspaces", level: 3, exact: true }).isVisible(),
				).toBe(true);
				expect(await cloud.textContent()).toContain("Separate from device pairing and access.");
				expect(await devices.getByLabel(/^new pairing lifetime/).isVisible()).toBe(true);
				expect(await devices.getByRole("button", { name: "unpair", exact: true }).isVisible()).toBe(true);
				expect(cloudReads()).toHaveLength(0);
				await link.scrollIntoViewIfNeeded();
				const rect = await link.boundingBox();
				expect(rect).not.toBeNull();
				expect(rect!.height).toBeGreaterThanOrEqual(44);
				expect(rect!.x).toBeGreaterThanOrEqual(0);
				expect(rect!.x + rect!.width).toBeLessThanOrEqual(width + 1);
				expect(rect!.y).toBeGreaterThanOrEqual(0);
				expect(rect!.y + rect!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
				const layout = await page.evaluate(() => ({
					width: document.documentElement.scrollWidth,
					overflow: [...document.querySelectorAll("main *")]
						.filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
						.map((element) => ({
							tag: element.tagName,
							class: element.className,
							text: element.textContent?.slice(0, 100),
						})),
				}));
				expect(layout.width, JSON.stringify(layout)).toBeLessThanOrEqual(width + 1);
				const settingsCalls = calls.filter((call) => call.path.startsWith("/api/settings")).length;
				if (width === 1024) {
					await link.focus();
					await page.keyboard.press("Enter");
				} else {
					await link.click();
				}
				await page.locator(".cloud-workspaces .cloud-row").first().waitFor();
				expect(new URL(page.url()).hash).toBe(CLOUD_ROUTE);
				expect(await page.locator(".settings-wrap").count()).toBe(0);
				expect(calls.filter((call) => call.path.startsWith("/api/settings"))).toHaveLength(settingsCalls);
				expect(cloudReads()).toHaveLength(1);
				expect(calls.filter((call) => call.method !== "GET" && call.path !== "/api/events/diagnostic")).toEqual([]);
				expect(creates()).toHaveLength(0);
			},
		);
	}
});

for (const width of [1024, 390]) {
	describe(`real App Cloud Workspaces at ${width}px`, () => {
		it("cold-loads an empty registry without utility, hydration or runtime calls", async () => {
			overview = emptyOverview();
			await open(width, CLOUD_ROUTE);
			await waitText(
				".cloud-workspaces",
				"No registered workspaces or projects. Ordinary local sessions work without setup.",
			);
			expect(await page.getByLabel("Workspace identity mode").inputValue()).toBe("existing");
			expect(await page.getByLabel("Project identity mode").inputValue()).toBe("existing");
			expect(await page.getByLabel("Project binding").inputValue()).toBe("");
			expect(
				calls.every((c) =>
					[
						"/api/auth",
						"/api/fleet/live",
						"/api/sessions",
						"/api/events/diagnostic",
						"/api/cloud-workspaces",
					].includes(c.path),
				),
			).toBe(true);
			expect(writes()).toEqual([]);
			await expectLayout("body", width <= 700);
		});

		it("submits exact initialize/connect, known-ID local/workspace links, same-ID rebinds and confirmed removals", async () => {
			overview = emptyOverview();
			await open(width, CLOUD_ROUTE);
			const connect = page.getByRole("form", { name: "Connect workspace", exact: true });
			await connect.getByLabel("Workspace absolute host path").fill(LONG_PATH);
			await connect.getByLabel("Workspace identity mode").selectOption("initialize");
			await connect.getByRole("button", { name: "Connect workspace", exact: true }).click();
			await page.getByRole("article", { name: `Workspace ${WORKSPACE}`, exact: true }).waitFor();
			expect(writes().at(-1)).toEqual({
				method: "POST",
				path: "/api/cloud-workspaces/connect",
				body: { path: LONG_PATH, initialize: true },
			});
			await connect.getByLabel("Workspace identity mode").selectOption("existing");
			await connect.getByRole("button", { name: "Connect workspace", exact: true }).click();
			await page.waitForFunction(() => !document.querySelector(".cloud-workspaces fieldset:disabled"));
			expect(writes().at(-1)?.body).toEqual({ path: LONG_PATH });
			const link = page.getByRole("form", { name: "Link project", exact: true });
			await link.getByLabel("Project absolute host path").fill(`${LONG_PATH}/local`);
			await link.getByLabel("Project identity mode").selectOption("known");
			await link.getByLabel("Known full project ID").fill(PROJECT);
			await link.getByRole("button", { name: "Link project", exact: true }).click();
			const row = page.getByRole("article", { name: `Project ${PROJECT}`, exact: true });
			await row.waitFor();
			expect(writes().at(-1)?.body).toEqual({ path: `${LONG_PATH}/local`, projectId: PROJECT });
			await link.getByLabel("Known full project ID").fill(SECOND_PROJECT);
			await link.getByLabel("Project binding").selectOption(WORKSPACE);
			await link.getByLabel("Project absolute host path").fill(`${LONG_PATH}/project`);
			await link.getByRole("button", { name: "Link project", exact: true }).click();
			await page.getByRole("article", { name: `Project ${SECOND_PROJECT}`, exact: true }).waitFor();
			expect(writes().at(-1)?.body).toEqual({
				path: `${LONG_PATH}/project`,
				projectId: SECOND_PROJECT,
				workspaceId: WORKSPACE,
			});
			await row.getByRole("button", { name: "Rebind project", exact: true }).click();
			const edit = row.getByRole("form", { name: `Rebind ${PROJECT}`, exact: true });
			await edit.getByLabel("New absolute host path").fill(`${LONG_PATH}/replacement`);
			await edit.getByLabel("Project binding").selectOption(WORKSPACE);
			await edit.getByRole("button", { name: "Save rebind", exact: true }).click();
			await edit.waitFor({ state: "detached" });
			expect(writes().at(-1)).toEqual({
				method: "PUT",
				path: `/api/cloud-workspaces/projects/${PROJECT}`,
				body: { path: `${LONG_PATH}/replacement`, workspaceId: WORKSPACE },
			});
			const workspace = page.getByRole("article", { name: `Workspace ${WORKSPACE}`, exact: true });
			await workspace.getByRole("button", { name: "Rebind workspace", exact: true }).click();
			await workspace.getByLabel("New absolute host path").fill(`${LONG_PATH}/rebound`);
			await workspace.getByRole("button", { name: "Save rebind", exact: true }).click();
			await workspace.getByRole("form").waitFor({ state: "detached" });
			expect(writes().at(-1)).toEqual({
				method: "PUT",
				path: `/api/cloud-workspaces/workspaces/${WORKSPACE}`,
				body: { path: `${LONG_PATH}/rebound` },
			});
			await expectLayout("body", width <= 700);
			for (const [target, action, confirmation, endpoint] of [
				[row, "Unlink project", "Confirm unlink", `/api/cloud-workspaces/projects/${PROJECT}`],
				[workspace, "Disconnect workspace", "Confirm disconnect", `/api/cloud-workspaces/workspaces/${WORKSPACE}`],
			] as const) {
				const before = writes().length;
				await target.getByRole("button", { name: action, exact: true }).click();
				expect(writes()).toHaveLength(before);
				expect(await target.locator(".cloud-confirmation").textContent()).toContain(
					"preserves the folder, marker, session bytes and cloud content",
				);
				await target.getByRole("button", { name: "Cancel removal", exact: true }).click();
				expect(writes()).toHaveLength(before);
				await target.getByRole("button", { name: action, exact: true }).click();
				await target.getByRole("button", { name: confirmation, exact: true }).click();
				await target.waitFor({ state: "detached" });
				expect(writes().at(-1)).toEqual({ method: "DELETE", path: endpoint, body: undefined });
			}
			await waitText(".cloud-row", "UNAVAILABLE");
			await expectLayout("body", width <= 700);
		}, 60_000);

		it("retains last-good rows on refresh failure, wraps errors and prevents pending duplicate mutations", async () => {
			await open(width, CLOUD_ROUTE);
			await page.locator(".cloud-row").first().waitFor();
			overviewFailure = { code: "IO_ERROR", error: LONG_ERROR };
			await page.getByRole("button", { name: "Refresh metadata", exact: true }).click();
			await waitText("[role=alert]", "Refresh failed. Last-good metadata is stale: IO_ERROR:");
			expect(await page.locator(".cloud-row").count()).toBe(3);
			await expectLayout("body", width <= 700);
			overviewFailure = undefined;
			mutationGate = gate();
			mutationFailure = { code: "PARTIAL_INITIALIZATION", error: LONG_ERROR };
			const form = page.getByRole("form", { name: "Connect workspace", exact: true });
			await form.getByLabel("Workspace absolute host path").fill(LONG_PATH);
			await form.getByLabel("Workspace identity mode").selectOption("initialize");
			await form.evaluate((form) => {
				form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
				form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
			});
			await expect.poll(() => writes().length).toBe(1);
			expect(await form.getByLabel("Workspace absolute host path").isDisabled()).toBe(true);
			expect(await page.getByRole("button", { name: "Refresh metadata", exact: true }).isDisabled()).toBe(true);
			mutationGate.release();
			await waitText("[role=alert]", "PARTIAL_INITIALIZATION:");
			await waitText("[role=alert]", "Do not initialize a replacement identity.");
			expect(await form.getByLabel("Workspace absolute host path").inputValue()).toBe(LONG_PATH);
			expect(await form.getByLabel("Workspace identity mode").inputValue()).toBe("initialize");
			expect(writes()).toHaveLength(1);
			expect(await page.locator(".cloud-row").count()).toBe(3);
			await expectLayout("body", width <= 700);
		});

		it("focus-traps New Session, returns focus on Escape, launches an explicit ID without navigation and resets on reopen", async () => {
			compactProjects();
			await open(width);
			const invoker = page.getByRole("button", { name: "+ new session", exact: true });
			const dialog = await openNew();
			expect(cloudReads()).toHaveLength(0);
			expect(await dialog.getByLabel("directory source", { exact: true }).inputValue()).toBe("local");
			expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
			await dialog.getByLabel("directory source", { exact: true }).focus();
			await page.keyboard.press("Shift+Tab");
			expect(
				await dialog
					.getByRole("button", { name: "cancel", exact: true })
					.evaluate((el) => el === document.activeElement),
			).toBe(true);
			await page.keyboard.press("Tab");
			expect(
				await dialog
					.getByLabel("directory source", { exact: true })
					.evaluate((el) => el === document.activeElement),
			).toBe(true);
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "detached" });
			expect(await invoker.evaluate((el) => el.isConnected && el === document.activeElement)).toBe(true);
			const reopened = await openNew();
			await chooseProject(reopened);
			await reopened.getByLabel("first prompt (optional)", { exact: true }).fill("Synthetic first prompt");
			await expectLayout(".modal-backdrop", width <= 700);
			permitCreate = true;
			await reopened.getByRole("button", { name: "start session", exact: true }).click();
			await reopened.waitFor({ state: "detached" });
			expect(creates().map((c) => c.body)).toEqual([{ projectId: PROJECT, firstPrompt: "Synthetic first prompt" }]);
			expect(new URL(page.url()).hash).toBe("#/");
			expect(calls.some((c) => c.path.endsWith("/hydrate"))).toBe(false);
			const reset = await openNew();
			expect(await reset.getByLabel("directory source", { exact: true }).inputValue()).toBe("local");
			expect(await reset.getByLabel("project path", { exact: true }).inputValue()).toBe("");
			expect(await reset.getByLabel("first prompt (optional)", { exact: true }).inputValue()).toBe("");
		});

		it("holds pending create open, disables controls/management and closes after success even when inventory fails", async () => {
			compactProjects();
			await open(width);
			const dialog = await openNew();
			await chooseProject(dialog);
			permitCreate = true;
			createGate = gate();
			inventoryFails = true;
			const invoker = page.getByRole("button", { name: "+ new session", exact: true });
			const start = dialog.getByRole("button", { name: "start session", exact: true });
			// Native clicking focuses the button before pending disables it. A
			// synthetic click alone misses Chromium's resulting body-focus loss.
			await start.click();
			await dialog.getByRole("button", { name: "starting…", exact: true }).evaluate((button) => {
				(button as HTMLButtonElement).click();
				button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			await expect.poll(() => creates().length).toBe(1);
			expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
			for (const control of await dialog.locator("input, select, textarea, button").all())
				expect(await control.isDisabled()).toBe(true);
			const management = dialog.getByText("manage cloud workspaces", { exact: true });
			expect(await management.getAttribute("href")).toBeNull();
			expect(await management.getAttribute("aria-disabled")).toBe("true");
			await management.dispatchEvent("click");
			await page.keyboard.press("Escape");
			await page.locator(".modal-backdrop").click({ position: { x: 1, y: 1 } });
			expect(await dialog.isVisible()).toBe(true);
			expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
			expect(new URL(page.url()).hash).toBe("#/");
			createGate.release();
			await dialog.waitFor({ state: "detached" });
			await waitText("[role=alert]", "Synthetic inventory refresh failed");
			expect(await invoker.evaluate((el) => el.isConnected && el === document.activeElement)).toBe(true);
			expect(creates().map((c) => c.body)).toEqual([{ projectId: PROJECT }]);
			expect(new URL(page.url()).hash).toBe("#/");
			const next = await openNew();
			expect(await next.getByLabel("directory source", { exact: true }).inputValue()).toBe("local");
			expect(creates()).toHaveLength(1);
		});

		it("retains the chosen ID and error on failed creation, and permits management only when not pending", async () => {
			compactProjects();
			await open(width);
			const dialog = await openNew();
			await chooseProject(dialog);
			permitCreate = true;
			createFailure = { code: "UNAVAILABLE", error: "Selected linked project is no longer available on this host." };
			await dialog.getByRole("button", { name: "start session", exact: true }).click();
			await waitText(".modal .pair-error", createFailure.error);
			expect(await dialog.getByLabel("linked project", { exact: true }).inputValue()).toBe(PROJECT);
			expect(await dialog.getByRole("button", { name: "start session", exact: true }).isEnabled()).toBe(true);
			expect(creates().map((c) => c.body)).toEqual([{ projectId: PROJECT }]);
			await expectLayout(".modal-backdrop", width <= 700);
			await dialog.getByRole("link", { name: "manage cloud workspaces", exact: true }).click();
			await page.locator(".cloud-workspaces").waitFor();
			expect(new URL(page.url()).hash).toBe(CLOUD_ROUTE);
			expect(creates()).toHaveLength(1);
		});

		it("handles empty, failed/retry and unavailable chooser states without selecting a fallback", async () => {
			overview = emptyOverview();
			await open(width);
			const dialog = await openNew();
			overviewFailure = { code: "IO_ERROR", error: "Synthetic registry temporarily unavailable" };
			await dialog.getByLabel("directory source", { exact: true }).selectOption("project");
			await waitText(".modal [role=alert]", "No registry result is available. Retry to load choices.");
			expect(await dialog.getByLabel("linked project", { exact: true }).inputValue()).toBe("");
			expect(await dialog.getByRole("button", { name: "start session", exact: true }).isDisabled()).toBe(true);
			overviewFailure = undefined;
			await dialog.getByRole("button", { name: "retry linked projects", exact: true }).click();
			await waitText(".modal", "No linked projects are registered on this host.");
			expect(await dialog.getByRole("button", { name: "start session", exact: true }).isDisabled()).toBe(true);
			overviewFailure = { code: "IO_ERROR", error: LONG_ERROR };
			await dialog.getByRole("button", { name: "refresh linked projects", exact: true }).click();
			await waitText(".modal [role=alert]", "Could not load linked projects:");
			await expectLayout(".modal-backdrop", width <= 700);
			overviewFailure = undefined;
			overview = populatedOverview();
			await dialog.getByRole("button", { name: "retry linked projects", exact: true }).click();
			await dialog.getByRole("option", { name: new RegExp(`^${PROJECT}`) }).waitFor({ state: "attached" });
			expect(await dialog.getByRole("option", { name: new RegExp(`^${SECOND_PROJECT}`) }).isDisabled()).toBe(true);
			expect(await dialog.getByLabel("linked project", { exact: true }).inputValue()).toBe("");
			await dialog.getByLabel("linked project", { exact: true }).selectOption(PROJECT);
			await expectLayout(".modal-backdrop", width <= 700);
			overview.projects = overview.projects.map((p) => ({
				...p,
				status: { available: false, error: { code: "UNAVAILABLE", message: LONG_ERROR } },
			}));
			await dialog.getByRole("button", { name: "refresh linked projects", exact: true }).click();
			await waitText(".modal [role=alert]", `Selection cleared: linked project ${PROJECT} is unavailable`);
			expect(await dialog.getByLabel("linked project", { exact: true }).inputValue()).toBe("");
			expect(await dialog.getByRole("button", { name: "start session", exact: true }).isDisabled()).toBe(true);
			expect(creates()).toHaveLength(0);
			await expectLayout(".modal-backdrop", width <= 700);
		});

		it("keeps long selected identity, unavailable details and modal actions reachable", async () => {
			await open(width);
			const dialog = await openNew();
			await chooseProject(dialog);
			expect(await dialog.locator(".project-directory-identity").textContent()).toContain(PROJECT);
			expect(await dialog.locator(".project-directory-identity").textContent()).toContain(LONG_PATH);
			await expectLayout(".modal-backdrop", width <= 700);
			await expectModalActionsReachable(dialog);
		});

		it("resumes an unavailable Fleet disk record with exact sessionPath/projectId and navigates the returned parent", async () => {
			compactProjects();
			inventory = [{ ...unavailableSession(), cwd: "/synthetic-host/unavailable" }];
			await open(width);
			await page.locator(".disk-row").getByRole("button", { name: "resume", exact: true }).click();
			const dialog = page.getByRole("dialog", { name: "choose runtime directory", exact: true });
			await dialog.waitFor();
			expect(await dialog.textContent()).toContain("The original working directory is unavailable on this host.");
			expect(creates()).toHaveLength(0);
			await chooseProject(dialog);
			await expectLayout(".modal-backdrop", width <= 700);
			permitCreate = true;
			permitSession = true;
			await dialog.getByRole("button", { name: "resume session", exact: true }).click();
			await page.waitForFunction((hash) => location.hash === hash, `#/session/${CREATED}`);
			await page.locator(".session-screen").waitFor();
			expect(creates().map((c) => c.body)).toEqual([{ sessionPath: inventory[0].path, projectId: PROJECT }]);
			expect(calls.filter((c) => c.path === `/api/runtimes/${CREATED}/hydrate`)).toHaveLength(1);
			expect(await page.getByRole("dialog").count()).toBe(0);
		});
	});
}

it("isolates a managed directory dialog's number keys from a real SSE question in the retained Session view", async () => {
	compactProjects();
	await open(1024);
	permitSession = true;
	await page.locator(".session-card").getByRole("button", { name: "open", exact: true }).click();
	await page.locator(".session-screen").waitFor();
	await expect.poll(() => calls.filter((c) => c.path.endsWith("/hydrate")).length).toBe(1);
	// Closing the runtime normally clears questions. A late relayed request is
	// injected through the fixture's real reducer seam, not a custom store/DOM.
	runtimes = [];
	await emit({ type: "runtime_removed" });
	await page.getByRole("button", { name: "Choose directory…", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "choose runtime directory", exact: true });
	await dialog.waitFor();
	await emit({
		type: "extension_ui_request",
		id: "88888888-8888-4888-8888-888888888888",
		method: "ask",
		title: "Synthetic background question",
		questions: [{ question: "Which synthetic choice?", options: ["First", "Second"], allowFreeText: false }],
	});
	await page.locator(".ask-wizard").waitFor();
	const selected = page.locator(".ask-wizard input:checked");
	expect(await selected.count()).toBe(0);
	await dialog.getByRole("button", { name: "cancel", exact: true }).focus();
	await page.keyboard.press("1");
	expect(await selected.count()).toBe(0);
	expect(calls.filter((c) => c.path.includes("extension-ui-response"))).toHaveLength(0);
	expect(await dialog.isVisible()).toBe(true);
	await dialog.getByRole("button", { name: "cancel", exact: true }).click();
	await page.getByRole("button", { name: "Choose directory…", exact: true }).focus();
	await page.keyboard.press("1");
	await page.waitForFunction(() => document.querySelectorAll(".ask-wizard input:checked").length === 1);
	expect(await page.locator(".ask-wizard .ask-option.selected").textContent()).toContain("First");
});

it.each([1024, 390])("owns pending Resume focus and escaped question keys at %ipx", async (width) => {
	compactProjects();
	await open(width);
	permitSession = true;
	await page.locator(".session-card").getByRole("button", { name: "open", exact: true }).click();
	await page.locator(".session-screen").waitFor();
	await expect.poll(() => calls.filter((c) => c.path.endsWith("/hydrate")).length).toBe(1);
	runtimes = [];
	await emit({ type: "runtime_removed" });
	await page.getByRole("button", { name: "Choose directory…", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "choose runtime directory", exact: true });
	await dialog.waitFor();
	await chooseProject(dialog);
	await emit({
		type: "extension_ui_request",
		id: "88888888-8888-4888-8888-888888888888",
		method: "ask",
		title: "Synthetic background question",
		questions: [{ question: "Which synthetic choice?", options: ["First", "Second"], allowFreeText: false }],
	});
	await page.locator(".ask-wizard").waitFor();
	const selected = page.locator(".ask-wizard input:checked");
	expect(await selected.count()).toBe(0);
	permitCreate = true;
	createGate = gate();
	await dialog.getByRole("button", { name: "resume session", exact: true }).click();
	await expect.poll(() => creates().length).toBe(1);
	expect(await dialog.isVisible()).toBe(true);
	for (const button of await dialog.locator(".modal-actions button").all())
		expect(await button.isDisabled()).toBe(true);
	expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
	await page.keyboard.press("1");
	expect(await selected.count()).toBe(0);
	// A silent native blur does not emit focusin. The document guard must
	// still own keys even if some other DOM change sends focus back to body.
	await page.evaluate(() => (document.activeElement as HTMLElement).blur());
	expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
	await page.keyboard.press("1");
	expect(await selected.count()).toBe(0);
	expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
	await page.keyboard.press("Escape");
	await page.locator(".modal-backdrop").click({ position: { x: 1, y: 1 } });
	expect(await dialog.isVisible()).toBe(true);
	expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
	expect(creates().map((c) => c.body)).toEqual([
		{ projectId: PROJECT, sessionPath: `/synthetic-sessions/${SESSION}.jsonl` },
	]);
	expect(calls.filter((c) => c.path.includes("extension-ui-response"))).toHaveLength(0);
	createGate.release();
	await page.waitForFunction((hash) => location.hash === hash, `#/session/${CREATED}`);
	await dialog.waitFor({ state: "detached" });
	expect(creates()).toHaveLength(1);
});

it("contains long cloud rows, errors and the selected project identity at 320px", async () => {
	await open(320, CLOUD_ROUTE);
	await page.locator(".cloud-row").first().waitFor();
	overviewFailure = { code: "IO_ERROR", error: LONG_ERROR };
	await page.getByRole("button", { name: "Refresh metadata", exact: true }).click();
	await waitText("[role=alert]", LONG_ERROR);
	await expectLayout("body", true);
	overviewFailure = undefined;
	await page.getByRole("link", { name: "fleet", exact: true }).click();
	const dialog = await openNew();
	await chooseProject(dialog);
	await expectLayout(".modal-backdrop", true);
});
