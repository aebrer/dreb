/**
 * Service-worker handler tests — isolated in the default Node environment
 * (no jsdom). The service worker (`src/client/public/sw.js`) is plain browser
 * JS, not a module, and references the `self`/`caches`/`fetch` globals. We load
 * the file textually, evaluate it inside a `vm` context against a minimal
 * stub of those globals (capturing the `notificationclick`/`fetch`/`install`/
 * `activate` listeners registered via `self.addEventListener`), then drive the
 * captured handlers and assert on the stub interactions.
 *
 * Covers:
 *   - notificationclick: focus+postMessage for open clients, openWindow
 *     fallback (no client, and focus() rejection).
 *   - fetch: /api/* and cross-origin pass-through (respondWith never called),
 *     navigation network-first + caching, and the 503 terminal fallback when
 *     the network is down and the cache is empty.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SW_PATH = resolve(__dirname, "../src/client/public/sw.js");
const SW_SOURCE = readFileSync(SW_PATH, "utf-8");

/**
 * Evaluate sw.js against a fresh stub environment and return the captured
 * event handlers plus the stub objects (so tests can configure mock return
 * values and assert on calls). Each call yields an independent environment.
 */
function loadSW(overrides: { fetchImpl?: (...a: any[]) => any } = {}): {
	handlers: Record<string, Array<(e: any) => void>>;
	self: any;
	caches: any;
	fetch: (...a: any[]) => any;
	cache: { add: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; match: ReturnType<typeof vi.fn> };
} {
	const handlers: Record<string, Array<(e: any) => void>> = {};

	// A single shared cache object so we can assert on cache.put across calls.
	const cache = {
		add: vi.fn(async (_url: string) => {}),
		put: vi.fn(async (_req: any, _res: any) => {}),
		match: vi.fn(async (_req: any) => undefined),
	};

	const clients = {
		matchAll: vi.fn(async () => [] as any[]),
		openWindow: vi.fn(async (_url: string) => ({})),
		claim: vi.fn(async () => {}),
	};

	const self: any = {
		location: { origin: "https://dashboard.test" },
		addEventListener: vi.fn((type: string, handler: (e: any) => void) => {
			handlers[type] ??= [];
			handlers[type].push(handler);
		}),
		skipWaiting: vi.fn(async () => {}),
		clients,
	};

	const caches: any = {
		open: vi.fn(async () => cache),
		keys: vi.fn(async () => [] as string[]),
		delete: vi.fn(async (_key: string) => true),
		match: vi.fn(async (_req: any) => undefined),
	};

	const fetch = overrides.fetchImpl ?? vi.fn(async () => new Response("ok", { status: 200 }));

	const ctx = createContext({
		self,
		caches,
		fetch,
		// Node-globals (not V8 built-ins) the SW references — expose explicitly.
		URL,
		Response,
		Request,
		console,
	});
	runInContext(SW_SOURCE, ctx, { filename: "sw.js" });

	return { handlers, self, caches, fetch, cache };
}

beforeEach(() => {
	// Each test builds its own stub environment inside loadSW(); nothing global
	// to reset. (Placeholder for symmetry with the other test files.)
});

// ---------------------------------------------------------------------------
// notificationclick
// ---------------------------------------------------------------------------

describe("sw notificationclick handler", () => {
	async function clickNotification(
		env: ReturnType<typeof loadSW>,
		sessionKey: string | undefined,
		matchAllClients: any[],
	) {
		env.self.clients.matchAll.mockResolvedValue(matchAllClients);
		const close = vi.fn();
		let waitPromise: Promise<any> | undefined;
		const event = {
			notification: { data: sessionKey != null ? { sessionKey } : {}, close },
			waitUntil: vi.fn((p: Promise<any>) => {
				waitPromise = p;
			}),
		};
		env.handlers.notificationclick[0](event);
		// Flush the async IIFE the SW passes to event.waitUntil.
		await waitPromise;
		return { close };
	}

	it("A1: focuses an open client and posts a navigate-session message", async () => {
		const env = loadSW();
		const focus = vi.fn(async () => {});
		const postMessage = vi.fn();
		const { close } = await clickNotification(env, "sess-1", [{ focus, postMessage }]);

		expect(env.self.clients.matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
		expect(focus).toHaveBeenCalledTimes(1);
		expect(postMessage).toHaveBeenCalledWith({ type: "navigate-session", sessionKey: "sess-1" });
		expect(env.self.clients.openWindow).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("A2: with no open client, openWindow is called with the encoded session URL", async () => {
		const env = loadSW();
		await clickNotification(env, "a b/1", []);

		expect(env.self.clients.openWindow).toHaveBeenCalledTimes(1);
		const url = env.self.clients.openWindow.mock.calls[0][0] as string;
		// encodeURIComponent("a b/1") === "a%20b%2F1"
		expect(url).toBe("./#session/a%20b%2F1");
	});

	it("A3: falls back to openWindow when focus() throws", async () => {
		const env = loadSW();
		const focus = vi.fn(async () => {
			throw new Error("focus rejected");
		});
		const postMessage = vi.fn();
		await clickNotification(env, "sess-1", [{ focus, postMessage }]);

		// focus attempted, threw, and the catch branch opened a new window.
		expect(focus).toHaveBeenCalledTimes(1);
		expect(env.self.clients.openWindow).toHaveBeenCalledTimes(1);
		expect(env.self.clients.openWindow.mock.calls[0][0]).toBe("./#session/sess-1");
	});
});

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

describe("sw fetch handler", () => {
	function makeFetchEvent(req: any) {
		let respondPromise: Promise<any> | undefined;
		const event = {
			request: req,
			respondWith: vi.fn((p: Promise<any>) => {
				respondPromise = p;
			}),
			waitUntil: vi.fn(),
		};
		return { event, respondWith: () => respondPromise };
	}

	it("B1: a same-origin GET to /api/events (SSE) is passed through (respondWith NOT called)", async () => {
		const env = loadSW();
		const { event } = makeFetchEvent({ method: "GET", url: "https://dashboard.test/api/events", mode: "cors" });
		env.handlers.fetch[0](event);
		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it("B2: a same-origin GET to /api/fleet is passed through (respondWith NOT called)", async () => {
		const env = loadSW();
		const { event } = makeFetchEvent({ method: "GET", url: "https://dashboard.test/api/fleet", mode: "cors" });
		env.handlers.fetch[0](event);
		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it("B3: a cross-origin GET is passed through (respondWith NOT called)", async () => {
		const env = loadSW();
		const { event } = makeFetchEvent({ method: "GET", url: "https://fonts.cdn.test/font.woff2", mode: "cors" });
		env.handlers.fetch[0](event);
		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it("B4: a navigation that succeeds responds with the 200 network response and caches it", async () => {
		const networkRes = new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
		const fetchImpl = vi.fn(async () => networkRes);
		const env = loadSW({ fetchImpl });
		const { event } = makeFetchEvent({ method: "GET", url: "https://dashboard.test/", mode: "navigate" });
		env.handlers.fetch[0](event);

		expect(event.respondWith).toHaveBeenCalledTimes(1);
		const res = await event.respondWith.mock.calls[0][0];
		expect(res).toBe(networkRes);
		expect(res.status).toBe(200);

		// The handler caches a clone of the response. Flush the async cache.put chain.
		await Promise.resolve();
		await Promise.resolve();
		expect(env.cache.put).toHaveBeenCalledTimes(1);
		const [putReq, putRes] = env.cache.put.mock.calls[0];
		expect(putReq.url).toBe("https://dashboard.test/");
		expect(putRes).not.toBe(networkRes); // a clone, not the same instance
		expect(putRes.status).toBe(200);
	});

	it("B5: a navigation that fails with an empty cache responds with 503 (never undefined)", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("network down");
		});
		const env = loadSW({ fetchImpl });
		// caches.match resolves undefined (no cached index, no cached request).
		env.caches.match.mockResolvedValue(undefined);

		const { event } = makeFetchEvent({ method: "GET", url: "https://dashboard.test/", mode: "navigate" });
		env.handlers.fetch[0](event);

		expect(event.respondWith).toHaveBeenCalledTimes(1);
		const res = await event.respondWith.mock.calls[0][0];
		expect(res).toBeInstanceOf(Response);
		expect(res.status).toBe(503);
	});
});
