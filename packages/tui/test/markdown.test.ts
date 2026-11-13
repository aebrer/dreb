import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { Chalk } from "chalk";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.js";
import { type Component, TUI } from "../src/tui.js";
import { defaultMarkdownTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// Force full color in CI so ANSI assertions are deterministic
const chalk = new Chalk({ level: 3 });

function getCellItalic(terminal: VirtualTerminal, row: number, col: number): number {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const cell = line.getCell(col);
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	return cell.isItalic();
}

describe("Markdown component", () => {
	describe("Nested lists", () => {
		it("should render simple nested list", () => {
			const markdown = new Markdown(
				`- Item 1
  - Nested 1.1
  - Nested 1.2
- Item 2`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);

			// Check that we have content
			assert.ok(lines.length > 0);

			// Strip ANSI codes for checking
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check structure
			assert.ok(plainLines.some((line) => line.includes("- Item 1")));
			assert.ok(plainLines.some((line) => line.includes("  - Nested 1.1")));
			assert.ok(plainLines.some((line) => line.includes("  - Nested 1.2")));
			assert.ok(plainLines.some((line) => line.includes("- Item 2")));
		});

		it("should render deeply nested list", () => {
			const markdown = new Markdown(
				`- Level 1
  - Level 2
    - Level 3
      - Level 4`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check proper indentation
			assert.ok(plainLines.some((line) => line.includes("- Level 1")));
			assert.ok(plainLines.some((line) => line.includes("  - Level 2")));
			assert.ok(plainLines.some((line) => line.includes("    - Level 3")));
			assert.ok(plainLines.some((line) => line.includes("      - Level 4")));
		});

		it("should render ordered nested list", () => {
			const markdown = new Markdown(
				`1. First
   1. Nested first
   2. Nested second
2. Second`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			assert.ok(plainLines.some((line) => line.includes("1. First")));
			assert.ok(plainLines.some((line) => line.includes("  1. Nested first")));
			assert.ok(plainLines.some((line) => line.includes("  2. Nested second")));
			assert.ok(plainLines.some((line) => line.includes("2. Second")));
		});

		it("should render mixed ordered and unordered nested lists", () => {
			const markdown = new Markdown(
				`1. Ordered item
   - Unordered nested
   - Another nested
2. Second ordered
   - More nested`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			assert.ok(plainLines.some((line) => line.includes("1. Ordered item")));
			assert.ok(plainLines.some((line) => line.includes("  - Unordered nested")));
			assert.ok(plainLines.some((line) => line.includes("2. Second ordered")));
		});

		it("should maintain numbering when code blocks are not indented (LLM output)", () => {
			// When code blocks aren't indented, marked parses each item as a separate list.
			// We use token.start to preserve the original numbering.
			const markdown = new Markdown(
				`1. First item

\`\`\`typescript
// code block
\`\`\`

2. Second item

\`\`\`typescript
// another code block
\`\`\`

3. Third item`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim());

			// Find all lines that start with a number and period
			const numberedLines = plainLines.filter((line) => /^\d+\./.test(line));

			// Should have 3 numbered items
			assert.strictEqual(numberedLines.length, 3, `Expected 3 numbered items, got: ${numberedLines.join(", ")}`);

			// Check the actual numbers
			assert.ok(numberedLines[0].startsWith("1."), `First item should be "1.", got: ${numberedLines[0]}`);
			assert.ok(numberedLines[1].startsWith("2."), `Second item should be "2.", got: ${numberedLines[1]}`);
			assert.ok(numberedLines[2].startsWith("3."), `Third item should be "3.", got: ${numberedLines[2]}`);
		});
	});

	describe("Tables", () => {
		it("should render simple table", () => {
			const markdown = new Markdown(
				`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check table structure
			assert.ok(plainLines.some((line) => line.includes("Name")));
			assert.ok(plainLines.some((line) => line.includes("Age")));
			assert.ok(plainLines.some((line) => line.includes("Alice")));
			assert.ok(plainLines.some((line) => line.includes("Bob")));
			// Check for table borders
			assert.ok(plainLines.some((line) => line.includes("│")));
			assert.ok(plainLines.some((line) => line.includes("─")));
		});

		it("should render row dividers between data rows", () => {
			const markdown = new Markdown(
				`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const dividerLines = plainLines.filter((line) => line.includes("┼"));

			assert.strictEqual(dividerLines.length, 2, "Expected header + row divider");
		});

		it("should keep column width at least the longest word", () => {
			const longestWord = "superlongword";
			const markdown = new Markdown(
				`| Column One | Column Two |
| --- | --- |
| ${longestWord} short | otherword |
| small | tiny |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(32);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const dataLine = plainLines.find((line) => line.includes(longestWord));
			assert.ok(dataLine, "Expected data row containing longest word");

			const segments = dataLine.split("│").slice(1, -1);
			const [firstSegment] = segments;
			assert.ok(firstSegment, "Expected first column segment");
			const firstColumnWidth = firstSegment.length - 2;

			assert.ok(
				firstColumnWidth >= longestWord.length,
				`Expected first column width >= ${longestWord.length}, got ${firstColumnWidth}`,
			);
		});

		it("should render table with alignment", () => {
			const markdown = new Markdown(
				`| Left | Center | Right |
| :--- | :---: | ---: |
| A | B | C |
| Long text | Middle | End |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check headers
			assert.ok(plainLines.some((line) => line.includes("Left")));
			assert.ok(plainLines.some((line) => line.includes("Center")));
			assert.ok(plainLines.some((line) => line.includes("Right")));
			// Check content
			assert.ok(plainLines.some((line) => line.includes("Long text")));
		});

		it("should handle tables with varying column widths", () => {
			const markdown = new Markdown(
				`| Short | Very long column header |
| --- | --- |
| A | This is a much longer cell content |
| B | Short |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);

			// Should render without errors
			assert.ok(lines.length > 0);

			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			assert.ok(plainLines.some((line) => line.includes("Very long column header")));
			assert.ok(plainLines.some((line) => line.includes("This is a much longer cell content")));
		});

		it("should wrap table cells when table exceeds available width", () => {
			const markdown = new Markdown(
				`| Command | Description | Example |
| --- | --- | --- |
| npm install | Install all dependencies | npm install |
| npm run build | Build the project | npm run build |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Render at narrow width that forces wrapping
			const lines = markdown.render(50);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// All lines should fit within width
			for (const line of plainLines) {
				assert.ok(line.length <= 50, `Line exceeds width 50: "${line}" (length: ${line.length})`);
			}

			// Content should still be present (possibly wrapped across lines)
			const allText = plainLines.join(" ");
			assert.ok(allText.includes("Command"), "Should contain 'Command'");
			assert.ok(allText.includes("Description"), "Should contain 'Description'");
			assert.ok(allText.includes("npm install"), "Should contain 'npm install'");
			assert.ok(allText.includes("Install"), "Should contain 'Install'");
		});

		it("should wrap long cell content to multiple lines", () => {
			const markdown = new Markdown(
				`| Header |
| --- |
| This is a very long cell content that should wrap |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Render at width that forces the cell to wrap
			const lines = markdown.render(25);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should have multiple data rows due to wrapping
			const dataRows = plainLines.filter((line) => line.startsWith("│") && !line.includes("─"));
			assert.ok(dataRows.length > 2, `Expected wrapped rows, got ${dataRows.length} rows`);

			// All content should be preserved (may be split across lines)
			const allText = plainLines.join(" ");
			assert.ok(allText.includes("very long"), "Should preserve 'very long'");
			assert.ok(allText.includes("cell content"), "Should preserve 'cell content'");
			assert.ok(allText.includes("should wrap"), "Should preserve 'should wrap'");
		});

		it("should wrap long unbroken tokens inside table cells (not only at line start)", () => {
			const url = "https://example.com/this/is/a/very/long/url/that/should/wrap";
			const markdown = new Markdown(
				`| Value |
| --- |
| prefix ${url} |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const width = 30;
			const lines = markdown.render(width);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			for (const line of plainLines) {
				assert.ok(line.length <= width, `Line exceeds width ${width}: "${line}" (length: ${line.length})`);
			}

			// Borders should stay intact (exactly 2 vertical borders for a 1-col table)
			const tableLines = plainLines.filter((line) => line.startsWith("│"));
			assert.ok(tableLines.length > 0, "Expected table rows to render");
			for (const line of tableLines) {
				const borderCount = line.split("│").length - 1;
				assert.strictEqual(borderCount, 2, `Expected 2 borders, got ${borderCount}: "${line}"`);
			}

			// Strip box drawing characters + whitespace so we can assert the URL is preserved
			// even if it was split across multiple wrapped lines.
			const extracted = plainLines.join("").replace(/[│├┤─\s]/g, "");
			assert.ok(extracted.includes("prefix"), "Should preserve 'prefix'");
			assert.ok(extracted.includes(url), "Should preserve URL");
		});

		it("should wrap styled inline code inside table cells without breaking borders", () => {
			const markdown = new Markdown(
				`| Code |
| --- |
| \`averyveryveryverylongidentifier\` |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const width = 20;
			const lines = markdown.render(width);
			const joinedOutput = lines.join("\n");
			assert.ok(joinedOutput.includes("\x1b[33m"), "Inline code should be styled (yellow)");

			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
			for (const line of plainLines) {
				assert.ok(line.length <= width, `Line exceeds width ${width}: "${line}" (length: ${line.length})`);
			}

			const tableLines = plainLines.filter((line) => line.startsWith("│"));
			for (const line of tableLines) {
				const borderCount = line.split("│").length - 1;
				assert.strictEqual(borderCount, 2, `Expected 2 borders, got ${borderCount}: "${line}"`);
			}
		});

		it("should handle extremely narrow width gracefully", () => {
			const markdown = new Markdown(
				`| A | B | C |
| --- | --- | --- |
| 1 | 2 | 3 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Very narrow width
			const lines = markdown.render(15);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should not crash and should produce output
			assert.ok(lines.length > 0, "Should produce output");

			// Lines should not exceed width
			for (const line of plainLines) {
				assert.ok(line.length <= 15, `Line exceeds width 15: "${line}" (length: ${line.length})`);
			}
		});

		it("should render table correctly when it fits naturally", () => {
			const markdown = new Markdown(
				`| A | B |
| --- | --- |
| 1 | 2 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Wide width where table fits naturally
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should have proper table structure
			const headerLine = plainLines.find((line) => line.includes("A") && line.includes("B"));
			assert.ok(headerLine, "Should have header row");
			assert.ok(headerLine?.includes("│"), "Header should have borders");

			const separatorLine = plainLines.find((line) => line.includes("├") && line.includes("┼"));
			assert.ok(separatorLine, "Should have separator row");

			const dataLine = plainLines.find((line) => line.includes("1") && line.includes("2"));
			assert.ok(dataLine, "Should have data row");
		});

		it("should respect paddingX when calculating table width", () => {
			const markdown = new Markdown(
				`| Column One | Column Two |
| --- | --- |
| Data 1 | Data 2 |`,
				2, // paddingX = 2
				0,
				defaultMarkdownTheme,
			);

			// Width 40 with paddingX=2 means contentWidth=36
			const lines = markdown.render(40);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// All lines should respect width
			for (const line of plainLines) {
				assert.ok(line.length <= 40, `Line exceeds width 40: "${line}" (length: ${line.length})`);
			}

			// Table rows should have left padding
			const tableRow = plainLines.find((line) => line.includes("│"));
			assert.ok(tableRow?.startsWith("  "), "Table should have left padding");
		});

		it("should not add a trailing blank line when table is the last rendered block", () => {
			const markdown = new Markdown(
				`| Name |
| --- |
| Alice |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			assert.notStrictEqual(
				plainLines.at(-1),
				"",
				`Expected table to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	describe("Combined features", () => {
		it("should render lists and tables together", () => {
			const markdown = new Markdown(
				`# Test Document

- Item 1
  - Nested item
- Item 2

| Col1 | Col2 |
| --- | --- |
| A | B |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check heading
			assert.ok(plainLines.some((line) => line.includes("Test Document")));
			// Check list
			assert.ok(plainLines.some((line) => line.includes("- Item 1")));
			assert.ok(plainLines.some((line) => line.includes("  - Nested item")));
			// Check table
			assert.ok(plainLines.some((line) => line.includes("Col1")));
			assert.ok(plainLines.some((line) => line.includes("│")));
		});
	});

	describe("Pre-styled text (thinking traces)", () => {
		it("should preserve gray italic styling after inline code", () => {
			// This replicates how thinking content is rendered in assistant-message.ts
			const markdown = new Markdown(
				"This is thinking with `inline code` and more text after",
				1,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.gray(text),
					italic: true,
				},
			);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// Should contain the inline code block
			assert.ok(joinedOutput.includes("inline code"));

			// The output should have ANSI codes for gray (90) and italic (3)
			assert.ok(joinedOutput.includes("\x1b[90m"), "Should have gray color code");
			assert.ok(joinedOutput.includes("\x1b[3m"), "Should have italic code");

			// Verify that inline code is styled (theme uses yellow)
			const hasCodeColor = joinedOutput.includes("\x1b[33m");
			assert.ok(hasCodeColor, "Should style inline code");
		});

		it("should preserve gray italic styling after bold text", () => {
			const markdown = new Markdown(
				"This is thinking with **bold text** and more after",
				1,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.gray(text),
					italic: true,
				},
			);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// Should contain bold text
			assert.ok(joinedOutput.includes("bold text"));

			// The output should have ANSI codes for gray (90) and italic (3)
			assert.ok(joinedOutput.includes("\x1b[90m"), "Should have gray color code");
			assert.ok(joinedOutput.includes("\x1b[3m"), "Should have italic code");

			// Should have bold codes (1 or 22 for bold on/off)
			assert.ok(joinedOutput.includes("\x1b[1m"), "Should have bold code");
		});

		it("should not leak styles into following lines when rendered in TUI", async () => {
			class MarkdownWithInput implements Component {
				public markdownLineCount = 0;

				constructor(private readonly markdown: Markdown) {}

				render(width: number): string[] {
					const lines = this.markdown.render(width);
					this.markdownLineCount = lines.length;
					return [...lines, "INPUT"];
				}

				invalidate(): void {
					this.markdown.invalidate();
				}
			}

			const markdown = new Markdown("This is thinking with `inline code`", 1, 0, defaultMarkdownTheme, {
				color: (text) => chalk.gray(text),
				italic: true,
			});

			const terminal = new VirtualTerminal(80, 6);
			const tui = new TUI(terminal);
			const component = new MarkdownWithInput(markdown);
			tui.addChild(component);
			tui.start();
			await terminal.flush();

			assert.ok(component.markdownLineCount > 0);
			const inputRow = component.markdownLineCount;
			assert.strictEqual(getCellItalic(terminal, inputRow, 0), 0);
			tui.stop();
		});
	});

	describe("Spacing after code blocks", () => {
		it("should have only one blank line between code block and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

\`\`\`js
const hello = "world";
\`\`\`

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const closingBackticksIndex = plainLines.indexOf("```");
			assert.ok(closingBackticksIndex !== -1, "Should have closing backticks");

			const afterBackticks = plainLines.slice(closingBackticksIndex + 1);
			const emptyLineCount = afterBackticks.findIndex((line) => line !== "");

			assert.strictEqual(
				emptyLineCount,
				1,
				`Expected 1 empty line after code block, but found ${emptyLineCount}. Lines after backticks: ${JSON.stringify(afterBackticks.slice(0, 5))}`,
			);
		});

		it("should normalize paragraph and code block spacing to one blank line", () => {
			const cases = [
				`hello this is text
\`\`\`
code block
\`\`\`
more text`,
				`hello this is text

\`\`\`
code block
\`\`\`

more text`,
			];
			const expectedLines = ["hello this is text", "", "```", "  code block", "```", "", "more text"];

			for (const text of cases) {
				const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80);
				const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

				assert.deepStrictEqual(
					plainLines,
					expectedLines,
					`Unexpected spacing for markdown: ${JSON.stringify(text)}`,
				);
			}
		});

		it("should not add a trailing blank line when code block is the last rendered block", () => {
			const cases = ["```js\nconst hello = 'world';\n```", "hello world\n\n```js\nconst hello = 'world';\n```"];

			for (const text of cases) {
				const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80);
				const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

				assert.notStrictEqual(
					plainLines.at(-1),
					"",
					`Expected code block to end without a blank line: ${JSON.stringify(plainLines)}`,
				);
			}
		});
	});

	describe("Spacing after dividers", () => {
		it("should have only one blank line between divider and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

---

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const dividerIndex = plainLines.findIndex((line) => line.includes("─"));
			assert.ok(dividerIndex !== -1, "Should have divider");

			const afterDivider = plainLines.slice(dividerIndex + 1);
			const emptyLineCount = afterDivider.findIndex((line) => line !== "");

			assert.strictEqual(
				emptyLineCount,
				1,
				`Expected 1 empty line after divider, but found ${emptyLineCount}. Lines after divider: ${JSON.stringify(afterDivider.slice(0, 5))}`,
			);
		});

		it("should not add a trailing blank line when divider is the last rendered block", () => {
			const markdown = new Markdown("---", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			assert.notStrictEqual(
				plainLines.at(-1),
				"",
				`Expected divider to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	describe("Spacing after headings", () => {
		it("should have only one blank line between heading and following paragraph", () => {
			const markdown = new Markdown(
				`# Hello

This is a paragraph`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const headingIndex = plainLines.findIndex((line) => line.includes("Hello"));
			assert.ok(headingIndex !== -1, "Should have heading");

			const afterHeading = plainLines.slice(headingIndex + 1);
			const emptyLineCount = afterHeading.findIndex((line) => line !== "");

			assert.strictEqual(
				emptyLineCount,
				1,
				`Expected 1 empty line after heading, but found ${emptyLineCount}. Lines after heading: ${JSON.stringify(afterHeading.slice(0, 5))}`,
			);
		});

		it("should not add a trailing blank line when heading is the last rendered block", () => {
			const markdown = new Markdown("# Hello", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			assert.notStrictEqual(
				plainLines.at(-1),
				"",
				`Expected heading to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	describe("Spacing after blockquotes", () => {
		it("should have only one blank line between blockquote and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

> This is a quote

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const quoteIndex = plainLines.findIndex((line) => line.includes("This is a quote"));
			assert.ok(quoteIndex !== -1, "Should have blockquote");

			// The quote block now ends with a bottom frame rule; there should be exactly
			// one blank line between that rule and the following paragraph.
			const paragraphIndex = plainLines.findIndex((line) => line.includes("again, hello world"));
			assert.ok(paragraphIndex > quoteIndex, "Should have paragraph after blockquote");
			let blankCount = 0;
			let k = paragraphIndex - 1;
			while (k >= 0 && plainLines[k] === "") {
				blankCount++;
				k--;
			}
			assert.strictEqual(
				blankCount,
				1,
				`Expected 1 empty line after blockquote frame, found ${blankCount}. Lines: ${JSON.stringify(plainLines.slice(quoteIndex, paragraphIndex + 1))}`,
			);
			assert.ok(
				/^─+$/.test(plainLines[k]!),
				`Expected bottom frame rule before the blank line, got: "${plainLines[k]}"`,
			);
		});

		it("should not add a trailing blank line when blockquote is the last rendered block", () => {
			const markdown = new Markdown("> This is a quote", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			assert.notStrictEqual(
				plainLines.at(-1),
				"",
				`Expected blockquote to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	describe("Blockquotes with multiline content", () => {
		it("should apply consistent styling to all lines in lazy continuation blockquote", () => {
			// Markdown "lazy continuation" - second line without > is still part of the quote
			const markdown = new Markdown(
				`>Foo
bar`,
				0,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.magenta(text), // This should NOT be applied to blockquotes
				},
			);

			const lines = markdown.render(80);

			// No sidebar any more: the body lines carry no "│ " prefix, but the quote is
			// framed top and bottom by a rule and the italic styling is preserved.
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			assert.ok(!plainLines.some((line) => line.includes("│")), "Quote should not use a left sidebar");
			const ruleLines = plainLines.filter((line) => /^─+$/.test(line.trimEnd()));
			assert.strictEqual(
				ruleLines.length,
				2,
				`Expected top and bottom frame rules, got: ${JSON.stringify(plainLines)}`,
			);

			// Both lines should have italic (from theme.quote styling)
			const fooLine = lines.find((line) => line.includes("Foo"));
			const barLine = lines.find((line) => line.includes("bar"));
			assert.ok(fooLine, "Should have Foo line");
			assert.ok(barLine, "Should have bar line");

			// Check that both have italic (\x1b[3m) - blockquotes use theme styling, not default message color
			assert.ok(fooLine?.includes("\x1b[3m"), `Foo line should have italic: ${fooLine}`);
			assert.ok(barLine?.includes("\x1b[3m"), `bar line should have italic: ${barLine}`);

			// Blockquotes should NOT have the default message color (magenta)
			assert.ok(!fooLine?.includes("\x1b[35m"), `Foo line should NOT have magenta color: ${fooLine}`);
			assert.ok(!barLine?.includes("\x1b[35m"), `bar line should NOT have magenta color: ${barLine}`);
		});

		it("should apply consistent styling to explicit multiline blockquote", () => {
			const markdown = new Markdown(
				`>Foo
>bar`,
				0,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.cyan(text), // This should NOT be applied to blockquotes
				},
			);

			const lines = markdown.render(80);

			// No sidebar: body lines have no "│ " prefix; the quote is framed top/bottom.
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			assert.ok(!plainLines.some((line) => line.includes("│")), "Quote should not use a left sidebar");
			const ruleLines = plainLines.filter((line) => /^─+$/.test(line.trimEnd()));
			assert.strictEqual(
				ruleLines.length,
				2,
				`Expected top and bottom frame rules, got: ${JSON.stringify(plainLines)}`,
			);

			// Both lines should have italic (from theme.quote styling)
			const fooLine = lines.find((line) => line.includes("Foo"));
			const barLine = lines.find((line) => line.includes("bar"));
			assert.ok(fooLine?.includes("\x1b[3m"), `Foo line should have italic: ${fooLine}`);
			assert.ok(barLine?.includes("\x1b[3m"), `bar line should have italic: ${barLine}`);

			// Blockquotes should NOT have the default message color (cyan)
			assert.ok(!fooLine?.includes("\x1b[36m"), `Foo line should NOT have cyan color: ${fooLine}`);
			assert.ok(!barLine?.includes("\x1b[36m"), `bar line should NOT have cyan color: ${barLine}`);
		});

		it("should render list content inside blockquotes", () => {
			const markdown = new Markdown(
				`> 1. bla bla
> - nested bullet`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const bodyLines = plainLines.filter((line) => !/^─*$/.test(line.trimEnd()));

			assert.ok(!plainLines.some((line) => line.includes("│")), "Quote should not use a left sidebar");
			assert.ok(
				bodyLines.some((line) => line.includes("1. bla bla")),
				`Missing ordered list item: ${JSON.stringify(bodyLines)}`,
			);
			assert.ok(
				bodyLines.some((line) => line.includes("- nested bullet")),
				`Missing unordered list item: ${JSON.stringify(bodyLines)}`,
			);
		});

		it("should wrap long blockquote lines and frame the quote top and bottom", () => {
			const longText = "This is a very long blockquote line that should wrap to multiple lines when rendered";
			const markdown = new Markdown(`> ${longText}`, 0, 0, defaultMarkdownTheme);

			// Render at narrow width to force wrapping
			const lines = markdown.render(30);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Filter to non-empty lines (exclude trailing blank line after blockquote)
			const contentLines = plainLines.filter((line) => line.length > 0);
			const ruleLines = contentLines.filter((line) => /^─+$/.test(line));
			const bodyLines = contentLines.filter((line) => !/^─+$/.test(line));

			// Framed top and bottom; no left sidebar.
			assert.ok(!contentLines.some((line) => line.includes("│")), "Quote should not use a left sidebar");
			assert.strictEqual(
				ruleLines.length,
				2,
				`Expected top and bottom frame rules: ${JSON.stringify(contentLines)}`,
			);
			// Body should wrap to multiple lines.
			assert.ok(bodyLines.length > 1, `Expected multiple wrapped body lines, got: ${JSON.stringify(bodyLines)}`);

			// All content should be preserved
			const allText = bodyLines.join(" ");
			assert.ok(allText.includes("very long"), "Should preserve 'very long'");
			assert.ok(allText.includes("blockquote"), "Should preserve 'blockquote'");
			assert.ok(allText.includes("multiple"), "Should preserve 'multiple'");
		});

		it("should style wrapped blockquote body lines without a sidebar", () => {
			const markdown = new Markdown(
				"> This is styled text that is long enough to wrap",
				0,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.yellow(text), // This should NOT be applied to blockquotes
					italic: true,
				},
			);

			const lines = markdown.render(25);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// No sidebar on any line.
			assert.ok(!plainLines.some((line) => line.includes("│")), "Quote should not use a left sidebar");

			// Check that italic is applied (from theme.quote)
			const allOutput = lines.join("\n");
			assert.ok(allOutput.includes("\x1b[3m"), "Should have italic");

			// Blockquotes should NOT have the default message color (yellow)
			assert.ok(!allOutput.includes("\x1b[33m"), "Should NOT have yellow color from default style");
		});

		it("should render inline formatting inside blockquotes and reapply quote styling after", () => {
			const markdown = new Markdown("> Quote with **bold** and `code`", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Quote is framed top/bottom (no sidebar).
			assert.ok(!plainLines.some((line) => line.includes("│")), "Quote should not use a left sidebar");
			assert.ok(
				plainLines.some((line) => /^─+$/.test(line.trimEnd())),
				"Should have a quote frame rule",
			);

			// Content should be preserved
			const allPlain = plainLines.join(" ");
			assert.ok(allPlain.includes("Quote with"), "Should preserve 'Quote with'");
			assert.ok(allPlain.includes("bold"), "Should preserve 'bold'");
			assert.ok(allPlain.includes("code"), "Should preserve 'code'");

			const allOutput = lines.join("\n");

			// Should have bold styling (\x1b[1m)
			assert.ok(allOutput.includes("\x1b[1m"), "Should have bold styling");

			// Should have code styling (yellow = \x1b[33m from defaultMarkdownTheme)
			assert.ok(allOutput.includes("\x1b[33m"), "Should have code styling (yellow)");

			// Should have italic from quote styling (\x1b[3m)
			assert.ok(allOutput.includes("\x1b[3m"), "Should have italic from quote styling");
		});
	});

	describe("Heading with inline code", () => {
		it("should preserve heading styling after inline code", () => {
			const markdown = new Markdown("### Why `sourceInfo` should not be optional", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// The heading theme is bold+cyan. After the yellow inline code, the heading
			// styling (bold+cyan) must be restored so subsequent text is styled correctly.
			// bold = \x1b[1m, cyan = \x1b[36m, yellow = \x1b[33m
			assert.ok(joinedOutput.includes("\x1b[33m"), "Should have yellow for inline code");

			// Find the position of "should not be optional" in the raw output.
			// It must be preceded by heading style codes (bold+cyan), not appear unstyled.
			const afterCodeIndex = joinedOutput.indexOf("should not be optional");
			assert.ok(afterCodeIndex > 0, "Should contain text after inline code");

			// Look at the ANSI codes between the code span end and "should not be optional".
			// There should be bold (\x1b[1m) and cyan (\x1b[36m) re-applied.
			const precedingChunk = joinedOutput.slice(Math.max(0, afterCodeIndex - 40), afterCodeIndex);
			assert.ok(
				precedingChunk.includes("\x1b[1m"),
				`Should re-apply bold before text after code: ${precedingChunk}`,
			);
			assert.ok(
				precedingChunk.includes("\x1b[36m"),
				`Should re-apply cyan before text after code: ${precedingChunk}`,
			);
		});

		it("should preserve heading styling after inline code for h1", () => {
			const markdown = new Markdown("# Title with `code` inside", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			const afterCodeIndex = joinedOutput.indexOf("inside");
			assert.ok(afterCodeIndex > 0, "Should contain text after inline code");

			const precedingChunk = joinedOutput.slice(Math.max(0, afterCodeIndex - 40), afterCodeIndex);
			// H1 uses heading + bold + underline
			assert.ok(precedingChunk.includes("\x1b[1m"), `Should re-apply bold for h1: ${precedingChunk}`);
			assert.ok(precedingChunk.includes("\x1b[36m"), `Should re-apply cyan for h1: ${precedingChunk}`);
			assert.ok(precedingChunk.includes("\x1b[4m"), `Should re-apply underline for h1: ${precedingChunk}`);
		});

		it("should preserve heading styling after bold text", () => {
			const markdown = new Markdown("## Heading with **bold** and more", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			const afterBoldIndex = joinedOutput.indexOf("and more");
			assert.ok(afterBoldIndex > 0, "Should contain text after bold");

			const precedingChunk = joinedOutput.slice(Math.max(0, afterBoldIndex - 40), afterBoldIndex);
			assert.ok(precedingChunk.includes("\x1b[1m"), `Should re-apply bold for h2: ${precedingChunk}`);
			assert.ok(precedingChunk.includes("\x1b[36m"), `Should re-apply cyan for h2: ${precedingChunk}`);
		});
	});

	describe("Links", () => {
		it("should not duplicate URL for autolinked emails", () => {
			const markdown = new Markdown("Contact user@example.com for help", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// Should contain the email once, not duplicated with mailto:
			assert.ok(joinedPlain.includes("user@example.com"), "Should contain email");
			assert.ok(!joinedPlain.includes("mailto:"), "Should not show mailto: prefix for autolinked emails");
		});

		it("should not duplicate URL for bare URLs", () => {
			const markdown = new Markdown("Visit https://example.com for more", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// URL should appear only once
			const urlCount = (joinedPlain.match(/https:\/\/example\.com/g) || []).length;
			assert.strictEqual(urlCount, 1, "URL should appear exactly once");
		});

		it("should show URL for explicit markdown links with different text", () => {
			const markdown = new Markdown("[click here](https://example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// Should show both link text and URL
			assert.ok(joinedPlain.includes("click here"), "Should contain link text");
			assert.ok(joinedPlain.includes("(https://example.com)"), "Should show URL in parentheses");
		});

		it("should show URL for explicit mailto links with different text", () => {
			const markdown = new Markdown("[Email me](mailto:test@example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// Should show both link text and mailto URL
			assert.ok(joinedPlain.includes("Email me"), "Should contain link text");
			assert.ok(joinedPlain.includes("(mailto:test@example.com)"), "Should show mailto URL in parentheses");
		});
	});

	describe("HTML-like tags in text", () => {
		it("should render content with HTML-like tags as text", () => {
			// When the model emits something like <thinking>content</thinking> in regular text,
			// marked might treat it as HTML and hide the content
			const markdown = new Markdown(
				"This is text with <thinking>hidden content</thinking> that should be visible",
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// The content inside the tags should be visible
			assert.ok(
				joinedPlain.includes("hidden content") || joinedPlain.includes("<thinking>"),
				"Should render HTML-like tags or their content as text, not hide them",
			);
		});

		it("should render HTML tags in code blocks correctly", () => {
			const markdown = new Markdown("```html\n<div>Some HTML</div>\n```", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join("\n");

			// HTML in code blocks should be visible
			assert.ok(
				joinedPlain.includes("<div>") && joinedPlain.includes("</div>"),
				"Should render HTML in code blocks",
			);
		});
	});

	describe("Spacing after HTML blocks", () => {
		it("should have one blank line between an HTML block and the following paragraph", () => {
			const markdown = new Markdown("<div>hi</div>\n\ntext", 0, 0, defaultMarkdownTheme);
			const plainLines = markdown.render(80).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			assert.deepStrictEqual(plainLines, ["<div>hi</div>", "", "text"]);
		});
	});

	describe("Strikethrough (GitHub GFM parity)", () => {
		// The reported bug: `~` used as "approximately" turned unrelated text into
		// strikethrough, and could even close on a `~` inside an inline code span.
		const REPORTED =
			'Starting from the first ~ in "~7 percent vs ~12 percent", the 7 passes the lookahead, but the next `~` sits after a space, so nothing ends a valid match there.';

		// Bracket markers make strikethrough and code-span boundaries exact in assertions.
		const markerTheme = {
			...defaultMarkdownTheme,
			strikethrough: (text: string) => `[del]${text}[/del]`,
			code: (text: string) => `[code]${text}[/code]`,
		};

		function renderInline(text: string): string {
			const markdown = new Markdown(text, 0, 0, markerTheme);
			return markdown
				.render(400)
				.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
				.join("\n");
		}

		// Expected output for each input matches GitHub's GFM renderer.
		const cases: Array<{ name: string; input: string; expected: string }> = [
			{
				name: "reported example: no strikethrough, code span intact",
				input: REPORTED,
				expected:
					'Starting from the first ~ in "~7 percent vs ~12 percent", the 7 passes the lookahead, but the next [code]~[/code] sits after a space, so nothing ends a valid match there.',
			},
			{
				name: "approximate values with a code-span tilde",
				input: "about ~7 percent vs ~12 percent (see `~`)",
				expected: "about ~7 percent vs ~12 percent (see [code]~[/code])",
			},
			{
				name: "tilde after punctuation and before a word cannot close",
				input: "(~7 percent) vs (~12 percent)",
				expected: "(~7 percent) vs (~12 percent)",
			},
			{
				name: "intra-word tildes still strike",
				input: "range 5~7 and 10~12",
				expected: "range 5[del]7 and 10[/del]12",
			},
			{
				name: "double and single tilde strikethrough still work",
				input: "~~real strike~~ and ~single strike~",
				expected: "[del]real strike[/del] and [del]single strike[/del]",
			},
			{
				name: "double tilde opening after a space still strikes",
				input: "word ~~real strike~~ here",
				expected: "word [del]real strike[/del] here",
			},
			{
				name: "single tilde opening after a space still strikes",
				input: "a ~single~ b",
				expected: "a [del]single[/del] b",
			},
		];

		for (const { name, input, expected } of cases) {
			it(name, () => {
				assert.strictEqual(renderInline(input), expected);
			});
		}

		it("does not emit the strikethrough SGR for the reported example with the real theme", () => {
			const markdown = new Markdown(REPORTED, 0, 0, defaultMarkdownTheme);
			const rendered = markdown.render(400).join("\n");

			assert.ok(!rendered.includes("\x1b[9m"), `Unexpected strikethrough in ${JSON.stringify(rendered)}`);
			assert.ok(rendered.includes(chalk.yellow("~")), "Expected the `~` code span to be styled as inline code");
		});

		it("emits the strikethrough SGR for intentional strikethrough with the real theme", () => {
			const markdown = new Markdown("~~done~~", 0, 0, defaultMarkdownTheme);
			const rendered = markdown.render(80).join("\n");

			assert.ok(
				rendered.includes(chalk.strikethrough("done")),
				`Expected strikethrough in ${JSON.stringify(rendered)}`,
			);
		});
	});

	describe("Character references and terminal safety", () => {
		// Identity theme: every control character in the output came from the markdown content.
		const plainTheme: MarkdownTheme = {
			heading: (text) => text,
			link: (text) => text,
			linkUrl: (text) => text,
			code: (text) => text,
			codeBlock: (text) => text,
			codeBlockBorder: (text) => text,
			quote: (text) => text,
			quoteBorder: (text) => text,
			hr: (text) => text,
			listBullet: (text) => text,
			bold: (text) => text,
			italic: (text) => text,
			strikethrough: (text) => text,
			underline: (text) => text,
		};
		const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

		function renderPlain(text: string): string[] {
			return new Markdown(text, 0, 0, plainTheme).render(200).map((line) => line.trimEnd());
		}

		function assertTerminalSafe(lines: string[], input: string): void {
			for (const line of lines) {
				assert.ok(!UNSAFE.test(line), `Control character from ${JSON.stringify(input)} in ${JSON.stringify(line)}`);
			}
		}

		// marked 18 decodes numeric character references in text, so these would otherwise
		// reach the terminal as ESC/CSI/OSC sequences, a CR, a BEL, or a bidi override.
		const decodedControls: Array<{ name: string; input: string; expected: string[] }> = [
			{ name: "CSI erase display", input: "before &#27;[2J after", expected: ["before [2J after"] },
			{
				name: "OSC 52 clipboard write",
				input: "osc &#27;]52;c;aGVsbG8=&#7; end",
				expected: ["osc ]52;c;aGVsbG8= end"],
			},
			{ name: "hex escape with SGR", input: "x &#x1b;[31mRED&#x1B;[0m y", expected: ["x [31mRED[0m y"] },
			{ name: "C1 CSI", input: "c1 &#155;31m x", expected: ["c1 31m x"] },
			{ name: "DEL", input: "del &#127; x", expected: ["del  x"] },
			{ name: "bidi override", input: "bidi &#8238;txet", expected: ["bidi txet"] },
			{ name: "carriage return", input: "one&#13;two", expected: ["one", "two"] },
			{ name: "tab", input: "tab&#9;tab", expected: ["tab   tab"] },
		];

		for (const { name, input, expected } of decodedControls) {
			it(`strips decoded control characters: ${name}`, () => {
				const lines = renderPlain(input);
				assertTerminalSafe(lines, input);
				assert.deepStrictEqual(lines, expected);
			});
		}

		it("strips decoded control characters in every inline context", () => {
			// ESC c (RIS) resets the whole terminal.
			const inputs = [
				"# heading &#27;cRESET",
				"**bold &#27;cRESET**",
				"- item &#27;cRESET",
				"| a |\n|---|\n| cell &#27;cRESET |",
				"[link &#27;cRESET](https://example.com)",
				"> quote &#27;cRESET",
				"~~struck &#27;cRESET~~",
			];
			for (const input of inputs) {
				const lines = renderPlain(input);
				assertTerminalSafe(lines, input);
				assert.ok(lines.join("\n").includes(" cRESET"), `Expected visible text for ${JSON.stringify(input)}`);
			}
		});

		it("strips raw control characters from every token type", () => {
			const inputs = [
				"raw \x1b[2J text",
				"`code \x1b[31m span`",
				"```\nfenced \x1b]52;c;aGk=\x07 code\n```",
				"    indented \x1b[2J code",
				"inline <b>\x1b[31m</b> html",
				"<div>\x1b[2J</div>",
				"[link](https://example.com/\x1b[2J)",
				"bidi \u202Etxet",
			];
			for (const input of inputs) {
				assertTerminalSafe(renderPlain(input), input);
			}
		});

		it("keeps character references inside code spans literal", () => {
			assert.deepStrictEqual(renderPlain("`&#27;[2J`"), ["&#27;[2J"]);
		});

		const ampersandCases: Array<{ input: string; expected: string }> = [
			// marked 18 encodes bare `&` as `&amp;` in any text run with a numeric reference.
			{ input: "Q&A &#8212; R&D", expected: "Q&A — R&D" },
			{ input: "Tom &#38; Jerry", expected: "Tom & Jerry" },
			{ input: "it&#39;s fine & dandy", expected: "it's fine & dandy" },
			{ input: "Q&A plain R&D", expected: "Q&A plain R&D" },
			{ input: "write &amp; here", expected: "write & here" },
		];

		for (const { input, expected } of ampersandCases) {
			it(`renders ampersands as written: ${input}`, () => {
				assert.deepStrictEqual(renderPlain(input), [expected]);
			});
		}

		it("renders ampersands as written in headings, list items and table cells", () => {
			assert.deepStrictEqual(renderPlain("## Q&A &#8212; R&D"), ["Q&A — R&D"]);
			assert.deepStrictEqual(renderPlain("- Q&A &#8212; R&D"), ["- Q&A — R&D"]);
			assert.ok(renderPlain("| h |\n|---|\n| Q&A &#8212; R&D |").some((line) => line.includes("Q&A — R&D")));
		});
	});

	describe("Indented code blocks", () => {
		const identity = (text: string) => text;
		const theme: MarkdownTheme = { ...defaultMarkdownTheme, codeBlock: identity, codeBlockBorder: identity };

		function render(text: string, overrides: Partial<MarkdownTheme> = {}): string[] {
			return new Markdown(text, 0, 0, { ...theme, ...overrides })
				.render(80)
				.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
		}

		it("does not render the terminating newline as an extra row", () => {
			assert.deepStrictEqual(render("    code\n"), ["```", "  code", "```"]);
		});

		it("keeps blank lines inside the block but not after it", () => {
			assert.deepStrictEqual(render("    a\n\n    b\n"), ["```", "  a", "", "  b", "```"]);
		});

		it("does not add a trailing row when highlighted", () => {
			const highlightCode = (code: string) => code.split("\n");
			assert.deepStrictEqual(render("    code\n", { highlightCode }), ["```", "  code", "```"]);
		});

		it("does not add a trailing row inside a list item", () => {
			assert.deepStrictEqual(render("- item\n\n      code1\n      code2\n\n- next"), [
				"- item",
				"  ```",
				"    code1",
				"    code2",
				"  ```",
				"- next",
			]);
		});
	});

	describe("List item continuation lines", () => {
		function render(text: string): string[] {
			return new Markdown(text, 0, 0, defaultMarkdownTheme)
				.render(80)
				.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
		}

		// A continuation indented past the item's content is lexed as indented code and merged
		// into the item's text, terminating newline included.
		it("adds no empty row after a deeply indented continuation in a loose list", () => {
			assert.deepStrictEqual(render("- a\n      b\n\n- c"), ["- a", "  b", "- c"]);
			assert.deepStrictEqual(render("1. a\n       b\n\n2. c"), ["1. a", "  b", "2. c"]);
			assert.deepStrictEqual(render("- a\n      b\n      c\n\n- d"), ["- a", "  b", "  c", "- d"]);
		});

		it("adds no empty row when the continuation ends with inline formatting", () => {
			assert.deepStrictEqual(render("- a\n      **b**\n\n- c"), ["- a", "  b", "- c"]);
			assert.deepStrictEqual(render("- a\n      b `c`\n\n- d"), ["- a", "  b c", "- d"]);
		});

		it("adds no empty row before a nested list that follows the continuation", () => {
			assert.deepStrictEqual(render("- a\n      b\n  - n\n- c"), ["- a", "  b", "  - n", "- c"]);
		});
	});

	describe("Link reference definitions", () => {
		function render(text: string): string[] {
			return new Markdown(text, 0, 0, defaultMarkdownTheme)
				.render(80)
				.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
		}

		it("adds no blank row before the content that follows a leading definition", () => {
			assert.deepStrictEqual(render("[ref]: /url\n\n[ref]"), ["ref (/url)"]);
		});

		it("keeps a single blank row between paragraphs around a definition", () => {
			assert.deepStrictEqual(render("before\n\n[ref]: /url\n\nafter"), ["before", "", "after"]);
		});

		it("adds no blank rows for consecutive definitions", () => {
			assert.deepStrictEqual(render("[a]: /a\n\n[b]: /b\n\n[a] [b]"), ["a (/a) b (/b)"]);
			assert.deepStrictEqual(render("[a]: /a\n[b]: /b\n\n[a] [b]"), ["a (/a) b (/b)"]);
		});

		it("keeps a single blank row after a heading followed by a definition", () => {
			assert.deepStrictEqual(render("# H\n\n[ref]: /url\n\ntext [ref]"), ["H", "", "text ref (/url)"]);
		});

		it("adds no blank row for a definition inside a blockquote", () => {
			const lines = render("> q\n>\n> [r]: /u\n>\n> [r]");
			assert.deepStrictEqual(lines.slice(1, -1), ["q", "", "r (/u)"]);
		});

		it("adds no trailing blank row for definitions that end the document", () => {
			assert.deepStrictEqual(render("# H\n\n[r]: /url"), ["H"]);
			assert.deepStrictEqual(render("# H\n\n[r]: /url\n\n"), ["H"]);
			assert.deepStrictEqual(render("    code\n\n[r]: /url"), ["```", "  code", "```"]);
			assert.deepStrictEqual(render("See [docs][1].\n\n[1]: https://example.com\n[2]: https://b.example"), [
				"See docs (https://example.com).",
			]);
		});

		it("keeps the blank row between blocks around a run of definitions", () => {
			assert.deepStrictEqual(render("before\n\n[a]: /a\n[b]: /b\n\nafter [a]"), ["before", "", "after a (/a)"]);
		});
	});
});
