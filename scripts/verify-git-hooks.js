#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const EXPECTED_HOOKS_PATH = ".husky/_";

function git(args) {
	try {
		return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch {
		return undefined;
	}
}

if (process.env.CI) {
	console.log("Skipping git hook verification in CI.");
	process.exit(0);
}

const gitDir = git(["rev-parse", "--git-dir"]);
if (!gitDir || !existsSync(gitDir)) {
	console.log("Skipping git hook verification outside a git checkout.");
	process.exit(0);
}

const hooksPath = git(["config", "--local", "--get", "core.hooksPath"]);
if (hooksPath !== EXPECTED_HOOKS_PATH) {
	console.error(`Git hooks are not installed for this checkout: core.hooksPath is ${JSON.stringify(hooksPath ?? "")}.`);
	console.error(`Expected ${JSON.stringify(EXPECTED_HOOKS_PATH)} so .husky/pre-commit runs before commits.`);
	console.error("Run `npm run prepare` from the repository root to install Husky hooks.");
	process.exit(1);
}

console.log(`Git hooks installed (${EXPECTED_HOOKS_PATH}).`);
