import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { createSearchToolDefinition, isSearchAvailable } from "../../src/core/tools/search.js";

// ============================================================================
// Availability
// ============================================================================

describe("isSearchAvailable", () => {
	it("returns true on Node 22+", () => {
		// We're running on Node 22, so node:sqlite should be available
		expect(isSearchAvailable()).toBe(true);
	});
});

// ============================================================================
// Tool Definition Properties
// ============================================================================

describe("createSearchToolDefinition", () => {
	const tmpDir = mkdtempSync(path.join(tmpdir(), "search-test-"));
	const tool = createSearchToolDefinition(tmpDir);

	it("has the correct name", () => {
		expect(tool.name).toBe("search");
	});

	it("has a label", () => {
		expect(tool.label).toBeDefined();
		expect(typeof tool.label).toBe("string");
		expect(tool.label!.length).toBeGreaterThan(0);
	});

	it("has a description", () => {
		expect(tool.description).toBeDefined();
		expect(typeof tool.description).toBe("string");
		expect(tool.description.length).toBeGreaterThan(0);
	});

	it("has a promptSnippet", () => {
		expect(tool.promptSnippet).toBeDefined();
		expect(typeof tool.promptSnippet).toBe("string");
		expect(tool.promptSnippet!.length).toBeGreaterThan(0);
	});

	it("has promptGuidelines array", () => {
		expect(tool.promptGuidelines).toBeDefined();
		expect(Array.isArray(tool.promptGuidelines)).toBe(true);
		expect(tool.promptGuidelines!.length).toBeGreaterThan(0);
	});

	// ============================================================================
	// Parameters Schema
	// ============================================================================

	describe("parameters schema", () => {
		const schema = tool.parameters as any;

		it("has query as a required property", () => {
			expect(schema.properties.query).toBeDefined();
			expect(schema.properties.query.type).toBe("string");
			expect(schema.required).toContain("query");
		});

		it("has path as an optional property", () => {
			expect(schema.properties.path).toBeDefined();
			// Optional properties are not in the required array
			expect(schema.required ?? []).not.toContain("path");
		});

		it("has limit as an optional property", () => {
			expect(schema.properties.limit).toBeDefined();
			expect(schema.required ?? []).not.toContain("limit");
		});
	});

	// ============================================================================
	// Execute — empty query
	// ============================================================================

	describe("execute", () => {
		it('returns "cannot be empty" message for empty query', async () => {
			const result = await tool.execute("test-1", { query: "" }, undefined, undefined, undefined as any);
			const text = result.content[0];
			expect(text.type).toBe("text");
			expect((text as { type: "text"; text: string }).text).toContain("empty");
		});
	});
});
