import { describe, expect, it } from "vitest";
import { renderTerminalOutput } from "../src/core/tools/terminal-render.js";

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
});
