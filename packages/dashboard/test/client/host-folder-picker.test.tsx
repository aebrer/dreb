// @vitest-environment jsdom
import { render } from "solid-js/web/dist/web.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudFolderListingDto } from "../../src/shared/protocol.js";

vi.mock("../../src/client/api.js", () => ({ api: { cloudFolders: vi.fn() } }));

import { api } from "../../src/client/api.js";
import { HostFolderPicker } from "../../src/client/components/host-folder-picker.js";

const home: CloudFolderListingDto = {
	path: "/host/home",
	parent: "/host",
	entries: [{ name: "folder with space ", path: "/host/home/folder with space " }],
	truncated: false,
};
let dispose: (() => void) | undefined;
const settle = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function button(name: string) {
	const result = [...document.querySelectorAll("button")].find((entry) => entry.textContent === name);
	if (!result) throw new Error(`Missing button ${name}`);
	return result;
}
function mount(initialPath = "") {
	const host = document.createElement("div");
	document.body.append(host);
	const onSelect = vi.fn(),
		onDismiss = vi.fn();
	dispose = render(
		() => <HostFolderPicker initialPath={initialPath} onSelect={onSelect} onDismiss={onDismiss} />,
		host,
	);
	return { onSelect, onDismiss, host };
}
function enter(path: string) {
	const input = document.querySelector("input")!;
	input.value = path;
	input.dispatchEvent(new Event("input", { bubbles: true }));
}
function go() {
	document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(api.cloudFolders).mockResolvedValue(home);
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("HostFolderPicker read-only selection", () => {
	it.each(["", "/host/literal trailing space ", "C:\\Users\\you\\folder"])(
		"loads the captured native location unchanged: %s",
		async (path) => {
			const view = mount(path);
			await settle();
			expect(api.cloudFolders).toHaveBeenCalledExactlyOnceWith(
				path === "" ? undefined : path,
				expect.any(AbortSignal),
			);
			expect(document.querySelector("[role=dialog]")?.getAttribute("aria-modal")).toBe("true");
			expect(document.body.textContent).toContain("not your browser or phone");
			expect(view.onSelect).not.toHaveBeenCalled();
			expect(view.onDismiss).not.toHaveBeenCalled();
		},
	);

	it("selects only the displayed canonical directory after explicit consent", async () => {
		const view = mount("/alias");
		await settle();
		button("Choose folder").click();
		expect(view.onSelect).toHaveBeenCalledExactlyOnceWith(home.path);
	});

	it("navigates using server child/parent paths without slash arithmetic", async () => {
		vi.mocked(api.cloudFolders)
			.mockResolvedValueOnce(home)
			.mockResolvedValueOnce({ ...home, path: "C:\\canonical\\child", parent: "C:\\canonical", entries: [] });
		mount();
		await settle();
		button("folder with space ").click();
		await settle();
		expect(api.cloudFolders).toHaveBeenNthCalledWith(2, home.entries[0].path, expect.any(AbortSignal));
		button("Up one folder").click();
		await settle();
		expect(api.cloudFolders).toHaveBeenNthCalledWith(3, "C:\\canonical", expect.any(AbortSignal));
		button("Home folder").click();
		await settle();
		expect(api.cloudFolders).toHaveBeenNthCalledWith(4, undefined, expect.any(AbortSignal));
	});

	it("retains typed whitespace and disables selection until Go succeeds", async () => {
		const view = mount();
		await settle();
		enter("/new path ");
		expect(button("Choose folder").disabled).toBe(true);
		expect(api.cloudFolders).toHaveBeenCalledTimes(1);
		vi.mocked(api.cloudFolders).mockResolvedValueOnce({ ...home, path: "/new path " });
		go();
		await settle();
		expect(api.cloudFolders).toHaveBeenNthCalledWith(2, "/new path ", expect.any(AbortSignal));
		button("Choose folder").click();
		expect(view.onSelect).toHaveBeenCalledExactlyOnceWith("/new path ");
	});

	it("blocks duplicate Go submits and selection while loading, but permits cancelling", async () => {
		const pending = deferred<CloudFolderListingDto>();
		vi.mocked(api.cloudFolders).mockReturnValueOnce(pending.promise);
		const view = mount("/pending");
		await settle();
		expect(button("Choose folder").disabled).toBe(true);
		go();
		go();
		expect(api.cloudFolders).toHaveBeenCalledTimes(1);
		button("Cancel folder selection").click();
		expect(view.onDismiss).toHaveBeenCalledOnce();
		expect(view.onSelect).not.toHaveBeenCalled();
		pending.resolve(home);
		await settle();
	});

	it("shows an error, never fabricates a listing, and retries only explicitly", async () => {
		vi.mocked(api.cloudFolders).mockRejectedValueOnce(new Error("Synthetic unavailable"));
		const view = mount("/missing");
		await settle();
		expect(document.querySelector("[role=alert]")?.textContent).toContain("Synthetic unavailable");
		expect(document.body.textContent).not.toContain("No subfolders");
		expect(button("Choose folder").disabled).toBe(true);
		expect(api.cloudFolders).toHaveBeenCalledTimes(1);
		button("Retry folders").click();
		await settle();
		expect(api.cloudFolders).toHaveBeenNthCalledWith(2, "/missing", expect.any(AbortSignal));
		expect(view.onSelect).not.toHaveBeenCalled();
		expect(button("Choose folder").disabled).toBe(false);
	});

	it("does not select an older displayed directory after failed navigation", async () => {
		const view = mount();
		await settle();
		vi.mocked(api.cloudFolders).mockRejectedValueOnce(new Error("Denied"));
		button("folder with space ").click();
		await settle();
		expect(button("Choose folder").disabled).toBe(true);
		expect(view.onSelect).not.toHaveBeenCalled();
	});

	it("distinguishes empty roots from truncated lists and disables Up at a native root", async () => {
		vi.mocked(api.cloudFolders).mockResolvedValueOnce({
			...home,
			path: "C:\\",
			parent: null,
			entries: [],
			truncated: true,
		});
		mount();
		await settle();
		expect(button("Up one folder").disabled).toBe(true);
		expect(document.body.textContent).toContain("Some folders are not shown");
		expect(document.body.textContent).toContain("No folders in the displayed portion");
		expect(document.body.textContent).not.toContain("No subfolders in this folder");
	});

	it("reports an actually empty nontruncated folder without a truncation warning", async () => {
		vi.mocked(api.cloudFolders).mockResolvedValueOnce({ ...home, entries: [] });
		mount();
		await settle();
		expect(document.body.textContent).toContain("No subfolders in this folder");
		expect(document.body.textContent).not.toContain("Some folders are not shown");
	});

	it.each([false, true])(
		"ignores stale superseded completion (rejected=%s) and aborts the superseded request",
		async (reject) => {
			const old = deferred<CloudFolderListingDto>();
			vi.mocked(api.cloudFolders).mockReturnValueOnce(old.promise);
			mount("/old");
			const signal = vi.mocked(api.cloudFolders).mock.calls[0][1]!;
			button("Home folder").click();
			await settle();
			expect(signal.aborted).toBe(true);
			if (reject) old.reject(new Error("stale failure"));
			else old.resolve({ ...home, path: "/old" });
			await settle();
			expect(document.querySelector("input")!.value).toBe(home.path);
			expect(document.querySelector("[role=alert]")).toBeNull();
		},
	);

	it.each([false, true])("aborts and ignores completion after unmount (rejected=%s)", async (reject) => {
		const old = deferred<CloudFolderListingDto>();
		vi.mocked(api.cloudFolders).mockReturnValueOnce(old.promise);
		const view = mount();
		const signal = vi.mocked(api.cloudFolders).mock.calls[0][1]!;
		dispose!();
		dispose = undefined;
		expect(signal.aborted).toBe(true);
		if (reject) old.reject(new Error("late"));
		else old.resolve(home);
		await settle();
		expect(view.host.textContent).toBe("");
		expect(view.onSelect).not.toHaveBeenCalled();
	});

	it("keeps focus inside during navigation and dismisses on Escape", async () => {
		const view = mount();
		await settle();
		button("folder with space ").focus();
		button("folder with space ").click();
		expect(document.querySelector("[role=dialog]")!.contains(document.activeElement)).toBe(true);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(view.onDismiss).toHaveBeenCalledOnce();
		await settle();
	});
});
