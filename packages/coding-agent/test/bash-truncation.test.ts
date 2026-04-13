import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { executeBash } from "../src/core/bash-executor.js";
import { createBashTool } from "../src/core/tools/bash.js";

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n") ?? ""
	);
}

/** Collect temp file paths created during tests so we can clean them up. */
const tempFiles: string[] = [];

function trackTempFile(path: string | undefined): void {
	if (path) tempFiles.push(path);
}

afterEach(() => {
	for (const f of tempFiles) {
		try {
			unlinkSync(f);
		} catch {}
	}
	tempFiles.length = 0;
});

// ---------------------------------------------------------------------------
// executeBash (bash-executor.ts)
// ---------------------------------------------------------------------------
describe("executeBash truncation temp file", () => {
	it("creates a temp file when output exceeds line limit but not byte limit", async () => {
		// seq 3000 produces 3000 lines (~14KB) — well under 50KB but over 2000 lines
		const result = await executeBash("seq 3000");
		trackTempFile(result.fullOutputPath);

		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		expect(result.fullOutputPath).not.toBe("undefined");
		expect(existsSync(result.fullOutputPath!)).toBe(true);

		const fullContent = readFileSync(result.fullOutputPath!, "utf-8");
		// Should contain all 3000 numbers
		expect(fullContent).toContain("1\n");
		expect(fullContent).toContain("3000");
		const lineCount = fullContent.trimEnd().split("\n").length;
		expect(lineCount).toBe(3000);
	});

	it("creates a temp file when output exceeds byte limit", async () => {
		// Generate >50KB of deterministic output (60000 bytes > 50KB = 51200 bytes)
		const result = await executeBash("head -c 60000 /dev/zero | tr '\\0' 'A'");
		trackTempFile(result.fullOutputPath);

		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		expect(existsSync(result.fullOutputPath!)).toBe(true);
	});

	it("does not create a temp file when output is small", async () => {
		const result = await executeBash("echo hello");
		trackTempFile(result.fullOutputPath);

		expect(result.truncated).toBe(false);
		expect(result.fullOutputPath).toBeUndefined();
	});

	it("creates a temp file when an aborted command has truncatable output", async () => {
		const controller = new AbortController();

		// Produce 3000+ lines (over the 2000-line truncation threshold) then sleep to keep alive
		const resultPromise = executeBash("seq 3000; sleep 30", { signal: controller.signal });

		// Give seq time to finish output, then abort during sleep
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
		controller.abort();

		const result = await resultPromise;
		trackTempFile(result.fullOutputPath);

		expect(result.cancelled).toBe(true);
		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		expect(result.fullOutputPath).not.toBe("undefined");
		expect(existsSync(result.fullOutputPath!)).toBe(true);

		const fullContent = readFileSync(result.fullOutputPath!, "utf-8");
		const lineCount = fullContent.trimEnd().split("\n").length;
		expect(lineCount).toBe(3000);
	});
});

// ---------------------------------------------------------------------------
// createBashTool (bash tool)
// ---------------------------------------------------------------------------
describe("bash tool truncation temp file", () => {
	it("includes a valid temp file path (not undefined) in truncation message for line-truncated output", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("test-call", { command: "seq 3000" });
		const output = getTextOutput(result);

		// The truncation message should mention "Showing lines" and a real file path
		expect(output).toContain("Showing lines");
		expect(output).toContain("Full output:");
		expect(output).not.toContain("Full output: undefined");

		// Extract the temp file path from the message
		const match = output.match(/Full output: (.+)\]/);
		expect(match).toBeTruthy();
		const tempPath = match![1];
		trackTempFile(tempPath);

		expect(existsSync(tempPath)).toBe(true);
		const fullContent = readFileSync(tempPath, "utf-8");
		expect(fullContent).toContain("3000");
		const lineCount = fullContent.trimEnd().split("\n").length;
		expect(lineCount).toBe(3000);
	});

	it("does not include temp file info for small output", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("test-call", { command: "echo hello" });
		const output = getTextOutput(result);

		expect(output).toContain("hello");
		expect(output).not.toContain("Full output:");
	});
});
