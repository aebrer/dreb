import { setKeybindings } from "@dreb/tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

const ENTER = "\r";
const ESC = "\x1b";

type Item = { id: string; text: string; role: "user" | "assistant" };

function makeItems(): Item[] {
	return [
		{ id: "u1", text: "first question", role: "user" },
		{ id: "a1", text: "the assistant answer", role: "assistant" },
		{ id: "u2", text: "second question", role: "user" },
	];
}

describe("UserMessageSelectorComponent render", () => {
	test("renders role badges and role-specific fork hints tied to the correct message line", () => {
		const component = new UserMessageSelectorComponent(makeItems(), vi.fn(), vi.fn());
		const lines = component.getMessageList().render(80);

		// Each message renders as: line N = cursor + role badge + preview,
		// line N+1 = the role-specific hint. Assert the badge and hint are attached
		// to the CORRECT message line, so a swapped badge/hint mapping fails.
		const assistantIdx = lines.findIndex((l) => l.includes("the assistant answer"));
		expect(assistantIdx).toBeGreaterThanOrEqual(0);
		expect(lines[assistantIdx]).toContain("[Assistant]");
		expect(lines[assistantIdx]).not.toContain("[You]");
		expect(lines[assistantIdx + 1]).toContain("continue from here");
		expect(lines[assistantIdx + 1]).not.toContain("rewind & re-ask");

		const userIdx = lines.findIndex((l) => l.includes("first question"));
		expect(userIdx).toBeGreaterThanOrEqual(0);
		expect(lines[userIdx]).toContain("[You]");
		expect(lines[userIdx]).not.toContain("[Assistant]");
		expect(lines[userIdx + 1]).toContain("rewind & re-ask");
		expect(lines[userIdx + 1]).not.toContain("continue from here");
	});

	test("bottom-anchors selection on the most recent message", () => {
		const onSelect = vi.fn();
		const component = new UserMessageSelectorComponent(makeItems(), onSelect, vi.fn());
		component.getMessageList().handleInput(ENTER);
		// Last item (u2) is selected by default.
		expect(onSelect).toHaveBeenCalledWith("u2");
	});

	test("Escape cancels", () => {
		const onCancel = vi.fn();
		const component = new UserMessageSelectorComponent(makeItems(), vi.fn(), onCancel);
		component.getMessageList().handleInput(ESC);
		expect(onCancel).toHaveBeenCalledOnce();
	});

	test("does not throw or produce negative-width truncation on a very narrow terminal", () => {
		// The [Assistant] badge eats into the width budget; at width 10 the message
		// budget goes negative and must be clamped (Math.max(0, …)).
		const component = new UserMessageSelectorComponent(makeItems(), vi.fn(), vi.fn());
		expect(() => component.getMessageList().render(10)).not.toThrow();
		const lines = component.getMessageList().render(10);
		expect(Array.isArray(lines)).toBe(true);
		expect(lines.length).toBeGreaterThan(0);
	});

	test("renders an empty-state message when there are no fork points", () => {
		const component = new UserMessageSelectorComponent([], vi.fn(), vi.fn());
		const lines = component.getMessageList().render(80);
		expect(lines.join("\n")).toContain("No messages found");
	});
});
