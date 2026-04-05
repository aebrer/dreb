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

	describe("HUSKY=0 (bypass pre-commit hooks)", () => {
		const HUSKY_PATTERN = "^(?:export\\s+)?HUSKY=0";

		it("blocks HUSKY=0 as env prefix", () => {
			expect(isForbiddenCommand('HUSKY=0 git commit -m "msg"')).toBe(HUSKY_PATTERN);
		});

		it("blocks HUSKY=0 in compound command", () => {
			expect(isForbiddenCommand("cd repo && HUSKY=0 git commit -m fix")).toBe(HUSKY_PATTERN);
		});

		it("blocks export HUSKY=0", () => {
			expect(isForbiddenCommand("export HUSKY=0")).toBe(HUSKY_PATTERN);
		});

		it("allows grep for HUSKY=0 in files (no false positive)", () => {
			expect(isForbiddenCommand("grep HUSKY=0 .husky/pre-commit")).toBeUndefined();
		});

		it("allows git log searching for HUSKY=0", () => {
			expect(isForbiddenCommand('git log --grep="HUSKY=0"')).toBeUndefined();
		});
	});

	describe("SKIP_VALIDATION=1 (bypass pre-commit hooks)", () => {
		const SKIP_PATTERN = "^(?:export\\s+)?SKIP_?VALIDATION=1";

		it("blocks SKIP_VALIDATION=1 as env prefix", () => {
			expect(isForbiddenCommand('SKIP_VALIDATION=1 git commit -m "msg"')).toBe(SKIP_PATTERN);
		});

		it("blocks SKIP_VALIDATION=1 in compound command", () => {
			expect(isForbiddenCommand("cd repo && SKIP_VALIDATION=1 git commit -m fix")).toBe(SKIP_PATTERN);
		});

		it("blocks export SKIP_VALIDATION=1", () => {
			expect(isForbiddenCommand("export SKIP_VALIDATION=1")).toBe(SKIP_PATTERN);
		});

		it("allows grep for SKIP_VALIDATION=1 in files (no false positive)", () => {
			expect(isForbiddenCommand("grep SKIP_VALIDATION=1 .husky/pre-commit")).toBeUndefined();
		});

		it("allows git log searching for SKIP_VALIDATION=1", () => {
			expect(isForbiddenCommand('git log --grep="SKIP_VALIDATION=1"')).toBeUndefined();
		});
	});

	describe("git commit --no-verify (bypass pre-commit hooks)", () => {
		const NO_VERIFY_PATTERN = "^git\\s+commit.*--no-verify";

		it("blocks git commit --no-verify", () => {
			expect(isForbiddenCommand('git commit -m "msg" --no-verify')).toBe(NO_VERIFY_PATTERN);
		});

		it("blocks git commit --no-verify -m msg", () => {
			expect(isForbiddenCommand('git commit --no-verify -m "msg"')).toBe(NO_VERIFY_PATTERN);
		});

		it("blocks git commit --no-verify after &&", () => {
			expect(isForbiddenCommand('npm run build && git commit --no-verify -m "msg"')).toBe(NO_VERIFY_PATTERN);
		});

		it("allows git commit without --no-verify", () => {
			expect(isForbiddenCommand('git commit -m "msg"')).toBeUndefined();
		});

		it("allows git commit --allow-empty", () => {
			expect(isForbiddenCommand('git commit --allow-empty -m "msg"')).toBeUndefined();
		});

		it("does not false-positive on grep for --no-verify", () => {
			expect(isForbiddenCommand("grep --no-verify config.txt")).toBeUndefined();
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

	describe("escaped backslashes before closing quotes", () => {
		it("correctly handles escaped backslash before closing quote (double quotes)", () => {
			// echo "\\" && git push --force — the \\ is a literal backslash,
			// " closes the string, && is a real operator
			expect(isForbiddenCommand('echo "\\\\" && git push --force')).toBe("^git push.*(-f\\b|--force)");
		});

		it("correctly handles escaped backslash before closing quote (single quotes)", () => {
			// Note: bash single quotes don't allow \', but our masker should still
			// handle the backslash counting correctly for robustness
			expect(isForbiddenCommand("echo '\\\\' && git push --force")).toBe("^git push.*(-f\\b|--force)");
		});

		it("correctly handles escaped quote (odd backslashes)", () => {
			// \\" inside quotes — 2 backslashes + escaped quote = literal "
			// The " is NOT a closing quote, so we're still in the string
			expect(isForbiddenCommand('echo "hello\\\\"  && git push --force')).toBe("^git push.*(-f\\b|--force)");
		});

		it("correctly handles triple backslash before quote (escaped)", () => {
			// \\\" — 3 backslashes: escaped backslash + escaped quote
			// The " IS escaped, so we're still inside the string
			expect(isForbiddenCommand('echo "hello\\\\\\" && safe')).toBeUndefined();
		});

		it("simple escaped quote is still treated as escaped", () => {
			// \" — 1 backslash, odd → the " is escaped, we stay in the string
			expect(isForbiddenCommand('echo "hello\\" && git push --force"')).toBeUndefined();
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
