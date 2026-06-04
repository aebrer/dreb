import assert from "node:assert";
import { describe, it } from "node:test";
import { RankedList, type RankedListTheme } from "../src/components/ranked-list.js";

const testTheme: RankedListTheme = {
	selectedText: (t) => t,
	rank: (t) => t,
	description: (t) => t,
	hint: (t) => t,
	empty: (t) => t,
};

describe("RankedList", () => {
	it("renders items in numbered order", () => {
		const list = new RankedList(
			[
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			10,
			testTheme,
		);
		const lines = list.render(80);
		assert.ok(lines.some((l) => l.includes("1. ") && l.includes("Alpha")));
		assert.ok(lines.some((l) => l.includes("2. ") && l.includes("Beta")));
	});

	it("renders empty state", () => {
		const list = new RankedList([], 10, testTheme);
		const lines = list.render(80);
		assert.ok(lines.some((l) => l.includes("No models configured")));
	});

	it("moves item up with Shift+Up", () => {
		let reordered: any[] | undefined;
		const list = new RankedList(
			[
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			10,
			testTheme,
		);
		list.onReorder = (items) => {
			reordered = items;
		};
		// Navigate to second item
		list.handleInput("\x1b[B"); // down arrow
		// Shift+Up to reorder
		list.handleInput("\x1b[1;2A");
		assert.ok(reordered);
		assert.equal(reordered[0].value, "b");
		assert.equal(reordered[1].value, "a");
	});

	it("moves item up with [ key", () => {
		let reordered: any[] | undefined;
		const list = new RankedList(
			[
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			10,
			testTheme,
		);
		list.onReorder = (items) => {
			reordered = items;
		};
		// Navigate to second item
		list.handleInput("\x1b[B"); // down arrow
		// [ to reorder up
		list.handleInput("[");
		assert.ok(reordered);
		assert.equal(reordered[0].value, "b");
		assert.equal(reordered[1].value, "a");
	});

	it("moves item down with ] key", () => {
		let reordered: any[] | undefined;
		const list = new RankedList(
			[
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			10,
			testTheme,
		);
		list.onReorder = (items) => {
			reordered = items;
		};
		// ] to reorder down
		list.handleInput("]");
		assert.ok(reordered);
		assert.equal(reordered[0].value, "b");
		assert.equal(reordered[1].value, "a");
	});

	it("moves item down with Shift+Down", () => {
		let reordered: any[] | undefined;
		const list = new RankedList(
			[
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			10,
			testTheme,
		);
		list.onReorder = (items) => {
			reordered = items;
		};
		// Shift+Down to reorder first item
		list.handleInput("\x1b[1;2B");
		assert.ok(reordered);
		assert.equal(reordered[0].value, "b");
		assert.equal(reordered[1].value, "a");
	});

	it("does not move first item up", () => {
		let reordered: any[] | undefined;
		const list = new RankedList(
			[
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			10,
			testTheme,
		);
		list.onReorder = (items) => {
			reordered = items;
		};
		list.handleInput("\x1b[1;2A"); // Shift+Up at index 0
		assert.equal(reordered, undefined);
	});

	it("does not move last item down", () => {
		let reordered: any[] | undefined;
		const list = new RankedList(
			[
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			10,
			testTheme,
		);
		list.onReorder = (items) => {
			reordered = items;
		};
		list.handleInput("\x1b[B"); // down arrow -> navigate to last item
		list.handleInput("]"); // reorder down at last index
		assert.equal(reordered, undefined);
		// Order unchanged
		const items = list.getItems();
		assert.equal(items[0].value, "a");
		assert.equal(items[1].value, "b");
	});

	it("setItems clamps selectedIndex when list shrinks", () => {
		const list = new RankedList(
			[
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
				{ value: "c", label: "Gamma" },
				{ value: "d", label: "Delta" },
			],
			10,
			testTheme,
		);
		// Navigate to index 3 (last)
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		// Shrink to 2 items
		list.setItems([
			{ value: "a", label: "Alpha" },
			{ value: "b", label: "Beta" },
		]);
		let lines: string[] = [];
		assert.doesNotThrow(() => {
			lines = list.render(80);
		});
		// Selected item should be within bounds (Beta, the new last item)
		assert.ok(lines.some((l) => l.includes("→") && l.includes("Beta")));
	});

	it("navigation on empty list does not produce negative index", () => {
		let removed: any | undefined;
		let remaining: any[] | undefined;
		const list = new RankedList([], 10, testTheme);
		list.onRemove = (item, items) => {
			removed = item;
			remaining = items;
		};
		// UP on empty list must not set a negative index
		list.handleInput("\x1b[A");
		// Add a single item
		list.setItems([{ value: "a", label: "Alpha" }]);
		// Delete should remove the single item (not splice the wrong index)
		list.handleInput("\x1b[3~");
		assert.equal(removed?.value, "a");
		assert.equal(remaining?.length, 0);
	});

	it("removes selected item with Delete", () => {
		let removed: any | undefined;
		let remaining: any[] | undefined;
		const list = new RankedList(
			[
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			10,
			testTheme,
		);
		list.onRemove = (item, items) => {
			removed = item;
			remaining = items;
		};
		list.handleInput("\x1b[3~"); // Delete key
		assert.equal(removed?.value, "a");
		assert.equal(remaining?.length, 1);
		assert.equal(remaining?.[0].value, "b");
	});

	it("fires onCancel on Escape", () => {
		let cancelled = false;
		const list = new RankedList([{ value: "a", label: "Alpha" }], 10, testTheme);
		list.onCancel = () => {
			cancelled = true;
		};
		list.handleInput("\x1b"); // Escape
		assert.ok(cancelled);
	});

	it("fires onSelect on Enter", () => {
		let selected = false;
		const list = new RankedList([{ value: "a", label: "Alpha" }], 10, testTheme);
		list.onSelect = () => {
			selected = true;
		};
		list.handleInput("\r"); // Enter
		assert.ok(selected);
	});

	it("wraps navigation at boundaries", () => {
		const list = new RankedList(
			[
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			10,
			testTheme,
		);
		// Up from first item wraps to last
		list.handleInput("\x1b[A"); // Up
		const lines = list.render(80);
		// The selected item (Beta, index 1) should have the → prefix
		assert.ok(lines.some((l) => l.includes("→") && l.includes("Beta")));
	});

	// Eight distinct, non-overlapping labels so substring assertions are unambiguous.
	const scrollItems = [
		{ value: "a", label: "Alpha" },
		{ value: "b", label: "Bravo" },
		{ value: "c", label: "Charlie" },
		{ value: "d", label: "Delta" },
		{ value: "e", label: "Echo" },
		{ value: "f", label: "Foxtrot" },
		{ value: "g", label: "Golf" },
		{ value: "h", label: "Hotel" },
	];

	it("shows position indicator at top with window clamped to start", () => {
		const list = new RankedList(scrollItems, 3, testTheme);
		const lines = list.render(80);
		// selectedIndex 0: window is items 0..2 (Alpha, Bravo, Charlie)
		assert.ok(lines.some((l) => l.includes("(1/8)")));
		assert.ok(lines.some((l) => l.includes("Alpha")));
		assert.ok(lines.some((l) => l.includes("Bravo")));
		assert.ok(lines.some((l) => l.includes("Charlie")));
		// Items outside the window must not be rendered
		assert.ok(!lines.some((l) => l.includes("Delta")));
		assert.ok(!lines.some((l) => l.includes("Hotel")));
	});

	it("scrolls the window to the middle and shows position indicator", () => {
		const list = new RankedList(scrollItems, 3, testTheme);
		// Navigate down to selectedIndex 3 (Delta)
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		const lines = list.render(80);
		// startIndex = clamp(3 - 1) = 2, window is items 2..4 (Charlie, Delta, Echo)
		assert.ok(lines.some((l) => l.includes("(4/8)")));
		assert.ok(lines.some((l) => l.includes("Charlie")));
		assert.ok(lines.some((l) => l.includes("→") && l.includes("Delta")));
		assert.ok(lines.some((l) => l.includes("Echo")));
		// Items before and after the window must not be rendered
		assert.ok(!lines.some((l) => l.includes("Alpha")));
		assert.ok(!lines.some((l) => l.includes("Bravo")));
		assert.ok(!lines.some((l) => l.includes("Foxtrot")));
		assert.ok(!lines.some((l) => l.includes("Golf")));
		assert.ok(!lines.some((l) => l.includes("Hotel")));
	});

	it("clamps window at the bottom of the list", () => {
		const list = new RankedList(scrollItems, 3, testTheme);
		// Navigate to the last item (index 7, Hotel)
		for (let i = 0; i < 7; i++) {
			list.handleInput("\x1b[B");
		}
		const lines = list.render(80);
		// startIndex clamps to items.length - maxVisible = 5, window is items 5..7
		assert.ok(lines.some((l) => l.includes("(8/8)")));
		assert.ok(lines.some((l) => l.includes("Foxtrot")));
		assert.ok(lines.some((l) => l.includes("Golf")));
		assert.ok(lines.some((l) => l.includes("→") && l.includes("Hotel")));
		// Earlier items are scrolled out of view
		assert.ok(!lines.some((l) => l.includes("Alpha")));
		assert.ok(!lines.some((l) => l.includes("Echo")));
		// Window stays within bounds: exactly maxVisible items rendered
		const itemLines = lines.filter((l) => /\d+\.\s/.test(l));
		assert.equal(itemLines.length, 3);
	});

	it("omits position indicator when all items fit in the window", () => {
		const list = new RankedList(scrollItems.slice(0, 3), 3, testTheme);
		const lines = list.render(80);
		// No scrolling needed: startIndex 0, endIndex === items.length
		assert.ok(!lines.some((l) => l.includes("(1/3)")));
		assert.ok(lines.some((l) => l.includes("Alpha")));
		assert.ok(lines.some((l) => l.includes("Charlie")));
	});
});
