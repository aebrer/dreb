import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getExportTemplateDir } from "../src/config.js";
import { exportFromFile } from "../src/core/export-html/index.js";

/**
 * Regression + security tests for HTML-export image rendering.
 *
 * The dashboard renders tool-result images inline; the HTML exporter must keep
 * parity. Images are NOT literal `<img>` strings in the exported HTML — they
 * are produced client-side at runtime by template.js. So we guard two things:
 *
 *   1. Images survive the export pipeline and round-trip intact inside the
 *      embedded (base64) session payload (index.ts must not strip them).
 *   2. template.js turns image content blocks into sanitized `<img data:...>`
 *      tags via the real `renderToolCall()` / `renderEntry()` dispatch, and
 *      rejects crafted MIME/base64 that could inject attributes or markup.
 *
 * To test (2) faithfully, `loadTemplateInternals()` below evaluates the real
 * shipped template.js: it decodes a session payload exactly like the browser
 * does, then returns the internal render functions. A `return` statement is
 * injected right before the DOM-heavy "HEADER / STATS" section so none of the
 * browser-only initialization (event listeners, marked.use, navigateTo) runs —
 * only lightweight `document`/`window`/`hljs` stubs are needed.
 */

// A tiny valid base64 PNG payload (content is arbitrary for the test).
const IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Extract and parse the base64 session payload embedded in the exported HTML. */
function extractSessionData(html: string): {
	entries: Array<{
		type: string;
		message?: {
			role: string;
			toolName?: string;
			content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		};
	}>;
} {
	const match = html.match(/<script id="session-data"[^>]*>([\s\S]*?)<\/script>/);
	if (!match) throw new Error("session-data script block not found in exported HTML");
	const base64 = match[1].trim();
	const json = Buffer.from(base64, "base64").toString("utf-8");
	return JSON.parse(json);
}

// ---------------------------------------------------------------------------
// Template harness: run the REAL template.js and expose its render functions.
// ---------------------------------------------------------------------------

interface ImageBlock {
	type: "image";
	mimeType: string;
	data: string;
}

interface TemplateInternals {
	renderToolCall(call: { id: string; name: string; arguments: Record<string, unknown> }): string;
	renderEntry(entry: unknown): string;
	sanitizeImageDataUri(mimeType: unknown, data: unknown): string | null;
	renderImageTag(img: unknown, className: string): string;
}

/** Minimal DOM stub sufficient for the template's data-loading + escapeHtml(). */
function makeStubs(sessionBase64: string) {
	const documentStub = {
		getElementById(id: string) {
			if (id === "session-data") return { textContent: sessionBase64 };
			return null;
		},
		querySelector() {
			return null;
		},
		// escapeHtml() creates a <div>, sets textContent, reads innerHTML.
		createElement() {
			let value = "";
			return {
				set textContent(v: unknown) {
					value = String(v);
				},
				get textContent() {
					return value;
				},
				get innerHTML() {
					return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
				},
				set innerHTML(v: string) {
					value = v;
				},
			};
		},
	};
	const windowStub = { location: { search: "" } };
	const hljsStub = {
		highlight: (code: string) => ({ value: code }),
		highlightAuto: (code: string) => ({ value: code }),
		getLanguage: () => null,
	};
	return { documentStub, windowStub, hljsStub };
}

function loadTemplateInternals(entries: unknown[]): TemplateInternals {
	const templateJs = readFileSync(join(getExportTemplateDir(), "template.js"), "utf-8").trim();

	// Inject a `return` just before the browser-only init section so we get the
	// render functions without running any DOM/marked/navigate side effects.
	const marker = "      // ============================================================\n      // HEADER / STATS";
	if (!templateJs.includes(marker)) {
		throw new Error("HEADER / STATS marker not found in template.js — harness needs updating");
	}
	const instrumented = templateJs.replace(
		marker,
		`      return { renderToolCall, renderEntry, sanitizeImageDataUri, renderImageTag };\n\n${marker}`,
	);

	const sessionData = { header: { id: "t" }, entries, leafId: null, systemPrompt: "", tools: [], renderedTools: {} };
	const sessionBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");
	const { documentStub, windowStub, hljsStub } = makeStubs(sessionBase64);

	// The template is an IIFE expression: `return` its value to obtain internals.
	const factory = new Function("document", "window", "hljs", `return ${instrumented}`) as (
		documentArg: unknown,
		windowArg: unknown,
		hljsArg: unknown,
	) => TemplateInternals;

	return factory(documentStub, windowStub, hljsStub);
}

/** Build a toolResult session entry that carries a single image block. */
function toolResultEntry(toolCallId: string, toolName: string, image: ImageBlock) {
	return {
		type: "message",
		id: `r-${toolCallId}`,
		parentId: "a1",
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text: `result for ${toolName}` }, image],
			isError: false,
		},
	};
}

describe("HTML export — tool-result image parity", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "dreb-export-images-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("embeds a read tool-result image in the exported session payload", async () => {
		const now = new Date().toISOString();
		const sessionFile = join(tmpDir, "session.jsonl");

		// Build a session where a `read` tool result includes a text note + an image block.
		const lines = [
			{ type: "session", id: "test-session", timestamp: now, cwd: tmpDir },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: now,
				message: { role: "user", content: [{ type: "text", text: "read the screenshot" }], timestamp: Date.now() },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: now,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "screenshot.png" } }],
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "toolUse",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				id: "r1",
				parentId: "a1",
				timestamp: now,
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [
						{ type: "text", text: "Read image file screenshot.png" },
						{ type: "image", data: IMAGE_BASE64, mimeType: "image/png" },
					],
					isError: false,
				},
			},
		];

		writeFileSync(sessionFile, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf-8");

		const outputPath = join(tmpDir, "out.html");
		const result = await exportFromFile(sessionFile, { outputPath });
		expect(result).toBe(outputPath);
		expect(existsSync(outputPath)).toBe(true);

		const html = readFileSync(outputPath, "utf-8");

		// The image content block must round-trip intact inside the embedded session payload.
		const session = extractSessionData(html);
		const toolResult = session.entries.find(
			(e) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolName === "read",
		);
		expect(toolResult).toBeDefined();
		const imageBlock = toolResult?.message?.content?.find((c) => c.type === "image");
		expect(imageBlock).toBeDefined();
		expect(imageBlock?.mimeType).toBe("image/png");
		expect(imageBlock?.data).toBe(IMAGE_BASE64);

		expect(session.entries.length).toBeGreaterThan(0);
	});
});

describe("HTML export — template.js image rendering & sanitization", () => {
	const validImage: ImageBlock = { type: "image", mimeType: "image/png", data: IMAGE_BASE64 };

	test("(a) valid read tool-result image renders via renderToolCall dispatch", () => {
		const { renderToolCall } = loadTemplateInternals([toolResultEntry("call-read", "read", validImage)]);

		const html = renderToolCall({ id: "call-read", name: "read", arguments: { path: "screenshot.png" } });

		expect(html).toContain("<img");
		expect(html).toContain(`src="data:image/png;base64,${IMAGE_BASE64}"`);
		expect(html).toContain('class="tool-image"');
		// The read branch still renders its path/output header.
		expect(html).toContain("read");
	});

	test("(b) non-read custom tool image renders via generic renderToolCall dispatch", () => {
		const { renderToolCall } = loadTemplateInternals([toolResultEntry("call-custom", "my_custom_tool", validImage)]);

		const html = renderToolCall({ id: "call-custom", name: "my_custom_tool", arguments: { foo: 1 } });

		// Proves it went through the generic (default) dispatch, not the read special-case.
		expect(html).toContain("my_custom_tool");
		expect(html).toContain("<img");
		expect(html).toContain(`src="data:image/png;base64,${IMAGE_BASE64}"`);
		expect(html).toContain('class="tool-image"');
	});

	test("(c) malicious MIME, SVG, and malformed base64 are rejected for tool-result images", () => {
		const cases: Array<{ label: string; image: ImageBlock; forbidden: string[] }> = [
			{
				label: "attribute-injection MIME",
				image: { type: "image", mimeType: 'image/png" onerror="alert(1)', data: IMAGE_BASE64 },
				forbidden: ["onerror", "<img"],
			},
			{
				label: "svg MIME",
				image: { type: "image", mimeType: "image/svg+xml", data: IMAGE_BASE64 },
				forbidden: ["svg", "<img"],
			},
			{
				label: "non-raster MIME",
				image: { type: "image", mimeType: "text/html", data: IMAGE_BASE64 },
				forbidden: ["text/html", "<img"],
			},
			{
				label: "markup-injection base64",
				image: { type: "image", mimeType: "image/png", data: 'abc"><img src=x onerror=alert(1)>' },
				forbidden: ["onerror", "<img"],
			},
			{
				label: "whitespace / invalid base64",
				image: { type: "image", mimeType: "image/png", data: "not valid base64!!" },
				forbidden: ["not valid", "<img"],
			},
		];

		for (const { label, image, forbidden } of cases) {
			const { renderToolCall } = loadTemplateInternals([toolResultEntry("call-x", "read", image)]);
			const html = renderToolCall({ id: "call-x", name: "read", arguments: { path: "x.png" } });
			for (const needle of forbidden) {
				expect(html, `${label}: expected no "${needle}"`).not.toContain(needle);
			}
		}
	});

	test("(d) renders only the valid image when a tool result mixes valid and invalid images", () => {
		// Per-item sanitization: a disallowed/malformed sibling must not suppress
		// the valid image, and the invalid ones must not leak markup.
		const mixedEntry = {
			type: "message",
			id: "r-call-mixed",
			parentId: "a1",
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "call-mixed",
				toolName: "read",
				content: [
					{ type: "text", text: "result for read" },
					{ type: "image", mimeType: "image/svg+xml", data: IMAGE_BASE64 },
					{ type: "image", mimeType: "image/png", data: IMAGE_BASE64 },
					{ type: "image", mimeType: "image/png", data: "not valid base64!!" },
				],
			},
		};
		const { renderToolCall } = loadTemplateInternals([mixedEntry]);
		const html = renderToolCall({ id: "call-mixed", name: "read", arguments: { path: "x.png" } });

		// Exactly one sanitized <img> from the single valid block.
		expect(html.match(/<img/g)?.length ?? 0).toBe(1);
		expect(html).toContain(`src="data:image/png;base64,${IMAGE_BASE64}"`);
		expect(html).not.toContain("svg");
		expect(html).not.toContain("not valid");
	});

	test("(a) valid message image renders via renderEntry dispatch", () => {
		const { renderEntry } = loadTemplateInternals([]);
		const html = renderEntry({
			type: "message",
			id: "u1",
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [validImage] },
		});

		expect(html).toContain("<img");
		expect(html).toContain(`src="data:image/png;base64,${IMAGE_BASE64}"`);
		expect(html).toContain('class="message-image"');
	});

	test("(c) malicious MIME, SVG, and malformed base64 are rejected for message images", () => {
		const cases: Array<{ label: string; image: ImageBlock; forbidden: string[] }> = [
			{
				label: "attribute-injection MIME",
				image: { type: "image", mimeType: 'image/png" onerror="alert(1)', data: IMAGE_BASE64 },
				forbidden: ["onerror", "<img"],
			},
			{
				label: "svg MIME",
				image: { type: "image", mimeType: "image/svg+xml", data: IMAGE_BASE64 },
				// The copy-link button embeds an <svg> icon, so match the exact MIME/img markers.
				forbidden: ["image/svg", "<img", "message-images"],
			},
			{
				label: "markup-injection base64",
				image: { type: "image", mimeType: "image/png", data: 'abc"><script>alert(1)</script>' },
				forbidden: ["<script>", "<img"],
			},
		];

		for (const { label, image, forbidden } of cases) {
			const { renderEntry } = loadTemplateInternals([]);
			const html = renderEntry({
				type: "message",
				id: "u1",
				timestamp: new Date().toISOString(),
				message: { role: "user", content: [image] },
			});
			for (const needle of forbidden) {
				expect(html, `${label}: expected no "${needle}"`).not.toContain(needle);
			}
		}
	});

	test("sanitizeImageDataUri enforces the raster allowlist and strict base64", () => {
		const { sanitizeImageDataUri } = loadTemplateInternals([]);

		// Valid raster types pass and produce a canonical data: URI.
		expect(sanitizeImageDataUri("image/png", IMAGE_BASE64)).toBe(`data:image/png;base64,${IMAGE_BASE64}`);
		expect(sanitizeImageDataUri("image/jpeg", "AAAA")).toBe("data:image/jpeg;base64,AAAA");
		expect(sanitizeImageDataUri("image/gif", "AAAA")).toBe("data:image/gif;base64,AAAA");
		expect(sanitizeImageDataUri("image/webp", "AAAA")).toBe("data:image/webp;base64,AAAA");

		// Rejected MIME types.
		expect(sanitizeImageDataUri("image/svg+xml", IMAGE_BASE64)).toBeNull();
		expect(sanitizeImageDataUri("text/html", IMAGE_BASE64)).toBeNull();
		expect(sanitizeImageDataUri('image/png" onerror="x', IMAGE_BASE64)).toBeNull();
		expect(sanitizeImageDataUri(42, IMAGE_BASE64)).toBeNull();

		// Rejected base64 payloads.
		expect(sanitizeImageDataUri("image/png", "")).toBeNull();
		expect(sanitizeImageDataUri("image/png", "abc")).toBeNull(); // length not multiple of 4
		expect(sanitizeImageDataUri("image/png", 'AA"><img>')).toBeNull();
		expect(sanitizeImageDataUri("image/png", "AA AA")).toBeNull();
		expect(sanitizeImageDataUri("image/png", null)).toBeNull();
	});
});
