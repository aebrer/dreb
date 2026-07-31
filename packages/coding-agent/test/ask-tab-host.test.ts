import { setKeybindings, TUI } from "@dreb/tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import type { AskRequest, AskResult } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AskTabHost } from "../src/modes/interactive/components/ask-tab-host.js";
import { AskUserComponent } from "../src/modes/interactive/components/ask-user.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const DOWN = "\x1b[B";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

function makeComponent(request: AskRequest) {
	const onSubmit = vi.fn<(result: AskResult) => void>();
	const onStop = vi.fn<() => void>();
	const component = new AskUserComponent(request, onSubmit, onStop);
	return { component, onSubmit, onStop };
}

describe("AskTabHost", () => {
	it("has no tabs when empty and reports size", () => {
		const host = new AskTabHost();
		expect(host.hasTabs()).toBe(false);
		expect(host.size).toBe(0);
	});

	it("focuses the newly added tab and defocuses the rest", () => {
		const host = new AskTabHost();
		const a = makeComponent({ question: "Q1", title: "First", options: ["a", "b"] });
		const b = makeComponent({ question: "Q2", title: "Second", options: ["c", "d"] });
		host.addTab("1", "First", a.component);
		host.addTab("2", "Second", b.component);
		host.focused = true;
		// The most recently opened question is active and focused.
		expect(host.size).toBe(2);
		expect(b.component.focused).toBe(true);
		expect(a.component.focused).toBe(false);
	});

	it("Tab switches to the next question and Shift+Tab to the previous (wrapping)", () => {
		const host = new AskTabHost();
		const a = makeComponent({ question: "Q1", title: "First", options: ["a", "b"] });
		const b = makeComponent({ question: "Q2", title: "Second", options: ["c", "d"] });
		host.addTab("1", "First", a.component);
		host.addTab("2", "Second", b.component); // active = b
		host.focused = true;

		host.handleInput(TAB); // wraps b -> a
		expect(a.component.focused).toBe(true);
		expect(b.component.focused).toBe(false);

		host.handleInput(TAB); // a -> b
		expect(b.component.focused).toBe(true);
		expect(a.component.focused).toBe(false);

		host.handleInput(SHIFT_TAB); // b -> a
		expect(a.component.focused).toBe(true);
		expect(b.component.focused).toBe(false);
	});

	it("does not switch on Tab when only one question is open", () => {
		const host = new AskTabHost();
		const a = makeComponent({ question: "Q1", title: "First", options: ["a", "b"] });
		host.addTab("1", "First", a.component);
		host.focused = true;
		const spy = vi.spyOn(a.component, "handleInput");
		host.handleInput(TAB);
		// With a single tab, Tab is delegated to the active question, not consumed
		// as a tab switch.
		expect(spy).toHaveBeenCalledWith(TAB);
	});

	it("delegates non-switch keys to the active question", () => {
		const host = new AskTabHost();
		const a = makeComponent({ question: "Q1", title: "First", options: ["a", "b"] });
		const b = makeComponent({ question: "Q2", title: "Second", options: ["c", "d"] });
		host.addTab("1", "First", a.component);
		host.addTab("2", "Second", b.component); // active = b
		host.focused = true;
		const spyA = vi.spyOn(a.component, "handleInput");
		const spyB = vi.spyOn(b.component, "handleInput");
		host.handleInput(DOWN);
		expect(spyB).toHaveBeenCalledWith(DOWN);
		expect(spyA).not.toHaveBeenCalled();
	});

	it("renders a tab strip only when 2+ questions are open", () => {
		const host = new AskTabHost();
		const a = makeComponent({ question: "Q1", title: "First", options: ["a", "b"] });
		host.addTab("1", "First", a.component);
		expect(host.render(80).join("\n")).not.toContain("⇥ switch");

		const b = makeComponent({ question: "Q2", title: "Second", options: ["c", "d"] });
		host.addTab("2", "Second", b.component);
		const rendered = host.render(80).join("\n");
		expect(rendered).toContain("First");
		expect(rendered).toContain("Second");
		expect(rendered).toContain("⇥ switch");
	});

	it("removeTab reports remaining tabs and re-picks an active one, disposing the removed component", () => {
		const host = new AskTabHost();
		const a = makeComponent({ question: "Q1", title: "First", options: ["a", "b"] });
		const b = makeComponent({ question: "Q2", title: "Second", options: ["c", "d"] });
		host.addTab("1", "First", a.component);
		host.addTab("2", "Second", b.component); // active = b (index 1)
		host.focused = true;
		const disposeSpy = vi.spyOn(b.component, "dispose");

		// Remove the active tab -> a becomes active and focused, one remains.
		expect(host.removeTab("2")).toBe(true);
		expect(disposeSpy).toHaveBeenCalled();
		expect(host.size).toBe(1);
		expect(a.component.focused).toBe(true);

		// Remove the last tab -> none remain.
		expect(host.removeTab("1")).toBe(false);
		expect(host.hasTabs()).toBe(false);
	});

	it("removeTab of an unknown id is a no-op and reports current tab count", () => {
		const host = new AskTabHost();
		const a = makeComponent({ question: "Q1", title: "First", options: ["a", "b"] });
		host.addTab("1", "First", a.component);
		expect(host.removeTab("nope")).toBe(true);
		expect(host.size).toBe(1);
	});

	it("propagates focus=false to the active question", () => {
		const host = new AskTabHost();
		const a = makeComponent({ question: "Q1", title: "First", options: ["a", "b"] });
		host.addTab("1", "First", a.component);
		host.focused = true;
		expect(a.component.focused).toBe(true);
		host.focused = false;
		expect(a.component.focused).toBe(false);
	});

	it("keeps a per-question countdown running independent of tab switches", () => {
		vi.useFakeTimers();
		try {
			const tui = new TUI(new VirtualTerminal(80, 24));
			const host = new AskTabHost(tui);
			const onSubmitA = vi.fn();
			const onStopA = vi.fn();
			const onStopB = vi.fn();
			const a = new AskUserComponent({ question: "Q1", title: "First", options: ["a", "b"] }, onSubmitA, onStopA, {
				tui,
				timeout: 5000,
			});
			const b = new AskUserComponent({ question: "Q2", title: "Second", options: ["c", "d"] }, vi.fn(), onStopB, {
				tui,
			});
			host.addTab("1", "First", a);
			host.addTab("2", "Second", b); // switch focus to b
			host.focused = true;

			// A's countdown must still fire (stopping the turn) even though B is the
			// active tab — switching tabs never pauses another question's timer.
			vi.advanceTimersByTime(5000);
			expect(onStopA).toHaveBeenCalled();
			expect(onStopB).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("dispose tears down every hosted question", () => {
		const host = new AskTabHost();
		const a = makeComponent({ question: "Q1", title: "First", options: ["a", "b"] });
		const b = makeComponent({ question: "Q2", title: "Second", options: ["c", "d"] });
		host.addTab("1", "First", a.component);
		host.addTab("2", "Second", b.component);
		const disposeA = vi.spyOn(a.component, "dispose");
		const disposeB = vi.spyOn(b.component, "dispose");
		host.dispose();
		expect(disposeA).toHaveBeenCalled();
		expect(disposeB).toHaveBeenCalled();
		expect(host.hasTabs()).toBe(false);
	});
});
