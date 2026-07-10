/*
 * dreb dashboard service worker.
 *
 * Minimal scope: notification display + installability + a conservative
 * network-first shell cache. The dashboard is a live control surface (SSE +
 * RPC); there is no offline mode here — the cache only smooths cold loads and
 * degrades gracefully when the network is down, never pretends to be live.
 *
 * Versioning: the SW_CACHE_VERSION below is substituted at build time (Vite
 * `generateBundle`). A new deploy → new version → the old SW's `install`/
 * `activate` skipWaiting/clients.claim takes over, busting stale caches. The
 * SW file itself is served from a STABLE URL (never content-hashed) so
 * browsers can fetch the latest copy and compare byte-for-byte.
 */

// Replaced at build time; see vite.config.ts generateBundle hook.
const SW_CACHE_VERSION = "__SW_VERSION__";
const SHELL_CACHE = `dreb-dashboard-shell-v${SW_CACHE_VERSION}`;

// Shell assets (HTML, JS, CSS) get a network-first strategy. The dashboard
// has no value when disconnected from its host; we never serve stale content
// when the network is up. On network failure only, fall back to cache.
const SHELL_PRECACHE = [
	"./",
	"./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
	// Pre-cache entries individually so a single failed URL does not reject
	// the whole install (which would prevent skipWaiting/activation and leave
	// notifications + installability permanently unavailable with no error).
	// Degraded cache is acceptable; activation must proceed unconditionally —
	// so a CacheStorage failure at the top level (e.g. `caches.open` rejecting
	// under private browsing / quota exhaustion / storage corruption) is caught
	// here and skipWaiting still runs, keeping notifications + installability
	// available even when the precache store is unusable.
	event.waitUntil(
		caches
			.open(SHELL_CACHE)
			.then((cache) =>
				Promise.all(
					SHELL_PRECACHE.map((url) =>
						cache.add(url).catch((err) => {
							console.warn(`[sw] precache failed for ${url}:`, err);
						}),
					),
				),
			)
			.then(() => self.skipWaiting())
			.catch((err) => {
				console.error("[sw] install cache open failed, forcing activation:", err);
				return self.skipWaiting();
			}),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		Promise.all([
			// Drop caches from prior versions. Best-effort: a CacheStorage failure
			// here (e.g. private browsing) must not reject the activate event and
			// prevent clients.claim() from running — otherwise already-open tabs
			// stay controlled by the stale SW and never receive notifications from
			// the new version until a full reload.
			caches
				.keys()
				.then((keys) =>
					Promise.all(
						keys
							.filter((key) => key.startsWith("dreb-dashboard-") && key !== SHELL_CACHE)
							.map((key) => caches.delete(key)),
					),
				)
				.catch((err) => {
					console.error("[sw] cache cleanup failed:", err);
				}),
			self.clients.claim(),
		]),
	);
});

// Network-first for navigations and same-origin GETs. On network failure only,
// fall back to cache (so a brief blip doesn't blank the dashboard).
self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET") return;
	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return; // never touch cross-origin (e.g. fonts CDN)
	// The dashboard is a live control surface (SSE + RPC); API responses and
	// the infinite EventSource stream must NEVER be cached (caching them hangs
	// cache.put and serves stale data). Pass /api/* straight through to network.
	if (url.pathname.startsWith("/api/")) return;

	// Navigations: network-first, fall back to cached index.html.
	if (req.mode === "navigate") {
		event.respondWith(
			fetch(req)
				.then((res) => {
					// Only cache a successful navigation. A transient 4xx/5xx would
					// otherwise be stored as the offline shell and served on the next
					// disconnected visit, showing a broken cached error page instead of
					// the graceful 503 fallback below.
					if (res && res.ok) {
						const copy = res.clone();
						caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
					}
					return res;
				})
				.catch(() =>
				caches
					.match(req)
					.then((r) => r || caches.match("./"))
					.then((r) => r || new Response("Service unavailable", { status: 503, statusText: "Service Unavailable" })),
			),
		);
		return;
	}

	// Static assets: network-first, fall back to cache.
	event.respondWith(
		fetch(req)
			.then((res) => {
				if (res && res.status === 200 && res.type === "basic") {
					const copy = res.clone();
					caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
				}
				return res;
			})
			.catch(() => caches.match(req)),
	);
});

// Notification click: focus an open dashboard client and navigate it to the
// attention session, or open a new one. The session key is carried in the
// notification's `data.sessionKey` (set by app.tsx via registration.showNotification).
self.addEventListener("notificationclick", (event) => {
	const sessionKey = event.notification.data?.sessionKey;
	event.notification.close();
	event.waitUntil(
		(async () => {
			const url = sessionKey ? `./#session/${encodeURIComponent(sessionKey)}` : "./";
			try {
				const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
				if (allClients.length > 0) {
					const client = allClients[0];
					await client.focus();
					if (sessionKey) client.postMessage({ type: "navigate-session", sessionKey });
					return;
				}
				// No open dashboard — open one, routed to the session by the URL
				// hash. The fresh client parses window.location.hash on load
				// (see state/store.ts parseHash()); there is no sessionStorage
				// handoff. The hash encodes the session so a page opened without
				// an existing client still lands on the right route.
				await self.clients.openWindow(url);
			} catch (err) {
				// focus()/postMessage() can reject (e.g. client closed mid-focus).
				// The notification is already closed above, so without a fallback a
				// rejection would leave the user with no visible action.
				console.warn("[sw] notificationclick handler failed:", err);
				try {
					await self.clients.openWindow(url);
				} catch (fallbackErr) {
					// Total failure (e.g. popup blocked in a restricted context): the
					// notification is gone and no window opened. Surface a loud error
					// rather than silently swallowing it — there's no other signal.
					console.error("[sw] notificationclick openWindow fallback failed:", fallbackErr);
				}
			}
		})(),
	);
});