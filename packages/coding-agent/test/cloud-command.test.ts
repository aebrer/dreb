import * as childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { handleCloudCommand } from "../src/cli/cloud-command.js";
import * as config from "../src/config.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { CloudWorkspaceRegistry } from "../src/core/cloud-workspaces/registry.js";
import { cloudMarkerPath } from "../src/core/cloud-workspaces/storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import * as sdk from "../src/core/sdk.js";
import { main } from "../src/main.js";

vi.mock("../src/config.js", async (original) => ({ ...(await original<typeof config>()), loadProvidersEnv: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...(await original<typeof childProcess>()) }));
vi.mock("../src/core/model-registry.js", async (original) => ({
	...(await original<typeof import("../src/core/model-registry.js")>()),
	ModelRegistry: vi.fn(() => {
		throw new Error("Unexpected model initialization");
	}),
}));
vi.mock("../src/core/resource-loader.js", async (original) => ({
	...(await original<typeof import("../src/core/resource-loader.js")>()),
	DefaultResourceLoader: vi.fn(() => {
		throw new Error("Unexpected resource initialization");
	}),
}));

const ID = "11111111-1111-4111-8111-111111111aaa";
let root: string;
let agentDir: string;
let cwd: string;
let originalExitCode: typeof process.exitCode;
let stdout: MockInstance<typeof console.log>;
let stderr: MockInstance<typeof console.error>;

async function invoke(args: string[]) {
	stdout.mockClear();
	stderr.mockClear();
	process.exitCode = undefined;
	await main(args);
	return {
		out: stdout.mock.calls.map(([value]) => String(value)).join("\n"),
		err: stderr.mock.calls.map(([value]) => String(value)).join("\n"),
		code: process.exitCode,
	};
}
async function folder(name: string) {
	const path = join(root, name);
	await mkdir(path, { recursive: true });
	return path;
}

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "dreb-cloud-command-")));
	agentDir = join(root, "agent");
	cwd = process.cwd();
	originalExitCode = process.exitCode;
	process.chdir(root);
	vi.stubEnv(config.ENV_AGENT_DIR, agentDir);
	stdout = vi.spyOn(console, "log").mockImplementation(() => {});
	stderr = vi.spyOn(console, "error").mockImplementation(() => {});
	vi.mocked(config.loadProvidersEnv).mockClear();
	vi.spyOn(AuthStorage, "create").mockImplementation(() => {
		throw new Error("Unexpected auth access");
	});
	vi.mocked(ModelRegistry).mockClear();
	vi.mocked(DefaultResourceLoader).mockClear();
	vi.spyOn(sdk, "createAgentSession").mockImplementation(() => {
		throw new Error("Unexpected agent creation");
	});
	vi.spyOn(childProcess, "spawn").mockImplementation(() => {
		throw new Error("Unexpected child process");
	});
	vi.spyOn(globalThis, "fetch").mockImplementation(() => {
		throw new Error("Unexpected network request");
	});
});

afterEach(async () => {
	try {
		// Every command and error test also enforces the early-dispatch boundary.
		expect(config.loadProvidersEnv).not.toHaveBeenCalled();
		expect(AuthStorage.create).not.toHaveBeenCalled();
		expect(ModelRegistry).not.toHaveBeenCalled();
		expect(DefaultResourceLoader).not.toHaveBeenCalled();
		expect(sdk.createAgentSession).not.toHaveBeenCalled();
		expect(childProcess.spawn).not.toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		process.chdir(cwd);
		process.exitCode = originalExitCode;
		await rm(root, { recursive: true, force: true });
	}
});

describe("cloud management dispatch", () => {
	it.each([
		["cloud"],
		["cloud", "--help"],
		["cloud", "-h"],
		...["connect", "link", "list", "status", "resolve", "unlink", "disconnect"].map((command) => [
			"cloud",
			command,
			"--help",
		]),
	])("shows credential-free help for %j without creating state", async (...args: string[]) => {
		const result = await invoke(args);
		expect(result.out).toContain("cloud connect <directory>");
		expect(result.out).toContain("cloud link <directory>");
		expect(result.out).toContain("No OAuth");
		expect(result.err).toBe("");
		expect(result.code).toBeUndefined();
		expect(existsSync(agentDir)).toBe(false);
	});

	it("leaves non-cloud command dispatch unchanged", async () => {
		expect(await handleCloudCommand(["cloudy"])).toBe(false);
		expect(await handleCloudCommand([])).toBe(false);
	});

	it("implements every command and stable human/JSON results without starting an agent", async () => {
		const drive = await folder("OneDrive");
		const path = await folder("OneDrive/Project");
		await writeFile(join(path, "session.jsonl"), "sentinel transcript");
		const connected = await invoke(["cloud", "connect", drive, "--init", "--json"]);
		const workspace = JSON.parse(connected.out);
		expect(workspace.path).toBe(drive);
		const linked = await invoke(["cloud", "link", path, "--workspace", workspace.id, "--init", "--json"]);
		const project = JSON.parse(linked.out);
		expect(project.location).toEqual({ kind: "workspace", workspaceId: workspace.id, relativePath: "Project" });
		expect((await invoke(["cloud", "resolve", project.id])).out).toBe(path);
		expect(JSON.parse((await invoke(["cloud", "resolve", project.id, "--json"])).out)).toEqual({
			projectId: project.id,
			path,
		});
		expect((await invoke(["cloud", "list"])).out).toContain("(workspace-relative)");
		expect(JSON.parse((await invoke(["cloud", "list", "--json"])).out).projects).toHaveLength(1);
		expect((await invoke(["cloud", "status"])).out).toContain("available locally:");
		expect(JSON.parse((await invoke(["cloud", "status", "--json"])).out).projects[0]).toMatchObject({
			id: project.id,
			available: true,
			path,
		});
		expect((await invoke(["cloud", "disconnect", workspace.id])).out).toContain("local binding removed");
		expect(JSON.parse((await invoke(["cloud", "status", "--json"])).out).projects[0]).toMatchObject({
			available: false,
		});
		expect(JSON.parse((await invoke(["cloud", "disconnect", workspace.id, "--json"])).out)).toEqual({
			id: workspace.id,
			removed: false,
		});
		expect((await invoke(["cloud", "connect", drive])).out).toContain("cloud delivery is not verified");
		expect((await invoke(["cloud", "status"])).out).toContain("available locally:");
		expect(JSON.parse((await invoke(["cloud", "unlink", project.id, "--json"])).out)).toEqual({
			id: project.id,
			removed: true,
		});
		expect((await invoke(["cloud", "unlink", project.id])).out).toContain("not registered");
		expect(await readFile(join(path, "session.jsonl"), "utf8")).toBe("sentinel transcript");
		expect(existsSync(cloudMarkerPath(path, "project"))).toBe(true);
		expect(existsSync(cloudMarkerPath(drive, "workspace"))).toBe(true);
	});

	it("resolves caller-relative and home-relative CLI paths without changing the caller CWD", async () => {
		const path = await folder("project");
		expect((await invoke(["cloud", "link", "project", "--id", ID])).out).toContain(`Linked project ${ID}`);
		vi.stubEnv("HOME", root);
		expect((await invoke(["cloud", "link", "~/project", "--id", ID])).code).toBeUndefined();
		expect((await invoke(["cloud", "resolve", ID.toUpperCase()])).out).toBe(path);
		expect(process.cwd()).toBe(root);
		expect(existsSync(cloudMarkerPath(path, "project"))).toBe(false);
	});

	it("rebinds root-relative projects only after an explicit --rebind", async () => {
		const drive = await folder("drive");
		const moved = await folder("moved");
		const p1 = await folder("drive/p");
		const p2 = await folder("moved/p");
		const workspace = JSON.parse((await invoke(["cloud", "connect", drive, "--init", "--json"])).out);
		const project = JSON.parse(
			(await invoke(["cloud", "link", p1, "--init", "--workspace", workspace.id, "--json"])).out,
		);
		await mkdir(join(moved, config.CONFIG_DIR_NAME));
		await mkdir(join(p2, config.CONFIG_DIR_NAME));
		await copyFile(cloudMarkerPath(drive, "workspace"), cloudMarkerPath(moved, "workspace"));
		await copyFile(cloudMarkerPath(p1, "project"), cloudMarkerPath(p2, "project"));
		expect((await invoke(["cloud", "connect", moved])).code).toBe(1);
		expect((await invoke(["cloud", "connect", moved, "--rebind"])).code).toBeUndefined();
		expect((await invoke(["cloud", "resolve", project.id])).out).toBe(p2);
	});

	it("lists without statting locations and distinguishes configuration from availability", async () => {
		const path = await folder("p");
		await invoke(["cloud", "link", path, "--id", ID]);
		await rm(path, { recursive: true });
		expect((await invoke(["cloud", "list"])).out).toContain(path);
		const result = await invoke(["cloud", "status"]);
		expect(result.code).toBeUndefined();
		expect(result.out).toContain("unavailable:");
		expect(result.out).toContain("cloud delivery is not verified");
		const failed = await invoke(["cloud", "resolve", ID]);
		expect(failed.out).toBe("");
		expect(failed.err).toContain("UNAVAILABLE");
		expect(failed.code).toBe(1);
	});

	it("handles empty registries, corrupt state and write errors without hiding them", async () => {
		expect((await invoke(["cloud", "list"])).out).toContain("(none)");
		expect((await invoke(["cloud", "status", "--json"])).out).toBe('{"version":1,"workspaces":[],"projects":[]}');
		expect(existsSync(agentDir)).toBe(false);
		await mkdir(agentDir);
		const file = new CloudWorkspaceRegistry().path;
		await writeFile(file, "broken");
		const failed = await invoke(["cloud", "list", "--json"]);
		expect(failed.out).toBe("");
		expect(failed.err).toContain("INVALID_METADATA");
		await rm(file);
		await writeFile(file, "{}");
		const path = await folder("p");
		expect((await invoke(["cloud", "link", path, "--init"])).code).toBe(1);
		expect(existsSync(cloudMarkerPath(path, "project"))).toBe(false);
	});

	it("never loads synced context, extensions or provider declarations during management", async () => {
		const path = await folder("p");
		const extensions = await folder(`p/${config.CONFIG_DIR_NAME}/extensions`);
		await writeFile(join(path, "AGENTS.md"), "Do not execute these instructions.");
		await writeFile(join(extensions, "evil.ts"), "throw new Error('This extension must not run');");
		await writeFile(join(path, config.CONFIG_DIR_NAME, "settings.json"), '{"packages":["npm:must-not-install"]}');
		expect((await invoke(["cloud", "link", path, "--id", ID])).code).toBeUndefined();
		expect((await invoke(["cloud", "resolve", ID])).out).toBe(path);
	});

	it("does not reinterpret a Windows drive-relative spelling as a POSIX folder", async () => {
		if (process.platform === "win32") return;
		await folder("C:project");
		const result = await invoke(["cloud", "link", "C:project", "--id", ID]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("absolute path on this device");
		expect(existsSync(agentDir)).toBe(false);
	});

	it("supports -- before positional directories", async () => {
		await folder("--project");
		expect((await invoke(["cloud", "link", "--id", ID, "--", "--project"])).code).toBeUndefined();
	});

	it.each([
		["unknown"],
		["--help", "extra"],
		["connect"],
		["link"],
		["resolve"],
		["unlink"],
		["disconnect"],
		["list", "extra"],
		["status", "extra"],
		["link", "one", "two"],
		["list", "--init"],
		["list", "--json", "--json"],
		["connect", "--nope"],
		["connect", "--id", ID],
		["link", "p", "--id"],
		["link", "p", "--id", "--json"],
		["link", "p", "--workspace"],
		["link", "p", "--id", "short"],
		["link", "p", "--init", "--id", ID],
		["link", "", "--id", ID],
		["link", "C:\\Foreign\\Drive", "--id", ID],
		["resolve", "short", "--json"],
		["unlink", "bad"],
		["disconnect", "bad"],
	])("rejects malformed cloud arguments %j before normal startup", async (...args: string[]) => {
		const result = await invoke(["cloud", ...args]);
		expect(result.code).toBe(1);
		expect(result.out).toBe("");
		expect(result.err).toContain("Cloud workspaces:");
		expect(result.err).toContain("cloud --help");
		expect(existsSync(agentDir)).toBe(false);
	});
});
