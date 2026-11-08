// @vitest-environment jsdom
import { render } from "solid-js/web/dist/web.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/api.js", () => ({
	api: {
		cloudWorkspaces: vi.fn(),
		connectWorkspace: vi.fn(),
		linkProject: vi.fn(),
		rebindWorkspace: vi.fn(),
		rebindProject: vi.fn(),
		unlinkProject: vi.fn(),
		disconnectWorkspace: vi.fn(),
	},
}));

import { api } from "../../src/client/api.js";
import { CloudWorkspacesScreen } from "../../src/client/screens/cloud-workspaces.js";
import type { AppStore } from "../../src/client/state/store.js";
import type { CloudWorkspacesDto } from "../../src/shared/protocol.js";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceZ = "99999999-9999-4999-8999-999999999999";
const projectA = "22222222-2222-4222-8222-222222222222";
const projectZ = "88888888-8888-4888-8888-888888888888";
const empty: CloudWorkspacesDto = { version: 1, pathStyle: "posix", workspaces: [], projects: [] };
const populated: CloudWorkspacesDto = {
	...empty,
	workspaces: [
		{
			id: workspaceZ,
			path: "/configured/z",
			status: { available: false, error: { code: "UNAVAILABLE", message: "Marker has not arrived" } },
		},
		{ id: workspaceA, path: "/configured/a", status: { available: true, path: "/canonical/a" } },
	],
	projects: [
		{
			id: projectZ,
			location: { kind: "workspace", workspaceId: workspaceZ, relativePath: "apps/a very long project" },
			markerRequired: true,
			status: {
				available: false,
				error: { code: "CONFLICT", message: "Expected marker identity differs from target" },
			},
		},
		{
			id: projectA,
			location: { kind: "local", path: "/outside/cloud" },
			markerRequired: false,
			status: { available: true, path: "/canonical/project" },
		},
	],
};
const disposers: Array<() => void> = [];

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

async function settle() {
	for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const store = {
		auth: () => ({ mode: "local" }),
		sessions: {},
		fleet: () => ({ runtimes: [] }),
		resyncing: () => false,
		connection: () => ({ state: "connected" }),
		resyncError: () => undefined,
	} as unknown as AppStore;
	const dispose = render(() => <CloudWorkspacesScreen store={store} />, host);
	disposers.push(dispose);
	return { host, dispose };
}

function text() {
	return document.body.textContent ?? "";
}

function field<T extends HTMLInputElement | HTMLSelectElement = HTMLInputElement>(
	name: string,
	scope: ParentNode = document,
): T {
	const label = Array.from(scope.querySelectorAll("label")).find((candidate) =>
		candidate.textContent?.startsWith(name),
	);
	const control = label?.querySelector("input, select");
	if (!control) throw new Error(`Missing field: ${name}`);
	return control as T;
}

function enter(name: string, value: string, scope: ParentNode = document) {
	const control = field(name, scope);
	control.value = value;
	control.dispatchEvent(new Event(control.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
}

function button(name: string, scope: ParentNode = document) {
	const control = Array.from(scope.querySelectorAll("button")).find((candidate) => candidate.textContent === name);
	if (!control) throw new Error(`Missing button: ${name}`);
	return control;
}

function form(name: string): HTMLFormElement {
	const element = document.querySelector<HTMLFormElement>(`form[aria-label="${name}"]`);
	if (!element) throw new Error(`Missing form: ${name}`);
	return element;
}

function submit(name: string) {
	form(name).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function row(kind: "Workspace" | "Project", id: string) {
	const element = document.querySelector<HTMLElement>(`article[aria-label="${kind} ${id}"]`);
	if (!element) throw new Error(`Missing row: ${id}`);
	return element;
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.spyOn(console, "warn");
	vi.mocked(api.cloudWorkspaces).mockResolvedValue(empty);
	vi.mocked(api.connectWorkspace).mockResolvedValue({ id: workspaceA, path: "/workspace" });
	vi.mocked(api.linkProject).mockResolvedValue({ id: projectA });
	vi.mocked(api.rebindWorkspace).mockResolvedValue({ id: workspaceA, path: "/new" });
	vi.mocked(api.rebindProject).mockResolvedValue({ id: projectA });
	vi.mocked(api.unlinkProject).mockResolvedValue({ removed: true });
	vi.mocked(api.disconnectWorkspace).mockResolvedValue({ removed: true });
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	document.body.replaceChildren();
	const warnings = vi.mocked(console.warn).mock.calls;
	vi.restoreAllMocks();
	expect(warnings).toEqual([]);
});

describe("CloudWorkspacesScreen metadata management", () => {
	it("separates loading from truly empty and explains host, initialization and metadata boundaries", async () => {
		const load = deferred<CloudWorkspacesDto>();
		vi.mocked(api.cloudWorkspaces).mockReturnValue(load.promise);
		mount();
		expect(text()).toContain("Loading metadata…");
		expect(text()).not.toContain("No registered workspaces");
		expect(field("Workspace absolute host path").matches(":disabled")).toBe(true);
		load.resolve(empty);
		await settle();
		expect(text()).not.toContain("Loading metadata…");
		expect(text()).toContain("No registered workspaces or projects");
		expect(text()).toContain("Local workflows need no registration");
		expect(text()).toContain("computer running the backend, not your phone or browser");
		expect(text()).toContain("do not synchronize code or sessions, grant trust, or make sessions portable");
		expect(text()).toContain("only after its marker arrives");
		expect(document.querySelector('main a[href="#/settings"]')?.textContent).toBe("Back to Settings");
		expect(document.querySelector('nav a[aria-current="page"]')?.getAttribute("href")).toBe("#/settings");
		// The API mock deliberately has no settings, provider, files or runtime methods.
		expect(api.cloudWorkspaces).toHaveBeenCalledTimes(1);
	});

	it("does not turn a failed first load into an empty registry and permits explicit retry", async () => {
		vi.mocked(api.cloudWorkspaces).mockRejectedValueOnce(
			Object.assign(new Error("Corrupt registry"), { body: { code: "INVALID_METADATA" } }),
		);
		mount();
		await settle();
		expect(text()).toContain("Could not load metadata: INVALID_METADATA: Corrupt registry");
		expect(text()).not.toContain("No registered workspaces");
		button("Refresh metadata").click();
		await settle();
		expect(text()).toContain("No registered workspaces or projects");
		expect(text()).not.toContain("Could not load metadata");
	});

	it.each(["posix", "windows"] as const)(
		"uses the backend %s path style rather than browser paths",
		async (pathStyle) => {
			vi.mocked(api.cloudWorkspaces).mockResolvedValue({ ...empty, pathStyle });
			mount();
			await settle();
			expect(field("Workspace absolute host path").placeholder).toBe(
				pathStyle === "windows" ? "C:\\Users\\you\\Projects" : "/home/you/projects",
			);
			expect(field("Project absolute host path").placeholder).toBe(
				field("Workspace absolute host path").placeholder,
			);
		},
	);

	it.each([false, true])(
		"connects with exact explicit initialize=%s payload and preserves the path",
		async (initialize) => {
			mount();
			await settle();
			expect(field<HTMLSelectElement>("Workspace identity mode").value).toBe("existing");
			enter("Workspace absolute host path", "/host/workspace");
			if (initialize) enter("Workspace identity mode", "initialize");
			submit("Connect workspace");
			await settle();
			expect(api.connectWorkspace).toHaveBeenCalledExactlyOnceWith({
				path: "/host/workspace",
				...(initialize ? { initialize: true } : {}),
			});
			expect(field("Workspace absolute host path").value).toBe("/host/workspace");
			expect(text()).toContain("Workspace connected successfully");
		},
	);

	it.each([
		["existing", false],
		["initialize", false],
		["known", false],
		["existing", true],
		["initialize", true],
		["known", true],
	] as const)("links mode=%s workspace-relative=%s using only the exact selected options", async (mode, relative) => {
		vi.mocked(api.cloudWorkspaces).mockResolvedValue(populated);
		mount();
		await settle();
		expect(field<HTMLSelectElement>("Project identity mode").value).toBe("existing");
		expect(field<HTMLSelectElement>("Project binding").value).toBe("");
		expect(text()).not.toContain("Known full project ID");
		enter("Project absolute host path", "/host/project");
		enter("Project identity mode", mode);
		if (mode === "known") enter("Known full project ID", projectA);
		if (relative) enter("Project binding", workspaceA);
		submit("Link project");
		await settle();
		expect(api.linkProject).toHaveBeenCalledExactlyOnceWith({
			path: "/host/project",
			...(mode === "initialize" ? { initialize: true } : {}),
			...(mode === "known" ? { projectId: projectA } : {}),
			...(relative ? { workspaceId: workspaceA } : {}),
		});
		expect(text()).toContain("Project linked successfully");
	});

	it("never carries a hidden known ID into initialize or existing-marker mode", async () => {
		mount();
		await settle();
		enter("Project absolute host path", "/host/project");
		enter("Project identity mode", "known");
		enter("Known full project ID", projectA);
		enter("Project identity mode", "initialize");
		expect(text()).not.toContain("Known full project ID");
		submit("Link project");
		await settle();
		expect(api.linkProject).toHaveBeenLastCalledWith({ path: "/host/project", initialize: true });
		enter("Project identity mode", "existing");
		submit("Link project");
		await settle();
		expect(api.linkProject).toHaveBeenLastCalledWith({ path: "/host/project" });
	});

	it("shows full IDs in stable order, configured relationships, marker requirements and full availability errors", async () => {
		vi.mocked(api.cloudWorkspaces).mockResolvedValue(populated);
		mount();
		await settle();
		expect(Array.from(document.querySelectorAll("article h3"), (element) => element.textContent)).toEqual([
			workspaceA,
			workspaceZ,
			projectA,
			projectZ,
		]);
		expect(row("Workspace", workspaceA).textContent).toContain("Configured host path: /configured/a");
		expect(row("Workspace", workspaceA).textContent).toContain("Available — canonical host path: /canonical/a");
		expect(row("Workspace", workspaceZ).textContent).toContain("Unavailable — UNAVAILABLE: Marker has not arrived");
		expect(row("Project", projectA).textContent).toContain("Configured local path: /outside/cloud");
		expect(row("Project", projectA).textContent).toContain("Marker required: no (known-ID markerless binding)");
		expect(row("Project", projectZ).textContent).toContain(
			`Workspace ID: ${workspaceZ} — relative path: apps/a very long project`,
		);
		expect(row("Project", projectZ).textContent).toContain("Marker required: yes");
		expect(row("Project", projectZ).textContent).toContain("CONFLICT: Expected marker identity differs from target");
		expect(populated.workspaces[0]?.id).toBe(workspaceZ); // Sorting does not mutate the DTO.
	});

	it("edits and cancels a workspace rebind, then saves only the captured same-ID and path", async () => {
		vi.mocked(api.cloudWorkspaces).mockResolvedValue(populated);
		mount();
		await settle();
		button("Rebind workspace", row("Workspace", workspaceA)).click();
		expect(form(`Rebind ${workspaceA}`).textContent).toContain(`Rebind the same identity: ${workspaceA}`);
		expect(form(`Rebind ${workspaceA}`).textContent).toContain("No replacement identity is initialized");
		enter("New absolute host path", "/cancelled");
		button("Cancel rebind").click();
		expect(api.rebindWorkspace).not.toHaveBeenCalled();
		button("Rebind workspace", row("Workspace", workspaceA)).click();
		enter("New absolute host path", "/moved/workspace");
		submit(`Rebind ${workspaceA}`);
		await settle();
		expect(api.rebindWorkspace).toHaveBeenCalledExactlyOnceWith(workspaceA, "/moved/workspace");
		expect(document.querySelector(`form[aria-label="Rebind ${workspaceA}"]`)).toBeNull();
	});

	it.each([false, true])(
		"rebinds the captured project ID with explicit workspace-relative=%s and no initialization",
		async (relative) => {
			vi.mocked(api.cloudWorkspaces).mockResolvedValue(populated);
			mount();
			await settle();
			button("Rebind project", row("Project", projectZ)).click();
			const editor = form(`Rebind ${projectZ}`);
			expect(field<HTMLSelectElement>("Project binding", editor).value).toBe(workspaceZ);
			expect(field("New absolute host path", editor).value).toBe("");
			enter("New absolute host path", "/moved/project", editor);
			enter("Project binding", relative ? workspaceA : "", editor);
			submit(`Rebind ${projectZ}`);
			await settle();
			expect(api.rebindProject).toHaveBeenCalledExactlyOnceWith(projectZ, {
				path: "/moved/project",
				...(relative ? { workspaceId: workspaceA } : {}),
			});
		},
	);

	it("keeps a disconnected workspace binding explicit in a project repair editor", async () => {
		vi.mocked(api.cloudWorkspaces).mockResolvedValue({ ...populated, workspaces: [] });
		mount();
		await settle();
		button("Rebind project", row("Project", projectZ)).click();
		const binding = field<HTMLSelectElement>("Project binding", form(`Rebind ${projectZ}`));
		expect(binding.value).toBe(workspaceZ);
		expect(binding.selectedOptions[0]?.textContent).toBe(`Disconnected workspace — ${workspaceZ}`);
	});

	it.each(["workspace", "project"] as const)(
		"requires explicit inline %s removal confirmation with exact identity and byte-preservation copy",
		async (kind) => {
			const confirm = vi.spyOn(window, "confirm");
			vi.mocked(api.cloudWorkspaces).mockResolvedValue(populated);
			mount();
			await settle();
			const id = kind === "workspace" ? workspaceZ : projectZ;
			const label = kind === "workspace" ? "Disconnect workspace" : "Unlink project";
			const target = row(kind === "workspace" ? "Workspace" : "Project", id);
			button(label, target).click();
			expect(api.disconnectWorkspace).not.toHaveBeenCalled();
			expect(api.unlinkProject).not.toHaveBeenCalled();
			expect(target.querySelector(".cloud-confirmation")?.textContent).toContain(id);
			expect(text()).toContain("preserves the folder, marker, session bytes and cloud content");
			if (kind === "workspace")
				expect(text()).toContain("Dependent project identities remain visible but unavailable");
			button("Cancel removal").click();
			expect(document.querySelector(".cloud-confirmation")).toBeNull();
			button(label, target).click();
			button(kind === "workspace" ? "Confirm disconnect" : "Confirm unlink").click();
			await settle();
			expect(kind === "workspace" ? api.disconnectWorkspace : api.unlinkProject).toHaveBeenCalledExactlyOnceWith(id);
			expect(confirm).not.toHaveBeenCalled();
			confirm.mockRestore();
		},
	);

	it("guards every mutation synchronously across forms and disables actions and refresh until reload completes", async () => {
		vi.mocked(api.cloudWorkspaces).mockResolvedValue(populated);
		const write = deferred<{ id: string; path: string }>();
		vi.mocked(api.connectWorkspace).mockReturnValue(write.promise);
		mount();
		await settle();
		enter("Workspace absolute host path", "/workspace");
		enter("Project absolute host path", "/project");
		submit("Connect workspace");
		submit("Connect workspace");
		submit("Link project"); // Synthetic submit deliberately bypasses disabled controls.
		button("Refresh metadata").click();
		button("Rebind project", row("Project", projectA)).click();
		button("Disconnect workspace", row("Workspace", workspaceA)).click();
		expect(api.connectWorkspace).toHaveBeenCalledTimes(1);
		expect(api.linkProject).not.toHaveBeenCalled();
		expect(api.cloudWorkspaces).toHaveBeenCalledTimes(1);
		for (const control of document.querySelectorAll("main button, main input, main select"))
			expect(control.matches(":disabled")).toBe(true);
		const reload = deferred<CloudWorkspacesDto>();
		vi.mocked(api.cloudWorkspaces).mockReturnValueOnce(reload.promise);
		write.resolve({ id: workspaceA, path: "/workspace" });
		await settle();
		expect(text()).toContain("Workspace connected successfully");
		expect(button("Refresh metadata").disabled).toBe(true);
		submit("Link project");
		expect(api.linkProject).not.toHaveBeenCalled();
		reload.resolve(populated);
		await settle();
		expect(button("Refresh metadata").disabled).toBe(false);
	});

	it.each(["CONFLICT", "PARTIAL_INITIALIZATION"])(
		"retains inputs and rows on failed write with %s and appropriate retry guidance",
		async (code) => {
			vi.mocked(api.cloudWorkspaces).mockResolvedValue(populated);
			vi.mocked(api.linkProject).mockRejectedValueOnce(
				Object.assign(new Error("Could not persist identity"), { body: { code } }),
			);
			mount();
			await settle();
			enter("Project absolute host path", "/keep/project");
			enter("Project identity mode", "known");
			enter("Known full project ID", projectA);
			enter("Project binding", workspaceA);
			submit("Link project");
			await settle();
			expect(text()).toContain(`Mutation failed: ${code}: Could not persist identity`);
			expect(field("Project absolute host path").value).toBe("/keep/project");
			expect(field("Known full project ID").value).toBe(projectA);
			expect(field<HTMLSelectElement>("Project binding").value).toBe(workspaceA);
			expect(row("Workspace", workspaceA)).toBeTruthy();
			expect(api.cloudWorkspaces).toHaveBeenCalledTimes(1);
			expect(button("Refresh metadata").disabled).toBe(false);
			if (code === "PARTIAL_INITIALIZATION") {
				expect(text()).toContain("A marker may already have been written");
				expect(text()).toContain("retry the same operation");
				expect(text()).toContain("Do not initialize a replacement identity");
			}
		},
	);

	it("retains the rebind editor and entered path on failure without changing the target identity", async () => {
		vi.mocked(api.cloudWorkspaces).mockResolvedValue(populated);
		vi.mocked(api.rebindWorkspace).mockRejectedValueOnce(
			Object.assign(new Error("Wrong marker"), { body: { code: "CONFLICT" } }),
		);
		mount();
		await settle();
		button("Rebind workspace", row("Workspace", workspaceZ)).click();
		enter("New absolute host path", "/keep/rebind");
		submit(`Rebind ${workspaceZ}`);
		await settle();
		expect(field("New absolute host path").value).toBe("/keep/rebind");
		expect(text()).toContain("CONFLICT: Wrong marker");
		submit(`Rebind ${workspaceZ}`);
		await settle();
		expect(api.rebindWorkspace).toHaveBeenNthCalledWith(2, workspaceZ, "/keep/rebind");
	});

	it("retains a removal confirmation on failed removal and does not silently retry", async () => {
		vi.mocked(api.cloudWorkspaces).mockResolvedValue(populated);
		vi.mocked(api.unlinkProject).mockRejectedValueOnce(
			Object.assign(new Error("Storage is read-only"), { body: { code: "IO_ERROR" } }),
		);
		mount();
		await settle();
		button("Unlink project", row("Project", projectA)).click();
		button("Confirm unlink").click();
		await settle();
		expect(text()).toContain("IO_ERROR: Storage is read-only");
		expect(document.querySelector(".cloud-confirmation")?.textContent).toContain(projectA);
		expect(api.unlinkProject).toHaveBeenCalledTimes(1);
		expect(api.cloudWorkspaces).toHaveBeenCalledTimes(1);
	});

	it("keeps last-good rows visible during refresh and marks them stale after refresh failure", async () => {
		vi.mocked(api.cloudWorkspaces).mockResolvedValueOnce(populated);
		mount();
		await settle();
		const refresh = deferred<CloudWorkspacesDto>();
		vi.mocked(api.cloudWorkspaces).mockReturnValueOnce(refresh.promise);
		button("Refresh metadata").click();
		expect(text()).toContain("Refreshing metadata; showing last-good snapshot");
		expect(row("Project", projectZ)).toBeTruthy();
		refresh.reject(Object.assign(new Error("Metadata unreadable"), { body: { code: "IO_ERROR" } }));
		await settle();
		expect(text()).toContain("Refresh failed. Last-good metadata is stale: IO_ERROR: Metadata unreadable");
		expect(row("Project", projectZ)).toBeTruthy();
		expect(text()).not.toContain("No registered workspaces");
		button("Refresh metadata").click();
		await settle();
		expect(text()).toContain("No registered workspaces");
		expect(text()).not.toContain("Last-good metadata is stale");
	});

	it("reports successful mutation plus failed reload separately, retaining rows without retrying the write", async () => {
		vi.mocked(api.cloudWorkspaces)
			.mockResolvedValueOnce(populated)
			.mockRejectedValueOnce(new Error("Reload disconnected"));
		mount();
		await settle();
		enter("Workspace absolute host path", "/workspace");
		submit("Connect workspace");
		await settle();
		expect(text()).toContain("Workspace connected successfully");
		expect(text()).toContain("Refresh failed. Last-good metadata is stale: Reload disconnected");
		expect(text()).not.toContain("Mutation failed");
		expect(row("Workspace", workspaceA)).toBeTruthy();
		expect(api.connectWorkspace).toHaveBeenCalledTimes(1);
		expect(api.cloudWorkspaces).toHaveBeenCalledTimes(2);
		button("Refresh metadata").click();
		await settle();
		expect(api.connectWorkspace).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])("ignores an obsolete overlapping load (old rejection=%s)", async (rejectOld) => {
		const older = deferred<CloudWorkspacesDto>();
		const newer = deferred<CloudWorkspacesDto>();
		vi.mocked(api.cloudWorkspaces).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
		mount();
		button("Refresh metadata").click();
		newer.resolve(populated);
		await settle();
		if (rejectOld) older.reject(new Error("Obsolete failure"));
		else older.resolve(empty);
		await settle();
		expect(row("Project", projectA)).toBeTruthy();
		expect(text()).not.toContain("Obsolete failure");
		expect(text()).not.toContain("No registered workspaces");
	});

	it("invalidates a pre-mutation refresh so it cannot overwrite the post-write snapshot", async () => {
		const older = deferred<CloudWorkspacesDto>();
		vi.mocked(api.cloudWorkspaces)
			.mockResolvedValueOnce(populated)
			.mockReturnValueOnce(older.promise)
			.mockResolvedValueOnce(empty);
		mount();
		await settle();
		button("Refresh metadata").click();
		enter("Workspace absolute host path", "/workspace");
		submit("Connect workspace");
		await settle();
		expect(text()).toContain("No registered workspaces");
		older.resolve(populated);
		await settle();
		expect(document.querySelectorAll("article")).toHaveLength(0);
		expect(text()).toContain("Workspace connected successfully");
	});

	it.each([false, true])("ignores a late initial load after disposal (rejection=%s)", async (rejectLoad) => {
		const load = deferred<CloudWorkspacesDto>();
		vi.mocked(api.cloudWorkspaces).mockReturnValueOnce(load.promise);
		const view = mount();
		view.dispose();
		if (rejectLoad) load.reject(new Error("Late read failure"));
		else load.resolve(populated);
		await settle();
		expect(view.host.textContent).toBe("");
		expect(api.cloudWorkspaces).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		"ignores late writes after disposal without triggering a reload (rejection=%s)",
		async (rejectWrite) => {
			const write = deferred<{ id: string }>();
			vi.mocked(api.linkProject).mockReturnValueOnce(write.promise);
			const view = mount();
			await settle();
			enter("Project absolute host path", "/project");
			submit("Link project");
			view.dispose();
			if (rejectWrite) write.reject(new Error("Late mutation failure"));
			else write.resolve({ id: projectA });
			await settle();
			expect(view.host.textContent).toBe("");
			expect(api.cloudWorkspaces).toHaveBeenCalledTimes(1);
		},
	);
});
