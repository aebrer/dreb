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

function createTempProject(rootPackage: PackageJson): string {
	const dir = mkdtempSync(join(tmpdir(), "verify-engines-"));
	tempDirs.push(dir);
	mkdirSync(join(dir, "packages"), { recursive: true });
	writeJson(join(dir, "package.json"), { workspaces: ["packages/*"], ...rootPackage });
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
		const projectDir = createTempProject({ engines: { node: "^22.0.0" } });
		writeWorkspacePackage(projectDir, "ai", { engines: { node: "^22.0.0" } });
		writeWorkspacePackage(projectDir, "agent", { engines: { node: "^22.0.0" } });

		const result = runVerifyEngines(projectDir);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("All workspace engines.node constraints are synchronized.");
		expect(result.stderr).toBe("");
	});

	it("exits 1 when the root package.json is missing engines.node", () => {
		const projectDir = createTempProject({ name: "dreb" });
		writeWorkspacePackage(projectDir, "ai", { engines: { node: "^22.0.0" } });

		const result = runVerifyEngines(projectDir);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Root package.json is missing engines.node");
	});

	it("exits 1 with a diagnostic for a mismatched workspace engines.node", () => {
		const projectDir = createTempProject({ engines: { node: "^22.0.0" } });
		writeWorkspacePackage(projectDir, "ai", { engines: { node: "^20.0.0" } });

		const result = runVerifyEngines(projectDir);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			'MISMATCH: packages/ai/package.json engines.node is "^20.0.0", expected "^22.0.0"',
		);
		expect(result.stderr).toContain(
			"Fix: update all workspace package.json engines.node fields to match the root package.json",
		);
	});

	it("detects mismatched engines.node in explicit nested workspace packages", () => {
		const projectDir = createTempProject({
			engines: { node: "^22.0.0" },
			workspaces: ["packages/*", "packages/coding-agent/examples/extensions/with-deps"],
		});
		writeWorkspacePackage(projectDir, "ai", { engines: { node: "^22.0.0" } });
		writePackage(projectDir, "packages/coding-agent/examples/extensions/with-deps", {
			engines: { node: "^20.0.0" },
		});

		const result = runVerifyEngines(projectDir);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			'MISMATCH: packages/coding-agent/examples/extensions/with-deps/package.json engines.node is "^20.0.0", expected "^22.0.0"',
		);
	});

	it("exits 1 with a diagnostic when a workspace package is missing engines.node", () => {
		const projectDir = createTempProject({ engines: { node: "^22.0.0" } });
		writeWorkspacePackage(projectDir, "ai", { name: "@dreb/ai" });

		const result = runVerifyEngines(projectDir);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('MISMATCH: packages/ai/package.json engines.node is missing, expected "^22.0.0"');
	});

	it("skips non-package directories under packages", () => {
		const projectDir = createTempProject({ engines: { node: "^22.0.0" } });
		mkdirSync(join(projectDir, "packages", "docs"), { recursive: true });
		writeWorkspacePackage(projectDir, "ai", { engines: { node: "^22.0.0" } });

		const result = runVerifyEngines(projectDir);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("All workspace engines.node constraints are synchronized.");
		expect(result.stderr).toBe("");
	});

	it("exits 1 with a diagnostic when a workspace package.json is invalid", () => {
		const projectDir = createTempProject({ engines: { node: "^22.0.0" } });
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
});
