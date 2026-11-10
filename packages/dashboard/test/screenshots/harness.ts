/**
 * README screenshot harness.
 *
 * Renders the real dashboard client, served by the real dashboard HTTP/SSE server,
 * against the fictional scenario in `scenario.ts`. Isolation is structural:
 *
 * - live sessions are fake RPC runtimes (`fixture-rpc-client.ts`) — no dreb child
 *   process, no model call, no API key;
 * - the server runs in-process with an injected runtime pool, session listing,
 *   memory home, and directory resolver — never the `dreb-dashboard` binary and
 *   never the real `~/.dreb`;
 * - `HOME` and `DREB_CODING_AGENT_DIR` point into a throwaway sandbox for the
 *   whole run and are restored afterwards;
 * - the browser may reach only the harness origin (plus Google Fonts for the
 *   default typeface in capture mode), and every rendered screen is scanned by the
 *   leak guard before it is written.
 *
 * Any deviation — a page error, an API error, an unimplemented RPC member, an
 * unexpected request, a missing selector, or a leak — fails the run.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@dreb/coding-agent";
import type { RpcClient } from "@dreb/coding-agent/rpc";
import { type Browser, type BrowserContext, chromium, type Page, type Request } from "playwright";
import { build as buildVite } from "vite";
import solid from "vite-plugin-solid";
import { DashboardAuth } from "../../src/server/auth.js";
import { RuntimePool } from "../../src/server/runtime-pool.js";
import { createDashboardServer, type DashboardServerApp } from "../../src/server/server.js";
import { createFixtureRpcClient, FixtureRpcFailures, fixtureControls } from "./fixture-rpc-client.js";
import { captureHostIdentity, findLeaks, type HostIdentity, type LeakNeedle, leakNeedles } from "./leak-guard.js";
import { collectRenderedSurface, fontState, fontsReady, seedAppearance, twoFrames } from "./page-scripts.js";
import { buildScenario, FIXTURE_DIRECTORIES, NOW_MS, type Scenario } from "./scenario.js";
import { toJsonl } from "./session-builder.js";
import { type ShotDefinition, shotViewport } from "./shots.js";

const DASHBOARD_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLIENT_ROOT = join(DASHBOARD_ROOT, "src/client");
const GOOGLE_FONT_ORIGINS = new Set(["https://fonts.googleapis.com", "https://fonts.gstatic.com"]);
const DEFAULT_FONT_FAMILY = "IBM Plex Mono";
/**
 * Chromium switches that remove rasterization variance (partial/threaded raster and
 * runtime-selected Skia paths can differ by one antialiasing step between runs).
 */
const DETERMINISTIC_CHROMIUM_ARGS = [
	"--disable-partial-raster",
	"--disable-skia-runtime-opts",
	"--force-color-profile=srgb",
	"--run-all-compositor-stages-before-draw",
	"--disable-checker-imaging",
	"--disable-threaded-animation",
	"--disable-threaded-scrolling",
	"--disable-lcd-text",
];
/** How long same-origin requests must stay idle before a screen counts as settled. */
const QUIET_MS = 400;
const READY_TIMEOUT_MS = 30_000;

export type FontMode =
	/** Load the Google-hosted default typeface and fail if it does not load (published captures). */
	| "network"
	/** Answer Google Fonts with an empty stylesheet so the run is fully offline (smoke tests). */
	| "stub";

export interface HarnessOptions {
	/** Directory the PNGs are written to (created if missing). */
	outDir: string;
	shots: readonly ShotDefinition[];
	fonts: FontMode;
	/**
	 * A client already built by {@link buildDashboardClient}. Omitted means build the
	 * current `src/client` into the sandbox for this run.
	 */
	clientDir?: string;
	/** Additional values the leak guard must reject (tests use this to prove the scan runs). */
	extraLeakNeedles?: LeakNeedle[];
	/** Progress lines; defaults to silent. */
	log?: (line: string) => void;
}

export interface CaptureResult {
	shot: ShotDefinition;
	path: string;
	width: number;
	height: number;
}

interface Sandbox {
	root: string;
	home: string;
	agentDir: string;
	sessionsDir: string;
	subagentDir: string;
	clientDir: string;
}

export class ScreenshotHarnessError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScreenshotHarnessError";
	}
}

async function dashboardVersion(): Promise<string> {
	const manifest = JSON.parse(await readFile(join(DASHBOARD_ROOT, "package.json"), "utf8")) as { version: string };
	return manifest.version;
}

async function createSandbox(): Promise<Sandbox> {
	const root = await mkdtemp(join(tmpdir(), "dreb-screenshots-"));
	const sandbox: Sandbox = {
		root,
		home: join(root, "home"),
		agentDir: join(root, "agent"),
		sessionsDir: join(root, "agent", "sessions"),
		subagentDir: join(root, "agent", "subagent-sessions"),
		clientDir: join(root, "client"),
	};
	await Promise.all([
		mkdir(sandbox.home, { recursive: true }),
		mkdir(sandbox.sessionsDir, { recursive: true }),
		mkdir(sandbox.subagentDir, { recursive: true }),
	]);
	return sandbox;
}

/** Write every scenario session as JSONL; returns a session-id → path lookup. */
async function materializeSessions(scenario: Scenario, sandbox: Sandbox): Promise<Map<string, string>> {
	const paths = new Map<string, string>();
	const write = async (dir: string, fixture: Scenario["past"][number]) => {
		if (paths.has(fixture.id)) throw new ScreenshotHarnessError(`Duplicate fixture session id ${fixture.id}`);
		const path = join(dir, fixture.fileName);
		paths.set(fixture.id, path);
		await writeFile(path, toJsonl(fixture));
	};
	for (const runtime of scenario.live) {
		await write(sandbox.sessionsDir, runtime.session);
		for (const agent of runtime.subagents) await write(sandbox.subagentDir, agent.session);
	}
	for (const past of scenario.past) await write(sandbox.sessionsDir, past);
	return paths;
}

/** Build the dashboard client from source (never a possibly stale `dist/`). */
export async function buildDashboardClient(outDir: string): Promise<void> {
	await buildVite({
		configFile: false,
		plugins: [solid()],
		root: CLIENT_ROOT,
		base: "./",
		logLevel: "error",
		build: { outDir, emptyOutDir: true },
	});
}

/** Environment overrides for the run; restored by the returned function. */
function isolateEnvironment(sandbox: Sandbox): () => void {
	const saved = {
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		DREB_CODING_AGENT_DIR: process.env.DREB_CODING_AGENT_DIR,
	};
	process.env.HOME = sandbox.home;
	process.env.USERPROFILE = sandbox.home;
	process.env.DREB_CODING_AGENT_DIR = sandbox.agentDir;
	return () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

interface RunningDashboard {
	baseUrl: string;
	runtimeKeys: Map<string, string>;
	/** Stream every runtime's scenario live events to connected browsers. */
	emitLiveEvents(): void;
	failures: FixtureRpcFailures;
	serverErrors: string[];
	close(): Promise<void>;
}

async function startDashboard(
	scenario: Scenario,
	sandbox: Sandbox,
	clientDir: string,
	paths: Map<string, string>,
): Promise<RunningDashboard> {
	const failures = new FixtureRpcFailures();
	const serverErrors: string[] = [];
	const version = await dashboardVersion();
	const sessionFile = (sessionId: string): string => {
		const path = paths.get(sessionId);
		if (!path) throw failures.record(`No materialized session file for ${sessionId}`);
		return path;
	};
	const runtimesBySessionFile = new Map(scenario.live.map((runtime) => [sessionFile(runtime.session.id), runtime]));
	let poolNow = NOW_MS;
	const pool = new RuntimePool({
		cliPath: "/screenshot-fixture/cli.js",
		now: () => poolNow,
		// The pool logs only degraded reads (unavailable state, stats, agents); each is a capture failure.
		logger: (line) => serverErrors.push(`runtime pool: ${line}`),
		clientFactory: ({ args }): RpcClient => {
			const sessionIndex = args.indexOf("--session");
			const binding =
				sessionIndex === -1
					? undefined
					: (() => {
							const runtime = runtimesBySessionFile.get(args[sessionIndex + 1]);
							if (!runtime) throw failures.record(`No scenario runtime for session ${args[sessionIndex + 1]}`);
							return { scenario: runtime, paths: { sessionFile } };
						})();
			return createFixtureRpcClient({ scenario, binding, version, failures });
		},
	});

	const runtimeKeys = new Map<string, string>();
	for (const runtime of scenario.live) {
		poolNow = runtime.createdAt;
		const handle = await pool.create(runtime.session.cwd, sessionFile(runtime.session.id));
		poolNow = runtime.lastActivity;
		fixtureControls(handle.client).replayLifecycle();
		runtimeKeys.set(runtime.slug, handle.key);
	}
	poolNow = NOW_MS;

	const available = new Set(FIXTURE_DIRECTORIES);
	const app: DashboardServerApp = createDashboardServer({
		auth: new DashboardAuth(),
		pool,
		staticDir: clientDir,
		listAllSessions: () => SessionManager.listAllMetadataFromDir(sandbox.sessionsDir),
		deleteSession: async () => {
			throw failures.record("Screenshot harness never deletes sessions");
		},
		renameSession: async () => {
			throw failures.record("Screenshot harness never renames sessions");
		},
		logger: () => {},
		serverVersion: version,
		memoryHomeDir: sandbox.home,
		resolveSessionDirectory: async (cwd) => {
			if (available.has(cwd)) return cwd;
			throw new Error(`Not a fixture project directory: ${cwd}`);
		},
	});
	const server = await new Promise<Server>((resolveServer, reject) => {
		const listening = app.listen(0, "127.0.0.1", () => resolveServer(listening));
		listening.once("error", reject);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new ScreenshotHarnessError("Dashboard screenshot server did not bind a TCP port");
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		runtimeKeys,
		emitLiveEvents() {
			for (const handle of pool.list()) fixtureControls(handle.client).emitLiveEvents();
		},
		failures,
		serverErrors,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((done) => server.close(() => done()));
			await app.closeDashboard();
			await pool.stopAll();
		},
	};
}

function routeHash(shot: ShotDefinition, runtimeKeys: Map<string, string>): string {
	const key = (slug: string) => {
		const found = runtimeKeys.get(slug);
		if (!found) throw new ScreenshotHarnessError(`Shot ${shot.name} references unknown runtime ${slug}`);
		return found;
	};
	switch (shot.route.screen) {
		case "fleet":
			return "#/";
		case "session":
			return `#/session/${key(shot.route.runtime)}`;
		case "subagent":
			return `#/session/${key(shot.route.runtime)}/subagent/${encodeURIComponent(shot.route.agentId)}`;
		case "settings":
			return "#/settings";
	}
}

/** Collects every browser-side problem for one shot. */
class PageProblems {
	readonly problems: string[] = [];
	private inFlight = new Set<Request>();
	private lastSettledAt = Date.now();

	constructor(
		private readonly page: Page,
		baseUrl: string,
	) {
		page.on("pageerror", (error) => this.problems.push(`page error: ${error.message}`));
		page.on("console", (message) => {
			if (message.type() === "error") this.problems.push(`console error: ${message.text()}`);
		});
		page.on("response", (response) => {
			if (response.url().startsWith(baseUrl) && response.status() >= 400) {
				this.problems.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
			}
		});
		const isTracked = (request: Request) =>
			request.url().startsWith(baseUrl) && !new URL(request.url()).pathname.startsWith("/api/events");
		page.on("request", (request) => {
			if (isTracked(request)) this.inFlight.add(request);
		});
		const settle = (request: Request) => {
			if (this.inFlight.delete(request)) this.lastSettledAt = Date.now();
		};
		page.on("requestfinished", settle);
		page.on("requestfailed", settle);
	}

	/** Wait until no tracked request has been in flight for {@link QUIET_MS}. */
	async waitForQuiet(): Promise<void> {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (this.inFlight.size === 0 && Date.now() - this.lastSettledAt >= QUIET_MS) return;
			await this.page.waitForTimeout(50);
		}
		throw new ScreenshotHarnessError(
			`Requests never settled: ${[...this.inFlight].map((request) => request.url()).join(", ")}`,
		);
	}
}

async function newShotContext(
	browser: Browser,
	shot: ShotDefinition,
	baseUrl: string,
	fonts: FontMode,
	blocked: string[],
): Promise<BrowserContext> {
	const viewport = shotViewport(shot);
	const context = await browser.newContext({
		viewport: { width: viewport.width, height: viewport.height },
		deviceScaleFactor: viewport.deviceScaleFactor,
		isMobile: viewport.isMobile,
		hasTouch: viewport.hasTouch,
		colorScheme: shot.colorMode,
		locale: "en-US",
		timezoneId: "UTC",
		reducedMotion: "reduce",
		serviceWorkers: "block",
	});
	await context.addInitScript(seedAppearance, { theme: shot.theme ?? null, colorMode: shot.colorMode });
	await context.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.origin === baseUrl) return route.continue();
		if (GOOGLE_FONT_ORIGINS.has(url.origin)) {
			if (fonts === "network") return route.continue();
			return route.fulfill({
				status: 200,
				contentType: "text/css",
				body: "/* fonts stubbed for offline capture */",
			});
		}
		blocked.push(url.href);
		return route.abort("blockedbyclient");
	});
	return context;
}

async function assertDefaultFontLoaded(page: Page): Promise<void> {
	const state = await page.evaluate(fontState, DEFAULT_FONT_FAMILY);
	if (state.usesFamily && !state.loaded) {
		throw new ScreenshotHarnessError(
			`${DEFAULT_FONT_FAMILY} did not load from Google Fonts — published screenshots need network access to fonts.googleapis.com and fonts.gstatic.com`,
		);
	}
}

async function captureShot(
	browser: Browser,
	dashboard: RunningDashboard,
	shot: ShotDefinition,
	options: HarnessOptions,
	needles: LeakNeedle[],
): Promise<CaptureResult> {
	const blocked: string[] = [];
	const context = await newShotContext(browser, shot, dashboard.baseUrl, options.fonts, blocked);
	try {
		const page = await context.newPage();
		await page.clock.setFixedTime(NOW_MS);
		const problems = new PageProblems(page, dashboard.baseUrl);
		await page.goto(`${dashboard.baseUrl}/${routeHash(shot, dashboard.runtimeKeys)}`, { waitUntil: "load" });
		const waitForAll = async (stage: string, selectors: readonly string[]) => {
			try {
				for (const selector of selectors) {
					await page.locator(selector).first().waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
				}
			} catch (cause) {
				const diagnostic = join(tmpdir(), `dreb-screenshot-failure-${shot.name}.png`);
				await page.screenshot({ path: diagnostic }).catch(() => {});
				throw new ScreenshotHarnessError(
					`Shot ${shot.name} never became ${stage} (${String(cause)}).\nProblems: ${JSON.stringify(problems.problems)}\nPage at failure: ${diagnostic}`,
				);
			}
		};
		await waitForAll("ready", shot.ready);
		await problems.waitForQuiet();
		if (shot.live) {
			dashboard.emitLiveEvents();
			await waitForAll("live", shot.live);
			await problems.waitForQuiet();
		}
		await shot.prepare?.(page);
		if (options.fonts === "network") await assertDefaultFontLoaded(page);
		else await page.evaluate(fontsReady);
		await problems.waitForQuiet();
		// Two frames so layout from the final scroll/state settles before capture.
		await page.evaluate(twoFrames);

		const issues = [
			...problems.problems,
			...blocked.map((url) => `blocked request to ${url}`),
			...dashboard.failures.messages,
			...dashboard.serverErrors,
		];
		if (issues.length > 0) {
			throw new ScreenshotHarnessError(`Shot ${shot.name} hit problems:\n- ${issues.join("\n- ")}`);
		}
		const leaks = findLeaks(await page.evaluate(collectRenderedSurface), needles);
		if (leaks.length > 0) {
			throw new ScreenshotHarnessError(
				`Shot ${shot.name} would publish host data:\n${leaks.map((leak) => `- ${leak.label}: …${leak.context}…`).join("\n")}`,
			);
		}
		const path = join(options.outDir, `${shot.name}.png`);
		await page.screenshot({ path, animations: "disabled", caret: "hide", scale: "device" });
		const viewport = shotViewport(shot);
		return {
			shot,
			path,
			width: viewport.width * viewport.deviceScaleFactor,
			height: viewport.height * viewport.deviceScaleFactor,
		};
	} finally {
		await context.close();
	}
}

/**
 * Render the requested shots into `options.outDir`. Rejects with a
 * {@link ScreenshotHarnessError} describing the first failing shot.
 */
export async function runScreenshotHarness(options: HarnessOptions): Promise<CaptureResult[]> {
	if (options.shots.length === 0) throw new ScreenshotHarnessError("No screenshots requested");
	const log = options.log ?? (() => {});
	const host: HostIdentity = captureHostIdentity();
	const sandbox = await createSandbox();
	const restoreEnvironment = isolateEnvironment(sandbox);
	let dashboard: RunningDashboard | undefined;
	let browser: Browser | undefined;
	try {
		const scenario = buildScenario();
		const paths = await materializeSessions(scenario, sandbox);
		let clientDir = options.clientDir;
		if (!clientDir) {
			log("building dashboard client…");
			clientDir = sandbox.clientDir;
			await buildDashboardClient(clientDir);
		}
		dashboard = await startDashboard(scenario, sandbox, clientDir, paths);
		const needles = [...leakNeedles(host, sandbox.root), ...(options.extraLeakNeedles ?? [])];
		await mkdir(resolve(options.outDir), { recursive: true });
		browser = await chromium.launch({ args: DETERMINISTIC_CHROMIUM_ARGS });
		const results: CaptureResult[] = [];
		for (const shot of options.shots) {
			const result = await captureShot(browser, dashboard, shot, options, needles);
			log(`captured ${result.path} (${result.width}×${result.height})`);
			results.push(result);
		}
		return results;
	} finally {
		await browser?.close();
		await dashboard?.close();
		restoreEnvironment();
		await rm(sandbox.root, { recursive: true, force: true });
	}
}
