import { describe, expect, it, vi } from "vitest";
import { renderTerminalOutput, sanitizeCursorPositioning } from "../src/core/tools/terminal-render.js";

describe("renderTerminalOutput", () => {
	it("should collapse \\r-based progress bar to final state", () => {
		const input = "Progress: 0%\rProgress: 50%\rProgress: 100%";
		const result = renderTerminalOutput(input);
		expect(result).toBe("Progress: 100%");
	});

	it("should handle \\r overwrites with newlines between sections", () => {
		const input = "Starting download...\nProgress: 0%\rProgress: 50%\rProgress: 100%\nDone!";
		const result = renderTerminalOutput(input);
		expect(result).toBe("Starting download...\nProgress: 100%\nDone!");
	});

	it("should handle multiple progress bars on separate lines", () => {
		const input = ["File 1: 0%\rFile 1: 100%", "File 2: 0%\rFile 2: 100%"].join("\n");
		const result = renderTerminalOutput(input);
		expect(result).toContain("File 1: 100%");
		expect(result).toContain("File 2: 100%");
		// The intermediate "0%" states should be overwritten — only "100%" remains
		expect(result).not.toContain("File 1: 0%");
		expect(result).not.toContain("File 2: 0%");
	});

	it("should handle backspace", () => {
		// "abc" then backspace twice, then "d" → overwrites 'b' with 'd'
		const input = "abc\b\bd";
		const result = renderTerminalOutput(input);
		expect(result).toBe("adc");
	});

	it("should handle ANSI cursor-up and overwrite", () => {
		// Write two lines, cursor up one, overwrite
		const input = "Line 1\nLine 2\x1b[AOverwritten";
		const result = renderTerminalOutput(input);
		expect(result).toContain("Overwritten");
		expect(result).toContain("Line 2");
	});

	it("should handle ANSI erase-line sequence", () => {
		const input = "Old content\x1b[2KNew content";
		const result = renderTerminalOutput(input);
		expect(result).toContain("New content");
		expect(result).not.toContain("Old content");
	});

	it("should pass through normal text unchanged", () => {
		const input = "Hello, world!\nThis is a test.\nLine 3.";
		const result = renderTerminalOutput(input);
		expect(result).toBe(input);
	});

	it("should handle empty input", () => {
		expect(renderTerminalOutput("")).toBe("");
	});

	it("should strip ANSI color codes while preserving text", () => {
		// Red "error" then reset
		const input = "\x1b[31merror\x1b[0m: something failed";
		const result = renderTerminalOutput(input);
		expect(result).toBe("error: something failed");
	});

	it("should handle \\r\\n line endings (Windows-style) correctly", () => {
		const input = "Line 1\r\nLine 2\r\nLine 3";
		const result = renderTerminalOutput(input);
		expect(result).toContain("Line 1");
		expect(result).toContain("Line 2");
		expect(result).toContain("Line 3");
	});

	it("should handle a realistic npm install progress pattern", () => {
		// npm-style progress: repeated \r overwrites on the same line
		const lines = [];
		for (let i = 0; i <= 100; i += 10) {
			lines.push(`\rDownloading packages... ${i}%`);
		}
		const input = lines.join("");
		const result = renderTerminalOutput(input);
		expect(result).toBe("Downloading packages... 100%");
		// Intermediate states should be overwritten
		expect(result).not.toContain("Downloading packages... 0%");
		expect(result).not.toContain("Downloading packages... 50%");
	});

	it("should handle large output efficiently", () => {
		// 2000 lines of normal text should process quickly
		const lines = Array.from({ length: 2000 }, (_, i) => `Line ${i + 1}: some content here`);
		const input = lines.join("\n");
		const start = performance.now();
		const result = renderTerminalOutput(input);
		const elapsed = performance.now() - start;
		expect(result).toBe(input);
		expect(elapsed).toBeLessThan(1000); // Should complete well under 1 second
	});

	it("should handle tab characters", () => {
		const input = "col1\tcol2\tcol3";
		const result = renderTerminalOutput(input);
		// Tabs are expanded to tab stops (8-char boundaries)
		expect(result).toContain("col1");
		expect(result).toContain("col2");
		expect(result).toContain("col3");
	});

	it("should handle clear-screen sequence", () => {
		const input = "old text\x1b[2Jnew text";
		const result = renderTerminalOutput(input);
		expect(result).toContain("new text");
		expect(result).not.toContain("old text");
	});

	it("should cap extreme cursor positioning to prevent memory exhaustion", () => {
		// ESC[9999999;1H would try to create ~10M lines without sanitization
		const input = "hello\x1b[9999999;1Hworld";
		const start = performance.now();
		const result = renderTerminalOutput(input);
		const elapsed = performance.now() - start;
		// Should complete quickly (not allocate millions of lines)
		expect(elapsed).toBeLessThan(2000);
		expect(result).toContain("world");
	});

	it("should return raw input when TerminalTextRender throws", async () => {
		// Use vi.doMock (not hoisted) + dynamic import to avoid breaking other tests
		vi.doMock("terminal-render", () => ({
			TerminalTextRender: vi.fn().mockImplementation(() => ({
				write: vi.fn(),
				render: vi.fn(() => {
					throw new Error("Mock render failure");
				}),
			})),
		}));

		vi.resetModules();
		const { renderTerminalOutput: mockedRender } = await import("../src/core/tools/terminal-render.js");

		const input = "test input with \x1b[31mcolor\x1b[0m";
		const result = mockedRender(input);
		expect(result).toBe(input); // Should return raw input on error

		vi.doUnmock("terminal-render");
		vi.resetModules();
	});
});

describe("sanitizeCursorPositioning", () => {
	it("should cap large row values in CUP sequences", () => {
		const input = "\x1b[9999999;1H";
		const result = sanitizeCursorPositioning(input);
		expect(result).toBe("\x1b[5000;1H");
	});

	it("should cap large column values in CUP sequences", () => {
		const input = "\x1b[1;9999999H";
		const result = sanitizeCursorPositioning(input);
		expect(result).toBe("\x1b[1;5000H");
	});

	it("should cap both row and column values", () => {
		const input = "\x1b[9999999;9999999H";
		const result = sanitizeCursorPositioning(input);
		expect(result).toBe("\x1b[5000;5000H");
	});

	it("should not modify values within the cap", () => {
		const input = "\x1b[25;80H";
		const result = sanitizeCursorPositioning(input);
		expect(result).toBe("\x1b[25;80H");
	});

	it("should cap cursor movement sequences (CUU/CUD/CUF/CUB)", () => {
		expect(sanitizeCursorPositioning("\x1b[9999999A")).toBe("\x1b[5000A");
		expect(sanitizeCursorPositioning("\x1b[9999999B")).toBe("\x1b[5000B");
		expect(sanitizeCursorPositioning("\x1b[9999999C")).toBe("\x1b[5000C");
		expect(sanitizeCursorPositioning("\x1b[9999999D")).toBe("\x1b[5000D");
	});

	it("should cap VPA and HPA sequences", () => {
		expect(sanitizeCursorPositioning("\x1b[9999999d")).toBe("\x1b[5000d");
		expect(sanitizeCursorPositioning("\x1b[9999999G")).toBe("\x1b[5000G");
	});

	it("should handle the lowercase f variant of CUP", () => {
		const input = "\x1b[9999999;1f";
		const result = sanitizeCursorPositioning(input);
		expect(result).toBe("\x1b[5000;1f");
	});

	it("should leave non-cursor sequences untouched", () => {
		// Color code
		const input = "\x1b[31mhello\x1b[0m";
		const result = sanitizeCursorPositioning(input);
		expect(result).toBe(input);
	});

	it("should handle input with no ANSI sequences", () => {
		const input = "plain text";
		const result = sanitizeCursorPositioning(input);
		expect(result).toBe(input);
	});

	it("should preserve empty params (defaults)", () => {
		// ESC[H means cursor to home (1,1) — empty params
		const input = "\x1b[H";
		const result = sanitizeCursorPositioning(input);
		expect(result).toBe("\x1b[H");
	});

	it("should handle multiple sequences in one string", () => {
		const input = "text\x1b[9999999;1Hmore\x1b[9999999A";
		const result = sanitizeCursorPositioning(input);
		expect(result).toBe("text\x1b[5000;1Hmore\x1b[5000A");
	});

	it("should cap large row values in CNL sequences", () => {
		const input = "\x1b[9999999E";
		const result = sanitizeCursorPositioning(input);
		expect(result).toBe("\x1b[5000E");
	});

	it("should cap scroll region bottom values", () => {
		const input = "\x1b[1;9999999r";
		const result = sanitizeCursorPositioning(input);
		expect(result).toBe("\x1b[1;5000r");
	});

	it("should clamp accumulated cursor-down sequences to MAX_CURSOR_POSITION", () => {
		// Three sequences of 2000 each = 6000 total, but should be clamped to 5000
		const input = "\x1b[2000B\x1b[2000B\x1b[2000B";
		const result = sanitizeCursorPositioning(input);
		// First: 2000 allowed (cursor at 2000)
		// Second: 2000 allowed (cursor at 4000)
		// Third: only 1000 allowed (cursor would exceed 5000)
		expect(result).toBe("\x1b[2000B\x1b[2000B\x1b[1000B");
	});

	it("should clamp accumulated cursor-forward sequences to MAX_CURSOR_POSITION", () => {
		const input = "\x1b[3000C\x1b[3000C";
		const result = sanitizeCursorPositioning(input);
		// First: 3000 allowed (cursor at 3000)
		// Second: only 2000 allowed (5000 - 3000)
		expect(result).toBe("\x1b[3000C\x1b[2000C");
	});

	it("should allow cursor re-use after moving up", () => {
		// Move down 3000, then up 2000, then down — should have 4000 available
		const input = "\x1b[3000B\x1b[2000A\x1b[4000B";
		const result = sanitizeCursorPositioning(input);
		// After first: cursorRow=3000
		// After second: cursorRow=1000
		// Third: allowed=5000-1000=4000, clamped=min(4000,4000)=4000
		expect(result).toBe("\x1b[3000B\x1b[2000A\x1b[4000B");
	});

	it("should track absolute positioning for accumulation limits", () => {
		// Absolute position to row 4000, then cursor down
		const input = "\x1b[4000;1H\x1b[2000B";
		const result = sanitizeCursorPositioning(input);
		// After H: cursorRow=4000
		// Cursor down 2000: allowed=5000-4000=1000, clamped=1000
		expect(result).toBe("\x1b[4000;1H\x1b[1000B");
	});

	it("should prevent cursor accumulation from many repeated sequences", () => {
		// Attack vector: 11000 sequences of ESC[5000B each pass per-sequence cap
		// but would accumulate to row ~55M without cumulative tracking
		const malicious = "\x1b[5000B".repeat(11000);
		const result = sanitizeCursorPositioning(malicious);
		// First sequence moves to 5000, all remaining are clamped to 0
		expect(result.startsWith("\x1b[5000B")).toBe(true);
		expect(result).toContain("\x1b[0B");
		// Total should be 11000 sequences (none stripped, just clamped)
		expect(result.split("\x1b[").length - 1).toBe(11000);
	});
});

describe("renderTerminalOutput — cursor accumulation security", () => {
	it("should survive repeated cursor-down attack without OOM or timeout", () => {
		// ~11000 sequences of ESC[5000B in ~100KB of input
		// Without the fix, this triggers ensureLine(55M) → ~1.3GB allocation → OOM
		const malicious = "\x1b[5000B".repeat(11000);
		const input = `start${malicious}end`;
		const start = performance.now();
		const result = renderTerminalOutput(input);
		const elapsed = performance.now() - start;
		// Must complete quickly — OOM or multi-second hang means the fix failed
		expect(elapsed).toBeLessThan(2000);
		expect(result).toContain("start");
		expect(result).toContain("end");
	});

	it("should survive repeated cursor-forward attack without OOM or timeout", () => {
		const malicious = "\x1b[5000C".repeat(11000);
		const input = `start${malicious}end`;
		const start = performance.now();
		const result = renderTerminalOutput(input);
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(2000);
		expect(result).toContain("start");
		expect(result).toContain("end");
	});
});
