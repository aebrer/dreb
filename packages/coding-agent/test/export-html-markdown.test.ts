import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { getExportTemplateDir } from "../src/config.js";
import { exportFromFile } from "../src/core/export-html/index.js";
import { loadTemplateInternals, type TemplateInternals } from "./export-html-template-harness.js";

/**
 * Markdown rendering in exported HTML sessions.
 *
 * The export inlines a vendored copy of marked (`vendor/marked.umd.js`) and
 * configures it in template.js. These tests take the marked bundle out of a
 * real exported file, run it the way a browser does (no CommonJS globals, so
 * the UMD wrapper installs a `marked` global), and render through the real
 * template's `renderEntry()` after its own `marked.use(...)` configuration.
 *
 * They also pin the vendored bundle to the installed `marked` package, so the
 * export can never silently drift from the TUI and dashboard renderers again.
 */

const REPORTED =
	'Starting from the first ~ in "~7 percent vs ~12 percent", the 7 passes the lookahead, but the next `~` sits after a space, so nothing ends a valid match there.';

const VENDORED_MARKED_PATH = join(getExportTemplateDir(), "vendor", "marked.umd.js");

function installedMarkedUmdPath(): string {
	const require = createRequire(import.meta.url);
	return join(dirname(require.resolve("marked/package.json")), "lib", "marked.umd.js");
}

/** The marked bundle as inlined into an exported HTML file. */
function extractInlinedMarked(html: string): string {
	const match = html.match(/<!-- Vendored libraries -->\s*<script>([\s\S]*?)<\/script>/);
	if (!match) throw new Error("vendored marked <script> block not found in exported HTML");
	return match[1];
}

/** Evaluate a marked UMD bundle like a browser <script> and return the `marked` global it installs. */
function loadBrowserMarked(source: string): unknown {
	const context: Record<string, unknown> = {};
	runInNewContext(source, context);
	if (typeof context.marked !== "object" || context.marked === null) {
		throw new Error("marked bundle did not install a `marked` global");
	}
	return context.marked;
}

/** Inner HTML of the first `markdown-content` div produced by `renderEntry`. */
function markdownContent(entryHtml: string): string {
	const match = entryHtml.match(/<div class="[^"]*markdown-content">([\s\S]*?)<\/div>/);
	if (!match) throw new Error(`markdown-content not found in ${JSON.stringify(entryHtml)}`);
	return match[1];
}

const now = new Date().toISOString();

function assistantEntry(content: unknown[]) {
	return {
		type: "message",
		id: "a1",
		parentId: "u1",
		timestamp: now,
		message: {
			role: "assistant",
			content,
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			timestamp: Date.now(),
		},
	};
}

/** Every template surface that renders markdown, each carrying `text`. */
const SURFACES: Array<{ name: string; entry: (text: string) => unknown }> = [
	{
		name: "user message",
		entry: (text) => ({
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: now,
			message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
		}),
	},
	{ name: "assistant text", entry: (text) => assistantEntry([{ type: "text", text }]) },
	{ name: "thinking", entry: (text) => assistantEntry([{ type: "thinking", thinking: text }]) },
	{
		name: "branch summary",
		entry: (summary) => ({ type: "branch_summary", id: "b1", parentId: "a1", timestamp: now, summary }),
	},
	{
		name: "custom message",
		entry: (content) => ({
			type: "custom_message",
			id: "c1",
			parentId: "a1",
			timestamp: now,
			customType: "note",
			display: true,
			content,
		}),
	},
];

/** Each input with the HTML GitHub's GFM renderer produces for it. */
const CASES: Array<{ input: string; html: string }> = [
	{
		input: REPORTED,
		html: '<p>Starting from the first ~ in "~7 percent vs ~12 percent", the 7 passes the lookahead, but the next <code>~</code> sits after a space, so nothing ends a valid match there.</p>\n',
	},
	{
		input: "about ~7 percent vs ~12 percent (see `~`)",
		html: "<p>about ~7 percent vs ~12 percent (see <code>~</code>)</p>\n",
	},
	{ input: "(~7 percent) vs (~12 percent)", html: "<p>(~7 percent) vs (~12 percent)</p>\n" },
	{ input: "range 5~7 and 10~12", html: "<p>range 5<del>7 and 10</del>12</p>\n" },
	{
		input: "~~real strike~~ and ~single strike~",
		html: "<p><del>real strike</del> and <del>single strike</del></p>\n",
	},
	{ input: "word ~~real strike~~ here", html: "<p>word <del>real strike</del> here</p>\n" },
	{ input: "a ~single~ b", html: "<p>a <del>single</del> b</p>\n" },
];

describe("HTML export — markdown strikethrough (GitHub GFM parity)", () => {
	let tmpDir: string;
	let exportedHtml: string;
	let render: (entry: unknown) => string;

	beforeAll(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "dreb-export-markdown-"));
		const sessionFile = join(tmpDir, "session.jsonl");
		const lines = [
			{ type: "session", id: "markdown-session", timestamp: now, cwd: tmpDir },
			SURFACES[0].entry(REPORTED),
		];
		writeFileSync(sessionFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");

		const outputPath = join(tmpDir, "out.html");
		await exportFromFile(sessionFile, { outputPath });
		exportedHtml = readFileSync(outputPath, "utf-8");

		const marked = loadBrowserMarked(extractInlinedMarked(exportedHtml));
		const internals: TemplateInternals = loadTemplateInternals([], { marked });
		render = (entry) => internals.renderEntry(entry);
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	for (const { input, html } of CASES) {
		test(`assistant text: ${input}`, () => {
			expect(markdownContent(render(SURFACES[1].entry(input)))).toBe(html);
		});
	}

	for (const surface of SURFACES) {
		test(`${surface.name}: reported example renders with no strikethrough and an intact code span`, () => {
			const html = markdownContent(render(surface.entry(REPORTED)));
			expect(html).not.toContain("<del>");
			expect(html).toContain("<code>~</code>");
			expect(html).toBe(CASES[0].html);
		});

		test(`${surface.name}: intentional strikethrough still renders`, () => {
			expect(markdownContent(render(surface.entry("~~real strike~~ and ~single strike~")))).toBe(CASES[4].html);
		});
	}

	test("inlines the vendored marked bundle verbatim", () => {
		// String.prototype.replace interprets `$&`-style patterns in replacement
		// text; the bundle must reach the exported file byte-for-byte unchanged.
		expect(extractInlinedMarked(exportedHtml) === readFileSync(VENDORED_MARKED_PATH, "utf-8")).toBe(true);
	});
});

describe("HTML export — vendored marked bundle", () => {
	test("is identical to the installed marked package's lib/marked.umd.js", () => {
		const installedPath = installedMarkedUmdPath();
		const vendored = readFileSync(VENDORED_MARKED_PATH);
		const installed = readFileSync(installedPath);
		const banner = (bundle: Buffer) => bundle.toString("utf-8").match(/marked v(\S+)/)?.[1] ?? "unknown";

		expect(
			vendored.equals(installed),
			`The HTML export's vendored marked (v${banner(vendored)}) differs from the installed marked package ` +
				`(v${banner(installed)}). Re-vendor it so every markdown surface renders the same:\n` +
				"  cp node_modules/marked/lib/marked.umd.js packages/coding-agent/src/core/export-html/vendor/marked.umd.js",
		).toBe(true);
	});
});
