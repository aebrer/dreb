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
	test("renders role badges and role-specific fork hints for both roles", () => {
		const component = new UserMessageSelectorComponent(makeItems(), vi.fn(), vi.fn());
		const lines = component.getMessageList().render(80);
		const blob = lines.join("\n");

		// Role badges distinguish the two message kinds.
		expect(blob).toContain("[Assistant]");
		expect(blob).toContain("[You]");
		// Role-specific hints describe the opposite-consequence actions.
		expect(blob).toContain("continue from here"); // assistant
		expect(blob).toContain("rewind & re-ask"); // user
		// Message previews appear.
		expect(blob).toContain("the assistant answer");
		expect(blob).toContain("first question");
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
