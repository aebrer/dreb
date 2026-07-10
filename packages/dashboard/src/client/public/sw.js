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
	event.waitUntil(
		caches
			.open(SHELL_CACHE)
			.then((cache) => cache.addAll(SHELL_PRECACHE))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		Promise.all([
			// Drop caches from prior versions.
			caches.keys().then((keys) =>
				Promise.all(
					keys
						.filter((key) => key.startsWith("dreb-dashboard-") && key !== SHELL_CACHE)
						.map((key) => caches.delete(key)),
				),
			),
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

	// Navigations: network-first, fall back to cached index.html.
	if (req.mode === "navigate") {
		event.respondWith(
			fetch(req)
				.then((res) => {
					const copy = res.clone();
					caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
					return res;
				})
				.catch(() => caches.match(req).then((r) => r || caches.match("./"))),
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
			const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			if (allClients.length > 0) {
				const client = allClients[0];
				await client.focus();
				if (sessionKey) client.postMessage({ type: "navigate-session", sessionKey });
				return;
			}
			// No open dashboard — open one. The client reads a pending-navigation
			// hint from sessionStorage on load (see app.tsx).
			const url = sessionKey ? `./#session/${encodeURIComponent(sessionKey)}` : "./";
			await self.clients.openWindow(url);
		})(),
	);
});