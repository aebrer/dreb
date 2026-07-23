/**
 * Mobile acceptance coverage for the SSE fleet snapshot path.
 *
 * This runs the source client through a programmatic Vite middleware server,
 * backed by the real dashboard HTTP/SSE server and RuntimePool. It deliberately
 * does not use the checked-in dashboard dist output.
 */

import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { RpcClient } from "@dreb/coding-agent/rpc";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DashboardAuth } from "../../src/server/auth.js";
import { RuntimePool } from "../../src/server/runtime-pool.js";
import { createDashboardServer } from "../../src/server/server.js";

interface RequestObservation {
	url: string;
	at: number;
}

interface FakeRuntimeClient {
	client: RpcClient;
	emit(event: Record<string, unknown>): void;
	readonly dashboardSnapshots: number;
}

function sessionState(streaming = false) {
	return {
		sessionId: "mobile-acceptance-session",
		sessionName: "mobile acceptance session",
		tasks: [],
		thinkingLevel: "medium",
		isStreaming: streaming,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
		model: { provider: "test", id: "mobile-model" },
	};
}

function makeFakeRuntimeClient(): FakeRuntimeClient {
	const events = new EventEmitter();
	let streaming = false;
	let dashboardSnapshots = 0;
	const emit = (event: Record<string, unknown>) => {
		if (event.type === "agent_start") streaming = true;
		if (event.type === "agent_end") streaming = false;
		events.emit("event", event);
	};
	const client = {
		start: async () => {},
		stop: async () => {},
		onEvent: (listener: (event: unknown) => void) => {
			events.on("event", listener);
			return () => events.off("event", listener);
		},
		onExit: (listener: (info: unknown) => void) => {
			events.on("exit", listener);
			return () => events.off("exit", listener);
		},
		getState: async () => sessionState(streaming),
		getDashboardSnapshot: async () => {
			dashboardSnapshots += 1;
			const snapshotId = `mobile-snapshot-${dashboardSnapshots}`;
			emit({ type: "dashboard_snapshot_barrier", snapshotId });
			return { snapshotId, state: sessionState(streaming), messages: [], backgroundAgents: [] };
		},
		getMessages: async () => [],
		getSessionStats: async () => ({
			sessionFile: undefined,
			sessionId: "mobile-acceptance-session",
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		}),
		getLastAssistantText: async () => undefined,
		listBackgroundAgents: async () => [],
		getPerformanceStats: async () => ({}),
		getGitBranch: async () => null,
		getDailyCost: async () => 0,
		getCommands: async () => [],
		getPendingMessages: async () => ({ steering: [], followUp: [] }),
	};
	return {
		client: client as unknown as RpcClient,
		emit,
		get dashboardSnapshots() {
			return dashboardSnapshots;
		},
	};
}

let vite: ViteDevServer | undefined;
let httpServer: Server | undefined;
let pool: RuntimePool | undefined;
let sessionClient: FakeRuntimeClient;
let baseUrl: string;
let runtimeKey: string;
let fleetSnapshots = 0;

beforeAll(async () => {
	sessionClient = makeFakeRuntimeClient();
	let clientFactoryCalls = 0;
	pool = new RuntimePool({
		cliPath: "/fake/cli.js",
		clientFactory: () => {
			clientFactoryCalls += 1;
			// Session mount asks the server for daily cost, which creates a hidden
			// utility runtime. Keep that client separate from the observed session.
			return clientFactoryCalls === 1 ? sessionClient.client : makeFakeRuntimeClient().client;
		},
		logger: () => {},
	});
	pool.onFleetSnapshot(() => {
		fleetSnapshots += 1;
	});
	const handle = await pool.create("/tmp/dashboard-mobile-acceptance");
	runtimeKey = handle.key;

	vite = await createViteServer({
		configFile: fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
		appType: "spa",
		logLevel: "error",
		server: { hmr: false, middlewareMode: true },
	});
	const app = createDashboardServer({
		auth: new DashboardAuth(),
		pool,
		listAllSessions: async () => [],
		deleteSession: async () => ({ method: "trash" }),
		logger: () => {},
	});
	// Vite is mounted after the dashboard API so browser traffic reaches the real
	// HTTP/SSE implementation while client modules are compiled from source.
	app.use(vite.middlewares);
	httpServer = await new Promise<Server>((resolve) => {
		const server = app.listen(0, "127.0.0.1", () => resolve(server));
	});
	const address = httpServer.address();
	if (address === null || typeof address === "string")
		throw new Error("dashboard test server did not bind a TCP port");
	baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
	await pool?.stopAll();
	if (httpServer?.listening) await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
	await vite?.close();
}, 60_000);

describe("mobile fleet SSE snapshots in a throttled real browser", () => {
	it("updates an existing card without a fleet poll and hydrates a drill-in atomically", async () => {
		const browser: Browser = await chromium.launch();
		let context: BrowserContext | undefined;
		try {
			context = await browser.newContext({
				viewport: { width: 390, height: 844 },
				deviceScaleFactor: 2,
				isMobile: true,
				hasTouch: true,
			});
			const page: Page = await context.newPage();
			const cdp = await context.newCDPSession(page);
			await cdp.send("Network.enable");
			// CDP's optional packetLoss setting applies to WebRTC, not HTTP/SSE, so
			// it is intentionally omitted rather than claiming unreliable coverage.
			await cdp.send("Network.emulateNetworkConditions", {
				offline: false,
				latency: 100,
				downloadThroughput: 1_500_000 / 8,
				uploadThroughput: 1_500_000 / 8,
				connectionType: "cellular3g",
			});

			const requests: RequestObservation[] = [];
			page.on("request", (request) => {
				const url = new URL(request.url());
				if (url.origin === baseUrl && url.pathname.startsWith("/api/")) {
					// Deliberately retain only routing/timing metadata, never request payloads.
					requests.push({ url: `${url.pathname}${url.search}`, at: Date.now() });
				}
			});

			await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
			const card = page.locator("article.session-card");
			await card.waitFor({ state: "visible", timeout: 10_000 });
			expect(await card.textContent()).toContain("mobile acceptance session");
			await page.locator(".connection-indicator .chip-idle").waitFor({ state: "visible", timeout: 10_000 });
			expect(requests.filter((request) => request.url === "/api/fleet")).toHaveLength(1);
			await card.locator(".chip-idle").waitFor({ state: "visible" });

			const fleetSnapshotsBeforeLifecycle = fleetSnapshots;
			const lifecycleStartedAt = Date.now();
			sessionClient.emit({
				type: "agent_start",
				model: { provider: "test", id: "mobile-model" },
			});
			await card.locator(".chip-running").waitFor({ state: "visible", timeout: 2_000 });
			expect(Date.now() - lifecycleStartedAt).toBeLessThanOrEqual(2_000);
			expect(fleetSnapshots).toBeGreaterThan(fleetSnapshotsBeforeLifecycle);
			expect(requests.filter((request) => request.url === "/api/fleet")).toHaveLength(1);

			const requestCountBeforeOpen = requests.length;
			const hydratePath = `/api/runtimes/${runtimeKey}/hydrate`;
			const hydrateResponse = page.waitForResponse(
				(response) => new URL(response.url()).pathname === hydratePath && response.status() === 200,
			);
			await card.getByRole("button", { name: "open" }).click();
			await hydrateResponse;
			await page.waitForFunction((key) => window.location.hash === `#/session/${key}`, runtimeKey, {
				timeout: 10_000,
			});
			await page.locator("textarea[placeholder^='Message dreb']").waitFor({ state: "visible", timeout: 10_000 });
			// Let the session screen's independent details requests start before
			// asserting its hydration route inventory.
			await page.waitForTimeout(400);

			const drillInRequests = requests.slice(requestCountBeforeOpen);
			expect(drillInRequests.filter((request) => request.url === hydratePath)).toHaveLength(1);
			expect(sessionClient.dashboardSnapshots).toBe(1);
			const oldHydrationRoutes = [
				`/api/runtimes/${runtimeKey}`,
				`/api/runtimes/${runtimeKey}/messages`,
				`/api/runtimes/${runtimeKey}/background-agents`,
			];
			expect(drillInRequests.filter((request) => oldHydrationRoutes.includes(request.url))).toEqual([]);
			// Captured observations intentionally have URL + timestamp only.
			expect(drillInRequests.every((request) => typeof request.at === "number")).toBe(true);
		} finally {
			await context?.close();
			await browser.close();
		}
	}, 30_000);
});
