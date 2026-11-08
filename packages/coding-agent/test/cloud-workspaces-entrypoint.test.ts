import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR, getCloudWorkspaceRegistryPath } from "../src/config.js";
import * as entrypoint from "../src/core/cloud-workspaces/index.js";
import { CloudWorkspaceRegistry } from "../src/core/cloud-workspaces/registry.js";
import { CloudWorkspaceError } from "../src/core/cloud-workspaces/types.js";

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const publicNames = [
	"CLOUD_WORKSPACE_VERSION",
	"CloudWorkspaceError",
	"CloudWorkspaceRegistry",
	"getCloudWorkspaceRegistryPath",
];
let root: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "dreb-cloud-entrypoint-")));
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

// Executed by a fresh Node process, not Vitest/tsx and not the installed CLI.
// This is a regression tripwire for this metadata graph, not an OS sandbox:
// built-in loader internals and FileHandle operations are not separately traced.
const guardedImport = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [home, profile, explicit, project, packageDir, repo, configDir, agentEnv] = process.argv.slice(1);
const violations = [];
function forbidden(message) {
  violations.push(message);
  throw new Error("metadata guard: " + message);
}
globalThis.__cloudMetadataForbidden = forbidden;
const graph = new Set([
  "dist/core/cloud-workspaces/index.js",
  "dist/core/cloud-workspaces/registry.js",
  "dist/core/cloud-workspaces/storage.js",
  "dist/core/cloud-workspaces/types.js",
  "dist/config.js",
  "dist/core/context-trust.js",
  "dist/core/tools/path-utils.js",
].map(path => join(packageDir, path)));
const dependencyRoots = ["proper-lockfile", "graceful-fs", "retry", "signal-exit"]
  .map(name => join(repo, "node_modules", name) + sep);
const sourceFile = path => graph.has(path) || dependencyRoots.some(base => path.startsWith(base) && /\.(?:js|json)$/.test(path));
const builtins = new Set(["assert", "assert/strict", "constants", "crypto", "events", "fs", "fs/promises", "os", "path", "stream", "url", "util"]);
const loaded = new Set();
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (result.url.startsWith("node:")) {
      if (!builtins.has(result.url.slice(5))) forbidden("builtin import " + result.url);
    } else if (!result.url.startsWith("file:") || !sourceFile(fileURLToPath(result.url))) {
      forbidden("module import " + result.url);
    }
    return result;
  },
  load(url, context, next) {
    const result = next(url, context);
    if (url.startsWith("file:")) {
      const path = fileURLToPath(url);
      loaded.add(path);
      // Helpers may be imported, but metadata work must never evaluate trust
      // policy/discover context, nor initialize provider environment loading.
      if (path === join(packageDir, "dist/core/context-trust.js")) {
        const names = "strictNativeRealpath|canonicalizeDirectory|canonicalizeTrustedRoots|validateTrustedContextFolder|validateTrustedContextFolders|matchContextTrust";
        const pattern = new RegExp("export function (" + names + ")\\([^)]*\\)\\s*\\{", "g");
        return { ...result, source: String(result.source).replace(pattern, match => match + ' globalThis.__cloudMetadataForbidden("context trust initialization");') };
      }
      if (path === join(packageDir, "dist/config.js")) {
        return { ...result, source: String(result.source).replace(/export function loadProvidersEnv\(\)\s*\{/, match => match + ' globalThis.__cloudMetadataForbidden("provider environment initialization");') };
      }
    }
    return result;
  },
});

const manifests = new Set([join(packageDir, "package.json"), join(packageDir, "dist/package.json")]);
const packageProbes = new Set([join(packageDir, "src"), join(packageDir, "node_modules"), join(packageDir, "agents")]);
const profiles = [profile, explicit];
const selectedMetadata = path => profiles.some(base =>
  path === base || path === join(base, "cloud-workspaces.json") ||
  path === join(base, "cloud-workspaces.json.lock") ||
  (path.startsWith(join(base, "cloud-workspaces.json") + ".") && path.endsWith(".tmp"))) ||
  path === project || path === join(project, configDir) || path === join(project, configDir, "project.json");
function checkPath(value, operation, write = false) {
  if (typeof value === "number") return; // descriptors can only originate at a guarded open
  const path = resolve(value instanceof URL ? fileURLToPath(value) : String(value));
  if (selectedMetadata(path)) return;
  if (!write && (sourceFile(path) || manifests.has(path) || (operation === "existsSync" && packageProbes.has(path)))) return;
  forbidden(operation + " " + path);
}
const mutations = new Set(["appendFile", "chmod", "chown", "copyFile", "cp", "link", "lchown", "lutimes", "mkdir", "mkdtemp", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile"]);
for (const api of [fs, fsp]) {
  for (const name of [...mutations, "access", "exists", "lstat", "open", "opendir", "readFile", "readdir", "readlink", "realpath", "stat", "statfs", "watch", "watchFile", "createReadStream", "createWriteStream"]) {
    for (const key of [name, name + "Sync"]) {
      if (typeof api[key] !== "function") continue;
      const original = api[key];
      const wrapped = function(...args) {
        const write = mutations.has(name) || name === "createWriteStream" ||
          (name === "open" && (typeof args[1] === "string" ? args[1] !== "r" : !!(args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC))));
        if (["opendir", "readdir", "watch", "watchFile"].includes(name)) forbidden("directory discovery " + key);
        checkPath(args[0], key, write);
        if (["rename", "copyFile", "cp", "link", "symlink"].includes(name)) checkPath(args[1], key, true);
        return original.apply(this, args);
      };
      if (typeof original.native === "function") {
        wrapped.native = function(...args) { checkPath(args[0], key + ".native"); return original.native(...args); };
      }
      api[key] = wrapped;
    }
  }
}
syncBuiltinESMExports();
globalThis.fetch = () => forbidden("outbound fetch");
globalThis.WebSocket = class { constructor() { forbidden("outbound websocket"); } };

// Negative controls demonstrate the tripwires work, including swallowed errors.
assert.throws(() => fs.readFileSync(join(home, configDir, "agent/auth.json")), /metadata guard/);
assert.throws(() => fs.readFileSync(join(project, "AGENTS.md")), /metadata guard/);
assert.throws(() => fs.writeFileSync(join(home, "unselected"), "no"), /metadata guard/);
for (const specifier of ["node:child_process", "node:http", "node:net", "node:worker_threads"]) {
  await assert.rejects(() => import(specifier), /metadata guard/);
}
for (const path of ["core/auth-storage.js", "core/model-registry.js", "core/resource-loader.js", "core/agent-session.js", "core/session-manager.js", "main.js", "modes/interactive/interactive-mode.js"]) {
  await assert.rejects(() => import(pathToFileURL(join(packageDir, "dist", path)).href), /metadata guard/);
}
assert.throws(() => fetch("https://example.invalid"), /metadata guard/);
violations.length = 0;

const entry = await import("@dreb/coding-agent/cloud-workspaces");
assert.equal(fileURLToPath(import.meta.resolve("@dreb/coding-agent/cloud-workspaces")), join(packageDir, "dist/core/cloud-workspaces/index.js"));
assert.deepEqual(Object.keys(entry).sort(), ["CLOUD_WORKSPACE_VERSION", "CloudWorkspaceError", "CloudWorkspaceRegistry", "getCloudWorkspaceRegistryPath"]);
assert.equal(entry.CLOUD_WORKSPACE_VERSION, 1);
assert.equal(new entry.CloudWorkspaceError("CONFLICT", "test").code, "CONFLICT");
assert.equal(entry.getCloudWorkspaceRegistryPath(), join(profile, "cloud-workspaces.json"));
assert.equal(entry.getCloudWorkspaceRegistryPath(explicit), join(explicit, "cloud-workspaces.json"));
assert.equal(entry.getCloudWorkspaceRegistryPath("~/literal profile"), join(home, "literal profile/cloud-workspaces.json"));
const configured = process.env[agentEnv];
delete process.env[agentEnv];
assert.equal(entry.getCloudWorkspaceRegistryPath(), join(home, configDir, "agent/cloud-workspaces.json"));
process.env[agentEnv] = configured;
const registry = new entry.CloudWorkspaceRegistry();
const isolated = new entry.CloudWorkspaceRegistry({ agentDir: explicit });
const empty = { version: 1, workspaces: [], projects: [] };
assert.deepEqual(await registry.list(), empty);
assert.deepEqual(await registry.status(), empty);
assert.deepEqual(await isolated.list(), empty);
assert.equal(fs.existsSync(profile), false);
assert.equal(fs.existsSync(explicit), false);
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
assert.deepEqual(await registry.link(project, { projectId: id, expectedId: id.toUpperCase() }), {
  id, location: { kind: "local", path: project }, markerRequired: false,
});
assert.equal(await registry.resolve(id), project);
assert.deepEqual(await registry.status(), { ...empty, projects: [{ id, available: true, path: project }] });
assert.deepEqual(await isolated.list(), empty);
assert.equal(await registry.unlink(id), true);
assert.equal(await registry.unlink(id), false);
assert.equal(await registry.disconnect(id), false);
assert.deepEqual(await registry.list(), empty);
assert.equal(fs.existsSync(join(project, configDir)), false);

assert.deepEqual(violations, []);
// Check function-entry tripwires too; neither helper is invoked by registry work.
const trust = await import(pathToFileURL(join(packageDir, "dist/core/context-trust.js")).href);
assert.throws(() => trust.canonicalizeTrustedRoots([]), /metadata guard/);
const config = await import(pathToFileURL(join(packageDir, "dist/config.js")).href);
assert.throws(() => config.loadProvidersEnv(), /metadata guard/);
assert.equal(violations.length, 2);
violations.length = 0;
assert.ok(loaded.has(join(packageDir, "dist/core/cloud-workspaces/index.js")));
assert.deepEqual(violations, []);
console.log(JSON.stringify({ exports: Object.keys(entry).sort(), loaded: [...loaded].sort() }));
`;

describe("metadata-only cloud-workspaces package boundary", () => {
	it("maps the public package export to compiled JS/types and the explicit source alias", async () => {
		const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
		expect(manifest.exports["./cloud-workspaces"]).toEqual({
			types: "./dist/core/cloud-workspaces/index.d.ts",
			import: "./dist/core/cloud-workspaces/index.js",
		});
		const tsconfig = JSON.parse(await readFile(join(repo, "tsconfig.json"), "utf8"));
		expect(tsconfig.compilerOptions.paths["@dreb/coding-agent/cloud-workspaces"]).toEqual([
			"./packages/coding-agent/src/core/cloud-workspaces/index.ts",
		]);
		expect(await readFile(join(packageDir, manifest.exports["./cloud-workspaces"].types), "utf8")).toContain(
			"CloudWorkspaceRegistry",
		);
	});

	it("shares source version/error/registry/path helpers without exposing storage or runtime APIs", () => {
		expect(Object.keys(entrypoint).sort()).toEqual(publicNames);
		expect(entrypoint.CLOUD_WORKSPACE_VERSION).toBe(1);
		expect(entrypoint.CloudWorkspaceError).toBe(CloudWorkspaceError);
		expect(entrypoint.CloudWorkspaceRegistry).toBe(CloudWorkspaceRegistry);
		expect(entrypoint.getCloudWorkspaceRegistryPath).toBe(getCloudWorkspaceRegistryPath);
		vi.stubEnv("HOME", root);
		vi.stubEnv("USERPROFILE", root);
		vi.stubEnv(ENV_AGENT_DIR, join(root, "profile"));
		expect(new entrypoint.CloudWorkspaceRegistry().path).toBe(join(root, "profile/cloud-workspaces.json"));
		expect(entrypoint.getCloudWorkspaceRegistryPath("~/explicit")).toBe(join(root, "explicit/cloud-workspaces.json"));
		const options: entrypoint.LinkCloudProjectOptions = { expectedId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
		const inherited: entrypoint.ConnectCloudWorkspaceOptions = options;
		expect(inherited.expectedId).toBe(options.expectedId);
		// Existing root-barrel compatibility is exercised by cloud-workspaces-sdk.test.ts.
	});

	it("imports the fresh compiled public subpath and manages only selected synthetic metadata", async () => {
		const home = join(root, "home");
		const project = join(root, "project");
		const profile = join(root, "selected-profile");
		const explicit = join(root, "explicit-profile");
		await mkdir(home);
		await mkdir(project);
		const sentinels = [
			join(project, "AGENTS.md"),
			join(project, "session.jsonl"),
			join(home, "settings.json"),
			join(root, "unrelated-registry.json"),
		];
		for (const path of sentinels) await writeFile(path, `Do not read or modify: ${path}\n`);
		const before = await Promise.all(sentinels.map((path) => readFile(path)));
		const result = await run(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				guardedImport,
				home,
				profile,
				explicit,
				project,
				packageDir,
				repo,
				CONFIG_DIR_NAME,
				ENV_AGENT_DIR,
			],
			{
				cwd: packageDir,
				env: {
					PATH: process.env.PATH,
					HOME: home,
					USERPROFILE: home,
					[ENV_AGENT_DIR]: profile,
					DREB_LIVE_API: "0",
					DREB_LIVE_API_EXPENSIVE: "0",
					DREB_NO_LOCAL_LLM: "1",
					DREB_OFFLINE: "1",
				},
				timeout: 15000,
			},
		);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout).exports).toEqual(publicNames);
		expect(await Promise.all(sentinels.map((path) => readFile(path)))).toEqual(before);
	});
});
