#!/usr/bin/env node
/**
 * Verify that all workspace package.json files declare the same engines.node
 * constraint as the root package.json.
 *
 * Exit code 1 if any workspace package has a mismatched engines.node value.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const rootPkg = JSON.parse(readFileSync("package.json", "utf-8"));
const rootEngine = rootPkg.engines?.node;

if (!rootEngine) {
	console.error("Root package.json is missing engines.node");
	process.exit(1);
}

const workspaceEntries = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];

let foundMismatch = false;
let foundReadOrParseError = false;

function isEnoent(error) {
	return error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function packageJsonPathsForWorkspace(workspaceEntry) {
	if (workspaceEntry.endsWith("/*")) {
		const workspaceRoot = workspaceEntry.slice(0, -2);
		let packageDirs;
		try {
			packageDirs = readdirSync(workspaceRoot);
		} catch (error) {
			if (isEnoent(error)) {
				return [];
			}

			const message = error instanceof Error ? error.message : String(error);
			console.error(`ERROR: failed to read workspace directory ${workspaceRoot}: ${message}`);
			foundReadOrParseError = true;
			return [];
		}

		return packageDirs.map((pkgDir) => join(workspaceRoot, pkgDir, "package.json"));
	}

	return [join(workspaceEntry, "package.json")];
}

function checkPackage(pkgPath) {
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	} catch (error) {
		if (isEnoent(error)) {
			return;
		}

		const message = error instanceof Error ? error.message : String(error);
		console.error(`ERROR: failed to read or parse ${pkgPath}: ${message}`);
		foundReadOrParseError = true;
		return;
	}

	const pkgEngine = pkg.engines?.node;
	if (pkgEngine !== rootEngine) {
		const actual = pkgEngine === undefined ? "missing" : `"${pkgEngine}"`;
		console.error(`MISMATCH: ${pkgPath} engines.node is ${actual}, expected "${rootEngine}"`);
		foundMismatch = true;
	}
}

for (const workspaceEntry of workspaceEntries) {
	for (const pkgPath of packageJsonPathsForWorkspace(workspaceEntry)) {
		checkPackage(pkgPath);
	}
}

if (foundReadOrParseError || foundMismatch) {
	console.error("");
	if (foundReadOrParseError) {
		console.error("Fix: correct the invalid JSON syntax in the reported file(s).");
	}
	if (foundMismatch) {
		console.error("Fix: update all workspace package.json engines.node fields to match the root package.json.");
	}
	process.exit(1);
}

console.log("All workspace engines.node constraints are synchronized.");
