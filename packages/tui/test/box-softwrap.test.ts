import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.js";
import { Text } from "../src/components/text.js";
import type { Component } from "../src/tui.js";
import { visibleWidth } from "../src/utils.js";
import { isWrappableLine, markWrappable, stripWrapMarker } from "../src/wrap.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class StaticComponent implements Component {
	constructor(private readonly lines: string[]) {}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

const blue = (text: string) => `\x1b[44m${text}\x1b[49m`;

async function paintLogicalLines(lines: string[], width: number): Promise<VirtualTerminal> {
	const term = new VirtualTerminal(width, lines.length * 4 + 8);
	term.write(lines.map((line) => stripWrapMarker(line)).join("\r\n"));
	await term.flush();
	return term;
}

function rowBgColors(term: VirtualTerminal, row: number, width: number): number[] {
	const line = (
		term as unknown as { xterm: { buffer: { active: { getLine(index: number): any } } } }
	).xterm.buffer.active.getLine(row);
	const bgs: number[] = [];
	for (let x = 0; x < width; x++) bgs.push(line.getCell(x).getBgColor());
	return bgs;
}

describe("Box soft-wrap background fill", () => {
	it("uses BCE for wrappable content and padding so wrapped rows stay background-filled and copy clean", async () => {
		const width = 12;
		const wide = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // plus Box left padding => wraps across 3 rows at width 12
		const box = new Box(1, 1, blue);
		box.addChild(new StaticComponent([markWrappable(wide)]));

		const lines = box.render(width);

		assert.strictEqual(lines.length, 3);
		assert.ok(lines[0].includes("\x1b[K"), "top padding row should use BCE");
		assert.ok(lines[1].includes("\x1b[K"), "wrappable content row should use BCE");
		assert.ok(lines[2].includes("\x1b[K"), "bottom padding row should use BCE");
		assert.ok(isWrappableLine(lines[1]), "Box must preserve the wrap marker even after prepending left padding");
		assert.strictEqual(visibleWidth(lines[1]), wide.length + 1, "wrappable content must not be space-padded");

		const term = await paintLogicalLines(lines, width);
		const wrappedRows = Math.ceil(visibleWidth(lines[1]) / width);

		// Top padding, each autowrapped content row, and bottom padding are filled edge-to-edge.
		for (let row = 0; row < wrappedRows + 2; row++) {
			const bgs = rowBgColors(term, row, width);
			assert.ok(
				bgs.every((color) => color === 4),
				`row ${row} should be fully blue-filled: ${bgs.join(",")}`,
			);
		}

		const logical = term.getLogicalScrollBuffer().filter((line) => line.length > 0);
		assert.deepStrictEqual(logical, [` ${wide}`]);
		assert.ok(
			!logical.some((line) => / +$/.test(line)),
			`logical copy should not contain trailing spaces: ${logical}`,
		);
	});

	it("uses BCE for short wrappable content instead of fixed-width trailing spaces", async () => {
		const width = 12;
		const box = new Box(1, 0, blue);
		box.addChild(new StaticComponent([markWrappable("short")]));

		const lines = box.render(width);

		assert.strictEqual(lines.length, 1);
		assert.ok(lines[0].includes("\x1b[K"), "short wrappable content should fill via BCE");
		assert.strictEqual(visibleWidth(lines[0]), " short".length);

		const term = await paintLogicalLines(lines, width);
		const logical = term.getLogicalScrollBuffer().filter((line) => line.length > 0);
		assert.deepStrictEqual(logical, [" short"]);
	});

	it("Text soft-wrap applies custom backgrounds to content rows with BCE", async () => {
		const text = new Text("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 0, 0, blue, true);
		const lines = text.render(12);

		assert.strictEqual(lines.length, 1);
		assert.ok(isWrappableLine(lines[0]), "soft-wrapped Text content should be marked wrappable");
		assert.ok(lines[0].includes("\x1b[K"), "custom background should use BCE on content rows");
		assert.strictEqual(visibleWidth(lines[0]), 26, "Text content must not be padded with copyable spaces");

		const term = await paintLogicalLines(lines, 12);
		assert.deepStrictEqual(
			term.getLogicalScrollBuffer().filter((line) => line.length > 0),
			["ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
		);
	});

	it("keeps non-wrappable content on the existing fixed-width padded background path", () => {
		const box = new Box(1, 0, blue);
		box.addChild(new StaticComponent(["abc"]));

		const lines = box.render(10);

		assert.deepStrictEqual(lines, [`\x1b[44m abc${" ".repeat(6)}\x1b[49m`]);
		assert.strictEqual(lines[0].includes("\x1b[K"), false);
		assert.strictEqual(visibleWidth(lines[0]), 10);
	});
});
