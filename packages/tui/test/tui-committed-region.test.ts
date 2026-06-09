import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, Container, TUI } from "../src/tui.js";
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

	it("height change only re-renders live region (no scrollback clear)", async () => {
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

		// Height change should NOT clear scrollback
		terminal.resize(40, 15);
		await terminal.flush();

		assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Height change should not clear scrollback");
		// Committed content should NOT be re-emitted
		assert.ok(!terminal.getWrites().includes("Msg 0"), "Height change should not re-emit committed content");

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
});
