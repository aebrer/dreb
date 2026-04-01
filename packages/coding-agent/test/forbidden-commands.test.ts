import { describe, expect, it } from "vitest";
import { isForbiddenCommand } from "../src/core/forbidden-commands.js";

describe("isForbiddenCommand", () => {
	describe("default patterns (always active)", () => {
		it("blocks gh pr merge --admin", () => {
			expect(isForbiddenCommand("gh pr merge 93 --admin")).toBe("gh pr merge.*--admin");
		});

		it("blocks gh pr merge --admin --squash", () => {
			expect(isForbiddenCommand("gh pr merge 93 --admin --squash")).toBe("gh pr merge.*--admin");
		});

		it("allows gh pr merge --squash", () => {
			expect(isForbiddenCommand("gh pr merge 93 --squash")).toBeUndefined();
		});

		it("allows gh pr merge (no flags)", () => {
			expect(isForbiddenCommand("gh pr merge 93")).toBeUndefined();
		});

		it("blocks git push --force", () => {
			expect(isForbiddenCommand("git push --force")).toBe("git push.*(-f\\b|--force)");
		});

		it("blocks git push -f", () => {
			expect(isForbiddenCommand("git push -f")).toBe("git push.*(-f\\b|--force)");
		});

		it("blocks git push --force-with-lease", () => {
			expect(isForbiddenCommand("git push --force-with-lease")).toBe("git push.*(-f\\b|--force)");
		});

		it("blocks git push --force origin feature-branch", () => {
			expect(isForbiddenCommand("git push --force origin feature-branch")).toBe("git push.*(-f\\b|--force)");
		});

		it("allows git push origin feature-branch", () => {
			expect(isForbiddenCommand("git push origin feature-branch")).toBeUndefined();
		});

		it("allows git push", () => {
			expect(isForbiddenCommand("git push")).toBeUndefined();
		});

		it("blocks gh api ... bypass", () => {
			expect(isForbiddenCommand("gh api repos/owner/repo --method PATCH --field bypass=true")).toBe(
				"gh api.*bypass",
			);
		});

		it("allows gh api without bypass", () => {
			expect(isForbiddenCommand("gh api repos/owner/repo --method PATCH")).toBeUndefined();
		});

		it("allows gh api repos/owner/repo", () => {
			expect(isForbiddenCommand("gh api repos/owner/repo")).toBeUndefined();
		});
	});

	describe("custom patterns from settings", () => {
		it("checks custom patterns in addition to defaults", () => {
			expect(isForbiddenCommand("rm -rf /")).toBeUndefined();
			expect(isForbiddenCommand("rm -rf /", ["rm -rf /"])).toBe("rm -rf /");
		});

		it("custom patterns do not replace defaults", () => {
			// Default pattern still blocks even with custom patterns
			expect(isForbiddenCommand("git push --force", ["rm -rf /"])).toBe("git push.*(-f\\b|--force)");
		});

		it("handles invalid regex gracefully", () => {
			expect(isForbiddenCommand("some safe command", ["[invalid"])).toBeUndefined();
		});

		it("returns first matching pattern", () => {
			const result = isForbiddenCommand("dangerous", ["dangerous", ".*dangerous.*"]);
			expect(result).toBe("dangerous");
		});
	});

	describe("edge cases", () => {
		it("returns undefined for empty command", () => {
			expect(isForbiddenCommand("")).toBeUndefined();
		});

		it("returns undefined for safe commands", () => {
			expect(isForbiddenCommand("npm run build")).toBeUndefined();
			expect(isForbiddenCommand("ls -la")).toBeUndefined();
			expect(isForbiddenCommand("echo hello")).toBeUndefined();
		});

		it("returns undefined with undefined extraPatterns", () => {
			expect(isForbiddenCommand("npm test", undefined)).toBeUndefined();
		});
	});
});
