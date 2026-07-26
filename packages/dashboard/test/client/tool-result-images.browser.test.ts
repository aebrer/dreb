import { type AddressInfo, createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { build as viteBuild } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let browser: Browser;
let server: Server;
let base: string;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);

beforeAll(async () => {
	const bundle = await viteBuild({
		configFile: false,
		logLevel: "error",
		root,
		plugins: [solid()],
		build: {
			minify: false,
			write: false,
			rollupOptions: { input: resolve(root, "test/client/tool-result-images.browser-harness.tsx") },
		},
	});
	const outputs = Array.isArray(bundle) ? bundle.flatMap((item) => item.output) : bundle.output;
	const entry = outputs.find((item) => item.type === "chunk" && item.isEntry);
	if (!entry || entry.type !== "chunk") throw new Error("Browser image harness bundle has no entry chunk");
	const script = entry.code.replaceAll("</script", "<\\/script");
	server = createServer((_req, res) => {
		res.setHeader("content-type", "text/html; charset=utf-8");
		res.end(`<!doctype html><html><body><main id="app"></main><script>${script}</script></body></html>`);
	});
	await new Promise<void>((resolveStarted) => server.listen(0, "127.0.0.1", resolveStarted));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	if (server) await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
});

async function open(mode: "placeholders" | "previews" | "originals", size?: number) {
	const page = await browser.newPage();
	const requests: string[] = [];
	await page.route("**/api/runtimes/**/images/**", async (route) => {
		requests.push(route.request().url());
		await route.fulfill({ status: 200, contentType: "image/png", body: png });
	});
	const query = new URLSearchParams({ mode });
	if (size !== undefined) query.set("size", String(size));
	await page.goto(`${base}/test/client/tool-result-images.browser.html?${query}`);
	await page.locator("details.tool").waitFor();
	return { page, requests };
}

describe("tool-result image browser requests", () => {
	it("placeholder mode makes no request before explicit preview loading", async () => {
		const { page, requests } = await open("placeholders");
		await page.locator(".tool-image-placeholder").waitFor();
		expect(requests).toEqual([]);
		await page.getByRole("button", { name: "load preview" }).click();
		await page.locator("img.tool-image").waitFor();
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("/preview");
		await page.close();
	});

	it("default preview and its lightbox never request the original", async () => {
		const { page, requests } = await open("previews");
		await page.locator("img.tool-image").waitFor();
		await page.getByRole("button", { name: "Enlarge image preview" }).click();
		await page.getByRole("dialog", { name: "Image preview" }).waitFor();
		expect(requests.length).toBeGreaterThanOrEqual(1);
		expect(requests.every((url) => url.endsWith("/preview"))).toBe(true);
		await page.close();
	});

	it("large explicit originals make no request when confirmation is cancelled", async () => {
		const { page, requests } = await open("previews", 2 * 1024 * 1024);
		await page.locator("img.tool-image").waitFor();
		page.once("dialog", (dialog) => dialog.dismiss());
		await page.getByRole("button", { name: /load original/ }).click();
		expect(requests.some((url) => url.endsWith("/original"))).toBe(false);
		page.once("dialog", (dialog) => dialog.accept());
		await page.getByRole("button", { name: /load original/ }).click();
		await page.locator('img.tool-image[src$="/original"]').waitFor();
		expect(requests.some((url) => url.endsWith("/original"))).toBe(true);
		await page.close();
	});

	it("automatic-original mode requests only the original", async () => {
		const { page, requests } = await open("originals", 2 * 1024 * 1024);
		await page.locator("img.tool-image").waitFor();
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("/original");
		await page.close();
	});

	it("surfaces failed preview requests without original fallback", async () => {
		const page = await browser.newPage();
		const requests: string[] = [];
		await page.route("**/api/runtimes/**/images/**", async (route) => {
			requests.push(route.request().url());
			await route.abort("failed");
		});
		await page.goto(`${base}/test/client/tool-result-images.browser.html?mode=previews`);
		await page.getByRole("alert").waitFor();
		expect(await page.getByRole("alert").textContent()).toContain("Could not load preview");
		expect(requests.every((url) => url.endsWith("/preview"))).toBe(true);
		await page.close();
	});
});
