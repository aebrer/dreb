import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import type { Terminal } from "../src/terminal.js";

// Extract Terminal class from the module
const XtermTerminal = xterm.Terminal;

/**
 * Virtual terminal for testing using xterm.js for accurate terminal emulation
 */
export class VirtualTerminal implements Terminal {
	private xterm: XtermTerminalType;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _columns: number;
	private _rows: number;

	constructor(columns = 80, rows = 24) {
		this._columns = columns;
		this._rows = rows;

		// Create xterm instance with specified dimensions
		this.xterm = new XtermTerminal({
			cols: columns,
			rows: rows,
			// Disable all interactive features for testing
			disableStdin: true,
			allowProposedApi: true,
		});
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		// Enable bracketed paste mode for consistency with ProcessTerminal
		this.xterm.write("\x1b[?2004h");
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {
		// No-op for virtual terminal - no stdin to drain
	}

	stop(): void {
		// Disable bracketed paste mode
		this.xterm.write("\x1b[?2004l");
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	write(data: string): void {
		this.xterm.write(data);
	}

	get columns(): number {
		return this._columns;
	}

	get rows(): number {
		return this._rows;
	}

	get kittyProtocolActive(): boolean {
		// Virtual terminal always reports Kitty protocol as active for testing
		return true;
	}

	getInputModeReenableSequence(): string {
		return this.kittyProtocolActive ? "\x1b[?2004h\x1b[>7u" : "\x1b[?2004h\x1b[>4;2m";
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			this.xterm.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			this.xterm.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		this.xterm.write("\x1b[?25l");
	}

	showCursor(): void {
		this.xterm.write("\x1b[?25h");
	}

	clearLine(): void {
		this.xterm.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.xterm.write("\x1b[J");
	}

	clearScreen(): void {
		this.xterm.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		this.xterm.write(`\x1b]0;${title}\x07`);
	}

	// Test-specific methods not in Terminal interface

	/**
	 * Simulate keyboard input
	 */
	sendInput(data: string): void {
		if (this.inputHandler) {
			this.inputHandler(data);
		}
	}

	/**
	 * Resize the terminal
	 */
	resize(columns: number, rows: number): void {
		this._columns = columns;
		this._rows = rows;
		this.xterm.resize(columns, rows);
		if (this.resizeHandler) {
			this.resizeHandler();
		}
	}

	/**
	 * Wait for all pending writes to complete. Viewport and scroll buffer will be updated.
	 * Waits long enough for TUI render throttle timers (setTimeout) to fire first.
	 */
	async flush(): Promise<void> {
		// Wait for pending timers (TUI render throttle uses setTimeout)
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		// Then flush xterm's write queue
		return new Promise<void>((resolve) => {
			this.xterm.write("", () => resolve());
		});
	}

	/**
	 * Flush and get viewport - convenience method for tests
	 */
	async flushAndGetViewport(): Promise<string[]> {
		await this.flush();
		return this.getViewport();
	}

	/**
	 * Get the visible viewport (what's currently on screen)
	 * Note: You should use getViewportAfterWrite() for testing after writing data
	 */
	getViewport(): string[] {
		const lines: string[] = [];
		const buffer = this.xterm.buffer.active;

		// Get only the visible lines (viewport)
		for (let i = 0; i < this.xterm.rows; i++) {
			const line = buffer.getLine(buffer.viewportY + i);
			if (line) {
				lines.push(line.translateToString(true));
			} else {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * Get the entire scroll buffer
	 */
	getScrollBuffer(): string[] {
		const lines: string[] = [];
		const buffer = this.xterm.buffer.active;

		// Get all lines in the buffer (including scrollback)
		for (let i = 0; i < buffer.length; i++) {
			const line = buffer.getLine(i);
			if (line) {
				lines.push(line.translateToString(true));
			} else {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * Get the scroll buffer reconstructed into *logical* lines: rows that the
	 * terminal soft-wrapped (marked `isWrapped`) are joined back with their
	 * predecessor. This is what a user copy of the scrollback yields — verifying
	 * that soft-wrapped output contains no injected hard newlines.
	 */
	getLogicalScrollBuffer(): string[] {
		const logical: string[] = [];
		const buffer = this.xterm.buffer.active;
		for (let i = 0; i < buffer.length; i++) {
			const line = buffer.getLine(i);
			const text = line ? line.translateToString(true) : "";
			if (line?.isWrapped && logical.length > 0) {
				logical[logical.length - 1] += text;
			} else {
				logical.push(text);
			}
		}
		return logical;
	}

	/** Scroll the viewport by a signed line count; negative moves up into scrollback. */
	scrollLines(amount: number): void {
		this.xterm.scrollLines(amount);
	}

	/** Scroll the viewport to the terminal's current bottom. */
	scrollToBottom(): void {
		const buffer = this.xterm.buffer.active;
		this.xterm.scrollLines(buffer.baseY - buffer.viewportY);
	}

	getViewportTop(): number {
		return this.xterm.buffer.active.viewportY;
	}

	getBufferLength(): number {
		return this.xterm.buffer.active.length;
	}

	/**
	 * Clear the terminal viewport
	 */
	clear(): void {
		this.xterm.clear();
	}

	/**
	 * Reset the terminal completely
	 */
	reset(): void {
		this.xterm.reset();
	}

	/**
	 * Get cursor position
	 */
	getCursorPosition(): { x: number; y: number } {
		const buffer = this.xterm.buffer.active;
		return {
			x: buffer.cursorX,
			y: buffer.cursorY,
		};
	}
}
