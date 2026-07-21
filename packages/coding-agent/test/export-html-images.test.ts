import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getExportTemplateDir } from "../src/config.js";
import { exportFromFile } from "../src/core/export-html/index.js";

/**
 * Regression test for HTML-export image parity.
 *
 * The dashboard renders tool-result images inline. This test locks the HTML
 * exporter so it keeps embedding tool-result images too.
 *
 * How the exporter works (verified in src/core/export-html):
 *   - index.ts `generateHtml()` base64-encodes the whole session (including
 *     tool-result content blocks) and injects it into
 *     `<script id="session-data">{{SESSION_DATA}}</script>`.
 *   - template.js runs in the browser: it decodes that base64 payload and, in
 *     `renderToolCall()` -> `renderResultImages()`, emits
 *     `<img src="data:${mimeType};base64,${data}" class="tool-image" />`
 *     for every `{ type: 'image', ... }` block in the tool result.
 *
 * So the `<img>` tag is NOT a literal string in the exported HTML — it is
 * produced client-side at runtime. The two things we must guard are therefore:
 *   1. Images survive the export pipeline and round-trip intact inside the
 *      embedded (base64) session payload (i.e. they are not stripped by
 *      index.ts before reaching the template).
 *   2. template.js still turns image content blocks into `<img data:...>` tags.
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

		// The raw base64 image data is therefore present in the exported HTML payload.
		// (Base64-in-base64: the decoded payload contains the exact data string.)
		expect(session.entries.length).toBeGreaterThan(0);
	});

	test("template.js renderResultImages() turns image blocks into <img data:...> tags", () => {
		// Focused unit test of the actual client-side render logic. We extract the
		// real `renderResultImages` implementation from the shipped template.js and
		// exercise it, so the img-tag format stays locked to the exporter's source.
		const templateJs = readFileSync(join(getExportTemplateDir(), "template.js"), "utf-8");

		const match = templateJs.match(/const renderResultImages = \(\) => \{[\s\S]*?\n\s*\};/);
		expect(match, "renderResultImages() not found in template.js").not.toBeNull();

		// Provide the closure dependency (`getResultImages`) and evaluate the real body.
		const factory = new Function("getResultImages", `${match?.[0]}\nreturn renderResultImages();`) as (
			getResultImages: () => Array<{ type: string; data: string; mimeType: string }>,
		) => string;

		const images = [{ type: "image", data: IMAGE_BASE64, mimeType: "image/png" }];
		const rendered = factory(() => images);

		expect(rendered).toContain("<img");
		expect(rendered).toContain(`src="data:image/png;base64,${IMAGE_BASE64}"`);
		expect(rendered).toContain('class="tool-image"');

		// And the empty case produces nothing.
		const empty = factory(() => []);
		expect(empty).toBe("");
	});
});
