import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.js";
import { Text } from "../src/components/text.js";
import { visibleWidth } from "../src/utils.js";
import { isWrappableLine, stripWrapMarker, WRAP_MARKER } from "../src/wrap.js";
import { defaultMarkdownTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

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
		assert.strictEqual(plain(lines[0]), longParagraph);
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

	it("fills a soft-wrapped background to full width via erase-to-EOL, not spaces", () => {
		// Mirrors user-message styling: a bgColor must still wrap the visible text and
		// fill the row, but via BCE (`\x1b[K`) rather than padded spaces — so the row is
		// a full-width block on screen yet copies clean.
		const bg = (t: string) => `\x1b[44m${t}\x1b[49m`;
		const width = 24;
		const markdown = new Markdown("hello there", 1, 0, defaultMarkdownTheme, { bgColor: bg }, true);

		const lines = markdown.render(width);

		assert.strictEqual(lines.length, 1);
		assert.ok(isWrappableLine(lines[0]));
		// Background sequence is present (not dropped)...
		assert.ok(lines[0].includes("\x1b[44m"), "bg color should be applied behind the text");
		// ...filled with erase-to-EOL rather than literal spaces...
		assert.ok(lines[0].includes("\x1b[K"), "should fill the row with BCE erase, not padded spaces");
		// ...and the printable width is just the text (no left margin, no padding).
		assert.strictEqual(visibleWidth(lines[0]), "hello there".length);
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
	it("emits marked, unpadded, flush-left lines when enabled", () => {
		const text = new Text("short", 2, 1, undefined, true);

		const lines = text.render(20);

		assert.strictEqual(lines.length, 3);
		assert.strictEqual(isWrappableLine(lines[0]), false);
		assert.strictEqual(lines[0], " ".repeat(20));
		assert.ok(isWrappableLine(lines[1]));
		// Flush-left: horizontal padding is dropped in soft-wrap mode.
		assert.strictEqual(stripWrapMarker(lines[1]), "short");
		assert.strictEqual(visibleWidth(lines[1]), 5);
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

/**
 * Write each logical (marker-stripped) line to a real xterm, joined by `\r\n`
 * exactly as the renderer does, so the terminal applies its own autowrap and BCE.
 */
async function paintLogicalLines(lines: string[], width: number): Promise<VirtualTerminal> {
	const term = new VirtualTerminal(width, lines.length * 4 + 4);
	term.write(lines.map((l) => stripWrapMarker(l)).join("\r\n"));
	await term.flush();
	return term;
}

function rowBgColors(term: VirtualTerminal, row: number, width: number): number[] {
	const line = (
		term as unknown as { xterm: { buffer: { active: { getLine(i: number): any } } } }
	).xterm.buffer.active.getLine(row);
	const bgs: number[] = [];
	for (let x = 0; x < width; x++) bgs.push(line.getCell(x).getBgColor());
	return bgs;
}

describe("Markdown softWrap background fill (BCE)", () => {
	it("fills every wrapped row to full width and copies clean", async () => {
		const blue = (t: string) => `\x1b[44m${t}\x1b[49m`;
		const width = 12;
		const sentence = "the quick brown fox jumps"; // 25 chars → wraps across rows at width 12
		const md = new Markdown(sentence, 0, 0, defaultMarkdownTheme, { bgColor: blue }, true);
		const lines = md.render(width);

		// One marked logical line, longer than the width (so the terminal wraps it).
		const marked = lines.filter(isWrappableLine);
		assert.strictEqual(marked.length, 1);
		assert.ok(visibleWidth(marked[0]) > width);

		const term = await paintLogicalLines(lines, width);

		// Every visible row of the wrapped block is filled with the blue background
		// edge to edge — including the last row's tail, via erase-to-EOL (BCE).
		const rows = Math.ceil(visibleWidth(marked[0]) / width);
		for (let r = 0; r < rows; r++) {
			const bgs = rowBgColors(term, r, width);
			assert.ok(
				bgs.every((c) => c === 4),
				`Row ${r} should be fully blue-filled, got: ${bgs.join(",")}`,
			);
		}

		// The copy (logical scroll buffer) is a single clean line — no injected
		// newlines and no trailing space padding.
		const logical = term.getLogicalScrollBuffer().filter((l) => l.length > 0);
		assert.deepStrictEqual(logical, [sentence]);
	});

	it("fills background padding rows without polluting the copy", async () => {
		const blue = (t: string) => `\x1b[44m${t}\x1b[49m`;
		const width = 16;
		// paddingY=1 → a blank background row above and below the content.
		const md = new Markdown("hello", 0, 1, defaultMarkdownTheme, { bgColor: blue }, true);
		const lines = md.render(width);
		assert.strictEqual(lines.length, 3); // top pad, content, bottom pad

		const term = await paintLogicalLines(lines, width);

		// Top and bottom padding rows are fully blue-filled via BCE.
		for (const r of [0, 2]) {
			const bgs = rowBgColors(term, r, width);
			assert.ok(
				bgs.every((c) => c === 4),
				`Padding row ${r} should be blue-filled, got: ${bgs.join(",")}`,
			);
		}

		// Copy contains the text with no stray space-runs from the filled rows.
		const logical = term.getLogicalScrollBuffer();
		assert.ok(logical.includes("hello"));
		assert.ok(
			!logical.some((l) => /\S {2,}$/.test(l)),
			`No trailing space-runs expected: ${JSON.stringify(logical)}`,
		);
	});
});

describe("Markdown softWrap blockquotes", () => {
	it("soft-wraps the body, drops the sidebar, and frames top/bottom", () => {
		const quote = "> a fairly long quoted sentence that should soft wrap across the width";
		const width = 20;
		const md = new Markdown(quote, 0, 0, defaultMarkdownTheme, undefined, true);
		const lines = md.render(width);

		const plain = lines.map((l) =>
			stripWrapMarker(l)
				.replace(/\x1b\[[0-9;]*m/g, "")
				.trimEnd(),
		);

		// No sidebar; framed by exactly two horizontal rules.
		assert.ok(!plain.some((l) => l.includes("│")), `Quote should not use a left sidebar: ${JSON.stringify(plain)}`);
		assert.strictEqual(plain.filter((l) => /^─+$/.test(l)).length, 2);

		// The body is a single soft-wrappable logical line that exceeds the width.
		const marked = lines.filter(isWrappableLine);
		assert.ok(marked.length >= 1);
		assert.ok(marked.some((l) => visibleWidth(l) > width));
	});

	it("copies the quote body as one clean line", async () => {
		const body = "a fairly long quoted sentence that should soft wrap across the width";
		const width = 20;
		const md = new Markdown(`> ${body}`, 0, 0, defaultMarkdownTheme, undefined, true);
		const lines = md.render(width);

		const term = await paintLogicalLines(lines, width);
		const logical = term.getLogicalScrollBuffer().map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

		// The quoted text survives as a single logical line (no injected newlines).
		assert.ok(
			logical.some((l) => l.includes(body)),
			`Expected the quote body intact on one line: ${JSON.stringify(logical)}`,
		);
	});
});
