import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "../src/components/editor.js";
import { TUI } from "../src/tui.js";
import { visibleWidth } from "../src/utils.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

/** Create a TUI with a virtual terminal for testing */
function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

describe("Editor ghost text", () => {
	describe("setGhostText / getGhostText", () => {
		it("starts with null ghost text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			assert.strictEqual(editor.getGhostText(), null);
		});

		it("stores ghost text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setGhostText("/skill:mach6-plan 42");
			assert.strictEqual(editor.getGhostText(), "/skill:mach6-plan 42");
		});

		it("clears ghost text with null", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setGhostText("/skill:mach6-plan 42");
			editor.setGhostText(null);
			assert.strictEqual(editor.getGhostText(), null);
		});
	});

	describe("rendering", () => {
		it("renders ghost text with dim ANSI when editor is empty", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setGhostText("/skill:mach6-push");

			const lines = editor.render(40);
			// The content line (between borders) should contain the ghost text
			const contentLine = lines[1]; // First line is top border
			assert.ok(contentLine, "Content line should exist");
			assert.ok(contentLine.includes("/skill:mach6-push"), "Should contain ghost text");
			// Should contain dim escape code
			assert.ok(contentLine.includes("\x1b[2m"), "Should contain dim ANSI code");
		});

		it("does not render ghost text when editor has content", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setGhostText("/skill:mach6-push");
			editor.setText("hello");

			const lines = editor.render(40);
			const contentLine = lines[1];
			assert.ok(contentLine, "Content line should exist");
			// Ghost text should NOT appear
			assert.ok(!contentLine.includes("/skill:mach6-push"), "Should not contain ghost text when editor has content");
		});

		it("truncates ghost text to available width", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setGhostText("/skill:mach6-plan-with-a-very-long-argument 12345");

			// Render with narrow width - cursor takes 1 col
			const lines = editor.render(20);
			const contentLine = lines[1];
			assert.ok(contentLine, "Content line should exist");
			// The stripped content should fit within 20 chars
			const stripped = stripVTControlCharacters(contentLine);
			assert.ok(visibleWidth(stripped) <= 20, `Line width ${visibleWidth(stripped)} should be <= 20`);
		});
	});

	describe("Tab to accept", () => {
		it("Tab accepts ghost text into editor content", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setGhostText("/skill:mach6-push");

			editor.handleInput("\t"); // Tab

			assert.strictEqual(editor.getText(), "/skill:mach6-push");
			assert.strictEqual(editor.getGhostText(), null);
		});

		it("Tab does not accept ghost text when editor has content", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setText("hello");
			editor.setGhostText("/skill:mach6-push");

			editor.handleInput("\t"); // Tab

			// Ghost text should have been cleared by setText, but even if set manually,
			// editor is not empty so Tab should not accept
			assert.notStrictEqual(editor.getText(), "/skill:mach6-push");
		});
	});

	describe("dismiss on input", () => {
		it("clears ghost text on character input", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setGhostText("/skill:mach6-push");

			editor.handleInput("a");

			assert.strictEqual(editor.getGhostText(), null);
		});

		it("clears ghost text on Escape", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setGhostText("/skill:mach6-push");

			editor.handleInput("\x1b"); // Escape

			assert.strictEqual(editor.getGhostText(), null);
		});

		it("clears ghost text on arrow key", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setGhostText("/skill:mach6-push");

			editor.handleInput("\x1b[C"); // Right arrow

			assert.strictEqual(editor.getGhostText(), null);
		});

		it("does not clear ghost text on Tab (Tab accepts instead)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setGhostText("/skill:mach6-push");

			// Tab should accept, not just clear
			editor.handleInput("\t");

			// Ghost text cleared because it was accepted
			assert.strictEqual(editor.getGhostText(), null);
			// Content should be the ghost text
			assert.strictEqual(editor.getText(), "/skill:mach6-push");
		});
	});
});
