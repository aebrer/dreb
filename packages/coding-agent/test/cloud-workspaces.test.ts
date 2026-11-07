import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.js";
import { CloudWorkspaceRegistry } from "../src/core/cloud-workspaces/registry.js";
import { cloudMarkerPath } from "../src/core/cloud-workspaces/storage.js";
import {
	CloudWorkspaceError,
	parseCloudWorkspaceState,
	portableRelativePath,
} from "../src/core/cloud-workspaces/types.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));

const PROJECT = "11111111-1111-4111-8111-111111111aaa";
const OTHER = "22222222-2222-4222-8222-222222222222";

let root: string;
let registry: CloudWorkspaceRegistry;
async function folder(name: string): Promise<string> {
	const path = join(root, name);
	await fs.mkdir(path, { recursive: true });
	return path;
}
async function copyMarker(from: string, to: string, kind: "project" | "workspace") {
	await fs.mkdir(join(to, CONFIG_DIR_NAME), { recursive: true });
	await fs.copyFile(cloudMarkerPath(from, kind), cloudMarkerPath(to, kind));
}
async function marker(path: string, kind: "project" | "workspace", id: string) {
	await fs.mkdir(join(path, CONFIG_DIR_NAME), { recursive: true });
	await fs.writeFile(cloudMarkerPath(path, kind), JSON.stringify({ version: 1, kind, id }));
}

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "dreb-cloud-registry-")));
	registry = new CloudWorkspaceRegistry({ agentDir: join(root, "device-a") });
});
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

describe("portable identities and device-local mappings", () => {
	it("connects two simulated devices through different roots and resolves shared and local projects", async () => {
		const driveA = await folder("Mac OneDrive");
		const driveB = await folder("PC Google Drive");
		const projectA = await folder("Mac OneDrive/Projects/Résumé notes");
		const projectB = await folder("PC Google Drive/Projects/Résumé notes");
		const workspace = await registry.connect(driveA, { initialize: true });
		const project = await registry.link(projectA, { initialize: true, workspaceId: workspace.id });
		await copyMarker(driveA, driveB, "workspace");
		await copyMarker(projectA, projectB, "project");
		const deviceB = new CloudWorkspaceRegistry({ agentDir: join(root, "device-b") });
		expect((await deviceB.connect(driveB)).id).toBe(workspace.id);
		expect((await deviceB.link(projectB, { workspaceId: workspace.id })).id).toBe(project.id);
		expect(await registry.resolve(project.id)).toBe(projectA);
		expect(await deviceB.resolve(project.id)).toBe(projectB);
		expect((await registry.list()).projects[0].location).toEqual((await deviceB.list()).projects[0].location);

		const localA = await folder("Development/Other checkout");
		const localB = await folder("Different disk/Code");
		await registry.link(localA, { projectId: PROJECT });
		await deviceB.link(localB, { projectId: PROJECT });
		expect(await registry.resolve(PROJECT)).toBe(localA);
		expect(await deviceB.resolve(PROJECT)).toBe(localB);
		await expect(fs.stat(cloudMarkerPath(localA, "project"))).rejects.toMatchObject({ code: "ENOENT" });
		const shared = JSON.parse(await fs.readFile(cloudMarkerPath(projectA, "project"), "utf8"));
		expect(shared).toEqual({ version: 1, kind: "project", id: project.id });
		expect(JSON.stringify(shared)).not.toContain(root);
	});

	it("rebinds one root without editing relative project bindings or their identities", async () => {
		const first = await folder("first");
		const next = await folder("renamed-root");
		const one = await folder("first/p");
		const two = await folder("renamed-root/p");
		const workspace = await registry.connect(first, { initialize: true });
		const project = await registry.link(one, { initialize: true, workspaceId: workspace.id });
		const before = (await registry.list()).projects;
		await copyMarker(first, next, "workspace");
		await copyMarker(one, two, "project");
		await expect(registry.connect(next)).rejects.toMatchObject({ code: "CONFLICT" });
		expect(await registry.resolve(project.id)).toBe(one);
		await registry.connect(next, { rebind: true });
		expect(await registry.resolve(project.id)).toBe(two);
		expect((await registry.list()).projects).toEqual(before);
	});

	it("requires explicit workspace selection and permits the root itself as a project", async () => {
		const path = await folder("root");
		const workspace = await registry.connect(path, { initialize: true });
		const project = await registry.link(path, { initialize: true });
		expect(project.location).toEqual({ kind: "local", path });
		await expect(registry.link(path, { workspaceId: workspace.id })).rejects.toMatchObject({ code: "CONFLICT" });
		expect((await registry.link(path, { workspaceId: workspace.id, rebind: true })).location).toEqual({
			kind: "workspace",
			workspaceId: workspace.id,
			relativePath: ".",
		});
		expect(await registry.resolve(project.id)).toBe(path);
	});

	it("supports a read-only markerless project using only an explicitly known ID", async () => {
		const path = await folder("readonly");
		const write = vi.spyOn(fs, "open");
		const binding = await registry.link(path, { projectId: PROJECT });
		expect(binding.markerRequired).toBe(false);
		expect(await registry.resolve(PROJECT.toUpperCase())).toBe(path);
		expect(write.mock.calls.filter(([file, flags]) => String(file).startsWith(path) && flags === "wx")).toEqual([]);
		await expect(fs.stat(join(path, CONFIG_DIR_NAME))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("checks a subsequently added marker even for a markerless binding", async () => {
		const path = await folder("p");
		await registry.link(path, { projectId: PROJECT });
		await marker(path, "project", OTHER);
		await expect(registry.resolve(PROJECT)).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("can upgrade marker validation but never silently downgrade it", async () => {
		const path = await folder("p");
		await registry.link(path, { projectId: PROJECT });
		await marker(path, "project", PROJECT);
		expect((await registry.link(path)).markerRequired).toBe(true);
		await fs.unlink(cloudMarkerPath(path, "project"));
		await expect(registry.link(path, { projectId: PROJECT })).rejects.toMatchObject({ code: "CONFLICT" });
		expect((await registry.link(path, { projectId: PROJECT, rebind: true })).markerRequired).toBe(false);
	});

	it("refuses conflicting markers without rewriting them", async () => {
		const path = await folder("p");
		await marker(path, "project", PROJECT);
		const before = await fs.readFile(cloudMarkerPath(path, "project"), "utf8");
		await expect(registry.link(path, { projectId: OTHER })).rejects.toMatchObject({ code: "CONFLICT" });
		expect(await fs.readFile(cloudMarkerPath(path, "project"), "utf8")).toBe(before);
	});

	it("requires an explicit rebind for multiple local checkouts of the same identity", async () => {
		const one = await folder("one");
		const two = await folder("two");
		await registry.link(one, { projectId: PROJECT });
		await expect(registry.link(two, { projectId: PROJECT })).rejects.toMatchObject({ code: "CONFLICT" });
		await registry.link(two, { projectId: PROJECT, rebind: true });
		expect(await registry.resolve(PROJECT)).toBe(two);
	});

	it("refuses a different project ID at an already linked local directory", async () => {
		const path = await folder("p");
		await registry.link(path, { projectId: PROJECT });
		await expect(registry.link(path, { projectId: OTHER, rebind: true })).rejects.toMatchObject({ code: "CONFLICT" });
		expect((await registry.list()).projects.map((p) => p.id)).toEqual([PROJECT]);
	});

	it("does not initialize a new identity over an existing markerless registration", async () => {
		const path = await folder("p");
		await registry.link(path, { projectId: PROJECT });
		await expect(registry.link(path, { initialize: true })).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(fs.stat(cloudMarkerPath(path, "project"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await registry.resolve(PROJECT)).toBe(path);
	});

	it("does not reinitialize a connected workspace whose marker disappeared", async () => {
		const path = await folder("workspace");
		await registry.connect(path, { initialize: true });
		await fs.unlink(cloudMarkerPath(path, "workspace"));
		await expect(registry.connect(path, { initialize: true })).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(fs.stat(cloudMarkerPath(path, "workspace"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses a new workspace identity at a path belonging to another local binding", async () => {
		const path = await folder("workspace");
		const first = await registry.connect(path, { initialize: true });
		await marker(path, "workspace", OTHER);
		await expect(registry.connect(path, { rebind: true })).rejects.toMatchObject({ code: "CONFLICT" });
		expect((await registry.list()).workspaces[0].id).toBe(first.id);
	});

	it.each(["disconnect", "rebind"])(
		"refuses a link when the workspace mapping changes concurrently via %s",
		async (change) => {
			const first = await folder("workspace");
			const next = await folder("new-workspace");
			const project = await folder("workspace/p");
			const workspace = await registry.connect(first, { initialize: true });
			await copyMarker(first, next, "workspace");
			await marker(project, "project", PROJECT);
			const open = fs.open;
			let changed = false;
			vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
				if (String(path) === cloudMarkerPath(project, "project") && !changed) {
					changed = true;
					if (change === "disconnect") await registry.disconnect(workspace.id);
					else await registry.connect(next, { rebind: true });
				}
				return open(path, flags, mode);
			});
			await expect(registry.link(project, { projectId: PROJECT, workspaceId: workspace.id })).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining("mapping changed"),
			});
			expect(changed).toBe(true);
			expect((await registry.list()).projects).toEqual([]);
		},
	);

	it.each(["workspaces", "local projects", "relative projects", "mixed project locations"])(
		"rejects ambiguous duplicate %s without filesystem probing",
		(kind) => {
			const workspace = { id: OTHER, path: root };
			const local = { kind: "local", path: join(root, "p") };
			const relative = { kind: "workspace", workspaceId: OTHER, relativePath: "p" };
			const first = {
				id: PROJECT,
				markerRequired: false,
				location: kind === "relative projects" ? relative : local,
			};
			const second = {
				...first,
				id: "33333333-3333-4333-8333-333333333333",
				location: kind === "mixed project locations" ? relative : first.location,
			};
			expect(() =>
				parseCloudWorkspaceState({
					version: 1,
					workspaces: kind === "workspaces" ? [workspace, { ...workspace, id: PROJECT }] : [workspace],
					projects: kind === "workspaces" ? [] : [first, second],
				}),
			).toThrow("Ambiguous duplicate locations");
		},
	);

	it("returns fresh, detached state and deterministic identity ordering", async () => {
		const one = await folder("one");
		const two = await folder("two");
		await registry.link(two, { projectId: OTHER });
		await registry.link(one, { projectId: PROJECT });
		const state = await registry.list();
		expect(state.projects.map((p) => p.id)).toEqual([PROJECT, OTHER]);
		state.projects.length = 0;
		expect((await registry.list()).projects).toHaveLength(2);
	});
});

describe("strict local directory resolution", () => {
	it("does not infer missing identities or silently create markers", async () => {
		const path = await folder("p");
		await expect(registry.connect(path)).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(registry.link(path)).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(registry.resolve(PROJECT)).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(fs.stat(registry.path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["", ".", "../p", "C:\\Foreign\\Project", "C:relative"])(
		"refuses non-native/relative SDK directories %j",
		async (path) => {
			if (process.platform === "win32" && path === "C:\\Foreign\\Project") return;
			await expect(registry.link(path, { projectId: PROJECT })).rejects.toMatchObject({ code: "INVALID_PATH" });
		},
	);

	it("reports missing, non-directory and permission-denied locations explicitly", async () => {
		await expect(registry.link(join(root, "missing"), { projectId: PROJECT })).rejects.toMatchObject({
			code: "UNAVAILABLE",
		});
		const file = join(root, "file");
		await fs.writeFile(file, "not a directory");
		await expect(registry.link(file, { projectId: PROJECT })).rejects.toMatchObject({ code: "UNAVAILABLE" });
		const path = await folder("p");
		vi.spyOn(fs, "access").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
		await expect(registry.link(path, { projectId: PROJECT })).rejects.toMatchObject({ code: "UNAVAILABLE" });
	});

	it("revalidates folder availability and marker identity at every resolve", async () => {
		const path = await folder("p");
		const binding = await registry.link(path, { initialize: true });
		await marker(path, "project", OTHER);
		await expect(registry.resolve(binding.id)).rejects.toMatchObject({ code: "CONFLICT" });
		const status = await registry.status();
		expect(status.projects[0]).toMatchObject({ available: false, error: { code: "CONFLICT" } });
		await fs.rm(path, { recursive: true });
		await expect(registry.resolve(binding.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
	});

	it("will not associate a project outside the selected workspace or initialize it there", async () => {
		const workspacePath = await folder("workspace");
		const outside = await folder("outside");
		const workspace = await registry.connect(workspacePath, { initialize: true });
		await expect(registry.link(outside, { initialize: true, workspaceId: workspace.id })).rejects.toMatchObject({
			code: "INVALID_PATH",
		});
		await expect(fs.stat(cloudMarkerPath(outside, "project"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("accepts an explicitly selected root alias but rejects project symlink escapes at use time", async () => {
		const workspacePath = await folder("workspace");
		const alias = join(root, "alias");
		await fs.symlink(workspacePath, alias, "dir");
		const workspace = await registry.connect(alias, { initialize: true });
		expect(workspace.path).toBe(workspacePath);
		const path = await folder("workspace/p");
		const project = await registry.link(path, { initialize: true, workspaceId: workspace.id });
		const moved = join(root, "escaped");
		await fs.rename(path, moved);
		await fs.symlink(moved, path, "dir");
		await expect(registry.resolve(project.id)).rejects.toMatchObject({ code: "INVALID_PATH" });
		await fs.unlink(path);
		await fs.symlink(join(root, "gone"), path, "dir");
		await expect(registry.resolve(project.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
	});

	it("never substitutes another root when a workspace marker changes", async () => {
		const path = await folder("workspace");
		const workspace = await registry.connect(path, { initialize: true });
		const projectPath = await folder("workspace/p");
		const project = await registry.link(projectPath, { initialize: true, workspaceId: workspace.id });
		await marker(path, "workspace", OTHER);
		await expect(registry.resolve(project.id)).rejects.toMatchObject({ code: "CONFLICT" });
		expect((await registry.status()).workspaces[0].available).toBe(false);
	});

	it("rejects invalid runtime options and full-ID requirements before writing metadata", async () => {
		const path = await folder("p");
		await expect(registry.link(path, { initialize: true, projectId: PROJECT })).rejects.toMatchObject({
			code: "CONFLICT",
		});
		await expect(registry.link(path, { initialize: "yes" as unknown as boolean })).rejects.toBeInstanceOf(
			CloudWorkspaceError,
		);
		await expect(registry.link(path, { projectId: "11111111" })).rejects.toMatchObject({ code: "INVALID_METADATA" });
		await expect(registry.link(path, { projectId: PROJECT, workspaceId: "missing" })).rejects.toMatchObject({
			code: "INVALID_METADATA",
		});
		await expect(fs.stat(registry.path)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("portable relative directory syntax", () => {
	it.each([".", "projects/Alpha", "Résumé notes/子目录"])("preserves %j without host normalization", (path) => {
		expect(portableRelativePath(path)).toBe(path);
	});
	it.each([
		"",
		"..",
		"a/..",
		"a/./b",
		"/absolute",
		"a//b",
		"C:\\root",
		"C:root",
		"\\\\host\\share",
		"a\\b",
		"a\0b",
		"a/",
	])("rejects %j", (path) => {
		expect(() => portableRelativePath(path)).toThrow(CloudWorkspaceError);
	});
});
