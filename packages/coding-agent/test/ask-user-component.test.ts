import { setKeybindings, TUI } from "@dreb/tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import type { AskRequest, AskResult } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AskUserComponent } from "../src/modes/interactive/components/ask-user.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\n";
const ESC = "\x1b";
const SPACE = " ";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

function mount(request: AskRequest) {
	const onSubmit = vi.fn<(result: AskResult) => void>();
	const onStop = vi.fn<() => void>();
	const component = new AskUserComponent(request, onSubmit, onStop);
	component.focused = true;
	return { component, onSubmit, onStop };
}

/** Mount with a real TUI so the multiline `Editor` branch is exercised. */
function mountWithTui(request: AskRequest) {
	const tui = new TUI(new VirtualTerminal(80, 24));
	const onSubmit = vi.fn<(result: AskResult) => void>();
	const onStop = vi.fn<() => void>();
	const component = new AskUserComponent(request, onSubmit, onStop, { tui });
	component.focused = true;
	return { component, onSubmit, onStop, tui };
}

function type(component: AskUserComponent, text: string) {
	for (const char of text) component.handleInput(char);
}

describe("AskUserComponent", () => {
	it("renders the question with the existing TUI Markdown component", () => {
		const { component } = mount({ question: "Use **bold** and `code`", options: ["A", "B"] });
		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("bold");
		expect(rendered).toContain("code");
		expect(rendered).not.toContain("**bold**");
		expect(rendered).not.toContain("`code`");
	});

	it("single-select: Enter picks the highlighted option and submits", () => {
		const { component, onSubmit } = mount({ question: "DB?", options: ["SQLite", "Postgres", "JSON"] });
		component.handleInput(DOWN); // move to Postgres
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledWith({ selected: ["Postgres"], customText: undefined });
	});

	it("single-select: submitting the free-text field returns only the typed text", () => {
		const { component, onSubmit } = mount({ question: "DB?", options: ["SQLite", "Postgres"] });
		component.handleInput(DOWN); // Postgres
		component.handleInput(DOWN); // free-text row
		type(component, "duckdb");
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledWith({ selected: [], customText: "duckdb" });
	});

	it("single-select: submits the highlighted option together with typed free text", () => {
		// Parity with the Dashboard, which combines a radio selection with custom
		// text. Type in the field, move back up to an option, then submit.
		const { component, onSubmit } = mount({ question: "DB?", options: ["SQLite", "Postgres"] });
		component.handleInput(DOWN); // Postgres
		component.handleInput(DOWN); // free-text row
		type(component, "duckdb");
		component.handleInput(UP); // back to Postgres, keeping the typed text
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledWith({ selected: ["Postgres"], customText: "duckdb" });
	});

	it("multi-select: Space toggles checkboxes and Enter submits the combined answer", () => {
		const { component, onSubmit } = mount({
			question: "Checks?",
			options: ["unit", "browser", "types"],
			multiSelect: true,
		});
		component.handleInput(SPACE); // check unit
		component.handleInput(DOWN);
		component.handleInput(DOWN); // types
		component.handleInput(SPACE); // check types
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledWith({ selected: ["unit", "types"], customText: undefined });
	});

	it("multi-select: combines checked options with free text", () => {
		const { component, onSubmit } = mount({
			question: "Checks?",
			options: ["unit", "browser"],
			multiSelect: true,
		});
		component.handleInput(SPACE); // check unit
		component.handleInput(DOWN); // browser
		component.handleInput(DOWN); // free-text row
		type(component, "lint");
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledWith({ selected: ["unit"], customText: "lint" });
	});

	it("Esc requests that the current agent turn stop", () => {
		const { component, onSubmit, onStop } = mount({ question: "DB?", options: ["a", "b"] });
		component.handleInput(ESC);
		expect(onStop).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("ignores Enter on an empty free-text field (Esc stops the turn)", () => {
		const { component, onSubmit } = mount({ question: "Name?" });
		// Free-text-only question: cursor starts on the field, which is empty.
		component.handleInput(ENTER);
		expect(onSubmit).not.toHaveBeenCalled();
		type(component, "hi");
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledWith({ selected: [], customText: "hi" });
	});

	it("does not offer a free-text field when allowFreeText is false", () => {
		const { component, onSubmit } = mount({ question: "Pick", options: ["a", "b"], allowFreeText: false });
		// Arrowing down past the last option must not reach a field — Enter still
		// submits the highlighted option.
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledWith({ selected: ["b"], customText: undefined });
	});

	it("submits only once even if Enter is pressed repeatedly", () => {
		const { component, onSubmit } = mount({ question: "DB?", options: ["a", "b"] });
		component.handleInput(ENTER);
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it("does not navigate above the first row", () => {
		const { component, onSubmit } = mount({ question: "DB?", options: ["a", "b"] });
		component.handleInput(UP);
		component.handleInput(UP);
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledWith({ selected: ["a"], customText: undefined });
	});

	describe("multiline (real Editor branch)", () => {
		const CR = "\r"; // Enter → submit in the Editor
		const LF = "\n"; // bare LF → insert a newline in the Editor

		it("inserts newlines without submitting, then submits the multi-line answer", () => {
			const { component, onSubmit } = mountWithTui({ question: "Describe", multiline: true });
			type(component, "line1");
			component.handleInput(LF); // newline, not a submit
			type(component, "line2");
			expect(onSubmit).not.toHaveBeenCalled();
			component.handleInput(CR); // Enter submits
			expect(onSubmit).toHaveBeenCalledWith({ selected: [], customText: "line1\nline2" });
		});

		it("submits only once even if Enter is pressed repeatedly (one-time teardown)", () => {
			const { component, onSubmit } = mountWithTui({ question: "Describe", multiline: true });
			type(component, "hello");
			component.handleInput(CR);
			component.handleInput(CR);
			expect(onSubmit).toHaveBeenCalledTimes(1);
		});

		it("dispose is safe and idempotent", () => {
			const { component } = mountWithTui({ question: "Describe", multiline: true });
			expect(() => {
				component.dispose();
				component.dispose();
			}).not.toThrow();
		});
	});
});
