#!/usr/bin/env node
/**
 * Verify that the project declares exactly one Node/npm toolchain, consistently:
 *
 * - `.nvmrc` and `.node-version` pin the same exact Node version (the version CI,
 *   publishing, and lockfile writing run on).
 * - The root `devEngines` makes npm itself refuse other runtimes/npms
 *   (`runtime` = node, `packageManager` = npm, both `onFail: "error"`).
 * - The root `engines.node` (what users run) equals `devEngines.runtime.version`
 *   (what developers build with), and the pinned version satisfies it.
 * - Every workspace package declares the same `engines.node` as the root.
 *
 * Exit code 1 if any invariant is violated.
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
let foundToolchainError = false;

function isEnoent(error) {
	return error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function toolchainError(message) {
	console.error(`TOOLCHAIN: ${message}`);
	foundToolchainError = true;
}

/** Parse an exact `MAJOR.MINOR.PATCH` version (optionally `v`-prefixed). */
function parseExactVersion(value) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
	return match ? match.slice(1).map(Number) : undefined;
}

/**
 * Whether an exact version satisfies a caret range `^MAJOR.MINOR.PATCH` with MAJOR >= 1.
 * Other range syntaxes are rejected so a constraint can never be silently unchecked.
 */
function satisfiesCaret(version, range) {
	const floor = range.startsWith("^") ? parseExactVersion(range.slice(1)) : undefined;
	if (!floor || floor[0] === 0) return undefined;
	if (version[0] !== floor[0]) return false;
	for (let i = 1; i < 3; i++) {
		if (version[i] !== floor[i]) return version[i] > floor[i];
	}
	return true;
}

function readPinnedVersion(file) {
	let content;
	try {
		content = readFileSync(file, "utf-8");
	} catch (error) {
		if (isEnoent(error)) {
			toolchainError(`${file} is missing; it must pin the exact Node version (e.g. 26.13.0)`);
			return undefined;
		}
		throw error;
	}
	const value = content.trim();
	if (!parseExactVersion(value)) {
		toolchainError(`${file} must contain one exact Node version like 26.13.0, found "${value}"`);
		return undefined;
	}
	return value.replace(/^v/, "");
}

function checkToolchain() {
	const nvmrc = readPinnedVersion(".nvmrc");
	const nodeVersion = readPinnedVersion(".node-version");
	if (nvmrc && nodeVersion && nvmrc !== nodeVersion) {
		toolchainError(`.nvmrc (${nvmrc}) and .node-version (${nodeVersion}) pin different Node versions`);
	}

	const runtime = rootPkg.devEngines?.runtime;
	const packageManager = rootPkg.devEngines?.packageManager;
	if (runtime?.name !== "node" || typeof runtime.version !== "string" || runtime.onFail !== "error") {
		toolchainError('root devEngines.runtime must be { name: "node", version: <range>, onFail: "error" }');
	} else if (runtime.version !== rootEngine) {
		toolchainError(`root devEngines.runtime.version "${runtime.version}" must equal engines.node "${rootEngine}"`);
	}
	if (packageManager?.name !== "npm" || typeof packageManager.version !== "string" || packageManager.onFail !== "error") {
		toolchainError('root devEngines.packageManager must be { name: "npm", version: <range>, onFail: "error" }');
	}

	if (nvmrc) {
		const satisfied = satisfiesCaret(parseExactVersion(nvmrc), rootEngine);
		if (satisfied === undefined) {
			toolchainError(`root engines.node "${rootEngine}" must be a caret range like ^26.13.0`);
		} else if (!satisfied) {
			toolchainError(`pinned Node ${nvmrc} (.nvmrc) does not satisfy engines.node "${rootEngine}"`);
		}
	}
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

checkToolchain();

for (const workspaceEntry of workspaceEntries) {
	for (const pkgPath of packageJsonPathsForWorkspace(workspaceEntry)) {
		checkPackage(pkgPath);
	}
}

if (foundReadOrParseError || foundMismatch || foundToolchainError) {
	console.error("");
	if (foundReadOrParseError) {
		console.error("Fix: correct the invalid JSON syntax in the reported file(s).");
	}
	if (foundMismatch) {
		console.error("Fix: update all workspace package.json engines.node fields to match the root package.json.");
	}
	if (foundToolchainError) {
		console.error(
			"Fix: keep .nvmrc, .node-version, root devEngines, and engines.node in sync (see AGENTS.md, Node & npm Toolchain).",
		);
	}
	process.exit(1);
}

console.log("Node toolchain pins and all workspace engines.node constraints are synchronized.");
