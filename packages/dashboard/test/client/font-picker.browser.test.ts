import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const catalog: {
	id: string;
	label: string;
	family: string;
	faces: { file: string; style: string; weight: string; bytes: number }[];
}[] = JSON.parse(readFileSync(new URL("../../src/client/assets/fonts/expanded/catalog.json", import.meta.url), "utf8"));
let vite: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let baseUrl: string;
let requests: string[];
const fixture = "/test/client/fixtures/font-picker.html";
const trigger = () => page.locator("#pref-font");

beforeAll(async () => {
	vite = await createServer({
		root: fileURLToPath(new URL("../..", import.meta.url)),
		plugins: [solid({ include: [/src\/client\/.*\.[jt]sx$/, /test\/client\/fixtures\/.*\.tsx$/] })],
		logLevel: "error",
		optimizeDeps: { noDiscovery: true },
		server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
	});
	await vite.listen();
	const address = vite.httpServer!.address();
	if (!address || typeof address === "string") throw new Error("font fixture server did not bind");
	baseUrl = `http://127.0.0.1:${address.port}`;
	browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
	await browser?.close();
	await vite?.close();
});
beforeEach(async () => {
	context = await browser.newContext({ viewport: { width: 1024, height: 800 } });
	// Keep tests offline; IBM's pre-existing remote hosting is not changed here.
	await context.route("https://fonts.googleapis.com/**", (route) =>
		route.fulfill({ contentType: "text/css", body: "" }),
	);
	await context.route("https://fonts.gstatic.com/**", (route) => route.abort());
	page = await context.newPage();
	requests = [];
	page.on("request", (request) => {
		if (request.url().includes(".woff2")) requests.push(request.url());
	});
	await page.goto(baseUrl + fixture, { waitUntil: "networkidle", timeout: 60_000 });
	await trigger().waitFor();
}, 90_000);
afterEach(async () => {
	await context?.close();
});

async function waitForPreview(id: string, family: string): Promise<void> {
	const option = page.locator(`[data-font-option="${id}"]`);
	await option.scrollIntoViewIfNeeded();
	await page.waitForFunction(
		({ id, family }) => {
			const element = document.querySelector(`[data-font-option="${id}"]`)!;
			return (
				getComputedStyle(element).fontFamily.includes(family) &&
				[...document.fonts].some(
					(face) =>
						face.family.replaceAll('"', "").replaceAll("'", "") === family &&
						face.style === "normal" &&
						face.status === "loaded",
				)
			);
		},
		{ id, family },
	);
}

async function popupBounds() {
	return page.locator('[role="listbox"]').evaluate((element) => {
		const rect = element.getBoundingClientRect();
		const last = element.querySelector<HTMLElement>('[data-font-option="bodoni-moda"]')!.getBoundingClientRect();
		return {
			fits: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
			scrolls: element.scrollHeight > element.clientHeight,
			lastVisible: last.top >= rect.top && last.bottom <= rect.bottom,
			target: last.height,
			documentFits: document.documentElement.scrollWidth <= innerWidth,
		};
	});
}

describe("production font picker", () => {
	it("keeps closed startup lazy and limits first-open downloads to nearby regular previews", async () => {
		expect(requests).toEqual([]);
		const opened = await page.evaluate(async () => {
			const start = performance.now();
			document.querySelector<HTMLButtonElement>("#pref-font")!.click();
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			return { renderMs: performance.now() - start, options: document.querySelectorAll('[role="option"]').length };
		});
		await page.waitForFunction(() => [...document.fonts].some((face) => face.status === "loaded"));
		await page.evaluate(() => document.fonts.ready);
		expect(opened.options).toBe(37);
		expect(requests.filter((url) => url.includes("expanded")).length).toBeLessThanOrEqual(4);
		expect(requests.some((url) => /italic|normal-(500|600|700)/.test(url))).toBe(false);
		expect(requests.some((url) => url.includes("latin-serif"))).toBe(false);
		const newBytes = catalog
			.flatMap((entry) => entry.faces)
			.filter((face) => requests.some((url) => url.endsWith(face.file)))
			.reduce((sum, face) => sum + face.bytes, 0);
		console.log(
			"font-picker cold first-open",
			JSON.stringify({ ...opened, fontRequests: requests.length, newBytes }),
		);
		// A generous structural guard, not a hardware-specific latency claim.
		expect(opened.renderMs).toBeLessThan(1000);
		const count = requests.length;
		await trigger().press("Escape");
		await trigger().click();
		await page.evaluate(() => document.fonts.ready);
		expect(requests).toHaveLength(count);
	});
	it.each([375, 1024])(
		"distinguishes category headings from font options at %ipx without committing",
		async (width) => {
			await page.setViewportSize({ width, height: 667 });
			await trigger().click();
			const headings = page.locator(".font-picker-group");
			expect(await headings.allTextContents()).toEqual(["Existing choices", "Sans-serif fonts", "Serif fonts"]);
			expect(await page.getByRole("listbox", { name: "font choices" }).getByRole("option").count()).toBe(37);
			const serif = page.getByRole("group", { name: "Serif fonts", exact: true });
			const heading = serif.locator("legend");
			await heading.scrollIntoViewIfNeeded();
			const presentation = await heading.evaluate((element) => {
				const style = getComputedStyle(element);
				const field = element.parentElement!.getBoundingClientRect();
				const rect = element.getBoundingClientRect();
				return {
					fullWidth: Math.abs(field.width - rect.width) < 1,
					fontSize: style.fontSize,
					uppercase: style.textTransform,
					divider: style.borderBottomStyle,
					dividerWidth: style.borderBottomWidth,
					color: style.color,
					textColor: getComputedStyle(element.parentElement!).color,
				};
			});
			expect(presentation).toMatchObject({
				fullWidth: true,
				fontSize: "12px",
				uppercase: "uppercase",
				divider: "solid",
				dividerWidth: "1px",
			});
			expect(presentation.color).toBe(presentation.textColor);
			const activeId = await trigger().getAttribute("aria-activedescendant");
			await heading.click();
			expect(await trigger().getAttribute("aria-expanded")).toBe("true");
			expect(await trigger().getAttribute("aria-activedescendant")).toBe(activeId);
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("pref-font");
			expect(await page.evaluate(() => localStorage.getItem("dreb.dashboard.font"))).toBeNull();
			await page.keyboard.press("End");
			await page.keyboard.press("Enter");
			expect(await trigger().getAttribute("data-font-value")).toBe("bodoni-moda");
		},
	);
	it("renders each added option in its loaded face as it is revealed, without fetching italic/bold-only resources", async () => {
		await trigger().click();
		for (const entry of catalog) await waitForPreview(entry.id, entry.family);
		for (const [id, family] of [
			["jetbrains-mono", "JetBrains Mono"],
			["opendyslexic", "OpenDyslexic"],
			["fira-code", "Fira Code"],
			["iosevka", "Iosevka"],
			["atkinson-hyperlegible", "Atkinson Hyperlegible Next"],
		])
			await waitForPreview(id, family);
		expect(await page.locator('[role="option"]').count()).toBe(37);
		expect(requests.some((url) => /italic|normal-(500|600|700)/.test(url))).toBe(false);
		const bytes = catalog
			.flatMap((entry) => entry.faces)
			.filter((face) => requests.some((url) => url.endsWith(face.file)))
			.reduce((sum, face) => sum + face.bytes, 0);
		expect(bytes).toBe(
			catalog
				.flatMap((entry) =>
					entry.faces.filter(
						(face) => face.style === "normal" && (face.weight === "400" || face.weight.startsWith("400 ")),
					),
				)
				.reduce((sum, face) => sum + face.bytes, 0),
		);
		console.log("font-picker all-new regular previews", JSON.stringify({ bytes, newFamilies: catalog.length }));
	}, 60_000);
	it("provides real regular, italic, bold and bold-italic faces for every addition", async () => {
		const states = await page.evaluate(async (entries) => {
			const results: { family: string; style: string; weight: string; declared: boolean; loaded: boolean }[] = [];
			for (const { family } of entries)
				for (const style of ["normal", "italic"])
					for (const weight of ["400", "700"]) {
						const matching = [...document.fonts].filter(
							(face) =>
								face.family.replaceAll('"', "").replaceAll("'", "") === family &&
								face.style === style &&
								(() => {
									const range = face.weight.split(" ").map(Number);
									return Number(weight) >= range[0] && Number(weight) <= (range[1] ?? range[0]);
								})(),
						);
						const loaded = await document.fonts.load(`${style} ${weight} 16px "${family}"`, "Résumé 42");
						results.push({
							family,
							style,
							weight,
							declared: matching.length > 0,
							loaded: loaded.length > 0 && matching.some((face) => face.status === "loaded"),
						});
					}
			return results;
		}, catalog);
		expect(states).toHaveLength(120);
		expect(states.filter((state) => !state.declared || !state.loaded)).toEqual([]);
	}, 60_000);
	it("separates keyboard highlight from persisted selection and keeps theme-default/card behavior", async () => {
		await page.locator("#force-font").click();
		await page.locator("#force-theme").click();
		await trigger().click();
		await waitForPreview("theme", "JetBrains Mono");
		await trigger().press("End");
		expect(await trigger().getAttribute("data-font-value")).toBe("inter");
		expect(await page.evaluate(() => localStorage.getItem("dreb.dashboard.font"))).toBe("inter");
		await trigger().press("Escape");
		expect(await trigger().getAttribute("aria-expanded")).toBe("false");
		await trigger().press("n");
		await trigger().press("o");
		await trigger().press("t");
		await trigger().press("o");
		const activeId = await trigger().getAttribute("aria-activedescendant");
		expect(await page.locator(`[id="${activeId}"]`).textContent()).toContain("Noto Sans");
		await trigger().press("Enter");
		expect(await trigger().getAttribute("data-font-value")).toBe("noto-sans");
		expect(await trigger().evaluate((element) => document.activeElement === element)).toBe(true);
		await trigger().click();
		await page.locator('[data-font-option="theme"]').click();
		expect(await page.evaluate(() => localStorage.getItem("dreb.dashboard.font"))).toBeNull();
		expect(await page.locator('[data-theme-card="gruvbox"]').getAttribute("data-font")).toBe("ibm-plex-mono");
		await page.locator('[data-theme-card="default"]').click();
		await trigger().click();
		await page.waitForFunction(() =>
			getComputedStyle(document.querySelector('[data-font-option="theme"]')!).fontFamily.startsWith(
				'"IBM Plex Mono"',
			),
		);
		await trigger().press("Tab");
		expect(await trigger().getAttribute("aria-expanded")).toBe("false");
		expect(await trigger().evaluate((element) => document.activeElement !== element)).toBe(true);
	});
	it("focuses non-focusing activation and routes real keyboard input without committing", async () => {
		await page.locator("#before").focus();
		expect(await page.evaluate(() => document.activeElement?.id)).toBe("before");
		// HTMLElement.click() does not supply Chromium's usual mouse-button focus.
		await trigger().evaluate((element: HTMLButtonElement) => element.click());
		expect(await page.evaluate(() => document.activeElement?.id)).toBe("pref-font");
		await page.keyboard.press("End");
		expect(await trigger().getAttribute("aria-activedescendant")).toMatch(/bodoni-moda$/);
		await page.keyboard.type("lato");
		expect(await trigger().getAttribute("aria-activedescendant")).toMatch(/lato$/);
		await page.keyboard.press("Escape");
		expect(await trigger().getAttribute("aria-expanded")).toBe("false");
		for (const key of ["Tab", "Shift+Tab"]) {
			await trigger().evaluate((element: HTMLButtonElement) => element.click());
			await page.keyboard.press(key);
			expect(await trigger().getAttribute("aria-expanded")).toBe("false");
			expect(await page.evaluate(() => document.activeElement?.id)).not.toBe("pref-font");
		}
		expect(await page.evaluate(() => localStorage.getItem("dreb.dashboard.font"))).toBeNull();
	});
	it.each([375, 1024])("dismisses on surrounding-page wheel scroll at %ipx without committing", async (width) => {
		await page.setViewportSize({ width, height: 667 });
		// Ensure surrounding-page travel independently of theme-card wrapping.
		await page.evaluate(() => {
			document.body.style.minHeight = "2000px";
		});
		await trigger().click();
		const bottom = await trigger().evaluate((element) => element.getBoundingClientRect().bottom);
		await page.mouse.move(2, 400); // outside the popup, not internal list scrolling
		await page.mouse.wheel(0, Math.ceil(bottom + 150));
		await page.waitForFunction(() => document.querySelector("#pref-font")!.getBoundingClientRect().bottom < 0);
		await page.waitForFunction(() => document.querySelector("#pref-font")!.getAttribute("aria-expanded") === "false");
		expect(await page.locator('[role="listbox"]').count()).toBe(0);
		expect(await page.evaluate(() => localStorage.getItem("dreb.dashboard.font"))).toBeNull();
	});
	it("keeps internal wheel scrolling open and reaches late choices without committing", async () => {
		await trigger().click();
		const scrollBefore = await page.evaluate(() => scrollY);
		const box = await page.locator('[role="listbox"]').boundingBox();
		await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
		await page.mouse.wheel(0, 9999);
		await page.waitForFunction(() => {
			const list = document.querySelector('[role="listbox"]')!;
			const bounds = list.getBoundingClientRect();
			const last = list.querySelector('[data-font-option="bodoni-moda"]')!.getBoundingClientRect();
			return list.scrollTop > 0 && last.top >= bounds.top && last.bottom <= bounds.bottom;
		});
		expect(await trigger().getAttribute("aria-expanded")).toBe("true");
		expect(await page.evaluate(() => scrollY)).toBe(scrollBefore);
		expect(await page.evaluate(() => localStorage.getItem("dreb.dashboard.font"))).toBeNull();
		await page.locator('[data-font-option="bodoni-moda"]').click();
		expect(await trigger().getAttribute("data-font-value")).toBe("bodoni-moda");
	});
	it("separates restricted primary option names from accessible source descriptions and the committed trigger", async () => {
		const restricted = [
			"lato",
			"raleway",
			"playfair-display",
			"merriweather",
			"lora",
			"libre-baskerville",
			"pt-serif",
			"bitter",
			"arvo",
		];
		for (const id of restricted) {
			const entry = catalog.find((entry) => entry.id === id)!;
			await trigger().click();
			const option = page.getByRole("option", { name: entry.family, exact: true });
			await option.scrollIntoViewIfNeeded();
			expect(await option.locator(".font-picker-name").textContent()).toBe(entry.family);
			const sourceId = await option.getAttribute("aria-describedby");
			expect(await page.locator(`[id="${sourceId}"]`).textContent()).toBe(`Based on ${entry.label}`);
			// Chromium's accessibility snapshot contains primary name and distinct description.
			const cdp = await context.newCDPSession(page);
			try {
				await cdp.send("Accessibility.enable");
				const { nodes } = await cdp.send("Accessibility.getFullAXTree");
				const node = nodes.find((node) => node.role?.value === "option" && node.name?.value === entry.family);
				expect(node?.description?.value).toBe(`Based on ${entry.label}`);
			} finally {
				await cdp.detach();
			}
			await option.click();
			expect(await trigger().locator(".font-picker-name").textContent()).toBe(entry.family);
			const selectedSourceId = await trigger().getAttribute("aria-describedby");
			expect(await page.locator(`[id="${selectedSourceId}"]`).textContent()).toBe(`Based on ${entry.label}`);
			expect(await page.evaluate(() => localStorage.getItem("dreb.dashboard.font"))).toBe(id);
		}
		await page.reload({ waitUntil: "networkidle" });
		expect(await trigger().getAttribute("data-font-value")).toBe("arvo");
		expect(await trigger().locator(".font-picker-name").textContent()).toBe("Dreb Serif 14");
		expect(await trigger().locator(".font-picker-source").textContent()).toBe("Based on Arvo");
	}, 30_000);
	it("remains responsive under CPU/network throttling without waiting for typefaces", async () => {
		const cdp = await context.newCDPSession(page);
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
		await cdp.send("Network.enable");
		await cdp.send("Network.emulateNetworkConditions", {
			offline: false,
			latency: 150,
			downloadThroughput: 200_000,
			uploadThroughput: 100_000,
		});
		const measured = await page.evaluate(async () => {
			const before = document.querySelectorAll("*").length;
			const button = document.querySelector<HTMLButtonElement>("#pref-font")!;
			const start = performance.now();
			button.click();
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			return { renderMs: performance.now() - start, addedElements: document.querySelectorAll("*").length - before };
		});
		await trigger().press("End");
		await trigger().press("Enter");
		expect(await trigger().getAttribute("data-font-value")).toBe("bodoni-moda");
		expect(measured.addedElements).toBeLessThan(150);
		expect(measured.renderMs).toBeLessThan(1000);
		console.log("font-picker 4x CPU / 150ms / 1.6Mbit", JSON.stringify(measured));
		await cdp.detach();
	});
	it("allows touch opening, scrolling to the last option, and commitment", async () => {
		const mobile = await browser.newContext({
			viewport: { width: 375, height: 667 },
			isMobile: true,
			hasTouch: true,
		});
		try {
			await mobile.route("https://fonts.googleapis.com/**", (route) =>
				route.fulfill({ contentType: "text/css", body: "" }),
			);
			const phone = await mobile.newPage();
			await phone.goto(baseUrl + fixture, { waitUntil: "networkidle" });
			await phone.locator("#pref-font").tap();
			const last = phone.locator('[data-font-option="bodoni-moda"]');
			await last.scrollIntoViewIfNeeded();
			await last.tap();
			expect(await phone.locator("#pref-font").getAttribute("data-font-value")).toBe("bodoni-moda");
			expect(await phone.locator("#pref-font").getAttribute("aria-expanded")).toBe("false");
		} finally {
			await mobile.close();
		}
	});
	it("keeps failed previews readable and selectable without blocking on downloads", async () => {
		await page.route("**/expanded/*.woff2", (route) => route.abort());
		await trigger().click();
		const inter = page.locator('[data-font-option="inter"]');
		await inter.scrollIntoViewIfNeeded();
		await inter.click();
		expect(await trigger().getAttribute("data-font-value")).toBe("inter");
		expect(await trigger().textContent()).toContain("Inter");
		expect(await trigger().evaluate((element) => element.getBoundingClientRect().width > 30)).toBe(true);
		await trigger().press("End");
		await trigger().press(" ");
		expect(await trigger().getAttribute("data-font-value")).toBe("bodoni-moda");
	});
	it.each([320, 375, 768])(
		"keeps the keyboard-highlighted last option visible after delayed previews load at %ipx",
		async (width) => {
			await page.setViewportSize({ width, height: 568 });
			let release!: () => void;
			const previews = new Promise<void>((resolve) => {
				release = resolve;
			});
			await page.route("**/*.woff2", async (route) => {
				await previews;
				await route.continue();
			});
			try {
				await trigger().click();
				await trigger().press("End");
				await page.waitForFunction(() =>
					[...document.fonts].some((face) => face.family.includes("Dreb Serif 15") && face.status === "loading"),
				);
				expect(await popupBounds()).toMatchObject({ fits: true, lastVisible: true });
				expect(await page.evaluate(() => localStorage.getItem("dreb.dashboard.font"))).toBeNull();
				release();
				await page.waitForFunction(() =>
					[...document.fonts].some((face) => face.family.includes("Dreb Serif 15") && face.status === "loaded"),
				);
				await page.evaluate(async () => {
					await document.fonts.ready;
					// Let font-layout and browser scroll anchoring finish before measuring.
					await new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					);
				});
				expect(await popupBounds()).toMatchObject({
					fits: true,
					scrolls: true,
					lastVisible: true,
					documentFits: true,
				});
				expect(await trigger().getAttribute("aria-activedescendant")).toMatch(/bodoni-moda$/);
				expect(await page.evaluate(() => localStorage.getItem("dreb.dashboard.font"))).toBeNull();
				await trigger().press(" ");
				expect(await trigger().getAttribute("data-font-value")).toBe("bodoni-moda");
			} finally {
				release();
			}
		},
	);
	it.each([320, 375, 768])("bounds the popup and keeps the last option reachable at %ipx", async (width) => {
		await page.setViewportSize({ width, height: 568 });
		await trigger().click();
		await trigger().press("End");
		const bounds = await popupBounds();
		expect(bounds).toMatchObject({ fits: true, scrolls: true, lastVisible: true, documentFits: true });
		expect(bounds.target).toBeGreaterThanOrEqual(40);
		await trigger().press(" ");
		expect(await trigger().getAttribute("data-font-value")).toBe("bodoni-moda");
	});
});
