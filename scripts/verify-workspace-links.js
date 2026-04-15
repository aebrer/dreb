#!/usr/bin/env node
/**
 * Verify that all @dreb/* workspace packages are symlinked from nested
 * node_modules, never installed as stale npm tarballs.
 *
 * Exit code 1 if any workspace package is a real directory instead of a link.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const workspacePackages = [
	"@dreb/agent-core",
	"@dreb/ai",
	"@dreb/coding-agent",
	"@dreb/semantic-search",
	"@dreb/telegram",
	"@dreb/tui",
];

const packagesDir = "packages";
const packageDirs = readdirSync(packagesDir);

let foundStale = false;

for (const pkgDir of packageDirs) {
	const nestedScope = join(packagesDir, pkgDir, "node_modules", "@dreb");
	let entries = [];
	try {
		entries = readdirSync(nestedScope);
	} catch {
		continue;
	}

	for (const entry of entries) {
		const fullPath = join(nestedScope, entry);
		const name = `@dreb/${entry}`;
		if (!workspacePackages.includes(name)) continue;

		let isLink = false;
		try {
			isLink = lstatSync(fullPath).isSymbolicLink();
		} catch {
			continue;
		}

		if (!isLink) {
			console.error(`STALE PACKAGE: ${fullPath} is a real directory, not a workspace symlink`);
			foundStale = true;
		}
	}
}

if (foundStale) {
	console.error("\nFix: rm -rf packages/*/node_modules/@dreb && re-establish workspace symlinks locally (do not run npm install)");
	process.exit(1);
}

console.log("All workspace packages are correctly symlinked.");
