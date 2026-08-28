/**
 * Real-browser coverage for the dashboard appearance system (issue 325 / PR 372).
 *
 * jsdom resolves neither CSS custom-property cascades, `@media
 * (prefers-color-scheme)` rules, nor `@font-face` fetching, so the appearance
 * layer's core contracts can only be verified in a real engine. This suite
 * loads the production stylesheets in their production order (tokens.css →
 * app.css → themes.css) into headless Chromium and asserts the resolved
 * palette, forced-mode precedence, scoped previews, explicit font selection
 * (incl. the bundled OpenDyslexic, Fira Code, Iosevka, and Atkinson
 * Hyperlegible faces), the pristine-default regression, WCAG AA contrast
 * (computed from the live values, NOT duplicated TS palette constants), lazy
 * webfont fetching, the first-paint bootstrap, and the live
 * `<meta name="theme-color">` sync.
 *
 * Uses the default node vitest environment (see fleet-layout.browser.test.ts) —
 * NOT jsdom.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------- sources

const stylesDir = fileURLToPath(new URL("../../src/client/styles/", import.meta.url));
const fontsDir = fileURLToPath(new URL("../../src/client/assets/fonts/", import.meta.url));
const indexHtmlPath = fileURLToPath(new URL("../../src/client/index.html", import.meta.url));
const appearanceSource = fileURLToPath(new URL("../../src/client/state/appearance.ts", import.meta.url));

const tokensCss = readFileSync(join(stylesDir, "tokens.css"), "utf8");
const appCss = readFileSync(join(stylesDir, "app.css"), "utf8");
const themesCss = readFileSync(join(stylesDir, "themes.css"), "utf8");
const indexHtml = readFileSync(indexHtmlPath, "utf8");

// ---------------------------------------------------------------- catalog

const THEME_IDS = ["default", "dim", "solarized", "gruvbox", "qud", "vangogh", "okabe", "tol"] as const;
const MODES = ["system", "light", "dark"] as const;
type ThemeId = (typeof THEME_IDS)[number];
type Mode = (typeof MODES)[number];
type FontId =
	| "theme"
	| "ibm-plex-mono"
	| "jetbrains-mono"
	| "fira-code"
	| "iosevka"
	| "opendyslexic"
	| "atkinson-hyperlegible";
type Scheme = "light" | "dark";

/**
 * Bundled explicit font families (beyond JetBrains Mono / OpenDyslexic):
 * storage id, CSS family name, bundled face files, and the exact
 * `document.fonts` load states the face probes must reach (single-weight
 * faces report a single weight, not a range).
 */
const BUNDLED_FONTS = [
	{
		id: "fira-code",
		family: "Fira Code",
		faces: ["fira-code-regular.woff2", "fira-code-medium.woff2", "fira-code-semibold.woff2"],
		loadedStates: ["normal/400/loaded", "normal/500/loaded", "normal/600/loaded"],
	},
	{
		id: "iosevka",
		family: "Iosevka",
		faces: ["iosevka-regular.woff2", "iosevka-medium.woff2", "iosevka-semibold.woff2", "iosevka-italic.woff2"],
		loadedStates: ["normal/400/loaded", "normal/500/loaded", "normal/600/loaded", "italic/400/loaded"],
	},
	{
		id: "atkinson-hyperlegible",
		family: "Atkinson Hyperlegible Next",
		faces: [
			"atkinson-hyperlegible-regular.woff2",
			"atkinson-hyperlegible-medium.woff2",
			"atkinson-hyperlegible-semibold.woff2",
			"atkinson-hyperlegible-italic.woff2",
		],
		loadedStates: ["normal/400/loaded", "normal/500/loaded", "normal/600/loaded", "italic/400/loaded"],
	},
] as const;

const isBundledFontRequest = (url: string): boolean =>
	BUNDLED_FONTS.some((font) => (font.faces as readonly string[]).some((name) => url.endsWith(name)));

const BASE_VARS = ["--bg", "--text", "--border", "--muted"] as const;
const STATUS_VARS = ["--status-running", "--status-attention", "--status-idle", "--status-error"] as const;
const SYNTAX_VARS = [
	"--syntax-comment",
	"--syntax-keyword",
	"--syntax-string",
	"--syntax-number",
	"--syntax-function",
	"--syntax-type",
	"--syntax-variable",
	"--syntax-operator",
	"--syntax-punctuation",
] as const;
const ALL_VARS = [...BASE_VARS, ...STATUS_VARS, ...SYNTAX_VARS];
// Foregrounds that must clear WCAG AA on --bg (border is a hairline, not text).
const FG_VARS = ["--text", "--muted", ...STATUS_VARS, ...SYNTAX_VARS];

// -------------------------------------------------------------- WCAG helper

/** Parse "#rrggbb" / "#rgb" / "rgb(r, g, b[, a])" into [r, g, b] (0–255). */
function parseColor(value: string): [number, number, number] {
	const v = value.trim();
	if (v.startsWith("#")) {
		let hex = v.slice(1);
		if (hex.length === 3) {
			hex = hex
				.split("")
				.map((c) => c + c)
				.join("");
		}
		const n = Number.parseInt(hex, 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	}
	const m = v.match(/rgba?\(([^)]+)\)/i);
	if (m) {
		const parts = m[1]
			.split(/[,\s/]+/)
			.filter(Boolean)
			.map(Number);
		return [parts[0], parts[1], parts[2]];
	}
	throw new Error(`unparseable color: ${JSON.stringify(value)}`);
}

/** WCAG 2.1 relative luminance of an sRGB color. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
	const channel = (c: number): number => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio (symmetric, 1–21). */
function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(parseColor(a));
	const lb = relativeLuminance(parseColor(b));
	const [hi, lo] = la > lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

function isColor(value: string): boolean {
	return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim()) || /^rgba?\(/i.test(value.trim());
}

// ---------------------------------------------------------------- harness

function stylesHead(includeThemes = true): string {
	return `<style>${tokensCss}</style><style>${appCss}</style>${includeThemes ? `<style>${themesCss}</style>` : ""}`;
}

function harnessHtml(includeThemes = true): string {
	return `<!DOCTYPE html><html><head><meta charset="utf-8">${stylesHead(includeThemes)}</head><body><div id="probe">const x = 1;</div></body></html>`;
}

let browser: Browser;
let page: Page;

// HTTP origin (tests 6–8) + esbuild bundle + real font files.
let server: Server;
let baseUrl: string;
let tempDir: string;

function contentType(path: string): string {
	if (path.endsWith(".css")) return "text/css";
	if (path.endsWith(".html")) return "text/html; charset=utf-8";
	if (path.endsWith(".js")) return "text/javascript";
	if (path.endsWith(".woff2")) return "font/woff2";
	return "application/octet-stream";
}

/** Apply appearance to <html> exactly as appearance.ts does (omit defaults). */
async function applyRoot(target: Page, theme: ThemeId, mode: Mode, font: FontId = "theme"): Promise<void> {
	await target.evaluate(
		({ theme, mode, font }) => {
			const el = document.documentElement;
			if (theme === "default") el.removeAttribute("data-theme");
			else el.setAttribute("data-theme", theme);
			if (mode === "system") el.removeAttribute("data-color-mode");
			else el.setAttribute("data-color-mode", mode);
			if (font === "theme") el.removeAttribute("data-font");
			else el.setAttribute("data-font", font);
		},
		{ theme, mode, font },
	);
}

async function readVars(selector: string, names: readonly string[]): Promise<Record<string, string>> {
	return page.evaluate(
		({ selector, names }) => {
			const el =
				selector === ":root" ? document.documentElement : (document.querySelector(selector) as Element | null);
			if (!el) throw new Error(`no element for ${selector}`);
			const cs = getComputedStyle(el);
			const out: Record<string, string> = {};
			for (const n of names) out[n] = cs.getPropertyValue(n).trim();
			return out;
		},
		{ selector, names: [...names] },
	);
}

async function readBodyFont(): Promise<string> {
	return page.evaluate(() => getComputedStyle(document.body).fontFamily);
}

/** Resolve the design tokens for a (theme, mode) under an emulated OS scheme. */
async function computeVars(
	theme: ThemeId,
	mode: Mode,
	os: Scheme,
	options: { includeThemes?: boolean } = {},
): Promise<Record<string, string>> {
	await page.emulateMedia({ colorScheme: os });
	await page.setContent(harnessHtml(options.includeThemes ?? true));
	await applyRoot(page, theme, mode);
	return readVars(":root", ALL_VARS);
}

beforeAll(async () => {
	// HTTP origin: real production stylesheets + the self-hosted JetBrains Mono
	// woff2 + the real index.html + an appearance.ts IIFE bundle, mirroring the
	// on-disk layout so themes.css's `url(../assets/fonts/…)` resolves.
	tempDir = join(tmpdir(), `dreb-appearance-browser-${process.pid}-${Date.now()}`);
	mkdirSync(join(tempDir, "styles"), { recursive: true });
	mkdirSync(join(tempDir, "assets", "fonts"), { recursive: true });
	writeFileSync(join(tempDir, "styles", "tokens.css"), tokensCss);
	writeFileSync(join(tempDir, "styles", "app.css"), appCss);
	writeFileSync(join(tempDir, "styles", "themes.css"), themesCss);
	copyFileSync(join(fontsDir, "jetbrains-mono.woff2"), join(tempDir, "assets", "fonts", "jetbrains-mono.woff2"));
	copyFileSync(
		join(fontsDir, "jetbrains-mono-italic.woff2"),
		join(tempDir, "assets", "fonts", "jetbrains-mono-italic.woff2"),
	);
	// Bundled OpenDyslexic faces — same local-origin treatment so the
	// data-font="opendyslexic" @font-face srcs resolve against this origin.
	for (const name of [
		"opendyslexic-regular.woff2",
		"opendyslexic-italic.woff2",
		"opendyslexic-bold.woff2",
		"opendyslexic-bold-italic.woff2",
	]) {
		copyFileSync(join(fontsDir, name), join(tempDir, "assets", "fonts", name));
	}
	// Bundled Fira Code / Iosevka / Atkinson Hyperlegible faces — same
	// local-origin treatment so their @font-face srcs resolve too.
	for (const font of BUNDLED_FONTS) {
		for (const name of font.faces) {
			copyFileSync(join(fontsDir, name), join(tempDir, "assets", "fonts", name));
		}
	}
	// Real index.html (bootstrap + stylesheet order) — sub-resource 404s (module
	// script, manifest, external fonts) are harmless; the head bootstrap runs.
	writeFileSync(join(tempDir, "index.html"), indexHtml);
	// Font-probe page links the three stylesheets and renders a mono element.
	// The face probes exercise every OpenDyslexic @font-face range (400 → the
	// 100-499 regular faces, 500/600/700 → the 500-900 bold faces, both
	// styles); #glyphs holds the dashboard status glyphs + coding punctuation.
	writeFileSync(
		join(tempDir, "font-probe.html"),
		`<!DOCTYPE html><html><head><meta charset="utf-8">
			<link rel="stylesheet" href="./styles/tokens.css">
			<link rel="stylesheet" href="./styles/app.css">
			<link rel="stylesheet" href="./styles/themes.css">
		</head><body><div id="body-text">body</div><pre id="mono">const answer = 42;</pre>
			<select id="control"><option>control</option></select>
			<textarea id="memory" class="memory-textarea">memory</textarea>
			<div id="face-400" style="font-weight:400">face probe</div>
			<div id="face-500" style="font-weight:500">face probe</div>
			<div id="face-600" style="font-weight:600">face probe</div>
			<div id="face-700" style="font-weight:700">face probe</div>
			<div id="face-400i" style="font-weight:400;font-style:italic">face probe</div>
			<div id="face-700i" style="font-weight:700;font-style:italic">face probe</div>
			<div id="glyphs">●◆○✕ !\\"#$%&amp;'()*+,-./:;&lt;=&gt;?@[]{}~0Az—…</div></body></html>`,
	);
	// Appearance-module page: real bundled appearance.ts exposed as window.Appearance.
	const bundle = await build({
		entryPoints: [appearanceSource],
		bundle: true,
		format: "iife",
		globalName: "Appearance",
		write: false,
	});
	writeFileSync(join(tempDir, "appearance.js"), bundle.outputFiles[0]!.text);
	writeFileSync(
		join(tempDir, "appearance.html"),
		`<!DOCTYPE html><html><head><meta charset="utf-8">
			<link rel="stylesheet" href="./styles/tokens.css">
			<link rel="stylesheet" href="./styles/app.css">
			<link rel="stylesheet" href="./styles/themes.css">
			<script src="./appearance.js"></script>
		</head><body></body></html>`,
	);

	server = createServer((req, res) => {
		const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
		const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
		try {
			const data = readFileSync(join(tempDir, rel));
			res.writeHead(200, { "content-type": contentType(rel) });
			res.end(data);
		} catch {
			res.writeHead(404);
			res.end("not found");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	baseUrl = `http://127.0.0.1:${address.port}`;

	browser = await chromium.launch();
	page = await browser.newPage({ viewport: { width: 900, height: 800 } });
}, 60_000);

afterAll(async () => {
	await browser?.close();
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}, 60_000);

// ================================================================ 1. matrix

describe("appearance — theme × mode × OS matrix resolves every token", () => {
	const combos: Array<[ThemeId, Mode, Scheme]> = [];
	for (const theme of THEME_IDS) {
		for (const mode of MODES) {
			for (const os of ["light", "dark"] as const) combos.push([theme, mode, os]);
		}
	}

	it.each(combos)("theme=%s mode=%s os=%s → all tokens are non-empty colors", async (theme, mode, os) => {
		const vars = await computeVars(theme, mode, os);
		for (const name of ALL_VARS) {
			expect(vars[name], `${name} for ${theme}/${mode}/${os}`).not.toBe("");
			expect(isColor(vars[name]), `${name}=${vars[name]} for ${theme}/${mode}/${os}`).toBe(true);
		}
	});
});

// ==================================================== 2. forced-mode precedence

describe("appearance — forced color-mode outranks the OS; system follows it", () => {
	it.each(THEME_IDS)("theme=%s: forced light/dark win over OS and system follows OS", async (theme) => {
		const darkOnLight = (await computeVars(theme, "dark", "light"))["--bg"];
		const darkOnDark = (await computeVars(theme, "dark", "dark"))["--bg"];
		const lightOnDark = (await computeVars(theme, "light", "dark"))["--bg"];
		const lightOnLight = (await computeVars(theme, "light", "light"))["--bg"];
		const systemOnDark = (await computeVars(theme, "system", "dark"))["--bg"];
		const systemOnLight = (await computeVars(theme, "system", "light"))["--bg"];

		// Forced mode ignores the OS preference entirely.
		expect(darkOnLight).toBe(darkOnDark);
		expect(lightOnDark).toBe(lightOnLight);
		// The two forced variants are genuinely different backgrounds.
		expect(darkOnLight).not.toBe(lightOnLight);
		// System mode (no data-color-mode) tracks the emulated OS scheme.
		expect(systemOnDark).toBe(darkOnDark);
		expect(systemOnLight).toBe(lightOnLight);
	});
});

// ========================================================== 3. scoped preview

describe("appearance — a scoped data-theme themes only its subtree", () => {
	it("a data-theme='gruvbox' container differs from the default :root without touching it", async () => {
		await page.emulateMedia({ colorScheme: "light" });
		await page.setContent(
			`<!DOCTYPE html><html><head><meta charset="utf-8">${stylesHead(true)}</head><body><div id="preview" data-theme="gruvbox">preview card</div></body></html>`,
		);
		const rootBg = (await readVars(":root", ["--bg"]))["--bg"];
		const previewBg = (await readVars("#preview", ["--bg"]))["--bg"];

		// :root is untouched (still the default light bg); the preview subtree
		// resolves gruvbox's own bg — exactly how the settings gallery renders.
		expect(rootBg).not.toBe("");
		expect(previewBg).not.toBe("");
		expect(previewBg).not.toBe(rootBg);
	});

	it("gallery cards keep their own palette when a NON-default theme is active on :root", async () => {
		// Regression: selecting e.g. gruvbox must NOT bleed into the other preview
		// cards (including the Default card). Each card carries data-theme (default
		// included) so it renders its own palette regardless of the active root.
		await page.emulateMedia({ colorScheme: "light" });
		await page.setContent(
			`<!DOCTYPE html><html data-theme="gruvbox"><head><meta charset="utf-8">${stylesHead(true)}</head><body>` +
				`<div id="c-default" data-theme="default">d</div>` +
				`<div id="c-dim" data-theme="dim">d</div>` +
				`<div id="c-solarized" data-theme="solarized">s</div>` +
				`<div id="c-gruvbox" data-theme="gruvbox">g</div>` +
				`</body></html>`,
		);
		const rootBg = (await readVars(":root", ["--bg"]))["--bg"];
		const dflt = (await readVars("#c-default", ["--bg"]))["--bg"];
		const dim = (await readVars("#c-dim", ["--bg"]))["--bg"];
		const sol = (await readVars("#c-solarized", ["--bg"]))["--bg"];
		const gruv = (await readVars("#c-gruvbox", ["--bg"]))["--bg"];

		// The Default card shows the tokens.css baseline white, NOT gruvbox
		// (accept #fff or #ffffff — CSS minification may shorten it).
		expect(["#fff", "#ffffff"]).toContain(dflt.toLowerCase());
		// Every non-gruvbox card differs from the active gruvbox root.
		expect(dflt).not.toBe(rootBg);
		expect(dim).not.toBe(rootBg);
		expect(sol).not.toBe(rootBg);
		// The four preview backgrounds are all distinct palettes.
		expect(new Set([dflt, dim, sol, gruv]).size).toBe(4);
		// The gruvbox card matches the (also-gruvbox) root — same palette.
		expect(gruv).toBe(rootBg);
	});
});

// ================================================== 4. no-preference regression

describe("appearance — themes.css does not change the pristine default", () => {
	it.each(["light", "dark"] as const)(
		"os=%s: default+system tokens + body font match tokens.css+app.css alone",
		async (os) => {
			const withThemes = await computeVars("default", "system", os, { includeThemes: true });
			const withThemesFont = await readBodyFont();
			const baselineOnly = await computeVars("default", "system", os, { includeThemes: false });
			const baselineFont = await readBodyFont();

			for (const name of ["--bg", "--text", ...STATUS_VARS, ...SYNTAX_VARS]) {
				expect(withThemes[name], `${name} at os=${os}`).toBe(baselineOnly[name]);
			}
			expect(withThemesFont).toBe(baselineFont);
		},
	);
});

// ============================================================= 5. WCAG contrast

describe("appearance — every resolved variant clears WCAG AA (>=4.5:1)", () => {
	const cases: Array<[ThemeId, Mode]> = [];
	for (const theme of THEME_IDS) for (const variant of ["light", "dark"] as const) cases.push([theme, variant]);

	it.each(cases)("theme=%s variant=%s: text/muted/status/syntax on --bg + attention chip", async (theme, variant) => {
		// OS emulated light; a forced color-mode fixes the variant regardless.
		const vars = await computeVars(theme, variant, "light");
		const bg = vars["--bg"];
		for (const fg of FG_VARS) {
			const ratio = contrastRatio(vars[fg], bg);
			expect(ratio, `${fg} on --bg for ${theme}/${variant} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
		}
		// The needs-attention chip is filled: --bg text on the --status-attention
		// fill. Contrast is symmetric, so this equals --status-attention on --bg.
		const chipRatio = contrastRatio(bg, vars["--status-attention"]);
		expect(chipRatio, `attention chip for ${theme}/${variant} = ${chipRatio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
			4.5,
		);
	});

	it("Dim is low-glare: text-on-bg is comfortably below the pure extreme yet still AA", async () => {
		for (const variant of ["light", "dark"] as const) {
			const vars = await computeVars("dim", variant, "light");
			const ratio = contrastRatio(vars["--text"], vars["--bg"]);
			expect(ratio, `dim ${variant} text-on-bg = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
			expect(ratio, `dim ${variant} text-on-bg = ${ratio.toFixed(2)}:1`).toBeLessThan(15);
		}
	});
});

// ===================================================== 6. font request isolation

describe("appearance — theme-default font requests JetBrains Mono only for gruvbox", () => {
	it.each([
		["default", false],
		["dim", false],
		["solarized", false],
		["gruvbox", true],
		["qud", false],
		["vangogh", false],
		["okabe", false],
		["tol", false],
	] as Array<[ThemeId, boolean]>)("theme=%s requests the webfont: %s", async (theme, expectFont) => {
		// A fresh context per case gives a clean HTTP cache so a genuine (not
		// cache-suppressed) request is observed for gruvbox and none for the rest.
		const ctx = await browser.newContext();
		const p = await ctx.newPage();
		const fontRequests: string[] = [];
		p.on("request", (r) => {
			if (r.url().endsWith("jetbrains-mono.woff2")) fontRequests.push(r.url());
		});
		await p.goto(`${baseUrl}/font-probe.html`, { waitUntil: "load" });
		await p.evaluate((t) => {
			if (t !== "default") document.documentElement.setAttribute("data-theme", t);
			// Force layout so the mono element's font is actually resolved/used.
			void (document.getElementById("mono") as HTMLElement).offsetHeight;
		}, theme);
		await p.evaluate(() => document.fonts.ready);
		await p.waitForTimeout(100);

		const monoFamily = await p.evaluate(
			() => getComputedStyle(document.getElementById("mono") as HTMLElement).fontFamily,
		);

		if (expectFont) {
			expect(fontRequests.length).toBeGreaterThan(0);
			expect(monoFamily).toContain("JetBrains Mono");
			// After use, the loaded font set includes JetBrains Mono.
			const loaded = await p.evaluate(() =>
				[...document.fonts].some((f) => f.family.includes("JetBrains Mono") && f.status === "loaded"),
			);
			expect(loaded).toBe(true);
		} else {
			expect(fontRequests).toEqual([]);
			expect(monoFamily).toContain("IBM Plex Mono");
			expect(monoFamily).not.toContain("JetBrains Mono");
		}
		await ctx.close();
	});
});

describe("appearance — explicit font choice overrides theme typography", () => {
	it.each([
		["gruvbox", "ibm-plex-mono", "IBM Plex Mono", false],
		["solarized", "jetbrains-mono", "JetBrains Mono", true],
	] as Array<[ThemeId, Exclude<FontId, "theme">, string, boolean]>)(
		"theme=%s font=%s resolves %s",
		async (theme, selectedFont, expectedFamily, expectJetBrainsRequest) => {
			const ctx = await browser.newContext();
			const p = await ctx.newPage();
			const fontRequests: string[] = [];
			p.on("request", (request) => {
				if (request.url().endsWith("jetbrains-mono.woff2")) fontRequests.push(request.url());
			});
			await p.goto(`${baseUrl}/font-probe.html`, { waitUntil: "load" });
			await applyRoot(p, theme, "system", selectedFont);
			await p.evaluate(() => {
				for (const id of ["body-text", "mono", "control", "memory"]) {
					void (document.getElementById(id) as HTMLElement).offsetHeight;
				}
			});
			await p.evaluate(() => document.fonts.ready);
			await p.waitForTimeout(100);

			const families = await p.evaluate(() =>
				["body-text", "mono", "control", "memory"].map(
					(id) => getComputedStyle(document.getElementById(id) as HTMLElement).fontFamily,
				),
			);
			for (const family of families) expect(family).toContain(expectedFamily);
			if (expectJetBrainsRequest) expect(fontRequests.length).toBeGreaterThan(0);
			else expect(fontRequests).toEqual([]);
			await ctx.close();
		},
	);

	it("theme-default previews stay on IBM until an explicit JetBrains preview is selected", async () => {
		const ctx = await browser.newContext();
		const p = await ctx.newPage();
		const fontRequests: string[] = [];
		p.on("request", (request) => {
			if (request.url().endsWith("jetbrains-mono.woff2")) fontRequests.push(request.url());
		});
		await p.goto(`${baseUrl}/font-probe.html`, { waitUntil: "load" });
		await p.evaluate(() => {
			document.body.innerHTML =
				'<button id="card" data-theme="gruvbox" data-font="ibm-plex-mono"><pre class="theme-card-code">preview</pre></button>';
			void (document.querySelector(".theme-card-code") as HTMLElement).offsetHeight;
		});
		await p.waitForTimeout(100);
		expect(fontRequests).toEqual([]);
		expect(
			await p.evaluate(() => getComputedStyle(document.querySelector(".theme-card-code") as HTMLElement).fontFamily),
		).toContain("IBM Plex Mono");

		await p.evaluate(() => {
			document.getElementById("card")?.setAttribute("data-font", "jetbrains-mono");
			void (document.querySelector(".theme-card-code") as HTMLElement).offsetHeight;
		});
		await p.evaluate(() => document.fonts.ready);
		await p.waitForTimeout(100);
		expect(fontRequests.length).toBeGreaterThan(0);
		expect(
			await p.evaluate(() => getComputedStyle(document.querySelector(".theme-card-code") as HTMLElement).fontFamily),
		).toContain("JetBrains Mono");
		await ctx.close();
	});
});

// ================================================= 6b. OpenDyslexic (bundled)

describe("appearance — explicit OpenDyslexic selection (bundled dyslexia-friendly font)", () => {
	const OPENDYSLEXIC_FACES = [
		"opendyslexic-regular.woff2",
		"opendyslexic-italic.woff2",
		"opendyslexic-bold.woff2",
		"opendyslexic-bold-italic.woff2",
	] as const;
	const isOpenDyslexicRequest = (url: string): boolean => OPENDYSLEXIC_FACES.some((name) => url.endsWith(name));

	it("theme-default mode (no explicit font) never requests an OpenDyslexic face", async () => {
		const ctx = await browser.newContext();
		const p = await ctx.newPage();
		const requests: string[] = [];
		p.on("request", (request) => {
			if (isOpenDyslexicRequest(request.url())) requests.push(request.url());
		});
		await p.goto(`${baseUrl}/font-probe.html`, { waitUntil: "load" });
		// Gruvbox is the strongest case: its theme-default font is JetBrains
		// Mono, never OpenDyslexic — so rendering it must not touch the bundled
		// OpenDyslexic faces.
		await applyRoot(p, "gruvbox", "system");
		await p.evaluate(() => {
			for (const id of ["body-text", "mono", "control", "memory", "glyphs"]) {
				void (document.getElementById(id) as HTMLElement).offsetHeight;
			}
		});
		await p.evaluate(() => document.fonts.ready);
		await p.waitForTimeout(100);
		expect(requests).toEqual([]);
		// The faces are declared by themes.css but were never fetched or used —
		// Chromium reports a registered-but-unloaded family as not renderable.
		const active = await p.evaluate(() => document.fonts.check("16px OpenDyslexic", "A"));
		expect(active).toBe(false);
		await ctx.close();
	});

	it("explicit OpenDyslexic applies to body/code/controls/memory-editor, loads all four bundled faces, and requests nothing remote", async () => {
		const ctx = await browser.newContext();
		const p = await ctx.newPage();
		const fontRequests: string[] = [];
		const remoteRequests: string[] = [];
		p.on("request", (request) => {
			const url = request.url();
			if (isOpenDyslexicRequest(url)) fontRequests.push(url);
			if (url.includes("fonts.googleapis.com") || url.includes("fonts.gstatic.com")) remoteRequests.push(url);
		});
		await p.goto(`${baseUrl}/font-probe.html`, { waitUntil: "load" });
		await applyRoot(p, "solarized", "system", "opendyslexic");
		await p.evaluate(() => {
			for (const id of [
				"body-text",
				"mono",
				"control",
				"memory",
				"face-400",
				"face-500",
				"face-600",
				"face-700",
				"face-400i",
				"face-700i",
				"glyphs",
			]) {
				void (document.getElementById(id) as HTMLElement).offsetHeight;
			}
		});
		await p.evaluate(() => document.fonts.ready);
		await p.waitForTimeout(100);

		const families = await p.evaluate(() =>
			["body-text", "mono", "control", "memory"].map(
				(id) => getComputedStyle(document.getElementById(id) as HTMLElement).fontFamily,
			),
		);
		for (const family of families) expect(family).toContain("OpenDyslexic");

		// Only the bundled local faces are requested — and every one of the
		// four, because the probes use 400 (regular faces), 500–700 (bold
		// faces), and both italics. Nothing leaves this origin.
		const requestedNames = new Set(fontRequests.map((url) => url.split("/").pop()!));
		for (const name of OPENDYSLEXIC_FACES) expect(requestedNames.has(name), name).toBe(true);
		expect(fontRequests.every((url) => url.startsWith(baseUrl))).toBe(true);
		// No CDN request of any kind for the explicit font.
		expect(remoteRequests).toEqual([]);

		// All four faces are genuinely loaded — real faces, so 500–800 and the
		// italics render without faux-bold/faux-italic synthesis.
		const faceStates = await p.evaluate(() =>
			[...document.fonts]
				.filter((f) => f.family === "OpenDyslexic")
				.map((f) => `${f.style}/${String(f.weight)}/${f.status}`),
		);
		expect(faceStates).toContain("normal/100 499/loaded");
		expect(faceStates).toContain("italic/100 499/loaded");
		expect(faceStates).toContain("normal/500 900/loaded");
		expect(faceStates).toContain("italic/500 900/loaded");

		// The dashboard's status glyphs + coding punctuation are available
		// through the active stack: ● ○ and the punctuation come from
		// OpenDyslexic itself; ◆ ✕ fall back within the stack (the same path
		// today's IBM themes use, since the Google-hosted IBM slices lack those
		// geometric shapes too — see OPENDYSLEXIC-PROVENANCE.md).
		const glyphsAvailable = await p.evaluate(() =>
			document.fonts.check(
				'16px "OpenDyslexic", "IBM Plex Mono", "Courier New", monospace',
				"●◆○✕ !\"#$%&'()*+,-./:;<>?@[]{}~0Az—…",
			),
		);
		expect(glyphsAvailable).toBe(true);
		await ctx.close();
	});

	it("theme-default previews never request OpenDyslexic; an explicit preview card does", async () => {
		const ctx = await browser.newContext();
		const p = await ctx.newPage();
		const requests: string[] = [];
		p.on("request", (request) => {
			if (isOpenDyslexicRequest(request.url())) requests.push(request.url());
		});
		await p.goto(`${baseUrl}/font-probe.html`, { waitUntil: "load" });
		await p.evaluate(() => {
			// Mirror the real gallery: theme-default mode pins preview cards to
			// the baseline IBM family, so merely rendering a card cannot fetch
			// the bundled OpenDyslexic faces.
			document.body.innerHTML =
				'<button id="card" data-theme="gruvbox" data-font="ibm-plex-mono"><pre class="theme-card-code">preview</pre></button>';
			void (document.querySelector(".theme-card-code") as HTMLElement).offsetHeight;
		});
		await p.waitForTimeout(100);
		expect(requests).toEqual([]);

		await p.evaluate(() => {
			document.getElementById("card")?.setAttribute("data-font", "opendyslexic");
			void (document.querySelector(".theme-card-code") as HTMLElement).offsetHeight;
		});
		await p.evaluate(() => document.fonts.ready);
		await p.waitForTimeout(100);
		expect(requests.length).toBeGreaterThan(0);
		expect(
			await p.evaluate(() => getComputedStyle(document.querySelector(".theme-card-code") as HTMLElement).fontFamily),
		).toContain("OpenDyslexic");
		await ctx.close();
	});
});

// ==================================== 6c. Fira Code / Iosevka / Atkinson

describe("appearance — explicit Fira Code / Iosevka / Atkinson Hyperlegible (bundled)", () => {
	it.each(BUNDLED_FONTS.map((font) => [font.id, font.family, font.faces, font.loadedStates] as const))(
		"font=%s on gruvbox overrides the theme default, applies to body/code/controls/memory, loads all faces, and requests nothing remote",
		async (id, family, faces, loadedStates) => {
			const ctx = await browser.newContext();
			const p = await ctx.newPage();
			const fontRequests: string[] = [];
			const jetBrainsRequests: string[] = [];
			const remoteRequests: string[] = [];
			p.on("request", (request) => {
				const url = request.url();
				if (isBundledFontRequest(url)) fontRequests.push(url);
				if (url.endsWith("jetbrains-mono.woff2")) jetBrainsRequests.push(url);
				if (url.includes("fonts.googleapis.com") || url.includes("fonts.gstatic.com")) remoteRequests.push(url);
			});
			await p.goto(`${baseUrl}/font-probe.html`, { waitUntil: "load" });
			// Gruvbox is the strongest case: its theme default is JetBrains
			// Mono, so an explicit family must beat that rule AND not fetch it.
			await applyRoot(p, "gruvbox", "system", id);
			await p.evaluate(() => {
				for (const probeId of [
					"body-text",
					"mono",
					"control",
					"memory",
					"face-400",
					"face-500",
					"face-600",
					"face-700",
					"face-400i",
					"face-700i",
				]) {
					void (document.getElementById(probeId) as HTMLElement).offsetHeight;
				}
			});
			await p.evaluate(() => document.fonts.ready);
			await p.waitForTimeout(100);

			// The computed family must START with the explicit family — a losing
			// cascade would leave the gruvbox stack (JetBrains-first) in place.
			// (Chromium serializes computed font-family without quotes around
			// unquoted identifiers like `Iosevka`, so normalize before matching.)
			const families = await p.evaluate(() =>
				["body-text", "mono", "control", "memory"].map(
					(id) => getComputedStyle(document.getElementById(id) as HTMLElement).fontFamily,
				),
			);
			for (const computed of families) {
				expect(computed.replace(/"/g, "").startsWith(`${family},`), computed).toBe(true);
			}

			// Every bundled face is fetched locally and reaches `loaded` (the
			// probes use 400, 500, 600 and both italics — 700/700i resolve to
			// the nearest declared face without a new fetch).
			const requestedNames = new Set(fontRequests.map((url) => url.split("/").pop()!));
			for (const name of faces) expect(requestedNames.has(name), name).toBe(true);
			expect(fontRequests.every((url) => url.startsWith(baseUrl))).toBe(true);
			const faceStates = await p.evaluate(
				({ family }) =>
					[...document.fonts]
						.filter((f) => f.family === family)
						.map((f) => `${f.style}/${String(f.weight)}/${f.status}`),
				{ family },
			);
			for (const state of loadedStates) expect(faceStates, state).toContain(state);

			// No JetBrains fetch (explicit choice beats the gruvbox default) and
			// no CDN request of any kind.
			expect(jetBrainsRequests).toEqual([]);
			expect(remoteRequests).toEqual([]);
			await ctx.close();
		},
	);

	it("theme-default mode (no explicit font) never requests a Fira Code, Iosevka, or Atkinson face", async () => {
		const ctx = await browser.newContext();
		const p = await ctx.newPage();
		const requests: string[] = [];
		p.on("request", (request) => {
			if (isBundledFontRequest(request.url())) requests.push(request.url());
		});
		await p.goto(`${baseUrl}/font-probe.html`, { waitUntil: "load" });
		// Gruvbox again: the strongest theme-default case (JetBrains default).
		await applyRoot(p, "gruvbox", "system");
		await p.evaluate(() => {
			for (const probeId of ["body-text", "mono", "control", "memory", "glyphs"]) {
				void (document.getElementById(probeId) as HTMLElement).offsetHeight;
			}
		});
		await p.evaluate(() => document.fonts.ready);
		await p.waitForTimeout(100);
		expect(requests).toEqual([]);
		// Declared but never fetched — Chromium reports them as not renderable.
		for (const { family } of BUNDLED_FONTS) {
			expect(await p.evaluate((f) => document.fonts.check(`16px "${f}"`, "A"), family)).toBe(false);
		}
		await ctx.close();
	});

	it("each family renders the glyphs its provenance record claims, alone", async () => {
		// Per-family (NOT stack-based) checks: these fail if a bundled face is
		// missing a glyph the provenance claims it has. The set per family is
		// exactly what the provenance documents as present — Fira Code lacks
		// ✕/↻ and Atkinson is Latin-centric (no shapes/arrows), so those are
		// asserted only where the face really contains them.
		const claims: Array<{ id: FontId; family: string; glyphs: string }> = [
			// Iosevka's subset keeps the full symbol set (verified in
			// IOSEVKA-PROVENANCE.md), including every dashboard status glyph.
			{ id: "iosevka", family: "Iosevka", glyphs: "●◆○✕↻ !\"#$%&'()*+,-./:;<=>?@[]{}~0Az—…" },
			// Fira Code covers the shapes + punctuation but not dingbats/arrows.
			{ id: "fira-code", family: "Fira Code", glyphs: "●◆○ !\"#$%&'()*+,-./:;<=>?@[]{}~0Az—…±×÷≤≥≠" },
			// Atkinson Hyperlegible is Latin-centric by design.
			{
				id: "atkinson-hyperlegible",
				family: "Atkinson Hyperlegible Next",
				glyphs: "aA09 !\"#$%&'()*+,-./:;<=>?@[]{}~—…±×÷≤≥≠",
			},
		];
		const ctx = await browser.newContext();
		const p = await ctx.newPage();
		await p.goto(`${baseUrl}/font-probe.html`, { waitUntil: "load" });
		for (const { id, family, glyphs } of claims) {
			// Activate the family and force the face probes to render in it so
			// the faces are genuinely loaded before check() can be trusted.
			await applyRoot(p, "solarized", "system", id);
			await p.evaluate(() => {
				for (const probeId of ["face-400", "face-500", "face-600", "face-400i", "face-700i"]) {
					void (document.getElementById(probeId) as HTMLElement).offsetHeight;
				}
			});
			await p.evaluate(() => document.fonts.ready);
			// Family-ALONE check (no fallback stack): fails if the bundled face
			// lacks a claimed glyph or was never loaded.
			expect(
				await p.evaluate((c) => document.fonts.check(`16px "${c.family}"`, c.glyphs), { family, glyphs }),
				family,
			).toBe(true);
		}
		await ctx.close();
	});
});

// ====================================================== 7. first-paint bootstrap

describe("appearance — the head bootstrap paints the persisted theme on first frame", () => {
	it("places the bootstrap <script> before the appearance stylesheet links", () => {
		const scriptIdx = indexHtml.indexOf("dreb.dashboard.theme");
		const tokensLinkIdx = indexHtml.indexOf('href="./styles/tokens.css"');
		expect(scriptIdx).toBeGreaterThan(-1);
		expect(tokensLinkIdx).toBeGreaterThan(-1);
		// The synchronous bootstrap must run before tokens/app/themes load so the
		// correct appearance is present on the first paint (no wrong-appearance flash).
		expect(scriptIdx).toBeLessThan(tokensLinkIdx);
	});

	it("has data-theme/data-color-mode/data-font set from storage before any app script runs", async () => {
		const ctx = await browser.newContext();
		// Seed BEFORE navigation so the head bootstrap reads it synchronously.
		await ctx.addInitScript(() => {
			localStorage.setItem("dreb.dashboard.theme", "gruvbox");
			localStorage.setItem("dreb.dashboard.colorMode", "dark");
			localStorage.setItem("dreb.dashboard.font", "ibm-plex-mono");
		});
		const p = await ctx.newPage();
		// The app module (index.tsx) 404s from the temp origin and never executes,
		// so any attributes present come solely from the synchronous head bootstrap.
		await p.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
		const state = await p.evaluate(() => ({
			theme: document.documentElement.getAttribute("data-theme"),
			mode: document.documentElement.getAttribute("data-color-mode"),
			font: document.documentElement.getAttribute("data-font"),
			colorScheme: document.documentElement.style.getPropertyValue("color-scheme"),
		}));
		expect(state.theme).toBe("gruvbox");
		expect(state.mode).toBe("dark");
		expect(state.font).toBe("ibm-plex-mono");
		expect(state.colorScheme).toBe("dark");
		await ctx.close();
	});

	it("ignores an invalid persisted font before app code runs", async () => {
		const ctx = await browser.newContext();
		await ctx.addInitScript(() => {
			localStorage.setItem("dreb.dashboard.font", "retired-font");
		});
		const p = await ctx.newPage();
		await p.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
		expect(await p.evaluate(() => document.documentElement.getAttribute("data-font"))).toBeNull();
		await ctx.close();
	});

	it("restores a persisted OpenDyslexic font before any app script runs (font-only: no theme attr, no color-scheme)", async () => {
		const ctx = await browser.newContext();
		await ctx.addInitScript(() => {
			localStorage.setItem("dreb.dashboard.font", "opendyslexic");
		});
		const p = await ctx.newPage();
		await p.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
		const state = await p.evaluate(() => ({
			font: document.documentElement.getAttribute("data-font"),
			theme: document.documentElement.getAttribute("data-theme"),
			colorScheme: document.documentElement.style.getPropertyValue("color-scheme"),
		}));
		// The explicit bundled font restores on the first frame, while the
		// font-only state deliberately leaves no theme attribute and no
		// inline color-scheme (font is excluded from the active computation).
		expect(state.font).toBe("opendyslexic");
		expect(state.theme).toBeNull();
		expect(state.colorScheme).toBe("");
		await ctx.close();
	});

	it("sets color-scheme 'light dark' for a curated theme seeded without a color mode", async () => {
		const ctx = await browser.newContext();
		// Theme only, no color-mode key → the common "picked a theme, left mode on
		// system" case. The bootstrap's color-scheme ternary must resolve the
		// 'light dark' branch (matching applyAppearance()).
		await ctx.addInitScript(() => {
			localStorage.setItem("dreb.dashboard.theme", "gruvbox");
		});
		const p = await ctx.newPage();
		await p.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
		const state = await p.evaluate(() => ({
			theme: document.documentElement.getAttribute("data-theme"),
			mode: document.documentElement.getAttribute("data-color-mode"),
			colorScheme: document.documentElement.style.getPropertyValue("color-scheme"),
		}));
		expect(state.theme).toBe("gruvbox");
		expect(state.mode).toBeNull();
		expect(state.colorScheme).toBe("light dark");
		await ctx.close();
	});

	it("sets color-scheme 'light' when a forced-light mode is seeded on the default theme", async () => {
		const ctx = await browser.newContext();
		// Mode only (no theme) → default theme forced light. The bootstrap must
		// resolve the 'light' branch and set data-color-mode without data-theme.
		await ctx.addInitScript(() => {
			localStorage.setItem("dreb.dashboard.colorMode", "light");
		});
		const p = await ctx.newPage();
		await p.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
		const state = await p.evaluate(() => ({
			theme: document.documentElement.getAttribute("data-theme"),
			mode: document.documentElement.getAttribute("data-color-mode"),
			colorScheme: document.documentElement.style.getPropertyValue("color-scheme"),
		}));
		expect(state.theme).toBeNull();
		expect(state.mode).toBe("light");
		expect(state.colorScheme).toBe("light");
		await ctx.close();
	});
});

// ========================================================= 8. live theme-color

describe("appearance — the live <meta name=theme-color> tracks the resolved --bg", () => {
	it.each([
		["gruvbox", "dark"],
		["default", "dark"],
		["solarized", "light"],
	] as Array<[ThemeId, Mode]>)("theme=%s mode=%s: meta content equals the computed --bg", async (theme, mode) => {
		const ctx = await browser.newContext();
		const p = await ctx.newPage();
		await p.goto(`${baseUrl}/appearance.html`, { waitUntil: "load" });
		// Drive the REAL appearance.ts setters (bundled), which apply the
		// attributes and run updateThemeColorMeta().
		const result = await p.evaluate(
			({ theme, mode }) => {
				const A = (window as unknown as { Appearance: Record<string, (v: string) => void> }).Appearance;
				A.setColorMode(mode);
				A.setTheme(theme);
				const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
				const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
				return { content: meta?.getAttribute("content") ?? null, bg };
			},
			{ theme, mode },
		);
		expect(result.content).not.toBeNull();
		expect(result.bg).not.toBe("");
		expect(result.content).toBe(result.bg);
		await ctx.close();
	});
});
