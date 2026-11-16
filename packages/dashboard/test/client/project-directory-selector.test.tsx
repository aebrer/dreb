// @vitest-environment jsdom
import { createSignal } from "solid-js";
import { render } from "solid-js/web/dist/web.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/client/api.js";
import { ProjectDirectorySelector } from "../../src/client/components/project-directory-selector.js";
import type { CloudProjectDto, CloudWorkspacesDto, RuntimeDirectorySelection } from "../../src/shared/protocol.js";

vi.mock("../../src/client/api.js", () => ({
	api: {
		cloudWorkspaces: vi.fn(),
		settings: vi.fn(),
		listFiles: vi.fn(),
		models: vi.fn(),
		resources: vi.fn(),
		createRuntime: vi.fn(),
		createProjectRuntime: vi.fn(),
	},
}));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const W = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const disposers: Array<() => void> = [];

function available(id = A, path = "/canonical/same-name"): CloudProjectDto {
	return {
		id,
		location: { kind: "local", path: "/configured/same-name" },
		markerRequired: true,
		status: { available: true, path },
	};
}

function unavailable(id = B): CloudProjectDto {
	return {
		id,
		location: { kind: "workspace", workspaceId: W, relativePath: "nested/same-name" },
		markerRequired: true,
		status: { available: false, error: { code: "CONFLICT", message: "marker identity changed" } },
	};
}

function registry(projects: CloudProjectDto[] = []): CloudWorkspacesDto {
	return { version: 1, pathStyle: "posix", workspaces: [], projects };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function mount(initialCwd = " /group/initial cwd ", initiallyDisabled = false) {
	const [selection, setSelection] = createSignal<RuntimeDirectorySelection>({ kind: "local", cwd: initialCwd });
	const [disabled, setDisabled] = createSignal(initiallyDisabled);
	const onChange = vi.fn((next: RuntimeDirectorySelection) => setSelection(next));
	const container = document.createElement("div");
	document.body.appendChild(container);
	const dispose = render(
		() => (
			<ProjectDirectorySelector
				idPrefix="test"
				selection={selection()}
				onChange={onChange}
				recentProjects={[" /recent/exact path ", "/other/same-name"]}
				disabled={disabled()}
				localLabel="runtime project path"
			/>
		),
		container,
	);
	disposers.push(dispose);
	const source = () => container.querySelector<HTMLSelectElement>("#test-source")!;
	const project = () => container.querySelector<HTMLSelectElement>("#test-project")!;
	const local = () => container.querySelector<HTMLInputElement>("#test-cwd")!;
	const refresh = () =>
		[...container.querySelectorAll("button")].find((button) =>
			/(?:refresh|retry) linked projects/.test(button.textContent ?? ""),
		)!;
	return {
		container,
		selection,
		setSelection,
		disabled,
		setDisabled,
		onChange,
		dispose,
		source,
		project,
		local,
		refresh,
	};
}

function change(select: HTMLSelectElement, value: string): void {
	select.value = value;
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

function input(element: HTMLInputElement, value: string): void {
	element.value = value;
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(element: HTMLElement): void {
	element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(api.cloudWorkspaces).mockResolvedValue(registry());
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	document.body.innerHTML = "";
	for (const [name, method] of Object.entries(api)) {
		if (name !== "cloudWorkspaces") expect(method).not.toHaveBeenCalled();
	}
});

describe("ProjectDirectorySelector", () => {
	it("mounts local without metadata or runtime requests and keeps the group initial CWD", async () => {
		const view = mount();
		await flush();
		expect(view.source().value).toBe("local");
		expect(view.local().value).toBe(" /group/initial cwd ");
		expect(view.local().placeholder).toBe("/path/to/project");
		expect(view.container.querySelector('label[for="test-cwd"]')?.textContent).toBe("runtime project path");
		expect(view.container.querySelector('label[for="test-source"]')?.textContent).toBe("directory source");
		expect(api.cloudWorkspaces).not.toHaveBeenCalled();
		expect(view.container.querySelector("a")).toBeNull();
		expect(view.onChange).not.toHaveBeenCalled();
		expect(view.container.textContent).toContain("Start/Resume runs normal project settings, context and extensions");
		expect(view.container.textContent).toContain("does not persist a project association or move transcripts");
	});

	it("preserves exact typed, recent and externally controlled local values", () => {
		const view = mount();
		input(view.local(), "  /typed/path with spaces/  ");
		expect(view.selection()).toEqual({ kind: "local", cwd: "  /typed/path with spaces/  " });
		click(view.container.querySelector(".recent-projects button")!);
		expect(view.selection()).toEqual({ kind: "local", cwd: " /recent/exact path " });
		view.setSelection({ kind: "local", cwd: "  /parent/updated  " });
		expect(view.local().value).toBe("  /parent/updated  ");
		expect(api.cloudWorkspaces).not.toHaveBeenCalled();
	});

	it("explicit linked mode clears the ID, loads metadata and never auto-selects", async () => {
		const pending = deferred<CloudWorkspacesDto>();
		vi.mocked(api.cloudWorkspaces).mockReturnValue(pending.promise);
		const view = mount();
		change(view.source(), "project");
		expect(view.selection()).toEqual({ kind: "project", projectId: "" });
		expect(api.cloudWorkspaces).toHaveBeenCalledExactlyOnceWith();
		expect(view.container.textContent).toContain("Loading linked projects");
		expect(view.project().disabled).toBe(true);
		pending.resolve(registry([available()]));
		await flush();
		expect(view.project().value).toBe("");
		expect(view.project().options[0].text).toBe("choose linked project");
		expect(view.selection()).toEqual({ kind: "project", projectId: "" });
		expect(view.onChange).toHaveBeenCalledTimes(1);
		expect(view.container.querySelector("a")?.getAttribute("href")).toBe("#/settings/cloud-workspaces");
		expect(view.container.textContent).toContain("not synchronization or proof of code equivalence");
	});

	it("sorts by full IDs and distinguishes duplicate names, canonical paths and availability", async () => {
		vi.mocked(api.cloudWorkspaces).mockResolvedValue(
			registry([available(C, "/third/same-name"), unavailable(), available()]),
		);
		const view = mount();
		change(view.source(), "project");
		await flush();
		const options = [...view.project().options].slice(1);
		expect(options.map((option) => option.value)).toEqual([A, B, C]);
		expect(options[0].text).toBe(`${A} — /canonical/same-name — available`);
		expect(options[1].text).toBe(`${B} — ${W}/nested/same-name — unavailable`);
		expect(options[1].disabled).toBe(true);
		expect(options[2].text).toContain("/third/same-name");
		expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
			"CONFLICT: marker identity changed",
		);
		change(view.project(), B);
		expect(view.selection()).toEqual({ kind: "project", projectId: "" });
	});

	it("shows configured local paths for unavailable local projects", async () => {
		vi.mocked(api.cloudWorkspaces).mockResolvedValue(
			registry([{ ...unavailable(), location: { kind: "local", path: "/configured/unavailable" } }]),
		);
		const view = mount();
		change(view.source(), "project");
		await flush();
		expect(view.project().options[1].text).toContain("/configured/unavailable — unavailable");
	});

	it("emits only the chosen project ID and displays its full identity and canonical path", async () => {
		vi.mocked(api.cloudWorkspaces).mockResolvedValue(registry([available()]));
		const view = mount();
		change(view.source(), "project");
		await flush();
		change(view.project(), A);
		expect(view.onChange).toHaveBeenLastCalledWith({ kind: "project", projectId: A });
		expect(view.project().value).toBe(A);
		expect(view.container.querySelector(".project-directory-identity")?.textContent).toContain(A);
		expect(view.container.querySelector(".project-directory-identity")?.textContent).toContain(
			"/canonical/same-name",
		);
		change(view.project(), "");
		expect(view.selection()).toEqual({ kind: "project", projectId: "" });
	});

	it("restores the last exact local input and fetches afresh on every explicit linked switch", async () => {
		vi.mocked(api.cloudWorkspaces).mockResolvedValue(registry([available()]));
		const view = mount();
		input(view.local(), "  /remember/me  ");
		change(view.source(), "project");
		await flush();
		change(view.project(), A);
		change(view.source(), "local");
		expect(view.local().value).toBe("  /remember/me  ");
		change(view.source(), "project");
		expect(view.selection()).toEqual({ kind: "project", projectId: "" });
		expect(api.cloudWorkspaces).toHaveBeenCalledTimes(2);
		await flush();
		expect(view.project().value).toBe("");
	});

	it("distinguishes a successful empty registry from loading or a failure", async () => {
		const view = mount();
		change(view.source(), "project");
		await flush();
		expect(view.container.textContent).toContain("No linked projects are registered on this host");
		expect(view.container.querySelector('[role="alert"]')).toBeNull();
		expect(view.project().options).toHaveLength(1);
	});

	it("shows initial failure and retry without pretending the registry is empty", async () => {
		vi.mocked(api.cloudWorkspaces)
			.mockRejectedValueOnce(new Error("registry is corrupt"))
			.mockResolvedValueOnce(registry([available()]));
		const view = mount();
		change(view.source(), "project");
		await flush();
		expect(view.container.textContent).toContain("registry is corrupt");
		expect(view.container.textContent).toContain("No registry result is available");
		expect(view.container.textContent).not.toContain("No linked projects are registered");
		click(view.refresh());
		await flush();
		expect(view.project().options).toHaveLength(2);
		expect(view.project().value).toBe("");
		expect(view.container.querySelector('[role="alert"]')).toBeNull();
		change(view.source(), "local");
		expect(view.local().value).toBe(" /group/initial cwd ");
	});

	it("retains last-good fields, selected identity and stale choices after a failed refresh", async () => {
		vi.mocked(api.cloudWorkspaces)
			.mockResolvedValueOnce(registry([available()]))
			.mockRejectedValueOnce(new Error("offline"));
		const view = mount();
		change(view.source(), "project");
		await flush();
		change(view.project(), A);
		click(view.refresh());
		await flush();
		expect(view.project().value).toBe(A);
		expect(view.selection()).toEqual({ kind: "project", projectId: A });
		expect(view.project().options).toHaveLength(2);
		expect(view.container.textContent).toContain("Last-known choices are stale");
		expect(view.container.textContent).toContain("offline");
		expect(view.container.textContent).not.toContain("No linked projects are registered");
		vi.mocked(api.cloudWorkspaces).mockResolvedValueOnce(registry([available()]));
		click(view.refresh());
		await flush();
		expect(view.container.textContent).not.toContain("stale");
		expect(view.selection()).toEqual({ kind: "project", projectId: A });
	});

	it.each(["removed", "unavailable"])(
		"clears a selected ID when refresh finds it %s, without choosing another",
		async (outcome) => {
			vi.mocked(api.cloudWorkspaces).mockResolvedValueOnce(registry([available(), available(C)]));
			const view = mount();
			change(view.source(), "project");
			await flush();
			change(view.project(), A);
			vi.mocked(api.cloudWorkspaces).mockResolvedValueOnce(
				registry(outcome === "removed" ? [available(C)] : [unavailable(A), available(C)]),
			);
			click(view.refresh());
			await flush();
			expect(view.selection()).toEqual({ kind: "project", projectId: "" });
			expect(view.project().value).toBe("");
			expect(view.container.textContent).toContain(`Selection cleared: linked project ${A}`);
			expect(view.container.textContent).toContain(
				outcome === "removed" ? "no longer registered" : "is unavailable",
			);
			expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
		},
	);

	it.each(["resolve", "reject"])("ignores late %s after an immediate switch back to local", async (outcome) => {
		const pending = deferred<CloudWorkspacesDto>();
		vi.mocked(api.cloudWorkspaces).mockReturnValueOnce(pending.promise);
		const view = mount();
		change(view.source(), "project");
		change(view.source(), "local");
		expect(view.local().value).toBe(" /group/initial cwd ");
		const calls = view.onChange.mock.calls.length;
		if (outcome === "resolve") pending.resolve(registry([available()]));
		else pending.reject(new Error("obsolete error"));
		await flush();
		expect(view.selection()).toEqual({ kind: "local", cwd: " /group/initial cwd " });
		expect(view.onChange).toHaveBeenCalledTimes(calls);
		expect(view.container.textContent).not.toContain("obsolete error");
	});

	it("ignores older responses overlapping a fresh linked-mode load", async () => {
		const older = deferred<CloudWorkspacesDto>();
		const newer = deferred<CloudWorkspacesDto>();
		vi.mocked(api.cloudWorkspaces)
			.mockResolvedValueOnce(registry([available()]))
			.mockReturnValueOnce(older.promise)
			.mockReturnValueOnce(newer.promise);
		const view = mount();
		change(view.source(), "project");
		await flush();
		click(view.refresh());
		change(view.source(), "local");
		change(view.source(), "project");
		newer.resolve(registry([available(C)]));
		await flush();
		change(view.project(), C);
		older.resolve(registry([available()]));
		await flush();
		expect([...view.project().options].map((option) => option.value)).toEqual(["", C]);
		expect(view.selection()).toEqual({ kind: "project", projectId: C });
	});

	it.each(["resolve", "reject"])("keeps a newer load pending after an obsolete refresh %s", async (outcome) => {
		const older = deferred<CloudWorkspacesDto>();
		const newer = deferred<CloudWorkspacesDto>();
		vi.mocked(api.cloudWorkspaces)
			.mockResolvedValueOnce(registry([available()]))
			.mockReturnValueOnce(older.promise)
			.mockReturnValueOnce(newer.promise);
		const view = mount();
		change(view.source(), "project");
		await flush();
		click(view.refresh());
		change(view.source(), "local");
		change(view.source(), "project");
		if (outcome === "resolve") older.resolve(registry([available()]));
		else older.reject(new Error("obsolete refresh"));
		await flush();
		expect(view.container.textContent).toContain("Loading linked projects");
		expect(view.container.textContent).not.toContain("obsolete refresh");
		expect(view.project().disabled).toBe(true);
		newer.resolve(registry([available(C)]));
		await flush();
		expect([...view.project().options].map((option) => option.value)).toEqual(["", C]);
	});

	it.each(["resolve", "reject"])("ignores %s after disposal without calling the parent", async (outcome) => {
		const pending = deferred<CloudWorkspacesDto>();
		vi.mocked(api.cloudWorkspaces).mockReturnValueOnce(pending.promise);
		const view = mount();
		change(view.source(), "project");
		view.setSelection({ kind: "project", projectId: A });
		view.dispose();
		if (outcome === "resolve") pending.resolve(registry());
		else pending.reject(new Error("disposed failure"));
		await flush();
		expect(view.onChange).toHaveBeenCalledTimes(1);
		expect(view.selection()).toEqual({ kind: "project", projectId: A });
	});

	it("disables all local controls and synchronously guards synthetic input, recent and source actions", () => {
		const view = mount(" /disabled/exact ", true);
		for (const control of view.container.querySelectorAll("input, select, button"))
			expect(control.matches(":disabled")).toBe(true);
		input(view.local(), "/synthetic");
		click(view.container.querySelector(".recent-projects button")!);
		change(view.source(), "project");
		expect(view.selection()).toEqual({ kind: "local", cwd: " /disabled/exact " });
		expect(view.onChange).not.toHaveBeenCalled();
		expect(api.cloudWorkspaces).not.toHaveBeenCalled();
	});

	it("blocks disabled linked controls and management navigation even during a pending refresh", async () => {
		const pending = deferred<CloudWorkspacesDto>();
		vi.mocked(api.cloudWorkspaces)
			.mockResolvedValueOnce(registry([available()]))
			.mockReturnValueOnce(pending.promise);
		const view = mount();
		change(view.source(), "project");
		await flush();
		change(view.project(), A);
		click(view.refresh());
		view.setDisabled(true);
		const calls = view.onChange.mock.calls.length;
		for (const control of view.container.querySelectorAll("input, select, button"))
			expect(control.matches(":disabled")).toBe(true);
		change(view.source(), "local");
		change(view.project(), "");
		click(view.refresh());
		const link = view.container.querySelector("a")!;
		expect(link.hasAttribute("href")).toBe(false);
		expect(link.getAttribute("aria-disabled")).toBe("true");
		expect(link.tabIndex).toBe(-1);
		const event = new MouseEvent("click", { bubbles: true, cancelable: true });
		link.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		pending.resolve(registry([available()]));
		await flush();
		expect(view.selection()).toEqual({ kind: "project", projectId: A });
		expect(view.onChange).toHaveBeenCalledTimes(calls);
		expect(api.cloudWorkspaces).toHaveBeenCalledTimes(2);
		view.setDisabled(false);
		expect(link.getAttribute("href")).toBe("#/settings/cloud-workspaces");
	});

	it("guards synchronous duplicate source/refresh events and project choices during loading", async () => {
		const pending = deferred<CloudWorkspacesDto>();
		vi.mocked(api.cloudWorkspaces)
			.mockResolvedValueOnce(registry([available()]))
			.mockReturnValueOnce(pending.promise);
		const view = mount();
		change(view.source(), "project");
		change(view.source(), "project");
		expect(api.cloudWorkspaces).toHaveBeenCalledTimes(1);
		await flush();
		click(view.refresh());
		click(view.refresh());
		change(view.project(), A);
		expect(api.cloudWorkspaces).toHaveBeenCalledTimes(2);
		expect(view.selection()).toEqual({ kind: "project", projectId: "" });
		pending.resolve(registry([available()]));
		await flush();
	});
});
