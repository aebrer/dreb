import { setKeybindings } from "@dreb/tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { type CopyMessageItem, CopySelectorComponent } from "../src/modes/interactive/components/copy-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

// Key escape sequences
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const SPACE = " ";
const CTRL_A = "\x01";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

function makeItems(count: number): CopyMessageItem[] {
	const items: CopyMessageItem[] = [];
	for (let i = 0; i < count; i++) {
		items.push({
			index: i,
			roleLabel: i % 2 === 0 ? "You" : "Assistant",
			preview: `Message ${i} content here`,
		});
	}
	return items;
}

describe("CopyMessageList", () => {
	test("renders items with checkboxes and role labels", () => {
		const items = makeItems(3);
		const onCopy = vi.fn();
		const onCancel = vi.fn();
		const component = new CopySelectorComponent(items, onCopy, onCancel);
		const list = component.getMessageList();

		const lines = list.render(80);

		// Should have rendered lines for each item
		expect(lines.length).toBeGreaterThanOrEqual(3);
		// Check that role labels appear
		expect(lines.some((l) => l.includes("You"))).toBe(true);
		expect(lines.some((l) => l.includes("Assistant"))).toBe(true);
		// Check that previews appear
		expect(lines.some((l) => l.includes("Message 0"))).toBe(true);
	});

	test("bottom-anchor: selectedIndex starts at last item", () => {
		const items = makeItems(5);
		const onCopy = vi.fn();
		const onCancel = vi.fn();
		const component = new CopySelectorComponent(items, onCopy, onCancel);
		const list = component.getMessageList();

		const lines = list.render(80);

		// The last item (index 4) should have the cursor indicator ›
		// Find a line that has both › and "Message 4"
		expect(lines.some((l) => l.includes("›") && l.includes("Message 4"))).toBe(true);
	});

	test("navigation: up/down arrows move cursor with wrapping", () => {
		const items = makeItems(3);
		const onCopy = vi.fn();
		const onCancel = vi.fn();
		const component = new CopySelectorComponent(items, onCopy, onCancel);
		const list = component.getMessageList();

		// Starts at index 2 (last). Move down should wrap to 0.
		list.handleInput(DOWN);
		let lines = list.render(80);
		expect(lines.some((l) => l.includes("›") && l.includes("Message 0"))).toBe(true);

		// Move up should wrap back to 2
		list.handleInput(UP);
		lines = list.render(80);
		expect(lines.some((l) => l.includes("›") && l.includes("Message 2"))).toBe(true);

		// Move up should go to 1
		list.handleInput(UP);
		lines = list.render(80);
		expect(lines.some((l) => l.includes("›") && l.includes("Message 1"))).toBe(true);
	});

	test("toggle selection: Space toggles current item", () => {
		const items = makeItems(3);
		const onCopy = vi.fn();
		const onCancel = vi.fn();
		const component = new CopySelectorComponent(items, onCopy, onCancel);
		const list = component.getMessageList();

		// Cursor at last item (2). Toggle it.
		list.handleInput(SPACE);
		let lines = list.render(80);
		// Should show [×] for selected item
		const selectedLine = lines.find((l) => l.includes("Message 2"));
		expect(selectedLine).toBeDefined();
		expect(selectedLine!.includes("×")).toBe(true);

		// Toggle again to deselect
		list.handleInput(SPACE);
		lines = list.render(80);
		const deselectedLine = lines.find((l) => l.includes("Message 2"));
		expect(deselectedLine).toBeDefined();
		expect(deselectedLine!.includes("×")).toBe(false);
	});

	test("select all: Ctrl+A selects all, then deselects all", () => {
		const items = makeItems(3);
		const onCopy = vi.fn();
		const onCancel = vi.fn();
		const component = new CopySelectorComponent(items, onCopy, onCancel);
		const list = component.getMessageList();

		// Ctrl+A selects all
		list.handleInput(CTRL_A);
		let lines = list.render(80);
		const selectedCount = lines.filter((l) => l.includes("×")).length;
		expect(selectedCount).toBe(3);

		// Ctrl+A again deselects all
		list.handleInput(CTRL_A);
		lines = list.render(80);
		const deselectedCount = lines.filter((l) => l.includes("×")).length;
		expect(deselectedCount).toBe(0);
	});

	test("confirm: Enter calls onCopy with sorted selected indices", () => {
		const items = makeItems(5);
		const onCopy = vi.fn();
		const onCancel = vi.fn();
		const component = new CopySelectorComponent(items, onCopy, onCancel);
		const list = component.getMessageList();

		// Select items out of order: cursor at 4, select it
		list.handleInput(SPACE); // select item 4
		list.handleInput(UP); // move to 3
		list.handleInput(UP); // move to 2
		list.handleInput(SPACE); // select item 2
		list.handleInput(UP); // move to 1
		list.handleInput(UP); // move to 0
		list.handleInput(SPACE); // select item 0

		list.handleInput(ENTER);
		expect(onCopy).toHaveBeenCalledWith([0, 2, 4]);
	});

	test("cancel: Escape calls onCancel", () => {
		const items = makeItems(3);
		const onCopy = vi.fn();
		const onCancel = vi.fn();
		const component = new CopySelectorComponent(items, onCopy, onCancel);
		const list = component.getMessageList();

		list.handleInput(ESC);
		expect(onCancel).toHaveBeenCalled();
	});

	test("empty selection on confirm: Enter with nothing selected calls onCopy with empty array", () => {
		const items = makeItems(3);
		const onCopy = vi.fn();
		const onCancel = vi.fn();
		const component = new CopySelectorComponent(items, onCopy, onCancel);
		const list = component.getMessageList();

		list.handleInput(ENTER);
		expect(onCopy).toHaveBeenCalledWith([]);
	});

	test("scrolling: viewport window adjusts as cursor moves", () => {
		// Create more items than maxVisible (15)
		const items = makeItems(20);
		const onCopy = vi.fn();
		const onCancel = vi.fn();
		const component = new CopySelectorComponent(items, onCopy, onCancel);
		const list = component.getMessageList();

		// Starts at item 19 (last). Viewport should show items near the end.
		let lines = list.render(80);
		// Should have scroll indicator
		expect(lines.some((l) => l.includes("20/20"))).toBe(true);
		// Should show the last item
		expect(lines.some((l) => l.includes("Message 19"))).toBe(true);

		// Move cursor to start
		for (let i = 0; i < 19; i++) {
			list.handleInput(UP);
		}
		lines = list.render(80);
		expect(lines.some((l) => l.includes("1/20"))).toBe(true);
		expect(lines.some((l) => l.includes("Message 0"))).toBe(true);
	});

	test("page up/down: jumps by maxVisible", () => {
		const items = makeItems(30);
		const onCopy = vi.fn();
		const onCancel = vi.fn();
		const component = new CopySelectorComponent(items, onCopy, onCancel);
		const list = component.getMessageList();

		// Starts at 29. Page up should jump to 14.
		list.handleInput(PAGE_UP);
		let lines = list.render(80);
		expect(lines.some((l) => l.includes("›") && l.includes("Message 14"))).toBe(true);

		// Page down should jump back to 29
		list.handleInput(PAGE_DOWN);
		lines = list.render(80);
		expect(lines.some((l) => l.includes("›") && l.includes("Message 29"))).toBe(true);

		// Page up twice from 29: 29 -> 14 -> 0 (clamped)
		list.handleInput(PAGE_UP);
		list.handleInput(PAGE_UP);
		lines = list.render(80);
		expect(lines.some((l) => l.includes("›") && l.includes("Message 0"))).toBe(true);
	});
});

describe("CopySelectorComponent", () => {
	test("container renders header, controls text, borders, and list", () => {
		const items = makeItems(3);
		const onCopy = vi.fn();
		const onCancel = vi.fn();
		const component = new CopySelectorComponent(items, onCopy, onCancel);

		const lines = component.render(80);
		const output = lines.join("\n");

		// Header
		expect(output).toContain("Copy Messages");
		// Controls
		expect(output).toContain("Navigate");
		expect(output).toContain("Space Toggle");
		expect(output).toContain("Enter Copy");
		expect(output).toContain("Esc Cancel");
		// Borders (─ chars)
		expect(output).toContain("─");
		// List items
		expect(output).toContain("Message 0");
	});

	test("empty items: auto-cancels", async () => {
		vi.useFakeTimers();
		try {
			const onCopy = vi.fn();
			const onCancel = vi.fn();
			new CopySelectorComponent([], onCopy, onCancel);

			vi.advanceTimersByTime(200);
			expect(onCancel).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
