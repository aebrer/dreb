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

	it("A4: when the openWindow fallback also rejects, logs a loud error (no unhandled rejection)", async () => {
		const env = loadSW();
		// No open clients → primary path calls openWindow; make it reject to hit
		// the inner catch. The notification is already closed, so the only signal
		// is the console.error — assert it fires and the IIFE doesn't reject.
		env.self.clients.openWindow.mockRejectedValue(new Error("popup blocked"));
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		// No open clients → primary openWindow; make it reject so the inner catch
		// runs. The IIFE must resolve (not reject) — clickNotification awaits
		// waitPromise, so an unhandled rejection would surface here as a throw.
		const result = await clickNotification(env, "sess-2", []);

		expect(result).toBeDefined(); // reached without throwing
		// openWindow is called twice: once in the primary no-clients path, then
		// retried in the catch fallback. Both reject; the inner catch logs loudly
		// and the IIFE resolves (no unhandled rejection).
		expect(env.self.clients.openWindow).toHaveBeenCalledTimes(2);
		expect(errSpy).toHaveBeenCalledWith(
			expect.stringContaining("notificationclick openWindow fallback failed"),
			expect.any(Error),
		);
		errSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

describe("sw install handler", () => {
	// The install handler precaches each SHELL_PRECACHE entry individually and
	// catches per-URL failures, then ALWAYS calls skipWaiting — so one missing
	// asset degrades the cache but never blocks activation (which would leave
	// notifications + installability permanently unavailable with no error).
	function fireInstall(env: ReturnType<typeof loadSW>): Promise<any> | undefined {
		let waitPromise: Promise<any> | undefined;
		const event = {
			waitUntil: vi.fn((p: Promise<any>) => {
				waitPromise = p;
			}),
		};
		env.handlers.install[0](event);
		return waitPromise;
	}

	it("C1: precaches every shell entry and calls skipWaiting on success", async () => {
		const env = loadSW();
		const wait = fireInstall(env);
		await wait;

		// SHELL_PRECACHE = ["./", "./manifest.webmanifest"] — both add()ed.
		expect(env.cache.add).toHaveBeenCalledTimes(2);
		expect(env.cache.add.mock.calls.map((c) => c[0])).toEqual(["./", "./manifest.webmanifest"]);
		expect(env.self.skipWaiting).toHaveBeenCalledTimes(1);
	});

	it("C2: a single failed precache URL still activates (skipWaiting called, no install rejection)", async () => {
		const env = loadSW();
		// Make the manifest precache reject; the install must not reject and
		// skipWaiting must still run (degraded cache, activation proceeds).
		env.cache.add.mockImplementation(async (url: string) => {
			if (url === "./manifest.webmanifest") throw new Error("404 manifest");
			return undefined;
		});

		const wait = fireInstall(env);
		// Install resolves despite the per-URL failure (the rejection assertion
		// below would throw if the install Promise.all rejected instead).
		await expect(wait).resolves.toBeUndefined();
		expect(env.cache.add).toHaveBeenCalledTimes(2);
		expect(env.self.skipWaiting).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

describe("sw activate handler", () => {
	// The activate handler drops every dreb-dashboard-* cache except the current
	// SHELL_CACHE, then calls clients.claim() so a newly-activated SW controls
	// already-open tabs (without claim, notifications from the new SW version
	// wouldn't work on stale tabs until a reload).
	function fireActivate(env: ReturnType<typeof loadSW>): Promise<any> | undefined {
		let waitPromise: Promise<any> | undefined;
		const event = {
			waitUntil: vi.fn((p: Promise<any>) => {
				waitPromise = p;
			}),
		};
		env.handlers.activate[0](event);
		return waitPromise;
	}

	it("D1: deletes old dreb-dashboard-* caches but preserves the current one", async () => {
		const env = loadSW();
		// SHELL_CACHE in tests is `dreb-dashboard-shell-v__SW_VERSION__` (the
		// placeholder — sw.js is loaded as source, not the build-substituted copy).
		const currentShell = "dreb-dashboard-shell-v__SW_VERSION__";
		env.caches.keys.mockResolvedValue([
			currentShell, // current — must NOT be deleted
			"dreb-dashboard-shell-vold", // prior version — must be deleted
			"unrelated-cache", // foreign — must NOT be deleted
		]);

		await fireActivate(env);

		expect(env.caches.delete).toHaveBeenCalledTimes(1);
		expect(env.caches.delete).toHaveBeenCalledWith("dreb-dashboard-shell-vold");
		expect(env.caches.delete).not.toHaveBeenCalledWith(currentShell);
		expect(env.caches.delete).not.toHaveBeenCalledWith("unrelated-cache");
	});

	it("D2: calls clients.claim() so a new SW controls already-open tabs", async () => {
		const env = loadSW();
		env.caches.keys.mockResolvedValue([]);
		await fireActivate(env);
		expect(env.self.clients.claim).toHaveBeenCalledTimes(1);
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
		// The fallback chain must CONSULT the cache before falling through to 503 —
		// a regression that skips caches.match (e.g. a bare .catch(() => 503))
		// would still pass the status assertion above but break offline fallback.
		expect(env.caches.match).toHaveBeenCalled();
	});

	it("B6: a navigation that fails with no cached request but a cached index serves the index (middle fallback)", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("network down");
		});
		const env = loadSW({ fetchImpl });
		const indexRes = new Response("<html>cached shell</html>", { status: 200 });
		// caches.match(req) → undefined (request not cached); caches.match("./")
		// → the cached index. The chain falls through to the index, not 503.
		env.caches.match.mockImplementation(async (key: any) =>
			key === "./" || key?.url === "https://dashboard.test/" ? undefined : indexRes,
		);
		// The navigation handler calls caches.match(req) first (the Request), then
		// caches.match("./"). Make the Request match resolve undefined and "./"
		// resolve the cached index.
		env.caches.match.mockImplementation(async (key: any) => {
			if (typeof key === "string" && key === "./") return indexRes;
			return undefined; // the Request object lookup
		});

		const { event } = makeFetchEvent({ method: "GET", url: "https://dashboard.test/", mode: "navigate" });
		env.handlers.fetch[0](event);

		const res = await event.respondWith.mock.calls[0][0];
		expect(res).toBe(indexRes);
		expect(res.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// fetch — static assets (non-navigation)
// ---------------------------------------------------------------------------

describe("sw fetch handler — static assets", () => {
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

	it("E1: a 200 basic same-origin asset is cached and returned", async () => {
		// A real browser fetch of a same-origin asset yields type "basic"; Node's
		// `new Response()` yields "default", so override to model the browser
		// faithfully (the SW guard is `res.type === "basic"`).
		const assetRes = new Response("body()", { status: 200, headers: { "content-type": "text/javascript" } });
		Object.defineProperty(assetRes, "type", { value: "basic" });
		const fetchImpl = vi.fn(async () => assetRes);
		const env = loadSW({ fetchImpl });
		const { event } = makeFetchEvent({ method: "GET", url: "https://dashboard.test/assets/app.js", mode: "cors" });
		env.handlers.fetch[0](event);

		const res = await event.respondWith.mock.calls[0][0];
		expect(res).toBe(assetRes);
		await Promise.resolve();
		await Promise.resolve();
		expect(env.cache.put).toHaveBeenCalledTimes(1);
	});

	it("E2: a 404 asset is NOT cached (the 200+basic guard prevents caching error responses)", async () => {
		const notFound = new Response("not found", { status: 404 });
		const fetchImpl = vi.fn(async () => notFound);
		const env = loadSW({ fetchImpl });
		const { event } = makeFetchEvent({
			method: "GET",
			url: "https://dashboard.test/assets/missing.js",
			mode: "cors",
		});
		env.handlers.fetch[0](event);

		const res = await event.respondWith.mock.calls[0][0];
		expect(res).toBe(notFound); // still returned to the page, just not cached
		await Promise.resolve();
		await Promise.resolve();
		expect(env.cache.put).not.toHaveBeenCalled();
	});

	it("E3: a non-basic (opaque) 200 response is NOT cached (type === 'basic' guard)", async () => {
		const opaque = new Response("", { status: 200 });
		Object.defineProperty(opaque, "type", { value: "opaque" });
		const fetchImpl = vi.fn(async () => opaque);
		const env = loadSW({ fetchImpl });
		const { event } = makeFetchEvent({ method: "GET", url: "https://dashboard.test/assets/opaque.js", mode: "cors" });
		env.handlers.fetch[0](event);

		await event.respondWith.mock.calls[0][0];
		await Promise.resolve();
		await Promise.resolve();
		expect(env.cache.put).not.toHaveBeenCalled();
	});

	it("E4: on network failure falls back to caches.match(req) — no 503 terminal (unlike navigations)", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("network down");
		});
		const env = loadSW({ fetchImpl });
		const cachedAsset = new Response("cached", { status: 200 });
		// caches.match(req) → the cached asset. The static branch returns it
		// directly; there is no caches.match("./") or 503 fallback here.
		env.caches.match.mockResolvedValue(cachedAsset);

		const { event } = makeFetchEvent({ method: "GET", url: "https://dashboard.test/assets/app.js", mode: "cors" });
		env.handlers.fetch[0](event);

		const res = await event.respondWith.mock.calls[0][0];
		expect(res).toBe(cachedAsset);
		expect(env.caches.match).toHaveBeenCalledTimes(1);
		// Confirm the static branch did NOT fabricate a 503 — the cached asset is
		// served verbatim. (caches.match returning undefined would yield undefined,
		// which is a separate edge the navigation branch's 503 guards against.)
		expect(res.status).toBe(200);
	});
});
