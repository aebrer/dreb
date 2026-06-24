import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../..");
const realScriptPath = join(repoRoot, "scripts/sync-version.sh");
const realRootPackagePath = join(repoRoot, "package.json");

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

type Json = Record<string, unknown>;

function writeJson(path: string, value: Json, indent: string | number = "\t"): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, indent)}\n`, "utf-8");
}

/**
 * Build a self-contained fixture project that mirrors the dreb monorepo layout
 * closely enough to exercise scripts/sync-version.sh. The real script is copied
 * into the fixture's scripts/ dir so its `cd "$(dirname "$0")/.."` resolves to
 * the fixture root rather than the real repo.
 */
function createFixtureProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "sync-version-"));
	tempDirs.push(dir);

	mkdirSync(join(dir, "scripts"), { recursive: true });
	copyFileSync(realScriptPath, join(dir, "scripts/sync-version.sh"));

	// Root package.json starts at an old version.
	writeJson(join(dir, "package.json"), {
		name: "fixture",
		version: "1.0.0",
		workspaces: ["packages/*"],
	});

	// Top-level workspace packages that SHOULD be bumped.
	writeJson(join(dir, "packages/ai/package.json"), { name: "@dreb/ai", version: "1.0.0" });
	writeJson(join(dir, "packages/agent/package.json"), { name: "@dreb/agent", version: "1.0.0" });
	writeJson(join(dir, "packages/coding-agent/package.json"), { name: "@dreb/coding-agent", version: "1.0.0" });

	// A plugin manifest that SHOULD be bumped (2-space indented, like the real one).
	writeJson(join(dir, "packages/ai/.claude-plugin/plugin.json"), { name: "ai-plugin", version: "1.0.0" }, 2);

	// A nested example extension that must NOT be bumped (independent version).
	writeJson(join(dir, "packages/coding-agent/examples/extensions/with-deps/package.json"), {
		name: "example-with-deps",
		version: "9.9.9",
	});

	// Lockfile with workspace version metadata + a third-party dep that must stay byte-identical.
	const lock = {
		name: "fixture",
		version: "1.0.0",
		lockfileVersion: 3,
		requires: true,
		packages: {
			"": { name: "fixture", version: "1.0.0" },
			"packages/ai": { name: "@dreb/ai", version: "1.0.0" },
			"packages/agent": { name: "@dreb/agent", version: "1.0.0" },
			"packages/coding-agent": { name: "@dreb/coding-agent", version: "1.0.0" },
			"packages/coding-agent/examples/extensions/with-deps": {
				name: "example-with-deps",
				version: "9.9.9",
			},
			"node_modules/left-pad": {
				version: "1.3.0",
				resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
			},
		},
	};
	// Tabs + trailing newline, matching how npm writes the dreb lockfile.
	writeFileSync(join(dir, "package-lock.json"), `${JSON.stringify(lock, null, "\t")}\n`, "utf-8");

	return dir;
}

function runSyncVersion(projectDir: string, version: string) {
	return spawnSync("bash", [join(projectDir, "scripts/sync-version.sh"), version], {
		cwd: projectDir,
		encoding: "utf-8",
	});
}

function readJson(path: string): Json {
	return JSON.parse(readFileSync(path, "utf-8"));
}

describe("sync-version script", () => {
	it("propagates the version to root, workspace packages, and plugin manifests", () => {
		const dir = createFixtureProject();

		const result = runSyncVersion(dir, "2.0.0");
		expect(result.status).toBe(0);

		expect(readJson(join(dir, "package.json")).version).toBe("2.0.0");
		expect(readJson(join(dir, "packages/ai/package.json")).version).toBe("2.0.0");
		expect(readJson(join(dir, "packages/agent/package.json")).version).toBe("2.0.0");
		expect(readJson(join(dir, "packages/coding-agent/package.json")).version).toBe("2.0.0");
		expect(readJson(join(dir, "packages/ai/.claude-plugin/plugin.json")).version).toBe("2.0.0");
	});

	it("updates workspace version fields in package-lock.json", () => {
		const dir = createFixtureProject();

		runSyncVersion(dir, "2.0.0");

		const lock = readJson(join(dir, "package-lock.json")) as {
			version: string;
			packages: Record<string, { version?: string }>;
		};
		expect(lock.version).toBe("2.0.0");
		expect(lock.packages[""].version).toBe("2.0.0");
		expect(lock.packages["packages/ai"].version).toBe("2.0.0");
		expect(lock.packages["packages/agent"].version).toBe("2.0.0");
		expect(lock.packages["packages/coding-agent"].version).toBe("2.0.0");
	});

	it("leaves nested example extension versions untouched", () => {
		const dir = createFixtureProject();

		runSyncVersion(dir, "2.0.0");

		expect(readJson(join(dir, "packages/coding-agent/examples/extensions/with-deps/package.json")).version).toBe(
			"9.9.9",
		);

		const lock = readJson(join(dir, "package-lock.json")) as {
			packages: Record<string, { version?: string }>;
		};
		expect(lock.packages["packages/coding-agent/examples/extensions/with-deps"].version).toBe("9.9.9");
	});

	it("does not re-resolve or mutate third-party dependency metadata", () => {
		const dir = createFixtureProject();

		runSyncVersion(dir, "2.0.0");

		const lock = readJson(join(dir, "package-lock.json")) as {
			packages: Record<string, { version?: string; resolved?: string }>;
		};
		expect(lock.packages["node_modules/left-pad"]).toEqual({
			version: "1.3.0",
			resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
		});
	});

	it("preserves tab indentation and a trailing newline in package-lock.json", () => {
		const dir = createFixtureProject();

		runSyncVersion(dir, "2.0.0");

		const raw = readFileSync(join(dir, "package-lock.json"), "utf-8");
		expect(raw.endsWith("}\n")).toBe(true);
		expect(raw).toContain('\n\t"version": "2.0.0"');
		expect(raw).not.toContain("\n  "); // no two-space indentation crept in
	});

	it("is idempotent — re-syncing an already-current version is a byte-for-byte no-op", () => {
		const dir = createFixtureProject();

		// First bump establishes the new version across every file.
		const first = runSyncVersion(dir, "2.0.0");
		expect(first.status).toBe(0);

		// Snapshot the raw bytes of every file the script can touch.
		const trackedPaths = [
			join(dir, "package-lock.json"),
			join(dir, "package.json"),
			join(dir, "packages/ai/package.json"),
			join(dir, "packages/agent/package.json"),
			join(dir, "packages/coding-agent/package.json"),
			join(dir, "packages/ai/.claude-plugin/plugin.json"),
		];
		const snapshot = new Map(trackedPaths.map((p) => [p, readFileSync(p, "utf-8")]));

		// Re-running with the SAME version must change nothing — this is the
		// PR's core promise (no build/release churn). The `changed` counter and
		// the `entry.version !== version` guard exist precisely for this.
		const second = runSyncVersion(dir, "2.0.0");
		expect(second.status).toBe(0);
		expect(second.stdout).toContain("package-lock.json workspace versions updated (0 field(s))");

		for (const [path, bytes] of snapshot) {
			expect(readFileSync(path, "utf-8")).toBe(bytes);
		}
	});

	it("reports the exact number of lockfile version fields it changed", () => {
		const dir = createFixtureProject();

		// The fixture lockfile carries a version on the root (`lock.version`),
		// `packages[""]`, and the three top-level workspace packages
		// (ai, agent, coding-agent) — so a real bump touches exactly 5 fields.
		// Asserting the count proves the counter is real (not always-rewriting).
		const result = runSyncVersion(dir, "2.0.0");
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("package-lock.json workspace versions updated (5 field(s))");
	});

	it("does not run a full npm install (no dependency graph re-resolution)", () => {
		const scriptSource = readFileSync(realScriptPath, "utf-8");
		// Ignore comment lines — the script documents *why* it avoids `npm install`.
		const executableLines = scriptSource.split("\n").filter((line) => !line.trimStart().startsWith("#"));
		expect(executableLines.join("\n")).not.toMatch(/npm install/);
	});
});

describe("build script decoupling", () => {
	let rootPackage: { scripts?: Record<string, string> };

	beforeAll(() => {
		rootPackage = JSON.parse(readFileSync(realRootPackagePath, "utf-8"));
	});

	it("does not invoke sync-version from the build script", () => {
		expect(rootPackage.scripts?.build).toBeDefined();
		expect(rootPackage.scripts?.build).not.toMatch(/sync-version/);
	});

	it("keeps sync-version available as an explicit script", () => {
		expect(rootPackage.scripts?.["sync-version"]).toMatch(/sync-version\.sh/);
	});
});
