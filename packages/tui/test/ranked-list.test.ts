import assert from "node:assert";
import { describe, it } from "node:test";
import { RankedList, type RankedListTheme } from "../src/components/ranked-list.js";

const testTheme: RankedListTheme = {
	selectedPrefix: (t) => t,
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
});
