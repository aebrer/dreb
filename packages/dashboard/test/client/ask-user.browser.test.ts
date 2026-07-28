import { type AddressInfo, createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { build as viteBuild } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let browser: Browser;
let server: Server;
let base: string;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

beforeAll(async () => {
	const bundle = await viteBuild({
		configFile: false,
		logLevel: "error",
		root,
		plugins: [solid()],
		build: {
			minify: false,
			write: false,
			rollupOptions: { input: resolve(root, "test/client/ask-user.browser-harness.tsx") },
		},
	});
	const outputs = Array.isArray(bundle) ? bundle.flatMap((item) => item.output) : bundle.output;
	const entry = outputs.find((item) => item.type === "chunk" && item.isEntry);
	if (!entry || entry.type !== "chunk") throw new Error("ask_user browser harness bundle has no entry chunk");
	const script = entry.code.replaceAll("</script", "<\\/script");
	server = createServer((_req, response) => {
		response.setHeader("content-type", "text/html; charset=utf-8");
		response.end(`<!doctype html><html><body><div id="app"></div><script>${script}</script></body></html>`);
	});
	await new Promise<void>((resolveStarted) => server.listen(0, "127.0.0.1", resolveStarted));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	if (server) await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
});

async function openHarness(): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
	page.setDefaultTimeout(2_000);
	await page.goto(base);
	await page.getByRole("heading", { name: /ask_user cross-surface interaction/ }).waitFor();
	return page;
}

function surface(page: Page, name: "dashboard" | "tui") {
	return page.getByTestId(`${name}-surface`);
}

describe("ask_user UX prototype", () => {
	it("shows equivalent single-choice, free-text, skip, and attention affordances", async () => {
		const page = await openHarness();
		for (const name of ["dashboard", "tui"] as const) {
			const panel = surface(page, name);
			expect(await panel.getByText("◆ needs attention").textContent()).toContain("needs attention");
			expect(await panel.getByRole("radio").count()).toBe(3);
			if (name === "dashboard") {
				expect(await panel.locator(".control-glyph").count()).toBe(0);
				expect(
					await panel
						.getByRole("radio")
						.first()
						.evaluate((input) => getComputedStyle(input).opacity),
				).toBe("1");
			} else {
				expect(await panel.locator(".control-glyph").count()).toBe(3);
			}
			await panel.getByText("SQLite", { exact: true }).click();
			await panel.getByLabel("Or type your own answer").fill("with WAL enabled");
			await panel.getByRole("button", { name: "Submit answer" }).click();
			const result = panel.getByRole("status");
			await result.waitFor();
			expect(await result.textContent()).toContain("SQLite; with WAL enabled");
			expect(await result.evaluate((output) => getComputedStyle(output).display)).toBe("block");
			expect(
				await result.evaluate((output) => {
					const input = output.previousElementSibling?.querySelector("input");
					return input ? output.getBoundingClientRect().top > input.getBoundingClientRect().bottom : false;
				}),
			).toBe(true);
		}
		await page.close();
	});

	it("combines multiple selections with custom text on both surfaces", async () => {
		const page = await openHarness();
		await page.getByRole("button", { name: "multiple choice" }).click();
		for (const name of ["dashboard", "tui"] as const) {
			const panel = surface(page, name);
			await panel.getByText("Unit tests", { exact: true }).click();
			await panel.getByText("Type checking", { exact: true }).click();
			await panel.getByLabel("Or type your own answer").fill("Run smoke tests too");
			await panel.getByRole("button", { name: "Submit answer" }).click();
			const result = await panel.getByRole("status").textContent();
			expect(result).toContain("Unit tests; Type checking; Run smoke tests too");
		}
		await page.close();
	});

	it("covers free-text, multiline, skip, timeout, and abort states", async () => {
		const page = await openHarness();

		await page.getByRole("button", { name: "free text" }).click();
		expect(await surface(page, "dashboard").getByLabel("Your answer").getAttribute("type")).toBe("text");

		await page.getByRole("button", { name: "multiline" }).click();
		expect(
			await surface(page, "tui")
				.getByLabel("Your answer")
				.evaluate((element) => element.tagName),
		).toBe("TEXTAREA");

		await surface(page, "dashboard").getByRole("button", { name: "Skip" }).click();
		expect(await surface(page, "dashboard").getByRole("status").textContent()).toContain("Question skipped");

		await page.getByRole("button", { name: "timeout" }).click();
		for (const name of ["dashboard", "tui"] as const) {
			expect(await surface(page, name).getByRole("status").textContent()).toContain("No answer received");
		}

		await page.getByRole("button", { name: "abort" }).click();
		for (const name of ["dashboard", "tui"] as const) {
			expect(await surface(page, name).getByRole("status").textContent()).toContain("Question cancelled");
		}
		await page.close();
	});

	it("maps Escape to the explicit safe skip route", async () => {
		const page = await openHarness();
		await page.keyboard.press("Escape");
		for (const name of ["dashboard", "tui"] as const) {
			expect(await surface(page, name).getByRole("status").textContent()).toContain("Question skipped");
		}
		await page.close();
	});
});
