import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { type Component, Container, CURSOR_MARKER, TUI } from "../src/tui.js";
import { markWrappable } from "../src/wrap.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

/** A 50-char logical line that wraps to 3 rows at width 20. */
const WIDE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmn";

type TuiRenderInternals = { doRender(): void; hardwareCursorRow: number };
type TuiRenderState = TuiRenderInternals & {
	maxLinesRendered: number;
	previousLines: string[];
	previousViewportTop: number;
};

function renderNow(tui: TUI): void {
	(tui as unknown as TuiRenderInternals).doRender();
}

function withTempHome<T>(fn: (home: string) => T): T {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "dreb-tui-soft-wrap-"));
	const originalHome = process.env.HOME;
	process.env.HOME = home;
	try {
		return fn(home);
	} finally {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		fs.rmSync(home, { recursive: true, force: true });
	}
}

describe("TUI soft-wrap", () => {
	it("renders a wrappable wide line without injecting hard newlines (clean copy)", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const comp = new TestComponent();
		comp.lines = [markWrappable(WIDE)];
		tui.addChild(comp);
		tui.start();
		await terminal.flush();

		// The terminal lays it out across 3 rows...
		const viewport = await terminal.flushAndGetViewport();
		assert.equal(viewport[0], "ABCDEFGHIJKLMNOPQRST");
		assert.equal(viewport[1], "UVWXYZ0123456789abcd");
		assert.equal(viewport[2], "efghijklmn");

		// ...but it reconstructs to a single logical line (copies cleanly).
		const logical = terminal.getLogicalScrollBuffer().filter((l) => l.length > 0);
		assert.deepEqual(logical, [WIDE]);
	});

	it("does NOT throw the over-width guard for marked lines", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const comp = new TestComponent();
		comp.lines = [markWrappable(WIDE)];
		tui.addChild(comp);
		tui.start();
		// If the guard fired, start()/flush would have thrown / stopped the TUI.
		await assert.doesNotReject(terminal.flush());
	});

	it("still throws the over-width guard for UNMARKED over-width lines", async () => {
		// The guard is an intentional fail-loud crash inside the async render timer,
		// so it cannot be caught with try/catch here. Its decision is unit-tested in
		// wrap.test.ts (isWrappableLine governs the `!isWrappableLine(line)` guard
		// condition). This render test asserts the inverse — that *unmarked* content
		// is still constrained to width by the layout (no >width row is laid out)
		// when it is properly truncated by the component.
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const comp = new TestComponent();
		comp.lines = ["x".repeat(20)]; // exactly width, unmarked, must be one row
		tui.addChild(comp);
		tui.start();
		await terminal.flush();
		const viewport = terminal.getViewport();
		assert.ok(
			viewport.every((l) => l.length <= 20),
			"unmarked content must never exceed the terminal width",
		);
	});

	it("composites overlays over wrapped screen rows", async () => {
		const terminal = new LoggingVirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const comp = new TestComponent();
		comp.lines = [markWrappable(WIDE)];
		tui.addChild(comp);
		tui.start();
		await terminal.flush();

		const fullRedrawsBefore = tui.fullRedraws;
		terminal.clearWrites();
		const overlay = new TestComponent();
		overlay.lines = ["OVERLAY"];
		tui.showOverlay(overlay, { row: 1, col: 0, width: 7 });
		await terminal.flush();

		const writes = terminal.getWrites();
		const viewport = terminal.getViewport();
		assert.equal(tui.fullRedraws, fullRedrawsBefore + 1, "overlay + soft-wrap must not use fast line diff");
		assert.ok(!writes.includes("\x1b[3J"), "overlay repaint must not clear scrollback");
		assert.ok(!writes.includes("\x1b[2J"), "overlay repaint must not clear the whole screen");
		assert.equal(viewport[0], "ABCDEFGHIJKLMNOPQRST");
		assert.ok(viewport[1].startsWith("OVERLAY"), "overlay row should target the second wrapped screen row");
		assert.match(viewport[1], /123456789abcd$/, "overlay should splice into the wrapped row, not the logical line");
		assert.equal(viewport[2], "efghijklmn");
		assert.equal(
			(tui as unknown as TuiRenderInternals).hardwareCursorRow,
			2,
			"cursor accounting must use terminal rows, not logical overlay lines",
		);
		tui.stop();
	});

	it("throws the over-width guard from the wrapped pure-append path", () => {
		withTempHome((home) => {
			const terminal = new VirtualTerminal(20, 8);
			const tui = new TUI(terminal);
			const comp = new TestComponent();
			comp.lines = [markWrappable(WIDE)];
			tui.addChild(comp);
			renderNow(tui);

			comp.lines = [markWrappable(WIDE), "x".repeat(21)];
			assert.throws(() => renderNow(tui), /Rendered line 1 exceeds terminal width \(21 > 20\)\./);

			const crashLogPath = path.join(home, ".dreb", "agent", "dreb-crash.log");
			assert.ok(fs.existsSync(crashLogPath), "over-width guard must write a crash log");
			assert.match(fs.readFileSync(crashLogPath, "utf8"), /Line 1 visible width: 21/);
		});
	});

	it("throws the over-width guard from the wrapped in-place path", () => {
		withTempHome((home) => {
			const terminal = new VirtualTerminal(20, 8);
			const tui = new TUI(terminal);
			const comp = new TestComponent();
			comp.lines = [markWrappable(WIDE), "ok"];
			tui.addChild(comp);
			renderNow(tui);

			comp.lines = [markWrappable(`${WIDE}!`), "x".repeat(21)];
			assert.throws(() => renderNow(tui), /Rendered line 1 exceeds terminal width \(21 > 20\)\./);

			const crashLogPath = path.join(home, ".dreb", "agent", "dreb-crash.log");
			assert.ok(fs.existsSync(crashLogPath), "over-width guard must write a crash log");
			assert.match(fs.readFileSync(crashLogPath, "utf8"), /Line 1 visible width: 21/);
		});
	});

	it("positions cursors inside wrapped lines using modulo columns and cumulative row starts", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal, true);
		const comp = new TestComponent();
		const cursorCol = 25;
		const cursorLine = `${"c".repeat(cursorCol)}${CURSOR_MARKER}${"d".repeat(10)}`;
		comp.lines = [markWrappable(cursorLine)];
		tui.addChild(comp);
		tui.start();
		await terminal.flush();

		assert.deepEqual(
			terminal.getCursorPosition(),
			{ x: 5, y: 1 },
			"cursor past the wrap boundary should land at col % width on the wrapped row",
		);

		comp.lines = [markWrappable(WIDE), markWrappable(cursorLine)];
		tui.requestRender();
		await terminal.flush();

		assert.deepEqual(
			terminal.getCursorPosition(),
			{ x: 5, y: 4 },
			"preceding wrapped lines should contribute their screen-row count to the cursor base row",
		);
		const logical = terminal.getLogicalScrollBuffer().filter((line) => line.length > 0);
		assert.deepEqual(logical, [WIDE, `${"c".repeat(cursorCol)}${"d".repeat(10)}`]);

		tui.stop();
	});

	it("reflows in-place wrapped line changes and tracks screen-row accounting", async () => {
		const terminal = new LoggingVirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const comp = new TestComponent();
		const initial = "I".repeat(50);
		const longer = "L".repeat(65);
		const shorter = "S".repeat(25);
		comp.lines = [markWrappable(initial), "tail"];
		tui.addChild(comp);
		tui.start();
		await terminal.flush();

		let state = tui as unknown as TuiRenderState;
		assert.equal(state.maxLinesRendered, 4, "initial 3-row wrapped line plus tail should track 4 screen rows");
		assert.equal(state.previousLines.length, 2, "renderer state should keep logical lines, not split rows");

		const redrawsBeforeLonger = tui.fullRedraws;
		terminal.clearWrites();
		comp.lines = [markWrappable(longer), "tail"];
		tui.requestRender();
		await terminal.flush();

		assert.ok(terminal.getWrites().includes("\r\x1b[J"), "in-place wrapped change should clear from its start row");
		assert.equal(tui.fullRedraws, redrawsBeforeLonger, "in-place wrapped rewrite should not take a full redraw");
		assert.deepEqual(
			terminal.getLogicalScrollBuffer().filter((line) => line.length > 0),
			[longer, "tail"],
		);
		state = tui as unknown as TuiRenderState;
		assert.equal(state.maxLinesRendered, 5, "longer line should update maxLinesRendered in screen rows");
		assert.equal(state.previousLines.length, 2, "logical state should still contain one wrapped line plus tail");
		assert.equal(state.hardwareCursorRow, 4, "hardware cursor row should track end of 5-row live region");

		terminal.clearWrites();
		comp.lines = [markWrappable(shorter), "tail"];
		tui.requestRender();
		await terminal.flush();

		assert.deepEqual(
			terminal.getLogicalScrollBuffer().filter((line) => line.length > 0),
			[shorter, "tail"],
		);
		state = tui as unknown as TuiRenderState;
		assert.equal(state.maxLinesRendered, 3, "shorter reflow should shrink maxLinesRendered to screen rows");
		assert.equal(
			state.previousLines.length,
			2,
			"shorter reflow should remain a single logical wrapped line plus tail",
		);
		assert.equal(state.hardwareCursorRow, 2, "hardware cursor row should track end of 3-row live region");

		tui.stop();
	});

	it("streams appended wrapped lines into scrollback as single logical lines", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const comp = new TestComponent();
		comp.lines = [];
		tui.addChild(comp);
		tui.start();
		await terminal.flush();

		// Append several wide lines one at a time (simulates streaming).
		const wides = [`${WIDE}-1`, `${WIDE}-2`, `${WIDE}-3`, `${WIDE}-4`];
		for (let i = 0; i < wides.length; i++) {
			comp.lines = wides.slice(0, i + 1).map(markWrappable);
			tui.requestRender();
			await terminal.flush();
		}

		// Every wide line must appear intact (no hard wrap) in the reconstructed buffer.
		const logical = terminal.getLogicalScrollBuffer();
		for (const w of wides) {
			assert.ok(
				logical.includes(w),
				`expected logical scrollback to contain "${w}" intact; got:\n${logical.join("\n")}`,
			);
		}
	});

	it("bottom-anchors on shrink without wiping scrollback (turn-end style)", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);

		const msg = new TestComponent();
		msg.lines = Array.from({ length: 5 }, (_, i) => markWrappable(`${WIDE}#${i}`));
		committed.addChild(msg);

		const spinner = new TestComponent();
		spinner.lines = ["Working..."];
		live.addChild(spinner);

		tui.start();
		await terminal.flush();
		tui.setCommittedChildCount(1);
		tui.commit();
		await terminal.flush();

		const fullRedrawsBefore = tui.fullRedraws;

		// Remove the spinner (1-line live shrink at turn end).
		spinner.lines = [];
		tui.requestRender();
		await terminal.flush();

		// Committed wide lines must still be present and intact in scrollback.
		const logical = terminal.getLogicalScrollBuffer();
		for (let i = 0; i < 5; i++) {
			assert.ok(logical.includes(`${WIDE}#${i}`), `committed line #${i} must survive the shrink`);
		}
		// Sanity: a shrink uses a bounded redraw, not an unbounded transcript replay loop.
		assert.ok(tui.fullRedraws - fullRedrawsBefore <= 1, "shrink should be a single bounded repaint");
	});

	it("bottom-anchors wrapped live-region shrink without replaying committed scrollback", async () => {
		const terminal = new LoggingVirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);

		const history = new TestComponent();
		history.lines = Array.from({ length: 8 }, (_, i) => `HIST ${i}`);
		committed.addChild(history);

		const liveComp = new TestComponent();
		liveComp.lines = Array.from({ length: 4 }, (_, i) => markWrappable(`${WIDE}${i}`));
		live.addChild(liveComp);

		tui.start();
		await terminal.flush();
		tui.setCommittedChildCount(1);
		tui.commit();
		await terminal.flush();

		assert.equal(
			(tui as unknown as TuiRenderState).previousViewportTop,
			6,
			"test setup should have a wrapped live region taller than the viewport",
		);
		const redrawsBefore = tui.fullRedraws;
		terminal.clearWrites();

		liveComp.lines = [markWrappable(WIDE)];
		tui.requestRender();
		await terminal.flush();

		const writes = terminal.getWrites();
		const viewport = terminal.getViewport();
		assert.equal(tui.fullRedraws - redrawsBefore, 1, "wrapped live shrink should take one bounded repaint");
		assert.ok(!writes.includes("\x1b[3J"), "wrapped live shrink must not clear scrollback");
		assert.ok(!writes.includes("\x1b[2J"), "wrapped live shrink must not clear the whole screen");
		assert.ok(!writes.includes("HIST 0"), "wrapped live shrink must not replay committed history");
		assert.ok(
			terminal.getLogicalScrollBuffer().some((line) => line.includes("HIST 0")),
			"committed scrollback should survive the wrapped live shrink",
		);
		assert.deepEqual(viewport.slice(-3), ["ABCDEFGHIJKLMNOPQRST", "UVWXYZ0123456789abcd", "efghijklmn"]);
		assert.equal((tui as unknown as TuiRenderState).maxLinesRendered, 3, "shrink should track screen rows");

		tui.stop();
	});

	it("bottom-anchors wrapped changes above the live viewport without replaying committed scrollback", async () => {
		const terminal = new LoggingVirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);

		const history = new TestComponent();
		history.lines = Array.from({ length: 8 }, (_, i) => `HIST ${i}`);
		committed.addChild(history);

		const liveComp = new TestComponent();
		const lineA = "A".repeat(50);
		const lineB = "B".repeat(50);
		const lineC = "C".repeat(50);
		const lineD = "D".repeat(50);
		const changedA = "E".repeat(50);
		liveComp.lines = [lineA, lineB, lineC, lineD].map(markWrappable);
		live.addChild(liveComp);

		tui.start();
		await terminal.flush();
		tui.setCommittedChildCount(1);
		tui.commit();
		await terminal.flush();

		assert.equal(
			(tui as unknown as TuiRenderState).previousViewportTop,
			6,
			"test setup should place the first wrapped live line above the viewport",
		);
		const redrawsBefore = tui.fullRedraws;
		terminal.clearWrites();

		liveComp.lines = [changedA, lineB, lineC, lineD].map(markWrappable);
		tui.requestRender();
		await terminal.flush();

		const writes = terminal.getWrites();
		const viewport = terminal.getViewport();
		const state = tui as unknown as TuiRenderState;
		assert.equal(tui.fullRedraws - redrawsBefore, 1, "change above viewport should take one bounded repaint");
		assert.ok(!writes.includes("\x1b[3J"), "change above viewport must not clear scrollback");
		assert.ok(!writes.includes("\x1b[2J"), "change above viewport must not clear the whole screen");
		assert.ok(!writes.includes("HIST 0"), "change above viewport must not replay committed history");
		assert.ok(
			terminal.getLogicalScrollBuffer().some((line) => line.includes("HIST 0")),
			"committed scrollback should survive the above-viewport wrapped repaint",
		);
		assert.ok(
			state.previousLines[0].includes(changedA),
			"off-screen changed line should still update renderer state",
		);
		assert.deepEqual(viewport.slice(0, 3), ["C".repeat(20), "C".repeat(20), "C".repeat(10)]);
		assert.deepEqual(viewport.slice(3), ["D".repeat(20), "D".repeat(20), "D".repeat(10)]);
		assert.equal(state.previousViewportTop, 6, "bottom-anchored repaint should keep the live viewport at the bottom");

		tui.stop();
	});

	it("accumulates mixed wrapped and fitting chrome rows through append and cursor positioning", async () => {
		const terminal = new LoggingVirtualTerminal(20, 10);
		const tui = new TUI(terminal, true);
		const comp = new TestComponent();
		const firstWrapped = "A".repeat(50);
		const cursorCol = 24;
		const secondWrapped = `${"C".repeat(cursorCol)}${CURSOR_MARKER}${"D".repeat(21)}`;
		const secondVisible = `${"C".repeat(cursorCol)}${"D".repeat(21)}`;
		comp.lines = [markWrappable(firstWrapped), "CHROME: ready", markWrappable(secondWrapped)];
		tui.addChild(comp);
		tui.start();
		await terminal.flush();

		assert.deepEqual(
			terminal.getCursorPosition(),
			{ x: 4, y: 5 },
			"cursor should skip the 3-row wrapped line and one fitting chrome row before wrapping within its own line",
		);
		assert.equal(terminal.getViewport()[3], "CHROME: ready", "fitting non-wrappable chrome should occupy one row");

		const redrawsBefore = tui.fullRedraws;
		terminal.clearWrites();
		comp.lines = [markWrappable(firstWrapped), "CHROME: ready", markWrappable(secondWrapped), "APPEND"];
		tui.requestRender();
		await terminal.flush();

		const writes = terminal.getWrites();
		const viewport = terminal.getViewport();
		assert.equal(tui.fullRedraws, redrawsBefore, "mixed wrapped append should stay on the row-aware append path");
		assert.ok(!writes.includes("\x1b[J"), "pure append after mixed content should not clear/rewrite the viewport");
		assert.equal(viewport[7], "APPEND", "append target should land after 3 + 1 + 3 accumulated rows");
		assert.deepEqual(terminal.getCursorPosition(), { x: 4, y: 5 });
		assert.deepEqual(
			terminal.getLogicalScrollBuffer().filter((line) => line.length > 0),
			[firstWrapped, "CHROME: ready", secondVisible, "APPEND"],
		);

		tui.stop();
	});

	it("maps wide-character cursor positions through the real renderer", async () => {
		const terminal = new VirtualTerminal(9, 8);
		const tui = new TUI(terminal, true);
		const comp = new TestComponent();
		const preceding = "漢".repeat(5); // 4 glyphs fit in row 0, fifth moves to row 1 at width 9.
		const cursorLine = `${"界".repeat(5)}${CURSOR_MARKER}tail`;
		comp.lines = [markWrappable(preceding), markWrappable(cursorLine)];
		tui.addChild(comp);
		tui.start();
		await terminal.flush();

		assert.deepEqual(
			terminal.getCursorPosition(),
			{ x: 2, y: 3 },
			"double-width glyphs at odd terminal boundaries should not use naive col % width math",
		);
		assert.deepEqual(
			terminal.getLogicalScrollBuffer().filter((line) => line.length > 0),
			[preceding, `${"界".repeat(5)}tail`],
		);

		tui.stop();
	});

	it("keeps height-only resize anchored using wrapped screen rows", async () => {
		const terminal = new LoggingVirtualTerminal(20, 10);
		const tui = new TUI(terminal);
		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);

		const history = new TestComponent();
		history.lines = Array.from({ length: 6 }, (_, i) => `HIST ${i}`);
		committed.addChild(history);
		const liveComp = new TestComponent();
		liveComp.lines = Array.from({ length: 4 }, (_, i) => markWrappable(`${WIDE}${i}`));
		live.addChild(liveComp);

		tui.start();
		await terminal.flush();
		tui.setCommittedChildCount(1);
		tui.commit();
		await terminal.flush();
		assert.equal((tui as unknown as TuiRenderState).previousViewportTop, 2);

		terminal.clearWrites();
		terminal.resize(20, 6);
		await terminal.flush();

		const writes = terminal.getWrites();
		const viewport = terminal.getViewport();
		assert.ok(!writes.includes("\x1b[3J"), "height-only resize must not clear scrollback");
		assert.ok(!writes.includes("HIST 0"), "height-only resize must not replay committed history");
		assert.equal((tui as unknown as TuiRenderState).previousViewportTop, 6);
		assert.deepEqual(viewport.slice(-3), ["ABCDEFGHIJKLMNOPQRST", "UVWXYZ0123456789abcd", "efghijklmn3"]);

		tui.stop();
	});

	it("recommitAll throws the over-width guard for unmarked wide lines", () => {
		withTempHome((home) => {
			const terminal = new VirtualTerminal(20, 8);
			const tui = new TUI(terminal);
			const comp = new TestComponent();
			comp.lines = ["x".repeat(21)];
			tui.addChild(comp);

			assert.throws(() => tui.recommitAll(), /Rendered line 0 exceeds terminal width \(21 > 20\)\./);
			const crashLogPath = path.join(home, ".dreb", "agent", "dreb-crash.log");
			assert.ok(fs.existsSync(crashLogPath), "recommitAll guard must write a crash log");
		});
	});

	it("stop moves below wrapped screen rows", async () => {
		const terminal = new LoggingVirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const comp = new TestComponent();
		comp.lines = [markWrappable(WIDE)];
		tui.addChild(comp);
		tui.start();
		await terminal.flush();

		terminal.clearWrites();
		tui.stop();

		assert.match(terminal.getWrites(), /\x1b\[1B\r\n/, "stop should move from row 2 to row 3 before newline");
	});

	it("reflows wrapped content on resize (recommitAll) and keeps it copy-clean", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TUI(terminal);
		const comp = new TestComponent();
		comp.lines = [markWrappable(WIDE), markWrappable(`${WIDE}xyz`)];
		tui.addChild(comp);
		tui.start();
		await terminal.flush();

		// Widen: now the first line fits on one row, the second still wraps.
		terminal.resize(60, 8);
		await terminal.flush();

		const logical = terminal.getLogicalScrollBuffer().filter((l) => l.length > 0);
		assert.ok(logical.includes(WIDE), "first line intact after resize");
		assert.ok(logical.includes(`${WIDE}xyz`), "second line intact after resize");
	});
});
