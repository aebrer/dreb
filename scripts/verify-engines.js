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

const packagesDir = "packages";
const packageDirs = readdirSync(packagesDir);

let foundMismatch = false;

for (const pkgDir of packageDirs) {
	const pkgPath = join(packagesDir, pkgDir, "package.json");
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	} catch {
		continue;
	}

	const pkgEngine = pkg.engines?.node;
	if (pkgEngine && pkgEngine !== rootEngine) {
		console.error(
			`MISMATCH: packages/${pkgDir}/package.json engines.node is "${pkgEngine}", expected "${rootEngine}"`,
		);
		foundMismatch = true;
	}
}

if (foundMismatch) {
	console.error("\nFix: update all workspace package.json engines.node fields to match the root package.json");
	process.exit(1);
}

console.log("All workspace engines.node constraints are synchronized.");
