import { describe, expect, test } from "vitest";

/**
 * Tests for agent model fallback lists (#80).
 *
 * Tests frontmatter parsing of model lists (comma-separated and YAML list syntax)
 * and the fallback resolution logic.
 */

// Replicate parseAgentFrontmatter's model parsing logic for unit testing
function parseModelField(frontmatter: string): string | string[] | undefined {
	// YAML list syntax
	const listMatch = frontmatter.match(/^model:\s*\n((?:\s+-\s+.+\n?)+)/m);
	if (listMatch) {
		const items = listMatch[1]
			.split("\n")
			.map((line) => line.replace(/^\s+-\s+/, "").trim())
			.filter(Boolean);
		return items.length > 1 ? items : items[0];
	}
	// Inline value
	const match = frontmatter.match(/^model:\s*(.+)$/m);
	const value = match?.[1].trim();
	if (!value) return undefined;
	if (value.includes(",")) {
		const items = value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		return items.length > 1 ? items : items[0];
	}
	return value;
}

// Replicate resolveModelWithFallbacks logic for unit testing
function resolveModelWithFallbacks(
	models: string | string[],
	resolver: (model: string) => { ok: true; modelId: string } | { ok: false; error: string },
): { ok: true; modelId: string } | { ok: false; error: string } {
	const modelList = Array.isArray(models) ? models : [models];
	let lastError = "";
	for (const modelStr of modelList) {
		const result = resolver(modelStr);
		if (result.ok) return result;
		lastError = result.error;
	}
	if (modelList.length > 1) {
		return {
			ok: false,
			error: `None of the fallback models resolved: ${modelList.join(", ")}. Last error: ${lastError}`,
		};
	}
	return { ok: false, error: lastError };
}

describe("model fallback lists", () => {
	describe("frontmatter parsing", () => {
		test("single model string", () => {
			const fm = "name: test\nmodel: glm-5-turbo";
			expect(parseModelField(fm)).toBe("glm-5-turbo");
		});

		test("no model field", () => {
			const fm = "name: test\ndescription: no model";
			expect(parseModelField(fm)).toBeUndefined();
		});

		test("comma-separated list", () => {
			const fm = "name: test\nmodel: glm-5.1, claude-opus-4-6";
			expect(parseModelField(fm)).toEqual(["glm-5.1", "claude-opus-4-6"]);
		});

		test("comma-separated list with three models", () => {
			const fm = "name: test\nmodel: glm-5.1, claude-opus-4-6, gpt-4o";
			expect(parseModelField(fm)).toEqual(["glm-5.1", "claude-opus-4-6", "gpt-4o"]);
		});

		test("single item comma-separated returns string", () => {
			const fm = "name: test\nmodel: glm-5-turbo,";
			expect(parseModelField(fm)).toBe("glm-5-turbo");
		});

		test("YAML list syntax", () => {
			const fm = "name: test\nmodel:\n  - glm-5.1\n  - claude-opus-4-6";
			expect(parseModelField(fm)).toEqual(["glm-5.1", "claude-opus-4-6"]);
		});

		test("YAML list with single item returns string", () => {
			const fm = "name: test\nmodel:\n  - glm-5-turbo";
			expect(parseModelField(fm)).toBe("glm-5-turbo");
		});

		test("model with provider prefix", () => {
			const fm = "name: test\nmodel: anthropic/claude-opus-4-6, openai/gpt-4o";
			expect(parseModelField(fm)).toEqual(["anthropic/claude-opus-4-6", "openai/gpt-4o"]);
		});
	});

	describe("fallback resolution", () => {
		const knownModels = new Set(["glm-5.1", "glm-5-turbo", "gpt-4o"]);

		const mockResolver = (model: string) => {
			if (knownModels.has(model)) {
				return { ok: true as const, modelId: model };
			}
			return { ok: false as const, error: `Model "${model}" not found` };
		};

		test("single model resolves", () => {
			const result = resolveModelWithFallbacks("glm-5.1", mockResolver);
			expect(result).toEqual({ ok: true, modelId: "glm-5.1" });
		});

		test("single model fails", () => {
			const result = resolveModelWithFallbacks("nonexistent", mockResolver);
			expect(result).toEqual({ ok: false, error: 'Model "nonexistent" not found' });
		});

		test("first model in list resolves", () => {
			const result = resolveModelWithFallbacks(["glm-5.1", "gpt-4o"], mockResolver);
			expect(result).toEqual({ ok: true, modelId: "glm-5.1" });
		});

		test("falls through to second model", () => {
			const result = resolveModelWithFallbacks(["nonexistent", "gpt-4o"], mockResolver);
			expect(result).toEqual({ ok: true, modelId: "gpt-4o" });
		});

		test("falls through to third model", () => {
			const result = resolveModelWithFallbacks(["nonexistent", "also-bad", "glm-5-turbo"], mockResolver);
			expect(result).toEqual({ ok: true, modelId: "glm-5-turbo" });
		});

		test("all models fail shows combined error", () => {
			const result = resolveModelWithFallbacks(["bad-1", "bad-2"], mockResolver);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("None of the fallback models resolved");
				expect(result.error).toContain("bad-1, bad-2");
			}
		});

		test("string input treated as single-element list", () => {
			const result = resolveModelWithFallbacks("glm-5.1", mockResolver);
			expect(result).toEqual({ ok: true, modelId: "glm-5.1" });
		});
	});
});
