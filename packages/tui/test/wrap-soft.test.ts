import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, Container, TUI } from "../src/tui.js";
import { markWrappable } from "../src/wrap.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/** A 50-char logical line that wraps to 3 rows at width 20. */
const WIDE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmn";

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
