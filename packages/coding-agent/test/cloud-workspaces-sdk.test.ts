import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRegisteredProject } from "../examples/sdk/13-cloud-workspaces.js";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	CLOUD_WORKSPACE_VERSION,
	type CloudProjectBinding,
	CloudWorkspaceError,
	CloudWorkspaceRegistry,
	getCloudWorkspaceRegistryPath,
} from "../src/index.js";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const run = promisify(execFile);
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const example = fileURLToPath(new URL("../examples/sdk/13-cloud-workspaces.ts", import.meta.url));
let root: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "dreb-cloud-sdk-")));
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

describe("cloud workspace public SDK", () => {
	it("exports version, error, registry and path helpers through the existing package API", async () => {
		expect(CLOUD_WORKSPACE_VERSION).toBe(1);
		const failure = new CloudWorkspaceError("CONFLICT", "explicit choice needed");
		expect(failure).toBeInstanceOf(Error);
		expect(failure.code).toBe("CONFLICT");
		vi.stubEnv(ENV_AGENT_DIR, join(root, "default-agent"));
		expect(getCloudWorkspaceRegistryPath()).toBe(join(root, "default-agent", "cloud-workspaces.json"));
		expect(new CloudWorkspaceRegistry().path).toBe(getCloudWorkspaceRegistryPath());
		expect(getCloudWorkspaceRegistryPath(join(root, "explicit"))).toBe(
			join(root, "explicit", "cloud-workspaces.json"),
		);
		expect(() => getCloudWorkspaceRegistryPath("")).toThrow("must not be empty");
	});

	it("uses separate supplied agent directories and the metadata-only SDK example", async () => {
		const agentA = join(root, "agent-a");
		const agentB = join(root, "agent-b");
		const first = join(root, "first");
		const second = join(root, "second");
		await mkdir(first);
		await mkdir(second);
		const registryA = new CloudWorkspaceRegistry({ agentDir: agentA });
		const registryB = new CloudWorkspaceRegistry({ agentDir: agentB });
		const binding: CloudProjectBinding = await registryA.link(first, { projectId: ID });
		expect(binding.id).toBe(ID);
		await registryB.link(second, { projectId: ID });
		expect(await resolveRegisteredProject(ID, agentA)).toBe(first);
		expect(await resolveRegisteredProject(ID, agentB)).toBe(second);
		vi.stubEnv(ENV_AGENT_DIR, agentA);
		expect(await resolveRegisteredProject(ID)).toBe(first);
	});

	it("reports lookup failures using the public structured error", async () => {
		const registry = new CloudWorkspaceRegistry({ agentDir: join(root, "agent") });
		await expect(registry.resolve(ID)).rejects.toMatchObject({ code: "NOT_FOUND", name: "CloudWorkspaceError" });
	});

	it("runs the SDK example with no credentials and gives useful usage/error exits", async () => {
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		await mkdir(project);
		await new CloudWorkspaceRegistry({ agentDir }).link(project, { projectId: ID });
		const options = {
			cwd: repo,
			env: {
				PATH: process.env.PATH,
				HOME: root,
				[ENV_AGENT_DIR]: agentDir,
				DREB_LIVE_API: "0",
				DREB_NO_LOCAL_LLM: "1",
			},
			timeout: 15000,
		};
		const result = await run(process.execPath, ["--import", "tsx", example, ID], options);
		expect(result.stdout.trim()).toBe(project);
		expect(result.stderr).toBe("");
		await expect(run(process.execPath, ["--import", "tsx", example], options)).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining("Usage:"),
		});
		await expect(run(process.execPath, ["--import", "tsx", example, ID, "extra"], options)).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining("Usage:"),
		});
		await expect(
			run(process.execPath, ["--import", "tsx", example, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"], options),
		).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("not linked") });
		expect(dirname(getCloudWorkspaceRegistryPath(agentDir))).toBe(agentDir);
	});
});
