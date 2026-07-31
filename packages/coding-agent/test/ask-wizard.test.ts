import { setKeybindings, TUI } from "@dreb/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import type { AskRequest, AskResult } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AskWizardComponent } from "../src/modes/interactive/components/ask-wizard.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\n";
const ESC = "\x1b";
const SPACE = " ";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

function mount(request: AskRequest) {
	const onSubmit = vi.fn<(result: AskResult) => void>();
	const onStop = vi.fn<() => void>();
	const component = new AskWizardComponent(request, onSubmit, onStop);
	component.focused = true;
	return { component, onSubmit, onStop };
}

/** Mount with a real TUI so countdown and multiline `Editor` branches work. */
function mountWithTui(request: AskRequest, timeout?: number) {
	const tui = new TUI(new VirtualTerminal(80, 24));
	const onSubmit = vi.fn<(result: AskResult) => void>();
	const onStop = vi.fn<() => void>();
	const component = new AskWizardComponent(request, onSubmit, onStop, { tui, timeout });
	component.focused = true;
	return { component, onSubmit, onStop, tui };
}

function type(component: AskWizardComponent, text: string) {
	for (const char of text) component.handleInput(char);
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("AskWizardComponent", () => {
	describe("single question (inline, no tab strip)", () => {
		it("renders the question via the TUI Markdown component and no tab strip", () => {
			const { component } = mount({ questions: [{ question: "Use **bold** and `code`", options: ["A", "B"] }] });
			const rendered = stripAnsi(component.render(80).join("\n"));
			expect(rendered).toContain("bold");
			expect(rendered).toContain("code");
			expect(rendered).not.toContain("**bold**");
			// No "✔ Submit" tab for a single question.
			expect(rendered).not.toContain("Submit");
		});

		it("Enter picks the highlighted option and submits the batch", () => {
			const { component, onSubmit } = mount({
				questions: [{ question: "DB?", options: ["SQLite", "Postgres", "JSON"] }],
			});
			component.handleInput(DOWN); // move to Postgres
			component.handleInput(ENTER);
			expect(onSubmit).toHaveBeenCalledWith({ answers: [{ selected: ["Postgres"], customText: undefined }] });
		});

		it("a numbered shortcut selects an option, and Enter submits it", () => {
			const { component, onSubmit } = mount({ questions: [{ question: "DB?", options: ["SQLite", "Postgres"] }] });
			component.handleInput("2"); // Postgres
			component.handleInput(ENTER);
			expect(onSubmit).toHaveBeenCalledWith({ answers: [{ selected: ["Postgres"], customText: undefined }] });
		});

		it("combines a picked option with typed free text", () => {
			const { component, onSubmit } = mount({ questions: [{ question: "DB?", options: ["SQLite", "Postgres"] }] });
			component.handleInput(DOWN); // Postgres
			component.handleInput(DOWN); // free-text row
			type(component, "duckdb");
			component.handleInput(UP); // back to Postgres, keeping typed text
			component.handleInput(ENTER);
			expect(onSubmit).toHaveBeenCalledWith({ answers: [{ selected: ["Postgres"], customText: "duckdb" }] });
		});

		it("submits only once even if Enter is pressed repeatedly", () => {
			const { component, onSubmit } = mount({ questions: [{ question: "DB?", options: ["a", "b"] }] });
			component.handleInput(ENTER);
			component.handleInput(ENTER);
			expect(onSubmit).toHaveBeenCalledTimes(1);
		});
	});

	describe("multiple questions (tabbed)", () => {
		const twoQuestions: AskRequest = {
			questions: [
				{ question: "Pick a DB", title: "Database", options: ["SQLite", "Postgres"] },
				{ question: "Which checks?", title: "Checks", options: ["unit", "types"], multiSelect: true },
			],
		};

		it("shows a tab strip with the first tab active by default", () => {
			const { component } = mount(twoQuestions);
			const rendered = stripAnsi(component.render(80).join("\n"));
			expect(rendered).toContain("1.");
			expect(rendered).toContain("Database");
			expect(rendered).toContain("Checks");
			expect(rendered).toContain("✔ Submit");
			// The first question's panel is shown.
			expect(rendered).toContain("Pick a DB");
		});

		it("a digit selects (single) and marks the question answered", () => {
			const { component } = mount(twoQuestions);
			component.handleInput("1"); // SQLite on tab 0
			const rendered = stripAnsi(component.render(80).join("\n"));
			// Answered marker for question 1, unanswered for question 2.
			expect(rendered).toContain("1.● Database");
			expect(rendered).toContain("2.○ Checks");
		});

		it("↑/↓ move the cursor within a question", () => {
			const { component, onSubmit } = mount(twoQuestions);
			component.handleInput(DOWN); // move to Postgres
			component.handleInput(ENTER); // pick Postgres, advance to tab 1
			component.handleInput(SPACE); // toggle "unit" on the multi-select tab
			// Now on tab 1 (Checks). Jump to review and submit.
			component.handleInput(TAB); // -> review tab
			component.handleInput(ENTER);
			expect(onSubmit).toHaveBeenCalledWith({
				answers: [
					{ selected: ["Postgres"], customText: undefined },
					{ selected: ["unit"], customText: undefined },
				],
			});
		});

		it("Tab and Shift+Tab switch tabs and wrap around", () => {
			const { component } = mount(twoQuestions);
			// tab0 -> tab1 -> review -> wrap to tab0
			component.handleInput(TAB);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("Which checks?");
			component.handleInput(TAB); // review
			expect(stripAnsi(component.render(80).join("\n"))).toContain("Review your answers");
			component.handleInput(TAB); // wrap back to tab0
			expect(stripAnsi(component.render(80).join("\n"))).toContain("Pick a DB");
			// Shift+Tab wraps backward to the review tab.
			component.handleInput(SHIFT_TAB);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("Review your answers");
		});

		it("multiSelect toggles with the number key and Space", () => {
			const { component, onSubmit } = mount(twoQuestions);
			component.handleInput("1"); // SQLite (tab 0)
			component.handleInput(TAB); // -> tab 1 (Checks)
			component.handleInput("1"); // toggle "unit"
			component.handleInput("2"); // toggle "types"
			component.handleInput("2"); // toggle "types" off again
			component.handleInput(TAB); // -> review
			component.handleInput(ENTER);
			expect(onSubmit).toHaveBeenCalledWith({
				answers: [
					{ selected: ["SQLite"], customText: undefined },
					{ selected: ["unit"], customText: undefined },
				],
			});
		});

		it("an unanswered question comes back skipped", () => {
			const { component, onSubmit } = mount(twoQuestions);
			component.handleInput("1"); // answer only the first question
			// Jump straight to review (tab0 -> tab1 -> review) and submit.
			component.handleInput(TAB);
			component.handleInput(TAB);
			component.handleInput(ENTER);
			expect(onSubmit).toHaveBeenCalledWith({
				answers: [
					{ selected: ["SQLite"], customText: undefined },
					{ selected: [], skipped: true },
				],
			});
		});

		it("the review tab summarizes every answer", () => {
			const { component } = mount(twoQuestions);
			component.handleInput("1"); // SQLite
			component.handleInput(TAB);
			component.handleInput(TAB); // review
			const rendered = stripAnsi(component.render(80).join("\n"));
			expect(rendered).toContain("Review your answers");
			expect(rendered).toContain("SQLite");
			expect(rendered).toContain("(unanswered)");
		});

		it("retains typed free text across tab switches", () => {
			const request: AskRequest = {
				questions: [
					{ question: "Name?", title: "Name" },
					{ question: "Nick?", title: "Nick" },
				],
			};
			const { component, onSubmit } = mount(request);
			// Cursor starts on the free-text field for a field-only question.
			type(component, "Ada");
			component.handleInput(TAB); // -> tab 1
			type(component, "Countess");
			component.handleInput(SHIFT_TAB); // back to tab 0 — text must persist
			const rendered = stripAnsi(component.render(80).join("\n"));
			expect(rendered).toContain("Ada");
			component.handleInput(TAB); // tab 1
			component.handleInput(TAB); // review
			component.handleInput(ENTER);
			expect(onSubmit).toHaveBeenCalledWith({
				answers: [
					{ selected: [], customText: "Ada" },
					{ selected: [], customText: "Countess" },
				],
			});
		});

		it("←/→ switch tabs when the cursor is not on the free-text field", () => {
			const { component } = mount(twoQuestions);
			component.handleInput(RIGHT); // -> tab 1
			expect(stripAnsi(component.render(80).join("\n"))).toContain("Which checks?");
			component.handleInput(LEFT); // -> tab 0
			expect(stripAnsi(component.render(80).join("\n"))).toContain("Pick a DB");
		});
	});

	describe("stopping", () => {
		it("Esc stops the current agent turn", () => {
			const { component, onSubmit, onStop } = mount({ questions: [{ question: "DB?", options: ["a", "b"] }] });
			component.handleInput(ESC);
			expect(onStop).toHaveBeenCalledTimes(1);
			expect(onSubmit).not.toHaveBeenCalled();
		});
	});

	describe("timeout", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("expiry stops the turn exactly once", () => {
			vi.useFakeTimers();
			const { component, onSubmit, onStop } = mountWithTui(
				{ questions: [{ question: "DB?", options: ["a", "b"] }] },
				2000,
			);
			vi.advanceTimersByTime(2100);
			expect(onStop).toHaveBeenCalledTimes(1);
			expect(onSubmit).not.toHaveBeenCalled();
			component.dispose();
		});
	});

	describe("multiline (real Editor branch)", () => {
		const CR = "\r"; // Enter → advance/submit
		const LF = "\n"; // bare LF → newline in the Editor

		it("inserts newlines without submitting, then submits the multi-line answer", () => {
			const { component, onSubmit } = mountWithTui({ questions: [{ question: "Describe", multiline: true }] });
			type(component, "line1");
			component.handleInput(LF); // newline, not a submit
			type(component, "line2");
			expect(onSubmit).not.toHaveBeenCalled();
			component.handleInput(CR); // Enter submits
			expect(onSubmit).toHaveBeenCalledWith({ answers: [{ selected: [], customText: "line1\nline2" }] });
		});

		it("dispose is safe and idempotent", () => {
			const { component } = mountWithTui({ questions: [{ question: "Describe", multiline: true }] });
			expect(() => {
				component.dispose();
				component.dispose();
			}).not.toThrow();
		});
	});

	describe("visual polish", () => {
		it("bounds the wizard with accent horizontal rules top and bottom", () => {
			const { component } = mount({ questions: [{ question: "DB?", options: ["a", "b"] }] });
			const lines = component.render(80);
			expect(stripAnsi(lines[0])).toMatch(/^─+$/);
			expect(stripAnsi(lines[lines.length - 1])).toMatch(/^─+$/);
		});

		it("does not draw a radio glyph for single-select options (checkmark only)", () => {
			const { component } = mount({ questions: [{ question: "DB?", options: ["SQLite", "Postgres"] }] });
			let rendered = stripAnsi(component.render(80).join("\n"));
			expect(rendered).not.toContain("(•)");
			expect(rendered).not.toContain("( )");
			component.handleInput("1"); // choose SQLite
			rendered = stripAnsi(component.render(80).join("\n"));
			expect(rendered).toContain("✔ SQLite");
		});

		it("shows the full title for the active tab and truncates the rest", () => {
			const { component } = mount({
				questions: [
					{ question: "Q1", title: "Cooking vs. Order or Delivery" },
					{ question: "Q2", title: "Effort Level and Time Available" },
				],
			});
			// Tab 0 active: its full title shows, tab 1 truncates with an ellipsis.
			let rendered = stripAnsi(component.render(120).join("\n"));
			expect(rendered).toContain("Cooking vs. Order or Delivery");
			expect(rendered).toContain("…");
			expect(rendered).not.toContain("Effort Level and Time Available");
			// Switch to tab 1: now its full title shows.
			component.handleInput("\t");
			rendered = stripAnsi(component.render(120).join("\n"));
			expect(rendered).toContain("Effort Level and Time Available");
		});

		it("still renders checkboxes for multi-select options", () => {
			const { component } = mount({
				questions: [{ question: "Checks?", options: ["unit", "types"], multiSelect: true }],
			});
			const rendered = stripAnsi(component.render(80).join("\n"));
			expect(rendered).toContain("[ ] unit");
		});
	});
});
