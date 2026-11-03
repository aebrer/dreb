import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dirname, "../../../scripts/verify-engines.js");
const tempDirs: string[] = [];

type PackageJson = Record<string, unknown>;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const ENGINE = "^26.13.0";
const PIN = "26.13.0";

function toolchainFor(engine: string): PackageJson {
	return {
		devEngines: {
			runtime: { name: "node", version: engine, onFail: "error" },
			packageManager: { name: "npm", version: "^11.20.0", onFail: "error" },
		},
	};
}

/**
 * Create a temp project with a valid, consistent toolchain by default: `.nvmrc` and
 * `.node-version` pinned to PIN, and root `devEngines.runtime.version` equal to the
 * root `engines.node`. Tests override individual pieces to exercise each invariant.
 */
function createTempProject(
	rootPackage: PackageJson,
	pins: { nvmrc?: string | null; nodeVersion?: string | null } = {},
): string {
	const dir = mkdtempSync(join(tmpdir(), "verify-engines-"));
	tempDirs.push(dir);
	mkdirSync(join(dir, "packages"), { recursive: true });
	const engine = (rootPackage.engines as { node?: string } | undefined)?.node ?? ENGINE;
	writeJson(join(dir, "package.json"), { workspaces: ["packages/*"], ...toolchainFor(engine), ...rootPackage });
	const nvmrc = pins.nvmrc === undefined ? PIN : pins.nvmrc;
	const nodeVersion = pins.nodeVersion === undefined ? PIN : pins.nodeVersion;
	if (nvmrc !== null) writeFileSync(join(dir, ".nvmrc"), `${nvmrc}\n`, "utf-8");
	if (nodeVersion !== null) writeFileSync(join(dir, ".node-version"), `${nodeVersion}\n`, "utf-8");
	return dir;
}

function writeWorkspacePackage(projectDir: string, packageName: string, packageJson: PackageJson): void {
	writePackage(projectDir, join("packages", packageName), packageJson);
}

function writePackage(projectDir: string, packagePath: string, packageJson: PackageJson): void {
	const packageDir = join(projectDir, packagePath);
	mkdirSync(packageDir, { recursive: true });
	writeJson(join(packageDir, "package.json"), packageJson);
}

function writeJson(path: string, value: PackageJson): void {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, "utf-8");
}

function runVerifyEngines(cwd: string) {
	return spawnSync(process.execPath, [scriptPath], {
		cwd,
		encoding: "utf-8",
	});
}

describe("verify-engines script", () => {
	it("exits 0 when all workspace engines.node constraints are synchronized", () => {
		const projectDir = createTempProject({ engines: { node: ENGINE } });
		writeWorkspacePackage(projectDir, "ai", { engines: { node: ENGINE } });
		writeWorkspacePackage(projectDir, "agent", { engines: { node: ENGINE } });

		const result = runVerifyEngines(projectDir);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			"Node toolchain pins and all workspace engines.node constraints are synchronized.",
		);
		expect(result.stderr).toBe("");
	});

	it("exits 1 when the root package.json is missing engines.node", () => {
		const projectDir = createTempProject({ name: "dreb" });
		writeWorkspacePackage(projectDir, "ai", { engines: { node: ENGINE } });

		const result = runVerifyEngines(projectDir);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Root package.json is missing engines.node");
	});

	it("exits 1 with a diagnostic for a mismatched workspace engines.node", () => {
		const projectDir = createTempProject({ engines: { node: ENGINE } });
		writeWorkspacePackage(projectDir, "ai", { engines: { node: "^20.0.0" } });

		const result = runVerifyEngines(projectDir);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			'MISMATCH: packages/ai/package.json engines.node is "^20.0.0", expected "^26.13.0"',
		);
		expect(result.stderr).toContain(
			"Fix: update all workspace package.json engines.node fields to match the root package.json",
		);
	});

	it("detects mismatched engines.node in explicit nested workspace packages", () => {
		const projectDir = createTempProject({
			engines: { node: ENGINE },
			workspaces: ["packages/*", "packages/coding-agent/examples/extensions/with-deps"],
		});
		writeWorkspacePackage(projectDir, "ai", { engines: { node: ENGINE } });
		writePackage(projectDir, "packages/coding-agent/examples/extensions/with-deps", {
			engines: { node: "^20.0.0" },
		});

		const result = runVerifyEngines(projectDir);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			'MISMATCH: packages/coding-agent/examples/extensions/with-deps/package.json engines.node is "^20.0.0", expected "^26.13.0"',
		);
	});

	it("exits 1 with a diagnostic when a workspace package is missing engines.node", () => {
		const projectDir = createTempProject({ engines: { node: ENGINE } });
		writeWorkspacePackage(projectDir, "ai", { name: "@dreb/ai" });

		const result = runVerifyEngines(projectDir);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			'MISMATCH: packages/ai/package.json engines.node is missing, expected "^26.13.0"',
		);
	});

	it("skips non-package directories under packages", () => {
		const projectDir = createTempProject({ engines: { node: ENGINE } });
		mkdirSync(join(projectDir, "packages", "docs"), { recursive: true });
		writeWorkspacePackage(projectDir, "ai", { engines: { node: ENGINE } });

		const result = runVerifyEngines(projectDir);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			"Node toolchain pins and all workspace engines.node constraints are synchronized.",
		);
		expect(result.stderr).toBe("");
	});

	it("exits 1 with a diagnostic when a workspace package.json is invalid", () => {
		const projectDir = createTempProject({ engines: { node: ENGINE } });
		const packageDir = join(projectDir, "packages", "broken");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "package.json"), "{ not json\n", "utf-8");

		const result = runVerifyEngines(projectDir);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("ERROR: failed to read or parse packages/broken/package.json");
		expect(result.stderr).toContain("Fix: correct the invalid JSON syntax in the reported file(s).");
		expect(result.stderr).not.toContain(
			"Fix: update all workspace package.json engines.node fields to match the root package.json",
		);
	});

	describe("toolchain pins", () => {
		const FIX = "Fix: keep .nvmrc, .node-version, root devEngines, and engines.node in sync";

		function expectToolchainFailure(projectDir: string, message: string): void {
			const result = runVerifyEngines(projectDir);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`TOOLCHAIN: ${message}`);
			expect(result.stderr).toContain(FIX);
		}

		it("accepts a later patch or minor of the same major as the pin", () => {
			const projectDir = createTempProject(
				{ engines: { node: ENGINE } },
				{ nvmrc: "26.14.2", nodeVersion: "26.14.2" },
			);
			const result = runVerifyEngines(projectDir);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		});

		it("exits 1 when .nvmrc is missing", () => {
			const projectDir = createTempProject({ engines: { node: ENGINE } }, { nvmrc: null });
			expectToolchainFailure(projectDir, ".nvmrc is missing");
		});

		it("exits 1 when .node-version is not an exact version", () => {
			const projectDir = createTempProject({ engines: { node: ENGINE } }, { nodeVersion: "26" });
			expectToolchainFailure(
				projectDir,
				'.node-version must contain one exact Node version like 26.13.0, found "26"',
			);
		});

		it("exits 1 when .nvmrc and .node-version pin different versions", () => {
			const projectDir = createTempProject({ engines: { node: ENGINE } }, { nodeVersion: "26.14.0" });
			expectToolchainFailure(projectDir, ".nvmrc (26.13.0) and .node-version (26.14.0) pin different Node versions");
		});

		it("exits 1 when the pinned version is below the engines floor", () => {
			const projectDir = createTempProject(
				{ engines: { node: ENGINE } },
				{ nvmrc: "26.12.9", nodeVersion: "26.12.9" },
			);
			expectToolchainFailure(projectDir, 'pinned Node 26.12.9 (.nvmrc) does not satisfy engines.node "^26.13.0"');
		});

		it("exits 1 when the pinned version is a different major", () => {
			const projectDir = createTempProject(
				{ engines: { node: ENGINE } },
				{ nvmrc: "27.0.0", nodeVersion: "27.0.0" },
			);
			expectToolchainFailure(projectDir, 'pinned Node 27.0.0 (.nvmrc) does not satisfy engines.node "^26.13.0"');
		});

		it("exits 1 when engines.node is not a caret range", () => {
			const projectDir = createTempProject({ engines: { node: "26.x" } });
			expectToolchainFailure(projectDir, 'root engines.node "26.x" must be a caret range like ^26.13.0');
		});

		it("exits 1 when devEngines.runtime is missing", () => {
			const projectDir = createTempProject({
				engines: { node: ENGINE },
				devEngines: { packageManager: { name: "npm", version: "^11.20.0", onFail: "error" } },
			});
			expectToolchainFailure(projectDir, "root devEngines.runtime must be");
		});

		it("exits 1 when devEngines only warns instead of failing", () => {
			const projectDir = createTempProject({
				engines: { node: ENGINE },
				devEngines: {
					runtime: { name: "node", version: ENGINE, onFail: "error" },
					packageManager: { name: "npm", version: "^11.20.0", onFail: "warn" },
				},
			});
			expectToolchainFailure(projectDir, "root devEngines.packageManager must be");
		});

		it("exits 1 when devEngines.runtime.version differs from engines.node", () => {
			const projectDir = createTempProject({
				engines: { node: ENGINE },
				devEngines: {
					runtime: { name: "node", version: "^26.0.0", onFail: "error" },
					packageManager: { name: "npm", version: "^11.20.0", onFail: "error" },
				},
			});
			expectToolchainFailure(
				projectDir,
				'root devEngines.runtime.version "^26.0.0" must equal engines.node "^26.13.0"',
			);
		});
	});
});
