/**
 * PWA static-serving tests — manifest + service worker are served correctly so
 * the dashboard is installable: manifest served with the right structure, the
 * service worker is served from a stable root-relative URL (never
 * content-hashed) so browsers can compare byte-for-byte, and the build-version
 * cacheName is present in the emitted sw.js.
 *
 * See `vite.config.ts` `versionServiceWorker()` for the build-time versioning.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardAuth } from "../src/server/auth.js";
import { RuntimePool } from "../src/server/runtime-pool.js";
import { createDashboardServer } from "../src/server/server.js";
import { makeFakeClient } from "./runtime-pool.test.js";

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function startStaticServer(staticDir: string): Promise<string> {
	const pool = new RuntimePool({
		cliPath: "/fake/cli.js",
		clientFactory: () => makeFakeClient(),
	});
	const app = createDashboardServer({
		auth: new DashboardAuth(),
		pool,
		listAllSessions: async () => [],
		deleteSession: async () => ({ method: "trash" }),
		staticDir,
	});
	const server = await new Promise<Server>((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	servers.push(server);
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	return `http://127.0.0.1:${address.port}`;
}

function fetchText(base: string, path: string): Promise<{ status: number; body: string; contentType: string }> {
	return new Promise((resolve, reject) => {
		const req = request(new URL(path, base), (res: IncomingMessage) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				body += chunk;
			});
			res.on("end", () =>
				resolve({ status: res.statusCode ?? 0, body, contentType: res.headers["content-type"] ?? "" }),
			);
		});
		req.on("error", reject);
		req.end();
	});
}

describe("dashboard PWA — manifest + service worker serving", () => {
	it("serves manifest.webmanifest with valid PWA structure", async () => {
		const staticDir = await mkdtemp(join(tmpdir(), "dreb-dash-pwa-"));
		tempDirs.push(staticDir);
		const manifest = {
			name: "dreb dashboard",
			short_name: "dreb",
			display: "standalone",
			start_url: ".",
			icons: [{ src: "icons/punk-192.png", sizes: "192x192", type: "image/png" }],
			theme_color: "#ffffff",
			background_color: "#ffffff",
		};
		await writeFile(join(staticDir, "index.html"), "<html><body>shell</body></html>");
		await writeFile(join(staticDir, "manifest.webmanifest"), JSON.stringify(manifest));
		await mkdir(join(staticDir, "icons"));
		await writeFile(join(staticDir, "icons", "punk-192.png"), Buffer.from("fake-png"));

		const base = await startStaticServer(staticDir);
		const res = await fetchText(base, "/manifest.webmanifest");

		expect(res.status).toBe(200);
		const parsed = JSON.parse(res.body) as Record<string, unknown>;
		expect(parsed.name).toBe("dreb dashboard");
		expect(parsed.display).toBe("standalone");
		const icons = parsed.icons as Array<Record<string, unknown>>;
		expect(icons.length).toBeGreaterThan(0);
		expect(icons.some((i) => i.sizes === "192x192")).toBe(true);
	});

	it("serves sw.js from a stable root URL with a build-version cache name", async () => {
		const staticDir = await mkdtemp(join(tmpdir(), "dreb-dash-pwa-"));
		tempDirs.push(staticDir);
		await writeFile(join(staticDir, "index.html"), "<html></html>");
		// Simulate the build-time-versioned sw.js the Vite plugin emits.
		await writeFile(
			join(staticDir, "sw.js"),
			'const SW_CACHE_VERSION = "2.35.0"; const SHELL = "dreb-dashboard-shell-v" + SW_CACHE_VERSION;',
		);

		const base = await startStaticServer(staticDir);
		const res = await fetchText(base, "/sw.js");

		expect(res.status).toBe(200);
		// The SW carries a concrete version, not the placeholder — that's what
		// invalidates stale clients on a new deploy.
		expect(res.body).toContain("2.35.0");
		expect(res.body).not.toContain("__SW_VERSION__");
		// JavaScript MIME so browsers accept it as a service worker script.
		expect(res.contentType).toContain("javascript");
	});

	it("serves icon assets referenced by the manifest", async () => {
		const staticDir = await mkdtemp(join(tmpdir(), "dreb-dash-pwa-"));
		tempDirs.push(staticDir);
		await writeFile(join(staticDir, "index.html"), "<html></html>");
		await mkdir(join(staticDir, "icons"));
		await writeFile(join(staticDir, "icons", "punk-192.png"), Buffer.from("fake-png"));
		await writeFile(join(staticDir, "icons", "punk-512.png"), Buffer.from("fake-png-512"));

		const base = await startStaticServer(staticDir);
		const res192 = await fetchText(base, "/icons/punk-192.png");
		const res512 = await fetchText(base, "/icons/punk-512.png");
		expect(res192.status).toBe(200);
		expect(res192.contentType).toContain("image/png");
		expect(res512.status).toBe(200);
	});

	it("preserves the committed manifest + sw.js from the real build output", async () => {
		// The built dist/static/ is the source of truth for what ships. Read the
		// committed artifacts directly and assert the invariants the Vite plugin
		// guarantees: manifest is valid, sw.js has a real version not the placeholder.
		const distStatic = join(import.meta.dirname, "..", "dist", "static");
		let manifestBody: string;
		let swBody: string;
		try {
			manifestBody = await readFile(join(distStatic, "manifest.webmanifest"), "utf8");
			swBody = await readFile(join(distStatic, "sw.js"), "utf8");
		} catch {
			// Build artifacts absent in this run (e.g. fresh checkout before
			// `npm run build`) — skip rather than fail.
			return;
		}
		const manifest = JSON.parse(manifestBody) as Record<string, unknown>;
		expect(manifest.display).toBe("standalone");
		expect((manifest.icons as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
		// Theme colors derive from tokens.css --bg (light #ffffff / dark #000000).
		// Regression guard: a prior review found background_color was a hardcoded
		// magenta that appeared nowhere in tokens.css; assert both fields stay
		// token-derived so a splash-screen color drift is caught here, not on a
		// user's device.
		expect(manifest.theme_color).toBe("#ffffff");
		expect(manifest.background_color).toBe("#ffffff");
		// Version baked by the build as a concrete string, not left as the placeholder.
		expect(swBody).toMatch(/SW_CACHE_VERSION = "[\w.-]+"/);
		expect(swBody).not.toContain("__SW_VERSION__");
	});
});
