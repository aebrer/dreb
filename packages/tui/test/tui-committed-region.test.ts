import assert from "node:assert";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "../src/autocomplete.js";
import { Editor } from "../src/components/editor.js";
import { type Component, Container, TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
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

	getWriteCount(): number {
		return this.writes.length;
	}

	clearWrites(): void {
		this.writes = [];
	}
}

describe("TUI committed-scrollback region", () => {
	it("commit() prevents transcript replay on content shrink", async () => {
		// This is the core fix: after committing finalized content, a 1-line
		// shrink (like spinner removal at agent_end) should NOT trigger a full
		// transcript replay into scrollback.
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		// Simulate layout: [committed container] [live container]
		const committedContainer = new Container();
		const liveContainer = new Container();
		tui.addChild(committedContainer);
		tui.addChild(liveContainer);

		// Add "finalized messages" to committed container (taller than terminal)
		const messageLines = Array.from({ length: 15 }, (_, i) => `Message ${i}`);
		const messageComponent = new TestComponent();
		messageComponent.lines = messageLines;
		committedContainer.addChild(messageComponent);

		// Add "spinner" to live container
		const spinnerComponent = new TestComponent();
		spinnerComponent.lines = ["Working..."];
		liveContainer.addChild(spinnerComponent);

		tui.start();
		await terminal.flush();

		// Mark committedContainer as committed (child 0)
		tui.setCommittedChildCount(1);
		tui.commit();

		const _redrawsBefore = tui.fullRedraws;
		terminal.clearWrites();

		// Simulate spinner removal (the trigger for the bug)
		spinnerComponent.lines = [];
		tui.requestRender();
		await terminal.flush();

		// The key assertions:
		// 1. No full-screen clear (\x1b[2J) — committed content untouched
		assert.ok(
			!terminal.getWrites().includes("\x1b[2J"),
			"Content shrink after commit should not clear entire screen",
		);
		// 2. No scrollback clear (\x1b[3J)
		assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Content shrink after commit should not clear scrollback");
		// 3. The committed lines ("Message 0" through "Message 14") should NOT
		//    appear in the write stream — they were already in scrollback.
		assert.ok(
			!terminal.getWrites().includes("Message 0"),
			"Committed message content should not be re-emitted on shrink",
		);

		tui.stop();
	});

	it("commit writes to scrollback once — subsequent shrink doesn't grow it", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const committedContainer = new Container();
		const liveContainer = new Container();
		tui.addChild(committedContainer);
		tui.addChild(liveContainer);

		// 5 message lines + 2 live lines
		const messages = new TestComponent();
		messages.lines = ["Msg 0", "Msg 1", "Msg 2", "Msg 3", "Msg 4"];
		committedContainer.addChild(messages);

		const spinner = new TestComponent();
		spinner.lines = ["Working...", "Status"];
		liveContainer.addChild(spinner);

		tui.start();
		await terminal.flush();

		// Commit the message container
		tui.setCommittedChildCount(1);
		tui.commit();

		// Get scroll buffer size after commit
		const bufferAfterCommit = terminal.getScrollBuffer().filter((l) => l.trim()).length;

		// Shrink live content (remove one line)
		spinner.lines = ["Working..."];
		tui.requestRender();
		await terminal.flush();

		const bufferAfterShrink = terminal.getScrollBuffer().filter((l) => l.trim()).length;

		// Scroll buffer should NOT grow by a transcript-sized copy
		// (at most it might change by 1 line, but should not double)
		assert.ok(
			bufferAfterShrink <= bufferAfterCommit + 1,
			`Scroll buffer grew unexpectedly: before=${bufferAfterCommit}, after=${bufferAfterShrink}`,
		);

		tui.stop();
	});

	it("live-region differential path leaves committed lines untouched", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);

		const msg = new TestComponent();
		msg.lines = ["Header", "Committed content"];
		committed.addChild(msg);

		const editor = new TestComponent();
		editor.lines = ["Editor line 1", "Editor line 2"];
		live.addChild(editor);

		tui.start();
		await terminal.flush();

		tui.setCommittedChildCount(1);
		tui.commit();

		terminal.clearWrites();

		// Update only live content
		editor.lines = ["Editor line 1", "Editor UPDATED"];
		tui.requestRender();
		await terminal.flush();

		// Committed content should not be in the write stream
		assert.ok(!terminal.getWrites().includes("Header"), "Committed 'Header' should not be re-emitted");
		assert.ok(!terminal.getWrites().includes("Committed content"), "Committed content should not be re-emitted");
		// Live content should be updated
		assert.ok(terminal.getWrites().includes("Editor UPDATED"), "Live content should be updated");

		tui.stop();
	});

	it("recommitAll() clears scrollback and re-renders everything", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);

		const msg = new TestComponent();
		msg.lines = ["Old theme message"];
		committed.addChild(msg);

		const editor = new TestComponent();
		editor.lines = ["Editor"];
		live.addChild(editor);

		tui.start();
		await terminal.flush();

		tui.setCommittedChildCount(1);
		tui.commit();

		const redrawsBefore = tui.fullRedraws;
		terminal.clearWrites();

		// Simulate theme change: modify content and recommit
		msg.lines = ["New theme message"];
		tui.recommitAll();

		assert.ok(terminal.getWrites().includes("\x1b[3J"), "recommitAll should clear scrollback");
		assert.ok(terminal.getWrites().includes("New theme message"), "recommitAll should re-render committed content");
		assert.ok(terminal.getWrites().includes("Editor"), "recommitAll should re-render live content");
		assert.ok(tui.fullRedraws > redrawsBefore, "recommitAll should increment fullRedraws");

		tui.stop();
	});

	it("width change triggers recommitAll (re-renders everything at new width)", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);

		const msg = new TestComponent();
		msg.lines = ["Committed at width 40"];
		committed.addChild(msg);

		const editor = new TestComponent();
		editor.lines = ["Live"];
		live.addChild(editor);

		tui.start();
		await terminal.flush();

		tui.setCommittedChildCount(1);
		tui.commit();

		terminal.clearWrites();

		// Width change should trigger recommitAll (re-render at new width)
		terminal.resize(60, 10);
		await terminal.flush();

		assert.ok(terminal.getWrites().includes("\x1b[3J"), "Width change should clear scrollback via recommitAll");
		assert.ok(
			terminal.getWrites().includes("Committed at width 40"),
			"Width change should re-render committed content",
		);

		tui.stop();
	});

	it("height change only re-renders live region when live-region start is visible", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);

		const msg = new TestComponent();
		msg.lines = Array.from({ length: 8 }, (_, i) => `Msg ${i}`);
		committed.addChild(msg);

		const editor = new TestComponent();
		editor.lines = ["Editor"];
		live.addChild(editor);

		tui.start();
		await terminal.flush();

		tui.setCommittedChildCount(1);
		tui.commit();

		terminal.clearWrites();

		// prevViewportTop is 0, so clearAndRedraw() keeps the cheap live-region-only
		// fullRender path and does not replay committed scrollback.
		terminal.resize(40, 15);
		await terminal.flush();

		assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Height change should not clear scrollback");
		// Committed content should NOT be re-emitted
		assert.ok(!terminal.getWrites().includes("Msg 0"), "Height change should not re-emit committed content");

		tui.stop();
	});

	it("height shrink after a scrolled live region recommits and bottom-anchors", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);

		const history = new TestComponent();
		history.lines = Array.from({ length: 20 }, (_, i) => `HIST ${i}`);
		committed.addChild(history);

		const liveComp = new TestComponent();
		liveComp.lines = ["EDITOR >", "footer"];
		live.addChild(liveComp);

		tui.start();
		await terminal.flush();
		tui.setCommittedChildCount(1);
		tui.commit();
		await terminal.flush();

		// Grow the live region beyond the 10-row viewport, then coalesce a live-region
		// shrink with a terminal height shrink. The heightChanged branch recomputes
		// prevViewportTop from the previous live-region height, sees that the old
		// live region had scrolled, and must recommit rather than live-region-only redraw.
		liveComp.lines = [...Array.from({ length: 11 }, (_, i) => `TALL ${i}`), "EDITOR >", "footer"];
		tui.requestRender();
		await terminal.flush();

		const redrawsBefore = tui.fullRedraws;
		terminal.clearWrites();

		liveComp.lines = ["EDITOR >", "footer"];
		terminal.resize(40, 8);
		await terminal.flush();

		const writes = terminal.getWrites();
		const viewport = terminal.getViewport();
		const editorRow = viewport.findIndex((l) => l.includes("EDITOR >"));
		const footerRow = viewport.findIndex((l) => l.includes("footer"));

		assert.ok(writes.includes("\x1b[3J"), "height shrink after scrolled live region should clear scrollback");
		assert.ok(writes.includes("HIST 0"), "height shrink recommit should re-emit committed history");
		assert.strictEqual(editorRow, viewport.length - 2, "editor should be second-from-bottom after recommit");
		assert.strictEqual(footerRow, viewport.length - 1, "last live line should be bottom-anchored after recommit");
		assert.ok(
			viewport.slice(0, editorRow).some((l) => l.includes("HIST")),
			"committed history must be restored above the editor after height shrink",
		);
		assert.ok(tui.fullRedraws > redrawsBefore, "height shrink after scrolled live region should full-redraw");

		tui.stop();
	});

	it("multiple commits accumulate correctly", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);

		tui.setCommittedChildCount(1);

		// Start with live content only
		const comp1 = new TestComponent();
		comp1.lines = ["Turn 1 msg", "Turn 1 tool"];
		live.addChild(comp1);

		const comp2 = new TestComponent();
		comp2.lines = ["Turn 2 msg"];
		live.addChild(comp2);

		const spinner = new TestComponent();
		spinner.lines = ["Working..."];
		live.addChild(spinner);

		tui.start();
		await terminal.flush();

		// Commit turn 1 (move comp1 from live to committed)
		live.removeChild(comp1);
		committed.addChild(comp1);
		tui.commit();

		terminal.clearWrites();

		// Commit turn 2
		live.removeChild(comp2);
		committed.addChild(comp2);
		tui.commit();

		terminal.clearWrites();

		// Remove spinner (content shrink)
		spinner.lines = [];
		tui.requestRender();
		await terminal.flush();

		// Neither turn's content should be re-emitted
		assert.ok(!terminal.getWrites().includes("Turn 1"), "Turn 1 not re-emitted after shrink");
		assert.ok(!terminal.getWrites().includes("Turn 2"), "Turn 2 not re-emitted after shrink");

		tui.stop();
	});

	it("getCommittedChildCount returns current value", () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		assert.strictEqual(tui.getCommittedChildCount(), 0);

		tui.addChild(new TestComponent());
		tui.setCommittedChildCount(1);
		assert.strictEqual(tui.getCommittedChildCount(), 1);
	});

	it("onPostRender fires after fullRender path", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);
		tui.setCommittedChildCount(1);

		const msg = new TestComponent();
		msg.lines = ["Committed"];
		committed.addChild(msg);

		const editor = new TestComponent();
		editor.lines = ["Editor"];
		live.addChild(editor);

		let postRenderCount = 0;
		tui.onPostRender = () => {
			postRenderCount++;
		};

		tui.start();
		await terminal.flush();

		assert.ok(postRenderCount > 0, "onPostRender should fire after first render");

		const before = postRenderCount;

		// Trigger content shrink → fullRender path
		editor.lines = [];
		tui.requestRender();
		await terminal.flush();

		assert.ok(postRenderCount > before, "onPostRender should fire after fullRender (content shrink)");

		tui.stop();
	});

	it("onPostRender fires after recommitAll", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);
		tui.setCommittedChildCount(1);

		const msg = new TestComponent();
		msg.lines = ["Msg"];
		committed.addChild(msg);

		tui.start();
		await terminal.flush();

		let postRenderCount = 0;
		tui.onPostRender = () => {
			postRenderCount++;
		};

		tui.recommitAll();
		assert.strictEqual(postRenderCount, 1, "onPostRender should fire after recommitAll");

		tui.stop();
	});

	it("onPostRender fires after differential render path", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const live = new Container();
		tui.addChild(live);

		const editor = new TestComponent();
		editor.lines = ["Line 1", "Line 2"];
		live.addChild(editor);

		tui.start();
		await terminal.flush();

		let postRenderCount = 0;
		tui.onPostRender = () => {
			postRenderCount++;
		};

		// Change only one line → differential path (no fullRender)
		editor.lines = ["Line 1", "Line UPDATED"];
		tui.requestRender();
		await terminal.flush();

		assert.strictEqual(postRenderCount, 1, "onPostRender should fire after differential render");

		tui.stop();
	});

	it("deferred commit via onPostRender paints final state before committing", async () => {
		// This is the key regression test for Finding 2: components must be
		// rendered with their final state BEFORE being committed to scrollback.
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);
		tui.setCommittedChildCount(1);

		// Simulate a tool in "streaming" state
		const tool = new TestComponent();
		tool.lines = ["Working..."];
		live.addChild(tool);

		const spinner = new TestComponent();
		spinner.lines = ["Spinner"];
		live.addChild(spinner);

		tui.start();
		await terminal.flush();

		// Simulate tool_execution_end: update to final state, then defer commit
		tool.lines = ["Tool result: success", "Output line 2", "Output line 3"];

		// Wire up deferred commit (like interactive-mode does)
		let commitNeeded = false;
		tui.onPostRender = () => {
			if (commitNeeded) {
				commitNeeded = false;
				// Move tool from live to committed (like tryCommitPrefix)
				live.removeChild(tool);
				committed.addChild(tool);
				tui.commit();
			}
		};

		// Mark for deferred commit and trigger render
		commitNeeded = true;
		terminal.clearWrites();
		tui.requestRender();
		await terminal.flush();

		// The render should have painted the FINAL tool state before committing
		const writes = terminal.getWrites();
		assert.ok(
			writes.includes("Tool result: success"),
			"Final tool state should be painted to terminal before commit",
		);
		assert.ok(writes.includes("Output line 3"), "All lines of final tool state should be visible");

		// After the post-render callback, tool is in committed container
		assert.strictEqual(committed.children.length, 1, "Tool should be in committed container");
		assert.strictEqual(live.children.length, 1, "Only spinner should remain in live");

		// A subsequent render should NOT re-emit the committed tool content
		terminal.clearWrites();
		spinner.lines = ["Done"];
		tui.requestRender();
		await terminal.flush();

		assert.ok(
			!terminal.getWrites().includes("Tool result"),
			"Committed tool content should not be re-emitted on subsequent render",
		);

		tui.stop();
	});

	it("commit() is idempotent when called twice without new content", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);
		tui.setCommittedChildCount(1);

		const msg = new TestComponent();
		msg.lines = ["Msg 1", "Msg 2"];
		committed.addChild(msg);

		const editor = new TestComponent();
		editor.lines = ["Editor"];
		live.addChild(editor);

		tui.start();
		await terminal.flush();

		tui.commit();
		const afterFirst = tui.getCommittedChildCount();

		// Second commit with no new content
		tui.commit();
		const afterSecond = tui.getCommittedChildCount();

		assert.strictEqual(afterFirst, afterSecond, "Idempotent commit should not change state");

		// Rendering should still work
		terminal.clearWrites();
		editor.lines = ["Updated"];
		tui.requestRender();
		await terminal.flush();

		assert.ok(terminal.getWrites().includes("Updated"), "Rendering should work after idempotent commit");

		tui.stop();
	});

	// Regression for issue 277: when the live region grows taller than the viewport
	// (big tool output, long streaming message, overlay padding) the terminal scrolls
	// committed history into scrollback. When the live region later shrinks, the
	// renderer must re-anchor the editor at the BOTTOM of the viewport. The old code
	// took a live-region-only fullRender() path that could not restore committed
	// history from scrollback, stranding the editor at the TOP of an empty viewport
	// ("jump to the top").
	it("live-region shrink past viewport re-anchors editor at the bottom (issue 277)", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);

		// Committed history taller than the 10-row viewport.
		const history = new TestComponent();
		history.lines = Array.from({ length: 20 }, (_, i) => `HIST ${i}`);
		committed.addChild(history);

		const liveComp = new TestComponent();
		liveComp.lines = [];
		live.addChild(liveComp);

		tui.start();
		await terminal.flush();
		tui.setCommittedChildCount(1);
		tui.commit();
		await terminal.flush();

		// 1. Live region grows taller than the viewport (e.g. a big tool output above
		//    the editor). This scrolls committed history out of the viewport.
		liveComp.lines = [...Array.from({ length: 11 }, (_, i) => `LIVE-BIG ${i}`), "EDITOR >", "footer"];
		tui.requestRender();
		await terminal.flush();

		const redrawsBefore = tui.fullRedraws;
		terminal.clearWrites();

		// 2. Live region shrinks back to just the editor (deferred post-turn render:
		//    big output commits / spinner removed / pending content clears).
		liveComp.lines = ["EDITOR >", "footer"];
		tui.requestRender();
		await terminal.flush();

		const viewport = terminal.getViewport();
		const editorRow = viewport.findIndex((l) => l.includes("EDITOR >"));
		const footerRow = viewport.findIndex((l) => l.includes("footer"));

		assert.ok(editorRow !== -1, "editor must be visible after the shrink");
		// The bug anchored the editor at the very top (row 0) of an otherwise empty
		// viewport. After the fix it sits exactly second-from-bottom (the editor) with
		// the footer bottom-anchored and committed history above — matching the exact
		// invariant asserted by the sibling recommit tests.
		assert.strictEqual(
			editorRow,
			viewport.length - 2,
			`editor should be second-from-bottom after recommit, was at row ${editorRow} of ${viewport.length}`,
		);
		assert.strictEqual(footerRow, viewport.length - 1, "last live line should be bottom-anchored after recommit");
		assert.ok(
			viewport.slice(0, editorRow).some((l) => l.includes("HIST")),
			"committed history must be restored above the editor (not stranded in scrollback)",
		);
		// The fix re-anchors via recommitAll(), which clears scrollback and repaints.
		assert.ok(
			terminal.getWrites().includes("\x1b[3J"),
			"exceeded-viewport shrink should re-anchor via recommitAll (scrollback clear)",
		);
		assert.ok(tui.fullRedraws > redrawsBefore, "exceeded-viewport shrink should perform a full redraw");

		tui.stop();
	});

	it("pure trailing deletion that moves the viewport up recommits and bottom-anchors", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);

		const history = new TestComponent();
		history.lines = Array.from({ length: 20 }, (_, i) => `HIST ${i}`);
		committed.addChild(history);

		const liveComp = new TestComponent();
		liveComp.lines = ["EDITOR >", "footer"];
		live.addChild(liveComp);

		tui.start();
		await terminal.flush();
		tui.setCommittedChildCount(1);
		tui.commit();
		await terminal.flush();

		// Grow by appending trailing rows after an unchanged editor/footer prefix. When
		// this later shrinks back to the prefix, firstChanged >= newLines.length and
		// targetRow (1) is above the previous viewport top (3), so doRender takes the
		// "deleted lines moved viewport up" clearAndRedraw() branch.
		liveComp.lines = ["EDITOR >", "footer", ...Array.from({ length: 11 }, (_, i) => `TRAILING ${i}`)];
		tui.requestRender();
		await terminal.flush();

		const redrawsBefore = tui.fullRedraws;
		terminal.clearWrites();

		liveComp.lines = ["EDITOR >", "footer"];
		tui.requestRender();
		await terminal.flush();

		const writes = terminal.getWrites();
		const viewport = terminal.getViewport();
		const editorRow = viewport.findIndex((l) => l.includes("EDITOR >"));
		const footerRow = viewport.findIndex((l) => l.includes("footer"));

		assert.ok(writes.includes("\x1b[3J"), "viewport-up trailing deletion should recommit and clear scrollback");
		assert.ok(writes.includes("HIST 0"), "recommit should re-emit committed history");
		assert.strictEqual(editorRow, viewport.length - 2, "editor should be second-from-bottom after recommit");
		assert.strictEqual(footerRow, viewport.length - 1, "last live line should be bottom-anchored after recommit");
		assert.ok(
			viewport.slice(0, editorRow).some((l) => l.includes("HIST")),
			"committed history must be restored above the editor",
		);
		assert.ok(tui.fullRedraws > redrawsBefore, "viewport-up trailing deletion should perform a full redraw");

		tui.stop();
	});

	it("oversized trailing deletion recommits from the extraLines > height branch", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);

		const history = new TestComponent();
		history.lines = Array.from({ length: 20 }, (_, i) => `HIST ${i}`);
		committed.addChild(history);

		const liveComp = new TestComponent();
		liveComp.lines = ["EDITOR >", "footer"];
		live.addChild(liveComp);

		tui.start();
		await terminal.flush();
		tui.setCommittedChildCount(1);
		tui.commit();
		await terminal.flush();

		liveComp.lines = ["EDITOR >", "footer", ...Array.from({ length: 13 }, (_, i) => `TRAILING ${i}`)];
		tui.requestRender();
		await terminal.flush();

		// Under the normal bottom-anchored invariant, deleting more than one viewport
		// of trailing rows also moves targetRow above prevViewportTop and is handled by
		// the earlier "deleted lines moved viewport up" guard. Lower prevViewportTop to
		// model a defensive/stale viewport-tracking state and exercise the sibling
		// extraLines > height clearAndRedraw() route directly.
		(tui as unknown as { previousViewportTop: number }).previousViewportTop = 1;

		const redrawsBefore = tui.fullRedraws;
		terminal.clearWrites();

		liveComp.lines = ["EDITOR >", "footer"];
		tui.requestRender();
		await terminal.flush();

		const writes = terminal.getWrites();
		const viewport = terminal.getViewport();
		const editorRow = viewport.findIndex((l) => l.includes("EDITOR >"));
		const footerRow = viewport.findIndex((l) => l.includes("footer"));

		assert.ok(writes.includes("\x1b[3J"), "oversized trailing deletion should recommit and clear scrollback");
		assert.ok(writes.includes("HIST 0"), "recommit should re-emit committed history");
		assert.strictEqual(editorRow, viewport.length - 2, "editor should be second-from-bottom after recommit");
		assert.strictEqual(footerRow, viewport.length - 1, "last live line should be bottom-anchored after recommit");
		assert.ok(
			viewport.slice(0, editorRow).some((l) => l.includes("HIST")),
			"committed history must be restored above the editor",
		);
		assert.ok(tui.fullRedraws > redrawsBefore, "oversized trailing deletion should perform a full redraw");

		tui.stop();
	});

	// This small shrink intentionally does not cover clearAndRedraw(): with
	// prevViewportTop === 0 and firstChanged === 0, it falls through to the older
	// live-region-only content-shrank path. The clearAndRedraw() fullRender arm is
	// guarded by the height-change-with-prevViewportTop-0 test above.
	it("small live-region content shrink stays live-region-only (no scrollback clear)", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);

		const committed = new Container();
		const live = new Container();
		tui.addChild(committed);
		tui.addChild(live);

		const history = new TestComponent();
		history.lines = Array.from({ length: 20 }, (_, i) => `HIST ${i}`);
		committed.addChild(history);

		const liveComp = new TestComponent();
		liveComp.lines = ["line a", "line b", "EDITOR >"];
		live.addChild(liveComp);

		tui.start();
		await terminal.flush();
		tui.setCommittedChildCount(1);
		tui.commit();
		await terminal.flush();

		terminal.clearWrites();

		// Shrink a small (fits-in-viewport) live region — should not clear scrollback.
		liveComp.lines = ["EDITOR >"];
		tui.requestRender();
		await terminal.flush();

		assert.ok(
			!terminal.getWrites().includes("\x1b[3J"),
			"within-viewport shrink must not clear scrollback (no transcript replay)",
		);
		assert.ok(
			!terminal.getWrites().includes("HIST"),
			"within-viewport shrink must not re-emit committed history (stays on live-region-only path)",
		);

		tui.stop();
	});
});

describe("autocomplete + committed scrollback (ghost whitespace)", () => {
	function applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: { value: string },
		prefix: string,
	) {
		const line = lines[cursorLine] || "";
		const before = line.slice(0, cursorCol - prefix.length);
		const after = line.slice(cursorCol);
		const newLines = [...lines];
		newLines[cursorLine] = before + item.value + after;
		return { lines: newLines, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
	}

	async function flushAutocomplete(): Promise<void> {
		await Promise.resolve();
		await new Promise((resolve) => setImmediate(resolve));
	}

	function slashProvider(): AutocompleteProvider {
		const all = [
			{ value: "/help", label: "/help" },
			{ value: "/model", label: "/model" },
			{ value: "/settings", label: "/settings" },
			{ value: "/compact", label: "/compact" },
			{ value: "/clear", label: "/clear" },
		];
		return {
			getSuggestions: async (lines, _cl, cursorCol) => {
				const text = lines[0] || "";
				const prefix = text.slice(0, cursorCol);
				if (!prefix.startsWith("/")) return null;
				const items = all.filter((i) => i.value.startsWith(prefix));
				return items.length ? { items, prefix } : null;
			},
			applyCompletion,
		};
	}

	function setup(height: number) {
		const terminal = new VirtualTerminal(40, height);
		const tui = new TUI(terminal);
		const committed = new Container();
		const transcript = new TestComponent();
		transcript.lines = Array.from({ length: 30 }, (_, i) => `Line ${i}`);
		committed.addChild(transcript);
		const editor = new Editor(tui, defaultEditorTheme);
		const footer = new TestComponent();
		footer.lines = ["[footer]"];
		tui.addChild(committed);
		tui.addChild(editor);
		tui.addChild(footer);
		editor.setAutocompleteProvider(slashProvider());
		return { terminal, tui, editor };
	}

	it("dismissing the menu restores committed content (no ghost whitespace)", async () => {
		const { terminal, tui, editor } = setup(10);
		tui.start();
		tui.setFocus(editor);
		await terminal.flush();
		tui.setCommittedChildCount(1);
		tui.commit();
		await terminal.flush();

		editor.handleInput("/");
		tui.requestRender();
		await flushAutocomplete();
		await terminal.flush();
		assert.strictEqual(editor.isShowingAutocomplete(), true, "menu open after /");

		// Dismiss with Escape
		editor.handleInput("\x1b");
		tui.requestRender();
		await terminal.flush();

		const viewport = terminal.getViewport();
		const lastNonBlank = viewport.map((l) => l.trim()).reduce((acc, l, i) => (l !== "" ? i : acc), -1);
		const blankBelow = viewport.length - 1 - lastNonBlank;
		assert.ok(blankBelow <= 1, `Expected no ghost whitespace below prompt, got ${blankBelow} blank rows`);
		// Committed content scrolled off by the menu should be back in view.
		assert.ok(
			viewport.some((l) => l.includes("[footer]")),
			"footer should be visible at the bottom after dismiss",
		);

		tui.stop();
	});

	it("filtering the menu shorter keeps the live region height stable", async () => {
		const { terminal, tui, editor } = setup(12);
		tui.start();
		tui.setFocus(editor);
		await terminal.flush();
		tui.setCommittedChildCount(1);
		tui.commit();
		await terminal.flush();

		editor.handleInput("/");
		tui.requestRender();
		await flushAutocomplete();
		await terminal.flush();
		const footerRowOpen = terminal.getViewport().findIndex((l) => l.includes("[footer]"));

		// Filter from 5 matches down to 1 ("/s" -> /settings)
		editor.handleInput("s");
		tui.requestRender();
		await flushAutocomplete();
		await terminal.flush();
		const footerRowFiltered = terminal.getViewport().findIndex((l) => l.includes("[footer]"));

		assert.strictEqual(
			footerRowFiltered,
			footerRowOpen,
			"footer row must not move up when the list narrows (no live-region shrink)",
		);

		tui.stop();
	});

	it("closing a tall inline modal via recommitAll leaves no ghost whitespace", async () => {
		// Mirrors the interactive-mode pattern: an inline modal (settings/extension
		// selector) is swapped into the editor slot, growing the live region and
		// scrolling committed content off; closing it must recommitAll() to restore
		// the committed content rather than leaving blank rows below the prompt.
		const height = 10;
		const terminal = new VirtualTerminal(40, height);
		const tui = new TUI(terminal);

		const committed = new Container();
		const transcript = new TestComponent();
		transcript.lines = Array.from({ length: 30 }, (_, i) => `Line ${i}`);
		committed.addChild(transcript);

		// editorSlot holds either the small editor or a tall modal
		const editorSlot = new Container();
		const editor = new TestComponent();
		editor.lines = ["> "];
		editorSlot.addChild(editor);
		const footer = new TestComponent();
		footer.lines = ["[footer]"];

		tui.addChild(committed);
		tui.addChild(editorSlot);
		tui.addChild(footer);

		tui.start();
		await terminal.flush();
		tui.setCommittedChildCount(1);
		tui.commit();
		await terminal.flush();

		// Open a tall modal in the editor slot (taller than what fits below committed)
		const modal = new TestComponent();
		modal.lines = Array.from({ length: 6 }, (_, i) => `Setting ${i}`);
		editorSlot.clear();
		editorSlot.addChild(modal);
		tui.requestRender();
		await terminal.flush();

		// Close: swap the editor back and recommitAll (what restoreEditorComponent does)
		editorSlot.clear();
		editorSlot.addChild(editor);
		tui.recommitAll();
		await terminal.flush();

		const viewport = terminal.getViewport();
		const lastNonBlank = viewport.map((l) => l.trim()).reduce((acc, l, i) => (l !== "" ? i : acc), -1);
		const blankBelow = viewport.length - 1 - lastNonBlank;
		assert.ok(blankBelow <= 1, `Expected no ghost whitespace after modal close, got ${blankBelow} blank rows`);
		assert.ok(
			viewport.some((l) => l.includes("[footer]")),
			"footer should be visible at the bottom after modal close",
		);
		assert.ok(!viewport.some((l) => l.includes("Setting ")), "modal content should be gone after close");

		tui.stop();
	});
});
