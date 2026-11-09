// @vitest-environment jsdom
import { render } from "solid-js/web/dist/web.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/api.js", () => ({
	api: {
		cloudWorkspaces: vi.fn(),
		cloudFolders: vi.fn(),
		cloudSessionStorage: vi.fn(),
		saveCloudSessionStorage: vi.fn(),
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
import type { CloudSessionStorageDto, CloudWorkspacesDto } from "../../src/shared/protocol.js";

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
const localStorage: CloudSessionStorageDto = {
	sessionDir: null,
	subagentSessionDir: null,
	subdirectories: { sessionDir: ".dreb/sessions", subagentSessionDir: ".dreb/subagent-sessions" },
	restartRequired: false,
};
const customStorage: CloudSessionStorageDto = {
	...localStorage,
	sessionDir: "/old/main",
	subagentSessionDir: "relative/old-subagents",
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
	const advanced = control.closest<HTMLDetailsElement>(".cloud-advanced");
	if (advanced) advanced.open = true;
	control.value = value;
	control.dispatchEvent(new Event(control.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
}

function button(name: string, scope: ParentNode = document) {
	const control = Array.from(scope.querySelectorAll("button")).find((candidate) => candidate.textContent === name);
	if (!control) throw new Error(`Missing button: ${name}`);
	const advanced = control.closest<HTMLDetailsElement>(".cloud-advanced");
	if (advanced) advanced.open = true;
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
	vi.mocked(api.cloudFolders).mockResolvedValue({
		path: "/chosen folder ",
		parent: "/",
		entries: [],
		truncated: false,
	});
	vi.mocked(api.cloudSessionStorage).mockResolvedValue(localStorage);
	vi.mocked(api.saveCloudSessionStorage).mockResolvedValue({
		...localStorage,
		sessionDir: "/logs/.dreb/sessions",
		subagentSessionDir: "/logs/.dreb/subagent-sessions",
		restartRequired: true,
	});
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

function failure(code: string) {
	return Object.assign(new Error("Synthetic failure"), { body: { code } });
}

function storeLogs(root = "/logs") {
	enter("Folder path on this computer", root);
	button("Store session logs here").click();
}

describe("CloudWorkspacesScreen host-folder picker", () => {
	it("keeps paste/focus freely editable and does not browse until explicitly opened", async () => {
		mount();
		await settle();
		enter("Folder path on this computer", "/pasted path ");
		field("Folder path on this computer").focus();
		field("Folder path on this computer").click();
		expect(api.cloudFolders).not.toHaveBeenCalled();
		button("Browse folders…").click();
		await settle();
		expect(api.cloudFolders).toHaveBeenCalledExactlyOnceWith("/pasted path ", expect.any(AbortSignal));
		button("Choose folder").click();
		expect(field("Folder path on this computer").value).toBe("/chosen folder ");
		expect(document.querySelector("[role=dialog]")).toBeNull();
		expect(api.linkProject).not.toHaveBeenCalled();
		expect(api.connectWorkspace).not.toHaveBeenCalled();
		expect(api.saveCloudSessionStorage).not.toHaveBeenCalled();
	});

	it("cancels without altering the pasted path or pending consent", async () => {
		mount();
		await settle();
		storeLogs("/keep this path ");
		button("Browse folders…").click();
		await settle();
		button("Cancel folder selection").click();
		expect(field("Folder path on this computer").value).toBe("/keep this path ");
		expect(document.querySelector(".cloud-confirmation")).not.toBeNull();
		expect(api.saveCloudSessionStorage).not.toHaveBeenCalled();
	});

	it.each(["setup", "logs"] as const)(
		"a chosen folder invalidates pending %s confirmation without writing",
		async (consent) => {
			mount();
			await settle();
			if (consent === "setup") {
				vi.mocked(api.linkProject).mockRejectedValueOnce(failure("NOT_FOUND"));
				enter("Folder path on this computer", "/original");
				submit("Connect folder");
				await settle();
			} else storeLogs("/original");
			expect(document.querySelector(".cloud-confirmation")).not.toBeNull();
			button("Browse folders…").click();
			await settle();
			button("Choose folder").click();
			expect(document.querySelector(".cloud-confirmation")).toBeNull();
			expect(field("Folder path on this computer").value).toBe("/chosen folder ");
			expect(api.linkProject).toHaveBeenCalledTimes(consent === "setup" ? 1 : 0);
			expect(api.saveCloudSessionStorage).not.toHaveBeenCalled();
		},
	);

	it("closes and aborts read-only browsing if a guarded metadata mutation begins", async () => {
		const listing = deferred<Awaited<ReturnType<typeof api.cloudFolders>>>();
		vi.mocked(api.cloudFolders).mockReturnValueOnce(listing.promise);
		mount();
		await settle();
		enter("Folder path on this computer", "/project");
		button("Browse folders…").click();
		const signal = vi.mocked(api.cloudFolders).mock.calls[0][1]!;
		submit("Connect folder");
		await settle();
		expect(document.querySelector("[role=dialog]")).toBeNull();
		expect(signal.aborted).toBe(true);
		listing.resolve({ path: "/late", parent: "/", entries: [], truncated: false });
		await settle();
		expect(field("Folder path on this computer").value).toBe("/project");
	});
});

describe("CloudWorkspacesScreen one-folder setup", () => {
	it("defaults to one path input and closed native advanced forms without writing settings", async () => {
		mount();
		await settle();
		const advanced = document.querySelector<HTMLDetailsElement>(".cloud-advanced")!;
		expect(advanced.open).toBe(false);
		expect(advanced.querySelector("summary")?.textContent).toBe("advanced setup");
		expect(advanced.contains(form("Connect workspace"))).toBe(true);
		expect(advanced.contains(form("Link project"))).toBe(true);
		expect(advanced.querySelector('[aria-label="Registered workspaces"]')).not.toBeNull();
		expect(form("Connect folder").querySelectorAll("input")).toHaveLength(1);
		expect(form("Connect folder").querySelector("select")).toBeNull();
		expect(text()).toContain("Projects may remain elsewhere");
		expect(api.cloudSessionStorage).toHaveBeenCalledOnce();
		expect(api.saveCloudSessionStorage).not.toHaveBeenCalled();
	});

	it("connects an existing folder identity without workspace or storage writes and preserves literal whitespace", async () => {
		mount();
		await settle();
		enter("Folder path on this computer", "/host/folder with trailing space ");
		submit("Connect folder");
		await settle();
		expect(api.linkProject).toHaveBeenCalledExactlyOnceWith({ path: "/host/folder with trailing space " });
		expect(api.connectWorkspace).not.toHaveBeenCalled();
		expect(api.saveCloudSessionStorage).not.toHaveBeenCalled();
		expect(text()).toContain("Folder connected successfully: /host/folder with trailing space ");
		expect(text()).not.toContain("Set up this folder for the first time?");
	});

	it("handles only NOT_FOUND as first-use and requires explicit captured-path confirmation", async () => {
		vi.mocked(api.linkProject).mockRejectedValueOnce(failure("NOT_FOUND"));
		mount();
		await settle();
		enter("Folder path on this computer", "/host/first ");
		submit("Connect folder");
		await settle();
		expect(text()).toContain("Set up this folder for the first time?");
		expect(text()).toContain("wait for its synced identity to arrive");
		expect(document.querySelector(".cloud-confirmation")?.textContent).toContain("/host/first ");
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(api.linkProject).toHaveBeenCalledTimes(1);
		button("Set up folder").click();
		expect(text()).not.toContain("Set up this folder for the first time?");
		await settle();
		expect(api.linkProject).toHaveBeenNthCalledWith(2, { path: "/host/first ", initialize: true });
		expect(api.connectWorkspace).not.toHaveBeenCalled();
	});

	it.each(["cancel", "edit"] as const)("invalidates first-use consent on %s without initializing", async (action) => {
		vi.mocked(api.linkProject).mockRejectedValue(failure("NOT_FOUND"));
		mount();
		await settle();
		enter("Folder path on this computer", "/first");
		submit("Connect folder");
		await settle();
		if (action === "cancel") button("Cancel setup").click();
		else enter("Folder path on this computer", "/other");
		expect(text()).not.toContain("Set up this folder for the first time?");
		expect(api.linkProject).toHaveBeenCalledExactlyOnceWith({ path: "/first" });
	});

	it.each(["INVALID_METADATA", "CONFLICT", "IO_ERROR", "UNAVAILABLE", "NOT_FOUND_OTHER"])(
		"never offers initialization for %s",
		async (code) => {
			vi.mocked(api.linkProject).mockRejectedValueOnce(failure(code));
			mount();
			await settle();
			enter("Folder path on this computer", "/existing");
			submit("Connect folder");
			await settle();
			expect(text()).toContain(`Mutation failed: ${code}:`);
			expect(text()).not.toContain("Set up this folder for the first time?");
			expect(api.linkProject).toHaveBeenCalledExactlyOnceWith({ path: "/existing" });
			expect(api.rebindProject).not.toHaveBeenCalled();
		},
	);

	it("does not infer first-use from an HTTP status or error message", async () => {
		vi.mocked(api.linkProject).mockRejectedValueOnce(Object.assign(new Error("NOT_FOUND"), { status: 404 }));
		mount();
		await settle();
		enter("Folder path on this computer", "/existing");
		submit("Connect folder");
		await settle();
		expect(text()).toContain("Mutation failed: NOT_FOUND");
		expect(text()).not.toContain("Set up this folder for the first time?");
	});

	it("dismisses initialization before a partial failure and retries only via normal Connect", async () => {
		vi.mocked(api.linkProject)
			.mockRejectedValueOnce(failure("NOT_FOUND"))
			.mockRejectedValueOnce(failure("PARTIAL_INITIALIZATION"));
		mount();
		await settle();
		enter("Folder path on this computer", "/first");
		submit("Connect folder");
		await settle();
		button("Set up folder").click();
		await settle();
		expect(text()).toContain("A marker may already have been written");
		expect(text()).not.toContain("Set up this folder for the first time?");
		expect(field("Folder path on this computer").value).toBe("/first");
		submit("Connect folder");
		await settle();
		expect(vi.mocked(api.linkProject).mock.calls.map(([body]) => body)).toEqual([
			{ path: "/first" },
			{ path: "/first", initialize: true },
			{ path: "/first" },
		]);
	});

	it.each(["/outside/cloud", "/canonical/project", "/configured/z/apps/a very long project"])(
		"preserves a known markerless/grouped identity for exact path %s",
		async (path) => {
			vi.mocked(api.cloudWorkspaces).mockResolvedValue(populated);
			mount();
			await settle();
			enter("Folder path on this computer", path);
			submit("Connect folder");
			await settle();
			expect(api.linkProject).toHaveBeenCalledExactlyOnceWith({
				path,
				projectId: path.startsWith("/configured/z") ? projectZ : projectA,
				...(path.startsWith("/configured/z") ? { workspaceId: workspaceZ } : {}),
			});
			expect(api.connectWorkspace).not.toHaveBeenCalled();
			expect(api.rebindProject).not.toHaveBeenCalled();
		},
	);

	it("preserves an available canonical grouped binding and does not match merely similar paths", async () => {
		vi.mocked(api.cloudWorkspaces).mockResolvedValue({
			...populated,
			projects: [{ ...populated.projects[0]!, status: { available: true, path: "/canonical/grouped" } }],
		});
		mount();
		await settle();
		enter("Folder path on this computer", "/canonical/grouped");
		submit("Connect folder");
		await settle();
		expect(api.linkProject).toHaveBeenNthCalledWith(1, {
			path: "/canonical/grouped",
			projectId: projectZ,
			workspaceId: workspaceZ,
		});
		enter("Folder path on this computer", "/canonical/grouped ");
		submit("Connect folder");
		await settle();
		expect(api.linkProject).toHaveBeenNthCalledWith(2, { path: "/canonical/grouped " });
	});

	it.each([false, true])("ignores late basic Connect completion after disposal (rejected=%s)", async (reject) => {
		const write = deferred<{ id: string }>();
		vi.mocked(api.linkProject).mockReturnValueOnce(write.promise);
		const view = mount();
		await settle();
		enter("Folder path on this computer", "/first");
		submit("Connect folder");
		view.dispose();
		if (reject) write.reject(failure("NOT_FOUND"));
		else write.resolve({ id: projectA });
		await settle();
		expect(view.host.textContent).toBe("");
		expect(api.cloudWorkspaces).toHaveBeenCalledTimes(1);
		expect(api.linkProject).toHaveBeenCalledExactlyOnceWith({ path: "/first" });
	});

	it("joins straightforward native Windows workspace paths without trimming", async () => {
		vi.mocked(api.cloudWorkspaces).mockResolvedValue({
			...empty,
			pathStyle: "windows",
			workspaces: [{ id: workspaceA, path: "C:\\cloud", status: { available: true, path: "C:\\cloud" } }],
			projects: [
				{
					id: projectA,
					markerRequired: false,
					location: { kind: "workspace", workspaceId: workspaceA, relativePath: "apps/project " },
					status: { available: false, error: { code: "UNAVAILABLE", message: "Offline" } },
				},
			],
		});
		mount();
		await settle();
		enter("Folder path on this computer", "C:\\cloud\\apps\\project ");
		submit("Connect folder");
		await settle();
		expect(api.linkProject).toHaveBeenCalledExactlyOnceWith({
			path: "C:\\cloud\\apps\\project ",
			projectId: projectA,
			workspaceId: workspaceA,
		});
	});

	it("guards basic repeated submits and every other action while connecting", async () => {
		const write = deferred<{ id: string }>();
		vi.mocked(api.linkProject).mockReturnValueOnce(write.promise);
		mount();
		await settle();
		storeLogs();
		submit("Connect folder");
		submit("Connect folder");
		submit("Connect workspace");
		submit("Link project");
		button("Save log locations").dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(api.linkProject).toHaveBeenCalledTimes(1);
		expect(api.connectWorkspace).not.toHaveBeenCalled();
		expect(api.saveCloudSessionStorage).not.toHaveBeenCalled();
		for (const control of document.querySelectorAll("main button, main input, main select"))
			expect(control.matches(":disabled")).toBe(true);
		write.resolve({ id: projectA });
		await settle();
	});
});

describe("CloudWorkspacesScreen independent global session storage", () => {
	it("shows configured/default paths and loads independently of a failed metadata registry", async () => {
		vi.mocked(api.cloudWorkspaces).mockRejectedValueOnce(failure("IO_ERROR"));
		vi.mocked(api.cloudSessionStorage).mockResolvedValueOnce(customStorage);
		mount();
		await settle();
		expect(text()).toContain("Main session logs: /old/main");
		expect(text()).toContain("Subagent session logs: relative/old-subagents");
		storeLogs();
		expect(button("Save log locations").matches(":disabled")).toBe(false);
		expect(button("Connect folder").matches(":disabled")).toBe(true);
		button("Save log locations").click();
		await settle();
		expect(api.saveCloudSessionStorage).toHaveBeenCalledOnce();
		expect(api.linkProject).not.toHaveBeenCalled();
	});

	it("never fabricates defaults on failed storage GET, permits project linking, and retries explicitly", async () => {
		vi.mocked(api.cloudSessionStorage).mockRejectedValueOnce(failure("INVALID_METADATA"));
		mount();
		await settle();
		expect(text()).toContain("Could not load session storage: INVALID_METADATA");
		expect(text()).not.toContain("Main session logs:");
		enter("Folder path on this computer", "/project");
		expect(button("Store session logs here").disabled).toBe(true);
		expect(button("Use local log defaults").disabled).toBe(true);
		submit("Connect folder");
		await settle();
		expect(api.linkProject).toHaveBeenCalledExactlyOnceWith({ path: "/project" });
		expect(api.cloudSessionStorage).toHaveBeenCalledTimes(1);
		button("Retry session storage").click();
		await settle();
		expect(api.cloudSessionStorage).toHaveBeenCalledTimes(2);
		expect(text()).toContain("Local default (~/.dreb/agent/sessions)");
		expect(button("Store session logs here").disabled).toBe(false);
		expect(api.saveCloudSessionStorage).not.toHaveBeenCalled();
	});

	it("requires successful storage load and a nonempty path, but leaves project linking independent", async () => {
		const load = deferred<CloudSessionStorageDto>();
		vi.mocked(api.cloudSessionStorage).mockReturnValueOnce(load.promise);
		mount();
		await settle();
		enter("Folder path on this computer", "/project");
		expect(button("Store session logs here").disabled).toBe(true);
		submit("Connect folder");
		await settle();
		expect(api.linkProject).toHaveBeenCalledOnce();
		load.resolve(localStorage);
		await settle();
		expect(button("Store session logs here").disabled).toBe(false);
		enter("Folder path on this computer", "");
		expect(button("Store session logs here").disabled).toBe(true);
		expect(api.saveCloudSessionStorage).not.toHaveBeenCalled();
	});

	it("requires separate consent, describes scope/derived paths and saves only storage with captured expected pair", async () => {
		vi.mocked(api.cloudSessionStorage).mockResolvedValueOnce(customStorage);
		mount();
		await settle();
		storeLogs("/logs with space ");
		expect(api.saveCloudSessionStorage).not.toHaveBeenCalled();
		const confirmation = document.querySelector(".cloud-confirmation")!.textContent!;
		for (const copy of [
			"/logs with space ",
			".dreb/sessions",
			".dreb/subagent-sessions",
			"global defaults for all projects",
			"not moved, copied or deleted",
			"Active sessions keep their existing files",
			"Project/CLI overrides remain",
			"No folders or markers are created",
			"no automatic restart",
			"Cloud sync is not a lock",
		])
			expect(confirmation).toContain(copy);
		button("Save log locations").click();
		await settle();
		expect(api.saveCloudSessionStorage).toHaveBeenCalledExactlyOnceWith("/logs with space ", {
			sessionDir: "/old/main",
			subagentSessionDir: "relative/old-subagents",
		});
		expect(api.linkProject).not.toHaveBeenCalled();
		expect(api.connectWorkspace).not.toHaveBeenCalled();
		expect(api.cloudWorkspaces).toHaveBeenCalledTimes(1);
		expect(document.querySelector(".cloud-confirmation")).toBeNull();
		expect(text()).toContain("Session log locations saved");
		expect(text()).toContain("Main session logs: /logs/.dreb/sessions");
		expect(text()).toContain("Restart Dashboard only when agents are idle");
		expect(field("Folder path on this computer").value).toBe("/logs with space ");
	});

	it.each(["cancel", "edit"] as const)(
		"invalidates log consent on %s and never saves automatically",
		async (action) => {
			mount();
			await settle();
			storeLogs();
			if (action === "cancel") button("Cancel log change").click();
			else enter("Folder path on this computer", "/different");
			expect(document.querySelector(".cloud-confirmation")).toBeNull();
			expect(api.saveCloudSessionStorage).not.toHaveBeenCalled();
		},
	);

	it.each([false, true])(
		"refresh invalidates consent and reloads storage without writes (failed=%s)",
		async (failed) => {
			mount();
			await settle();
			storeLogs();
			const refreshed = deferred<CloudSessionStorageDto>();
			vi.mocked(api.cloudSessionStorage).mockReturnValueOnce(refreshed.promise);
			button("Refresh metadata").click();
			expect(document.querySelector(".cloud-confirmation")).toBeNull();
			expect(button("Store session logs here").disabled).toBe(true);
			if (failed) refreshed.reject(failure("IO_ERROR"));
			else refreshed.resolve(customStorage);
			await settle();
			expect(api.cloudWorkspaces).toHaveBeenCalledTimes(2);
			expect(api.cloudSessionStorage).toHaveBeenCalledTimes(2);
			expect(api.saveCloudSessionStorage).not.toHaveBeenCalled();
			if (failed) {
				expect(text()).toContain("Could not load session storage: IO_ERROR");
				expect(button("Store session logs here").disabled).toBe(true);
			} else {
				button("Store session logs here").click();
				button("Save log locations").click();
				await settle();
				expect(api.saveCloudSessionStorage).toHaveBeenCalledExactlyOnceWith("/logs", {
					sessionDir: customStorage.sessionDir,
					subagentSessionDir: customStorage.subagentSessionDir,
				});
			}
		},
	);

	it("resets to local defaults only after separate confirmation with the current expected pair", async () => {
		vi.mocked(api.cloudSessionStorage).mockResolvedValueOnce(customStorage);
		vi.mocked(api.saveCloudSessionStorage).mockResolvedValueOnce(localStorage);
		mount();
		await settle();
		button("Use local log defaults").click();
		expect(text()).toContain("Return to local log defaults?");
		expect(api.saveCloudSessionStorage).not.toHaveBeenCalled();
		button("Cancel log change").click();
		expect(api.saveCloudSessionStorage).not.toHaveBeenCalled();
		button("Use local log defaults").click();
		button("Save log locations").click();
		await settle();
		expect(api.saveCloudSessionStorage).toHaveBeenCalledExactlyOnceWith(null, {
			sessionDir: "/old/main",
			subagentSessionDir: "relative/old-subagents",
		});
		expect(text()).toContain("Local default (~/.dreb/agent/subagent-sessions)");
		expect(api.linkProject).not.toHaveBeenCalled();
	});

	it.each(["CONFLICT", "IO_ERROR", "INVALID_METADATA"])(
		"preserves confirmation and input on %s, with explicit retry only",
		async (code) => {
			vi.mocked(api.saveCloudSessionStorage).mockRejectedValueOnce(failure(code));
			mount();
			await settle();
			storeLogs();
			button("Save log locations").click();
			await settle();
			expect(text()).toContain(`Mutation failed: ${code}:`);
			expect(field("Folder path on this computer").value).toBe("/logs");
			expect(document.querySelector(".cloud-confirmation")).not.toBeNull();
			expect(api.saveCloudSessionStorage).toHaveBeenCalledExactlyOnceWith("/logs", {
				sessionDir: null,
				subagentSessionDir: null,
			});
			expect(api.cloudSessionStorage).toHaveBeenCalledTimes(1);
			button("Save log locations").click();
			await settle();
			expect(api.saveCloudSessionStorage).toHaveBeenNthCalledWith(2, "/logs", {
				sessionDir: null,
				subagentSessionDir: null,
			});
		},
	);

	it("shares synchronous single-flight/pending protection with basic, advanced and row actions", async () => {
		const write = deferred<CloudSessionStorageDto>();
		vi.mocked(api.saveCloudSessionStorage).mockReturnValueOnce(write.promise);
		vi.mocked(api.cloudWorkspaces).mockResolvedValueOnce(populated);
		mount();
		await settle();
		storeLogs();
		button("Save log locations").click();
		button("Save log locations").dispatchEvent(new MouseEvent("click", { bubbles: true }));
		submit("Connect folder");
		submit("Connect workspace");
		submit("Link project");
		button("Rebind project", row("Project", projectA)).dispatchEvent(new MouseEvent("click", { bubbles: true }));
		for (const control of document.querySelectorAll("main button, main input, main select"))
			expect(control.matches(":disabled")).toBe(true);
		expect(api.saveCloudSessionStorage).toHaveBeenCalledTimes(1);
		expect(api.linkProject).not.toHaveBeenCalled();
		expect(api.connectWorkspace).not.toHaveBeenCalled();
		expect(api.cloudWorkspaces).toHaveBeenCalledTimes(1);
		write.resolve(localStorage);
		await settle();
		expect(button("Refresh metadata").disabled).toBe(false);
	});

	it.each([false, true])("ignores late storage reads after disposal (rejected=%s)", async (reject) => {
		const load = deferred<CloudSessionStorageDto>();
		vi.mocked(api.cloudSessionStorage).mockReturnValueOnce(load.promise);
		const view = mount();
		view.dispose();
		if (reject) load.reject(failure("IO_ERROR"));
		else load.resolve(customStorage);
		await settle();
		expect(view.host.textContent).toBe("");
		expect(api.saveCloudSessionStorage).not.toHaveBeenCalled();
	});

	it.each([false, true])("ignores late storage saves after disposal (rejected=%s)", async (reject) => {
		const write = deferred<CloudSessionStorageDto>();
		vi.mocked(api.saveCloudSessionStorage).mockReturnValueOnce(write.promise);
		const view = mount();
		await settle();
		storeLogs();
		button("Save log locations").click();
		view.dispose();
		if (reject) write.reject(failure("IO_ERROR"));
		else write.resolve(customStorage);
		await settle();
		expect(view.host.textContent).toBe("");
		expect(api.cloudSessionStorage).toHaveBeenCalledTimes(1);
		expect(api.cloudWorkspaces).toHaveBeenCalledTimes(1);
	});

	it("does not reset saved settings on navigation/remount or merely opening confirmations", async () => {
		vi.mocked(api.cloudSessionStorage).mockResolvedValue(customStorage);
		const first = mount();
		await settle();
		storeLogs();
		first.dispose();
		mount();
		await settle();
		expect(text()).toContain("Main session logs: /old/main");
		expect(api.saveCloudSessionStorage).not.toHaveBeenCalled();
	});
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
		expect(document.querySelector("h1")?.textContent).toBe("cloud workspaces");
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

	it("shows folder headings in stable ID order with IDs, relationships and markers under technical details", async () => {
		vi.mocked(api.cloudWorkspaces).mockResolvedValue(populated);
		mount();
		await settle();
		expect(Array.from(document.querySelectorAll("article h3"), (element) => element.textContent)).toEqual([
			workspaceA,
			workspaceZ,
			"/outside/cloud",
			"/configured/z/apps/a very long project",
		]);
		for (const id of [projectA, projectZ]) {
			const details = row("Project", id).querySelector<HTMLDetailsElement>("details")!;
			expect(details.open).toBe(false);
			expect(details.querySelector("summary")?.textContent).toBe("technical details");
			expect(details.textContent).toContain(`Project ID: ${id}`);
			expect(details.textContent).toContain("Marker required:");
		}
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
