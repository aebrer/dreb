import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { type Component, TUI } from "../src/tui.js";
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

async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(updates)) {
		previousValues.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	try {
		return await run();
	} finally {
		for (const [key, value] of previousValues) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function getCellItalic(terminal: VirtualTerminal, row: number, col: number): number {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const cell = line.getCell(col);
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	return cell.isItalic();
}

describe("TUI resize handling", () => {
	it("triggers full re-render when terminal height changes", async () => {
		await withEnv({ TERMUX_VERSION: undefined }, async () => {
			const terminal = new VirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["Line 0", "Line 1", "Line 2"];
			tui.start();
			await terminal.flush();

			const initialRedraws = tui.fullRedraws;

			// Resize height
			terminal.resize(40, 15);
			await terminal.flush();

			// Should have triggered a full redraw
			assert.ok(tui.fullRedraws > initialRedraws, "Height change should trigger full redraw");

			const viewport = terminal.getViewport();
			assert.ok(viewport[0]?.includes("Line 0"), "Content preserved after height change");

			tui.stop();
		});
	});

	it("skips full re-render on height changes in Termux", async () => {
		await withEnv({ TERMUX_VERSION: "1" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`);
			tui.start();
			await terminal.flush();
			terminal.clearWrites();

			const initialRedraws = tui.fullRedraws;
			for (const height of [15, 8, 14, 11]) {
				terminal.resize(40, height);
				await terminal.flush();
			}

			assert.strictEqual(tui.fullRedraws, initialRedraws, "Height change should not trigger full redraw");
			assert.ok(!terminal.getWrites().includes("\x1b[2J"), "Height change should not clear the screen");
			assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Height change should not clear scrollback");

			const viewport = terminal.getViewport();
			assert.ok(viewport.join("\n").includes("Line 19"), "Latest content remains visible after resize");

			tui.stop();
		});
	});

	it("triggers full re-render when terminal width changes", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.flush();

		const initialRedraws = tui.fullRedraws;

		// Resize width
		terminal.resize(60, 10);
		await terminal.flush();

		// Should have triggered a full redraw
		assert.ok(tui.fullRedraws > initialRedraws, "Width change should trigger full redraw");

		tui.stop();
	});
});

describe("TUI content shrinkage", () => {
	it("clears empty rows when content shrinks via differential renderer", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Start with many lines
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4", "Line 5"];
		tui.start();
		await terminal.flush();

		const initialRedraws = tui.fullRedraws;
		terminal.clearWrites();

		// Shrink to fewer lines
		component.lines = ["Line 0", "Line 1"];
		tui.requestRender();
		await terminal.flush();

		// Should NOT trigger a full redraw — differential renderer handles it
		assert.strictEqual(tui.fullRedraws, initialRedraws, "Shrink should use differential rendering, not full redraw");
		// Should NOT clear scrollback
		assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Shrink should not clear scrollback");

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), "First line preserved");
		assert.ok(viewport[1]?.includes("Line 1"), "Second line preserved");
		// Lines below should be empty (cleared by targeted erasure)
		assert.strictEqual(viewport[2]?.trim(), "", "Line 2 should be cleared");
		assert.strictEqual(viewport[3]?.trim(), "", "Line 3 should be cleared");

		tui.stop();
	});

	it("handles shrink to single line", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.flush();

		// Shrink to single line
		component.lines = ["Only line"];
		tui.requestRender();
		await terminal.flush();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Only line"), "Single line rendered");
		assert.strictEqual(viewport[1]?.trim(), "", "Line 1 should be cleared");

		tui.stop();
	});

	it("handles shrink to empty", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.flush();

		// Shrink to empty
		component.lines = [];
		tui.requestRender();
		await terminal.flush();

		const viewport = terminal.getViewport();
		// All lines should be empty
		assert.strictEqual(viewport[0]?.trim(), "", "Line 0 should be cleared");
		assert.strictEqual(viewport[1]?.trim(), "", "Line 1 should be cleared");

		tui.stop();
	});
});

describe("TUI differential rendering", () => {
	it("tracks cursor correctly when content shrinks with unchanged remaining lines", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Initial render: 5 identical lines
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		tui.start();
		await terminal.flush();

		// Shrink to 3 lines, all identical to before (no content changes in remaining lines)
		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.flush();

		// cursorRow should be 2 (last line of new content)
		// Verify by doing another render with a change on line 1
		component.lines = ["Line 0", "CHANGED", "Line 2"];
		tui.requestRender();
		await terminal.flush();

		const viewport = terminal.getViewport();
		// Line 1 should show "CHANGED", proving cursor tracking was correct
		assert.ok(viewport[1]?.includes("CHANGED"), `Expected "CHANGED" on line 1, got: ${viewport[1]}`);

		tui.stop();
	});

	it("renders correctly when only a middle line changes (spinner case)", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Initial render
		component.lines = ["Header", "Working...", "Footer"];
		tui.start();
		await terminal.flush();

		// Simulate spinner animation - only middle line changes
		const spinnerFrames = ["|", "/", "-", "\\"];
		for (const frame of spinnerFrames) {
			component.lines = ["Header", `Working ${frame}`, "Footer"];
			tui.requestRender();
			await terminal.flush();

			const viewport = terminal.getViewport();
			assert.ok(viewport[0]?.includes("Header"), `Header preserved: ${viewport[0]}`);
			assert.ok(viewport[1]?.includes(`Working ${frame}`), `Spinner updated: ${viewport[1]}`);
			assert.ok(viewport[2]?.includes("Footer"), `Footer preserved: ${viewport[2]}`);
		}

		tui.stop();
	});

	it("resets styles after each rendered line", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["\x1b[3mItalic", "Plain"];
		tui.start();
		await terminal.flush();

		assert.strictEqual(getCellItalic(terminal, 1, 0), 0);
		tui.stop();
	});

	it("renders correctly when first line changes but rest stays same", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.flush();

		// Change only first line
		component.lines = ["CHANGED", "Line 1", "Line 2", "Line 3"];
		tui.requestRender();
		await terminal.flush();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("CHANGED"), `First line changed: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("Line 1"), `Line 1 preserved: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("Line 3"), `Line 3 preserved: ${viewport[3]}`);

		tui.stop();
	});

	it("renders correctly when last line changes but rest stays same", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.flush();

		// Change only last line
		component.lines = ["Line 0", "Line 1", "Line 2", "CHANGED"];
		tui.requestRender();
		await terminal.flush();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), `Line 0 preserved: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("Line 1"), `Line 1 preserved: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("CHANGED"), `Last line changed: ${viewport[3]}`);

		tui.stop();
	});

	it("renders correctly when multiple non-adjacent lines change", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		tui.start();
		await terminal.flush();

		// Change lines 1 and 3, keep 0, 2, 4 the same
		component.lines = ["Line 0", "CHANGED 1", "Line 2", "CHANGED 3", "Line 4"];
		tui.requestRender();
		await terminal.flush();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), `Line 0 preserved: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("CHANGED 1"), `Line 1 changed: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("CHANGED 3"), `Line 3 changed: ${viewport[3]}`);
		assert.ok(viewport[4]?.includes("Line 4"), `Line 4 preserved: ${viewport[4]}`);

		tui.stop();
	});

	it("handles transition from content to empty and back to content", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Start with content
		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.flush();

		let viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), "Initial content rendered");

		// Clear to empty
		component.lines = [];
		tui.requestRender();
		await terminal.flush();

		// Add content back - this should work correctly even after empty state
		component.lines = ["New Line 0", "New Line 1"];
		tui.requestRender();
		await terminal.flush();

		viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("New Line 0"), `New content rendered: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("New Line 1"), `New content line 1: ${viewport[1]}`);

		tui.stop();
	});

	it("full re-renders when deleted lines move the viewport upward", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 12 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.flush();

		const initialRedraws = tui.fullRedraws;

		component.lines = Array.from({ length: 7 }, (_, i) => `Line ${i}`);
		tui.requestRender();
		await terminal.flush();

		assert.ok(tui.fullRedraws > initialRedraws, "Shrink should trigger a full redraw");
		assert.deepStrictEqual(terminal.getViewport(), ["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]);

		tui.stop();
	});

	it("appends after a shrink without another full redraw once the viewport is reset", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 8 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.flush();

		const initialRedraws = tui.fullRedraws;

		component.lines = ["Line 0", "Line 1"];
		tui.requestRender();
		await terminal.flush();

		assert.ok(tui.fullRedraws > initialRedraws, "Shrink should reset the viewport with a full redraw");
		const redrawsAfterShrink = tui.fullRedraws;

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.flush();

		assert.strictEqual(tui.fullRedraws, redrawsAfterShrink, "Append should stay on the differential path");
		assert.deepStrictEqual(terminal.getViewport(), ["Line 0", "Line 1", "Line 2", "", ""]);

		tui.stop();
	});

	it("clears stale content when maxLinesRendered was inflated by a transient component", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const chat = new TestComponent();
		const editor = new TestComponent();
		tui.addChild(chat);
		tui.addChild(editor);

		const longChat = Array.from({ length: 15 }, (_, i) => `Chat ${i}`);
		const shortChat = Array.from({ length: 12 }, (_, i) => `Chat ${i}`);
		const editorLines = ["Editor 0", "Editor 1", "Editor 2"];
		const selectorLines = Array.from({ length: 8 }, (_, i) => `Selector ${i}`);

		chat.lines = longChat;
		editor.lines = editorLines;
		tui.start();
		await terminal.flush();

		editor.lines = selectorLines;
		tui.requestRender();
		await terminal.flush();

		editor.lines = editorLines;
		tui.requestRender();
		await terminal.flush();

		const redrawsBeforeSwitch = tui.fullRedraws;
		chat.lines = shortChat;
		tui.requestRender();
		await terminal.flush();

		assert.ok(tui.fullRedraws > redrawsBeforeSwitch, "Branch switch should trigger a full redraw");

		const viewport = terminal.getViewport();
		for (let i = 0; i < 10; i++) {
			const line = viewport[i] ?? "";
			assert.ok(!line.includes("Chat 12"), `Stale "Chat 12" at viewport row ${i}`);
			assert.ok(!line.includes("Chat 13"), `Stale "Chat 13" at viewport row ${i}`);
			assert.ok(!line.includes("Chat 14"), `Stale "Chat 14" at viewport row ${i}`);
		}

		assert.deepStrictEqual(viewport, [
			"Chat 5",
			"Chat 6",
			"Chat 7",
			"Chat 8",
			"Chat 9",
			"Chat 10",
			"Chat 11",
			"Editor 0",
			"Editor 1",
			"Editor 2",
		]);

		tui.stop();
	});
});

describe("TUI scrollback preservation", () => {
	it("does not clear scrollback when content shrinks", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4", "Line 5"];
		tui.start();
		await terminal.flush();
		terminal.clearWrites();

		// Shrink content
		component.lines = ["Line 0", "Line 1"];
		tui.requestRender();
		await terminal.flush();

		assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Shrink should not clear scrollback");
		tui.stop();
	});

	it("clears scrollback on width change", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.flush();
		terminal.clearWrites();

		// Width change should clear scrollback (wrapping invalidates it)
		terminal.resize(60, 10);
		await terminal.flush();

		assert.ok(terminal.getWrites().includes("\x1b[3J"), "Width change should clear scrollback");
		tui.stop();
	});

	it("does not clear scrollback on height change", async () => {
		await withEnv({ TERMUX_VERSION: undefined }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["Line 0", "Line 1", "Line 2"];
			tui.start();
			await terminal.flush();
			terminal.clearWrites();

			// Height change should clear screen but NOT scrollback
			terminal.resize(40, 15);
			await terminal.flush();

			assert.ok(terminal.getWrites().includes("\x1b[2J"), "Height change should clear screen");
			assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Height change should not clear scrollback");
			tui.stop();
		});
	});

	it("off-screen changes do not trigger scrollback clear", async () => {
		const terminal = new LoggingVirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Content longer than terminal height
		component.lines = Array.from({ length: 15 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.flush();

		const initialRedraws = tui.fullRedraws;
		terminal.clearWrites();

		// Change a line above the viewport (viewport shows lines 10-14)
		component.lines = Array.from({ length: 15 }, (_, i) => (i === 2 ? "CHANGED" : `Line ${i}`));
		tui.requestRender();
		await terminal.flush();

		// Should not trigger a full redraw or clear scrollback
		assert.strictEqual(tui.fullRedraws, initialRedraws, "Off-screen change should not trigger full redraw");
		assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Off-screen change should not clear scrollback");
		assert.ok(!terminal.getWrites().includes("\x1b[2J"), "Off-screen change should not clear screen");

		// Visible content should remain correct
		const viewport = terminal.getViewport();
		assert.ok(viewport[4]?.includes("Line 14"), "Bottom of viewport preserved");

		tui.stop();
	});
});

describe("TUI maxLinesRendered tracking", () => {
	it("shrinks maxLinesRendered when no overlays are active", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Render long content
		component.lines = Array.from({ length: 8 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.flush();

		// Shrink content
		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.flush();

		// Now grow slightly — should NOT trigger full redraw (maxLinesRendered tracked actual)
		const redraws = tui.fullRedraws;
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.requestRender();
		await terminal.flush();

		assert.strictEqual(tui.fullRedraws, redraws, "Growth after shrink should use differential rendering");
		const viewport = terminal.getViewport();
		assert.ok(viewport[3]?.includes("Line 3"), "New line rendered correctly");

		tui.stop();
	});

	it("keeps maxLinesRendered stable with overlays active", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Render content
		component.lines = Array.from({ length: 8 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.flush();

		// Show overlay
		const overlayComponent = new TestComponent();
		overlayComponent.lines = ["Overlay content"];
		const handle = tui.showOverlay(overlayComponent, { width: 20, anchor: "center" });
		await terminal.flush();

		// Shrink content while overlay is active
		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.flush();

		// Overlay positioning should remain stable (maxLinesRendered should not shrink)
		const viewport = terminal.getViewport();
		// The overlay should still be visible and positioned correctly
		const overlayVisible = viewport.some((line) => line.includes("Overlay content"));
		assert.ok(overlayVisible, "Overlay should remain visible after content shrink");

		handle.hide();
		tui.stop();
	});
});

describe("TUI spinner lifecycle", () => {
	it("spinner add and remove leaves no ghost lines", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const chat = new TestComponent();
		const spinner = new TestComponent();
		tui.addChild(chat);
		tui.addChild(spinner);

		// Chat content with spinner
		chat.lines = ["Message 1", "Message 2"];
		spinner.lines = ["⠋ Loading..."];
		tui.start();
		await terminal.flush();

		let viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Message 1"), "Chat line 1");
		assert.ok(viewport[1]?.includes("Message 2"), "Chat line 2");
		assert.ok(viewport[2]?.includes("Loading"), "Spinner visible");

		// Remove spinner (simulates spinner stop)
		spinner.lines = [];
		tui.requestRender();
		await terminal.flush();

		viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Message 1"), "Chat line 1 preserved");
		assert.ok(viewport[1]?.includes("Message 2"), "Chat line 2 preserved");
		assert.strictEqual(viewport[2]?.trim(), "", "Spinner line should be cleared");

		tui.stop();
	});

	it("all-deleted case uses targeted erasure not full redraw", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Render 5 lines (all fit in viewport)
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		tui.start();
		await terminal.flush();

		const initialRedraws = tui.fullRedraws;
		terminal.clearWrites();

		// Shrink to 3 lines — lines 3,4 are "all deleted"
		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.flush();

		// Should use targeted erasure, not full redraw
		assert.strictEqual(tui.fullRedraws, initialRedraws, "Should not trigger full redraw");
		// Should use line-by-line erasure (\x1b[2K)
		assert.ok(terminal.getWrites().includes("\x1b[2K"), "Should use targeted line erasure");
		assert.ok(!terminal.getWrites().includes("\x1b[2J"), "Should not clear entire screen");

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), "Line 0 preserved");
		assert.ok(viewport[1]?.includes("Line 1"), "Line 1 preserved");
		assert.ok(viewport[2]?.includes("Line 2"), "Line 2 preserved");
		assert.strictEqual(viewport[3]?.trim(), "", "Line 3 cleared");
		assert.strictEqual(viewport[4]?.trim(), "", "Line 4 cleared");

		tui.stop();
	});
});

describe("TUI render throttle", () => {
	it("coalesces rapid render requests", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Initial"];
		tui.start();
		await terminal.flush();
		terminal.clearWrites();

		// Fire many rapid requestRender calls
		for (let i = 0; i < 50; i++) {
			component.lines = [`Update ${i}`];
			tui.requestRender();
		}

		// Wait for all timers to settle
		await terminal.flush();

		// The final state should reflect the last update
		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Update 49"), `Final state should be last update, got: ${viewport[0]}`);

		tui.stop();
	});

	it("force render resets state even during throttle window", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.flush();

		// Immediately force render — should still work correctly
		component.lines = ["Force updated"];
		tui.requestRender(true);
		await terminal.flush();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Force updated"), `Force render applied: ${viewport[0]}`);

		tui.stop();
	});
});
