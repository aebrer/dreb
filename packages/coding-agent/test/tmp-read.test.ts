import { describe, expect, test } from "vitest";
import { createTmpReadToolDefinition } from "../src/core/tools/tmp-read.js";

/**
 * Tests for tmp-read path validation (sandbox /tmp isolation).
 *
 * The tmp_read tool is the Sandbox agent's only security boundary.
 * These tests verify that path traversal, prefix confusion, and
 * escape attempts are all correctly blocked.
 */

describe("tmp_read path validation", () => {
	const tool = createTmpReadToolDefinition();

	/**
	 * Helper to call execute and check if the path validation blocked it.
	 * Returns { blocked: true, text } for access-denied, { blocked: false } for
	 * paths that pass validation (even if the inner read tool fails with ENOENT).
	 */
	async function readPath(path: string): Promise<{ blocked: boolean; text: string }> {
		try {
			const result = await tool.execute("test", { path }, undefined, undefined, undefined as any);
			const first = result.content?.[0];
			const text = first && "text" in first ? first.text : "";
			return { blocked: text.includes("Access denied"), text };
		} catch {
			// Inner read tool may throw (e.g. ENOENT) — that means path validation passed
			return { blocked: false, text: "" };
		}
	}

	describe("allowed paths", () => {
		test("/tmp/file.txt passes path validation", async () => {
			const { blocked } = await readPath("/tmp/file.txt");
			expect(blocked).toBe(false);
		});

		test("relative path resolves under /tmp", async () => {
			const { blocked } = await readPath("subdir/file.txt");
			expect(blocked).toBe(false);
		});
	});

	describe("blocked paths — traversal attacks", () => {
		test("/tmp/../etc/passwd is blocked (absolute traversal)", async () => {
			const { blocked, text } = await readPath("/tmp/../etc/passwd");
			expect(blocked).toBe(true);
			expect(text).toContain("Access denied");
		});

		test("../etc/passwd is blocked (relative traversal)", async () => {
			const { blocked, text } = await readPath("../etc/passwd");
			expect(blocked).toBe(true);
			expect(text).toContain("Access denied");
		});

		test("/tmp/foo/../../etc/passwd is blocked (nested traversal)", async () => {
			const { blocked, text } = await readPath("/tmp/foo/../../etc/passwd");
			expect(blocked).toBe(true);
			expect(text).toContain("Access denied");
		});
	});

	describe("blocked paths — prefix confusion", () => {
		test("/tmpevil/file.txt is blocked", async () => {
			const { blocked, text } = await readPath("/tmpevil/file.txt");
			expect(blocked).toBe(true);
			expect(text).toContain("Access denied");
		});

		test("/tmp_other/file.txt is blocked", async () => {
			const { blocked, text } = await readPath("/tmp_other/file.txt");
			expect(blocked).toBe(true);
			expect(text).toContain("Access denied");
		});
	});

	describe("blocked paths — absolute escapes", () => {
		test("/etc/passwd is blocked", async () => {
			const { blocked, text } = await readPath("/etc/passwd");
			expect(blocked).toBe(true);
			expect(text).toContain("Access denied");
		});

		test("/home/user/file is blocked", async () => {
			const { blocked, text } = await readPath("/home/user/file");
			expect(blocked).toBe(true);
			expect(text).toContain("Access denied");
		});
	});
});
