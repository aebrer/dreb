import { describe, expect, it } from "vitest";
import { isForbiddenCommand } from "../src/core/forbidden-commands.js";

describe("isForbiddenCommand", () => {
	describe("default patterns (always active)", () => {
		it("blocks gh pr merge --admin", () => {
			expect(isForbiddenCommand("gh pr merge 93 --admin")).toBe("^gh pr merge.*--admin");
		});

		it("blocks gh pr merge --admin --squash", () => {
			expect(isForbiddenCommand("gh pr merge 93 --admin --squash")).toBe("^gh pr merge.*--admin");
		});

		it("allows gh pr merge --squash", () => {
			expect(isForbiddenCommand("gh pr merge 93 --squash")).toBeUndefined();
		});

		it("allows gh pr merge (no flags)", () => {
			expect(isForbiddenCommand("gh pr merge 93")).toBeUndefined();
		});

		it("blocks git push --force", () => {
			expect(isForbiddenCommand("git push --force")).toBe("^git push.*(-f\\b|--force)");
		});

		it("blocks git push -f", () => {
			expect(isForbiddenCommand("git push -f")).toBe("^git push.*(-f\\b|--force)");
		});

		it("blocks git push --force-with-lease", () => {
			expect(isForbiddenCommand("git push --force-with-lease")).toBe("^git push.*(-f\\b|--force)");
		});

		it("blocks git push --force origin feature-branch", () => {
			expect(isForbiddenCommand("git push --force origin feature-branch")).toBe("^git push.*(-f\\b|--force)");
		});

		it("allows git push origin feature-branch", () => {
			expect(isForbiddenCommand("git push origin feature-branch")).toBeUndefined();
		});

		it("allows git push", () => {
			expect(isForbiddenCommand("git push")).toBeUndefined();
		});

		it("blocks gh api ... bypass", () => {
			expect(isForbiddenCommand("gh api repos/owner/repo --method PATCH --field bypass=true")).toBe(
				"^gh api.*bypass",
			);
		});

		it("allows gh api without bypass", () => {
			expect(isForbiddenCommand("gh api repos/owner/repo --method PATCH")).toBeUndefined();
		});

		it("allows gh api repos/owner/repo", () => {
			expect(isForbiddenCommand("gh api repos/owner/repo")).toBeUndefined();
		});
	});

	describe("command chaining (&&, ||, ;, |)", () => {
		it("blocks dangerous command after && ", () => {
			expect(isForbiddenCommand("cd /tmp && git push --force")).toBe("^git push.*(-f\\b|--force)");
		});

		it("blocks dangerous command after ;", () => {
			expect(isForbiddenCommand("echo hello; gh pr merge 93 --admin")).toBe("^gh pr merge.*--admin");
		});

		it("blocks dangerous command after ||", () => {
			expect(isForbiddenCommand("some_cmd || git push -f")).toBe("^git push.*(-f\\b|--force)");
		});

		it("blocks dangerous command after | (pipe)", () => {
			expect(isForbiddenCommand("echo y | gh pr merge 93 --admin")).toBe("^gh pr merge.*--admin");
		});

		it("blocks dangerous command after & (background)", () => {
			expect(isForbiddenCommand("sleep 1 & git push --force")).toBe("^git push.*(-f\\b|--force)");
		});

		it("blocks dangerous command after newline", () => {
			expect(isForbiddenCommand("cd /tmp\ngit push --force")).toBe("^git push.*(-f\\b|--force)");
		});

		it("allows safe commands chained with &&", () => {
			expect(isForbiddenCommand("npm run build && npm test")).toBeUndefined();
		});

		it("allows safe commands chained with ;", () => {
			expect(isForbiddenCommand("echo hello; echo world")).toBeUndefined();
		});
	});

	describe("does not false-positive on embedded patterns", () => {
		it("allows gh pr comment with --admin in body text", () => {
			expect(isForbiddenCommand('gh pr comment 93 --body "used --admin to merge"')).toBeUndefined();
		});

		it("allows echo with git push --force in string", () => {
			expect(isForbiddenCommand('echo "git push --force is bad"')).toBeUndefined();
		});

		it("allows node -e with --force in code string", () => {
			expect(isForbiddenCommand("node -e \"console.log('git push --force')\"")).toBeUndefined();
		});

		it("allows curl with bypass in URL", () => {
			expect(isForbiddenCommand("curl https://example.com/bypass")).toBeUndefined();
		});

		it("allows grep for --admin in file", () => {
			expect(isForbiddenCommand('grep -- "--admin" config.txt')).toBeUndefined();
		});

		it("does not split on operators inside double-quoted strings", () => {
			// The && is inside quotes — should not split, should not false-positive
			expect(isForbiddenCommand('echo "hello && git push --force"')).toBeUndefined();
		});

		it("does not split on operators inside single-quoted strings", () => {
			expect(isForbiddenCommand("echo 'hello ; git push --force'")).toBeUndefined();
		});

		it("splits correctly when operators are outside quotes", () => {
			// Real operator outside quotes should still split and catch
			expect(isForbiddenCommand('echo "hello" && git push --force')).toBe("^git push.*(-f\\b|--force)");
		});

		it("handles mixed quoted and unquoted operators", () => {
			expect(isForbiddenCommand('echo "a && b" && echo "c ; d"')).toBeUndefined();
		});
	});

	describe("custom patterns from settings", () => {
		it("checks custom patterns in addition to defaults", () => {
			expect(isForbiddenCommand("rm -rf /")).toBeUndefined();
			expect(isForbiddenCommand("rm -rf /", ["rm -rf /"])).toBe("rm -rf /");
		});

		it("custom patterns do not replace defaults", () => {
			// Default pattern still blocks even with custom patterns
			expect(isForbiddenCommand("git push --force", ["rm -rf /"])).toBe("^git push.*(-f\\b|--force)");
		});

		it("handles invalid regex gracefully", () => {
			expect(isForbiddenCommand("some safe command", ["[invalid"])).toBeUndefined();
		});

		it("returns first matching pattern", () => {
			const result = isForbiddenCommand("dangerous", ["dangerous", ".*dangerous.*"]);
			expect(result).toBe("dangerous");
		});

		it("invalid regex does not prevent later patterns from matching", () => {
			// An invalid pattern mid-array should not break the loop — later valid patterns still match
			expect(isForbiddenCommand("git push --force", ["[invalid", "rm -rf /"])).toBe("^git push.*(-f\\b|--force)");
		});

		it("custom patterns apply to each segment independently", () => {
			expect(isForbiddenCommand("echo hello && rm -rf /", ["^rm -rf /"])).toBe("^rm -rf /");
		});
	});

	describe("subshell wrappers (finding 1 fix)", () => {
		it("blocks command inside $() wrapper", () => {
			expect(isForbiddenCommand("$(git push --force)")).toBe("^git push.*(-f\\b|--force)");
		});

		it("blocks command inside () wrapper", () => {
			expect(isForbiddenCommand("(git push -f)")).toBe("^git push.*(-f\\b|--force)");
		});

		it("blocks command inside backtick wrapper", () => {
			expect(isForbiddenCommand("`gh pr merge 93 --admin`")).toBe("^gh pr merge.*--admin");
		});

		it("blocks subshell after chained operator", () => {
			expect(isForbiddenCommand("cd /tmp && $(git push --force)")).toBe("^git push.*(-f\\b|--force)");
		});

		it("blocks assignment with subshell containing dangerous command", () => {
			// result=$(git push --force) — the $() wrapper is not the whole segment,
			// but stripSubshellWrapper should still catch it via unwrapping
			expect(isForbiddenCommand("result=$(git push --force)")).toBe("^git push.*(-f\\b|--force)");
		});

		it("allows safe subshell commands", () => {
			expect(isForbiddenCommand("$(echo hello)")).toBeUndefined();
			expect(isForbiddenCommand("`cat file.txt`")).toBeUndefined();
		});
	});

	describe("non-array extraPatterns (finding 2 fix)", () => {
		it("ignores string extraPatterns instead of spreading into chars", () => {
			// A string "rm -rf /" should be ignored, not spread into ['r', 'm', ' ', '-', 'r', 'f', ' ', '/']
			expect(isForbiddenCommand("npm run build", "rm -rf /" as unknown as string[])).toBeUndefined();
		});

		it("ignores null extraPatterns", () => {
			expect(isForbiddenCommand("npm test", null as unknown as string[])).toBeUndefined();
		});

		it("still blocks defaults when extraPatterns is invalid type", () => {
			expect(isForbiddenCommand("git push --force", "rm -rf /" as unknown as string[])).toBe(
				"^git push.*(-f\\b|--force)",
			);
		});

		it("handles empty array", () => {
			expect(isForbiddenCommand("npm test", [])).toBeUndefined();
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

		it("handles multiple consecutive operators", () => {
			expect(isForbiddenCommand("echo a &&  echo b && git push --force")).toBe("^git push.*(-f\\b|--force)");
		});
	});
});
