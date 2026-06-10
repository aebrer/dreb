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
