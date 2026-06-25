import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.js";
import { Text } from "../src/components/text.js";
import { visibleWidth } from "../src/utils.js";
import { isWrappableLine, stripWrapMarker, WRAP_MARKER } from "../src/wrap.js";
import { defaultMarkdownTheme } from "./test-themes.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function plain(line: string): string {
	return stripAnsi(stripWrapMarker(line));
}

describe("Markdown softWrap", () => {
	it("renders long prose as one marked logical line when enabled", () => {
		const longParagraph =
			"This paragraph is deliberately long enough to exceed a narrow terminal width without requiring any hard wrapping.";
		const width = 24;
		const markdown = new Markdown(longParagraph, 1, 0, defaultMarkdownTheme, undefined, true);

		const lines = markdown.render(width);

		assert.strictEqual(lines.length, 1);
		assert.ok(isWrappableLine(lines[0]));
		assert.ok(lines[0].includes(WRAP_MARKER));
		assert.strictEqual(plain(lines[0]), ` ${longParagraph}`);
		assert.ok(visibleWidth(lines[0]) > width);
	});

	it("emits each long list item as one marked logical line when enabled", () => {
		const longItem = "this is a single bullet whose text runs well past the narrow width without hard wrapping";
		const md = `- ${longItem}\n- second item also reasonably long but distinct from the first one here`;
		const width = 24;
		const markdown = new Markdown(md, 0, 0, defaultMarkdownTheme, undefined, true);

		const lines = markdown.render(width);
		const marked = lines.filter(isWrappableLine);

		// Two bullets → two marked logical lines, neither hard-split.
		assert.strictEqual(marked.length, 2);
		assert.ok(plain(marked[0]).includes(longItem));
		assert.ok(visibleWidth(marked[0]) > width);
	});

	it("emits a long heading as one marked logical line when enabled", () => {
		const heading = "# A heading that is quite long and would otherwise be hard wrapped at a narrow width";
		const width = 24;
		const markdown = new Markdown(heading, 0, 0, defaultMarkdownTheme, undefined, true);

		const lines = markdown.render(width);
		const marked = lines.filter(isWrappableLine);

		assert.strictEqual(marked.length, 1);
		assert.ok(visibleWidth(marked[0]) > width);
	});

	it("applies a background behind soft-wrapped text without padding to full width", () => {
		// Mirrors user-message styling: a bgColor must still wrap the visible text
		// (not be dropped) but must NOT pad to full width (which would pollute copy).
		const bg = (t: string) => `\x1b[44m${t}\x1b[49m`;
		const width = 24;
		const markdown = new Markdown("hello there", 1, 0, defaultMarkdownTheme, { bgColor: bg }, true);

		const lines = markdown.render(width);

		assert.strictEqual(lines.length, 1);
		assert.ok(isWrappableLine(lines[0]));
		// Background sequence is present (not dropped)...
		assert.ok(lines[0].includes("\x1b[44m"), "bg color should be applied behind the text");
		// ...but the line is not padded out to full width.
		assert.ok(visibleWidth(lines[0]) < width, "soft-wrapped bg line must not pad to full width");
		assert.strictEqual(plain(lines[0]), " hello there");
	});

	it("emits fenced code block content as one marked unsplit line when enabled", () => {
		const longCodeLine = `const value = ${"x".repeat(60)};`;
		const width = 24;
		const markdown = new Markdown(`\`\`\`ts\n${longCodeLine}\n\`\`\``, 0, 0, defaultMarkdownTheme, undefined, true);

		const lines = markdown.render(width);
		const markedLines = lines.filter(isWrappableLine);

		assert.strictEqual(markedLines.length, 1);
		assert.strictEqual(plain(markedLines[0]), `  ${longCodeLine}`);
		assert.ok(visibleWidth(markedLines[0]) > width);
	});

	it("keeps tables unmarked and width-constrained when softWrap is enabled", () => {
		const table = `| Column A | Column B |\n| --- | --- |\n| ${"alpha ".repeat(8)} | ${"beta ".repeat(8)} |`;
		const width = 32;
		const markdown = new Markdown(table, 0, 0, defaultMarkdownTheme, undefined, true);

		const lines = markdown.render(width);

		assert.ok(lines.length > 0);
		assert.strictEqual(lines.some(isWrappableLine), false);
		for (const line of lines) {
			assert.ok(
				visibleWidth(line) <= width,
				`Expected width <= ${width}, got ${visibleWidth(line)}: ${plain(line)}`,
			);
		}
	});

	it("defaults to existing hard-wrapped behavior with no wrap markers", () => {
		const longParagraph =
			"This paragraph is deliberately long enough to exceed a narrow terminal width and should hard wrap by default.";
		const width = 24;
		const defaultMarkdown = new Markdown(longParagraph, 0, 0, defaultMarkdownTheme);
		const explicitFalseMarkdown = new Markdown(longParagraph, 0, 0, defaultMarkdownTheme, undefined, false);

		const lines = defaultMarkdown.render(width);

		assert.deepStrictEqual(lines, explicitFalseMarkdown.render(width));
		assert.ok(lines.length > 1);
		assert.strictEqual(lines.some(isWrappableLine), false);
		for (const line of lines) {
			assert.ok(
				visibleWidth(line) <= width,
				`Expected width <= ${width}, got ${visibleWidth(line)}: ${plain(line)}`,
			);
		}
	});
});

describe("Text softWrap", () => {
	it("emits marked, unpadded lines when enabled", () => {
		const text = new Text("short", 2, 1, undefined, true);

		const lines = text.render(20);

		assert.strictEqual(lines.length, 3);
		assert.strictEqual(isWrappableLine(lines[0]), false);
		assert.strictEqual(lines[0], " ".repeat(20));
		assert.ok(isWrappableLine(lines[1]));
		assert.strictEqual(stripWrapMarker(lines[1]), "  short");
		assert.strictEqual(visibleWidth(lines[1]), 7);
		assert.strictEqual(isWrappableLine(lines[2]), false);
		assert.strictEqual(lines[2], " ".repeat(20));
	});

	it("defaults to existing padded hard-wrapped behavior", () => {
		const text = new Text("short", 2, 0);

		const lines = text.render(20);

		assert.deepStrictEqual(lines, [`  short${" ".repeat(13)}`]);
		assert.strictEqual(lines.some(isWrappableLine), false);
		assert.strictEqual(visibleWidth(lines[0]), 20);
	});
});
