// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	api,
	connectEvents,
	dashboardImageUrl,
	type EventConnectionStatus,
	type EventSourceLike,
	type EventStreamDependencies,
} from "../../src/client/api.js";
import { createRuntimeInDirectory, runtimeDirectoryReady } from "../../src/client/state/runtime-directory.js";
import type {
	CloudWorkspacesDto,
	LinkProjectRequestDto,
	RuntimeDirectorySelection,
} from "../../src/shared/protocol.js";

class FakeVisibility {
	visibilityState: DocumentVisibilityState = "visible";
	private readonly listeners = new Set<() => void>();
	addEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
		this.listeners.add(listener as () => void);
	}
	removeEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
		this.listeners.delete(listener as () => void);
	}
	emit(): void {
		for (const listener of this.listeners) listener();
	}
}

class FakeEventSource implements EventSourceLike {
	static instances: FakeEventSource[] = [];
	readyState = 0;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent<string>) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
	closed = false;
	constructor(readonly url: string) {
		FakeEventSource.instances.push(this);
	}
	addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
		this.listeners.set(
			type,
			(this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
		);
	}
	close(): void {
		this.closed = true;
		this.readyState = 2;
	}
	open(): void {
		this.readyState = 1;
		this.onopen?.(new Event("open"));
	}
	error(): void {
		this.onerror?.(new Event("error"));
	}
	message(data: unknown): void {
		this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
	}
	named(type: string, data = "{}"): void {
		for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent<string>);
	}
}

function envelope(seq: number) {
	return { seq, key: "runtime", event: { type: "agent_start" } };
}

function setup(overrides: Partial<EventStreamDependencies> = {}) {
	FakeEventSource.instances = [];
	let now = 0;
	const statuses: EventConnectionStatus[] = [];
	const onEnvelope = vi.fn();
	const onAuthStatus = vi.fn();
	const recovery = vi.fn();
	const deps: EventStreamDependencies = {
		EventSource: FakeEventSource,
		now: () => now,
		random: () => 0.5,
		status: vi.fn().mockResolvedValue({ mode: "local", needsPairing: false }),
		baseDelayMs: 100,
		maxDelayMs: 400,
		watchdogMs: 30_000,
		...overrides,
	};
	const disconnect = connectEvents(
		{ onEnvelope, onAuthStatus, onRecovery: recovery, onStatusChange: (status) => statuses.push(status) },
		deps,
	);
	return {
		statuses,
		onEnvelope,
		onAuthStatus,
		recovery,
		disconnect,
		source: () => FakeEventSource.instances.at(-1)!,
		setNow: (value: number) => {
			now = value;
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("dashboardImageUrl", () => {
	it("builds encoded same-origin parent and subagent URLs only for validated IDs", () => {
		const id = "a".repeat(64);
		expect(dashboardImageUrl("runtime one", id, "preview")).toBe(`/api/runtimes/runtime%20one/images/${id}/preview`);
		expect(dashboardImageUrl("runtime", id, "original", "agent/one")).toBe(
			`/api/runtimes/runtime/subagents/agent%2Fone/images/${id}/original`,
		);
		expect(dashboardImageUrl("runtime", "../bad", "preview")).toBeUndefined();
	});
});

describe("subagent stop transport", () => {
	it("POSTs to the selected subagent's encoded abort route and surfaces server errors", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: 'Background agent "agent/one" is no longer running.' }), {
					status: 502,
					headers: { "content-type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);

		await api.abortSubagent("runtime", "agent/one");
		expect(fetchMock).toHaveBeenCalledWith("/api/runtimes/runtime/subagents/agent%2Fone/abort", { method: "POST" });

		await expect(api.abortSubagent("runtime", "agent/one")).rejects.toThrow("is no longer running");
	});
});

describe("settings project context transport", () => {
	it("encodes cwd for settings reads and writes while preserving global URLs", async () => {
		const fetchMock = vi.fn().mockImplementation(
			async () =>
				new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const cwd = "/projects/one space?branch=a&mode=b#scope";
		const encoded = "%2Fprojects%2Fone%20space%3Fbranch%3Da%26mode%3Db%23scope";

		await api.settings(cwd);
		await api.settingsModels(cwd);
		await api.saveSettings({ enabledModels: ["openai/gpt"] }, cwd);
		await api.settings();
		await api.settingsModels();
		await api.saveSettings({ enabledModels: null });

		expect(fetchMock.mock.calls).toEqual([
			[`/api/settings?cwd=${encoded}`, undefined],
			[`/api/settings/models?cwd=${encoded}`, undefined],
			[
				`/api/settings?cwd=${encoded}`,
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ enabledModels: ["openai/gpt"] }),
				},
			],
			["/api/settings", undefined],
			["/api/settings/models", undefined],
			[
				"/api/settings",
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ enabledModels: null }),
				},
			],
		]);
	});
});

describe("Cloud Workspaces transport", () => {
	function mockJson(body: unknown, status = 200) {
		const fetchMock = vi
			.fn()
			.mockImplementation(
				async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
			);
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("GETs the exact workspace and project availability response", async () => {
		const body: CloudWorkspacesDto = {
			version: 1,
			pathStyle: "posix",
			workspaces: [
				{ id: "workspace/full-id", path: "/cloud/root", status: { available: true, path: "/cloud/root" } },
			],
			projects: [
				{
					id: "project/local",
					location: { kind: "local", path: "/local/project" },
					markerRequired: false,
					status: { available: true, path: "/local/project" },
				},
				{
					id: "project/cloud",
					location: { kind: "workspace", workspaceId: "workspace/full-id", relativePath: "nested/project" },
					markerRequired: true,
					status: { available: false, error: { code: "UNAVAILABLE", message: "Drive is offline" } },
				},
			],
		};
		const fetchMock = mockJson(body);
		expect(await api.cloudWorkspaces()).toEqual(body);
		expect(fetchMock.mock.calls).toEqual([["/api/cloud-workspaces", undefined]]);
	});

	it("reads only the narrow global session-storage endpoint", async () => {
		const body = { sessionDir: null, subagentSessionDir: null, restartRequired: false };
		const fetchMock = mockJson(body);
		expect(await api.cloudSessionStorage()).toEqual(body);
		expect(fetchMock.mock.calls).toEqual([["/api/cloud-workspaces/session-storage", undefined]]);
	});

	it.each([" /cloud root/ ", null])("PUTs an explicit log root/reset and captured expected pair: %s", async (root) => {
		const expected = { sessionDir: "/old main", subagentSessionDir: null };
		const fetchMock = mockJson({ ...expected, restartRequired: true });
		await api.saveCloudSessionStorage(root, expected);
		expect(fetchMock.mock.calls).toEqual([
			[
				"/api/cloud-workspaces/session-storage",
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ root, expected }),
				},
			],
		]);
	});

	it("retains session-storage conflict details without retrying", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 409,
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => ({ code: "CONFLICT", error: "Reload current log locations" }),
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			api.saveCloudSessionStorage(null, { sessionDir: null, subagentSessionDir: null }),
		).rejects.toMatchObject({
			status: 409,
			body: { code: "CONFLICT", error: "Reload current log locations" },
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([undefined, false, true])(
		"POSTs connect with initialize=%s without changing the path",
		async (initialize) => {
			const body = { path: " /cloud/a b/ ", ...(initialize === undefined ? {} : { initialize }) };
			const response = { id: "workspace/full-id", path: body.path };
			const fetchMock = mockJson(response);
			expect(await api.connectWorkspace(body)).toEqual(response);
			expect(fetchMock.mock.calls).toEqual([
				[
					"/api/cloud-workspaces/connect",
					{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
				],
			]);
		},
	);

	it.each<LinkProjectRequestDto>([
		{ path: " /local/project " },
		{ path: "/local/project", projectId: "project/full-id" },
		{ path: "/local/project", initialize: true, projectId: "project/new-id" },
		{ path: "/cloud/nested", workspaceId: "workspace/full-id" },
		{ path: "/cloud/nested", workspaceId: "workspace/full-id", initialize: false },
		{ path: "/cloud/nested", workspaceId: "workspace/full-id", projectId: "project/new-id", initialize: true },
	])("POSTs the complete link mode unchanged: %j", async (body) => {
		const fetchMock = mockJson({ id: "project/full-id" });
		expect(await api.linkProject(body)).toEqual({ id: "project/full-id" });
		expect(fetchMock.mock.calls).toEqual([
			[
				"/api/cloud-workspaces/link",
				{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
			],
		]);
	});

	it("PUTs rebinds with fully encoded IDs and exact local/workspace bodies", async () => {
		const fetchMock = mockJson({ id: "full/id", path: " /replacement/root " });
		const id = "full/id ?branch=a&b#c%雪";
		const encoded = "full%2Fid%20%3Fbranch%3Da%26b%23c%25%E9%9B%AA";
		await api.rebindWorkspace(id, " /replacement/root ");
		await api.rebindProject(id, { path: " /replacement/local " });
		await api.rebindProject(id, { path: "/replacement/root/project", workspaceId: "workspace/full-id" });
		expect(fetchMock.mock.calls).toEqual([
			[
				`/api/cloud-workspaces/workspaces/${encoded}`,
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: " /replacement/root " }),
				},
			],
			[
				`/api/cloud-workspaces/projects/${encoded}`,
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: " /replacement/local " }),
				},
			],
			[
				`/api/cloud-workspaces/projects/${encoded}`,
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: "/replacement/root/project", workspaceId: "workspace/full-id" }),
				},
			],
		]);
	});

	it.each([true, false])("DELETEs encoded rows and returns removed=%s", async (removed) => {
		const fetchMock = mockJson({ removed });
		expect(await api.unlinkProject("project/full id?#%")).toEqual({ removed });
		expect(await api.disconnectWorkspace("workspace/full id?#%")).toEqual({ removed });
		expect(fetchMock.mock.calls).toEqual([
			["/api/cloud-workspaces/projects/project%2Ffull%20id%3F%23%25", { method: "DELETE" }],
			["/api/cloud-workspaces/workspaces/workspace%2Ffull%20id%3F%23%25", { method: "DELETE" }],
		]);
	});

	it.each([
		{
			operation: "list",
			status: 503,
			code: "UNAVAILABLE",
			message: "Registry is unavailable",
			run: () => api.cloudWorkspaces(),
		},
		{
			operation: "rebind",
			status: 409,
			code: "CONFLICT",
			message: "Project marker belongs to another full ID",
			run: () => api.rebindProject("project/full-id", { path: "/replacement" }),
		},
		{
			operation: "project launch",
			status: 404,
			code: "NOT_FOUND",
			message: "Project ID is not linked",
			run: () => api.createProjectRuntime("project/full-id", { sessionPath: "/sessions/parent.jsonl" }),
		},
	])(
		"preserves server status, stable body.code, and message for failed $operation",
		async ({ status, code, message, run }) => {
			const body = { code, error: message };
			mockJson(body, status);
			await expect(run()).rejects.toMatchObject({ status, body, message });
		},
	);
});

describe("runtime directory transport", () => {
	function mockRuntime() {
		const runtime = { key: "created", cwd: " /host/resolved/project " };
		const fetchMock = vi
			.fn()
			.mockImplementation(
				async () =>
					new Response(JSON.stringify(runtime), { status: 200, headers: { "content-type": "application/json" } }),
			);
		vi.stubGlobal("fetch", fetchMock);
		return { fetchMock, runtime };
	}

	it("keeps legacy cwd creation separate from ID-only project creation", async () => {
		const { fetchMock, runtime } = mockRuntime();
		const options = { sessionPath: " /sessions/parent transcript.jsonl ", firstPrompt: "  exact prompt\n " };
		expect(await api.createRuntime(" /literal/local path/ ", options)).toEqual(runtime);
		expect(await api.createProjectRuntime("project/full-id", options)).toEqual(runtime);
		await api.createRuntime(" /literal/local path/ ");
		await api.createProjectRuntime("project/full-id");
		expect(fetchMock.mock.calls).toEqual([
			[
				"/api/runtimes",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ cwd: " /literal/local path/ ", ...options }),
				},
			],
			[
				"/api/runtimes",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ projectId: "project/full-id", ...options }),
				},
			],
			[
				"/api/runtimes",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ cwd: " /literal/local path/ " }),
				},
			],
			[
				"/api/runtimes",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ projectId: "project/full-id" }),
				},
			],
		]);
	});

	it.each<{ selection: string | RuntimeDirectorySelection; source: { cwd: string } | { projectId: string } }>([
		{ selection: " /literal/local path/ ", source: { cwd: " /literal/local path/ " } },
		{ selection: { kind: "local", cwd: " /literal/local path/ " }, source: { cwd: " /literal/local path/ " } },
		{ selection: { kind: "project", projectId: "project/full-id" }, source: { projectId: "project/full-id" } },
	])("centralizes directory creation without normalizing selection $selection", async ({ selection, source }) => {
		const { fetchMock, runtime } = mockRuntime();
		const options = { sessionPath: " /sessions/PARENT ?#%.jsonl ", firstPrompt: "  keep whitespace\n" };
		expect(await createRuntimeInDirectory(selection, options)).toEqual(runtime);
		expect(fetchMock.mock.calls).toEqual([
			[
				"/api/runtimes",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...source, ...options }),
				},
			],
		]);
	});

	it.each<{ selection: RuntimeDirectorySelection; ready: boolean }>([
		{ selection: { kind: "local", cwd: "" }, ready: false },
		{ selection: { kind: "local", cwd: " \t\n " }, ready: false },
		{ selection: { kind: "local", cwd: " /literal/local path/ " }, ready: true },
		{ selection: { kind: "project", projectId: "" }, ready: false },
		{ selection: { kind: "project", projectId: "project/full-id" }, ready: true },
	])("checks readiness without mutating the literal selection: $selection", ({ selection, ready }) => {
		const original = { ...selection };
		expect(runtimeDirectoryReady(selection)).toBe(ready);
		expect(selection).toEqual(original);
	});
});

describe("connectEvents lifecycle", () => {
	it("applies before advancing the cursor and preserves it across a guarded retry", async () => {
		vi.useFakeTimers();
		const applied: number[] = [];
		const result = setup();
		const first = result.source();
		first.open();
		result.onEnvelope.mockImplementation((item) => applied.push(item.seq));
		first.message(envelope(7));
		expect(applied).toEqual([7]);
		first.error();
		expect(first.closed).toBe(true); // suppress EventSource's native retry
		expect(result.statuses.at(-1)?.state).toBe("disconnected");
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(100);
		expect(result.source().url).toBe("/api/events?lastEventId=7");
		expect(result.statuses.at(-1)?.state).toBe("connecting");
		result.disconnect();
	});

	it("closes and resumes from the last applied cursor after a numeric sequence gap", async () => {
		vi.useFakeTimers();
		const applied: number[] = [];
		const result = setup();
		const first = result.source();
		result.onEnvelope.mockImplementation((item) => applied.push(item.seq));
		first.open();
		first.message(envelope(1));
		first.message(envelope(3));
		expect(first.closed).toBe(true);
		expect(result.recovery).toHaveBeenCalledWith("protocol");
		expect(applied).toEqual([1]);
		await vi.advanceTimersByTimeAsync(100);
		expect(result.source().url).toBe("/api/events?lastEventId=1");
		result.disconnect();
	});

	it("accepts a resync barrier across an evicted range or server sequence reset", () => {
		const applied: number[] = [];
		const result = setup();
		result.onEnvelope.mockImplementation((item) => applied.push(item.seq));
		result.source().open();
		result.source().message(envelope(7));
		result.source().message({ seq: 500, key: "", event: { type: "dashboard_resync", reason: "buffer_gap" } });
		result.source().message({ seq: 1, key: "", event: { type: "dashboard_resync", reason: "empty_buffer" } });
		result.source().message(envelope(2));
		expect(applied).toEqual([7, 500, 1, 2]);
		expect(result.recovery).not.toHaveBeenCalled();
		result.disconnect();
	});

	it("uses capped jittered backoff, resets only after a healthy interval, and owns one retry", async () => {
		vi.useFakeTimers();
		const result = setup({ random: () => 1, healthyResetMs: 1_000 });
		result.source().error();
		await Promise.resolve();
		expect(result.statuses.at(-1)).toMatchObject({ state: "retrying", attempt: 1, retryDelayMs: 125 });
		result.source().error(); // stale/closed callback cannot create a second timer
		await vi.advanceTimersByTimeAsync(125);
		const second = result.source();
		second.open();
		expect(result.statuses.at(-1)).toMatchObject({ state: "connected", attempt: 1 });
		second.error(); // a brief open must not reset backoff
		await Promise.resolve();
		expect(result.statuses.at(-1)).toMatchObject({ state: "retrying", attempt: 2, retryDelayMs: 250 });
		await vi.advanceTimersByTimeAsync(250);
		const third = result.source();
		third.open();
		result.setNow(1_000);
		third.named("heartbeat");
		expect(result.statuses.at(-1)).toMatchObject({ state: "connected", attempt: 0 });
		result.disconnect();
	});

	it("keeps actual jittered delays within the configured cap", async () => {
		vi.useFakeTimers();
		const result = setup({ random: () => 1, maxDelayMs: 400 });
		result.source().error();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(125);
		result.source().error();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(250);
		result.source().error();
		await Promise.resolve();
		expect(result.statuses.at(-1)).toMatchObject({ state: "retrying", attempt: 3, retryDelayMs: 400 });
		result.disconnect();

		const lower = setup({ random: () => 0, maxDelayMs: 400 });
		lower.source().error();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(75);
		lower.source().error();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(150);
		lower.source().error();
		await Promise.resolve();
		expect(lower.statuses.at(-1)).toMatchObject({ state: "retrying", attempt: 3, retryDelayMs: 300 });
		lower.disconnect();
	});

	it("times out a hung watchdog validation into a bounded retry", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const status = vi.fn((candidateSignal?: AbortSignal) => {
			signal = candidateSignal;
			return new Promise<never>(() => {});
		});
		const result = setup({ status, watchdogMs: 10, statusTimeoutMs: 50 });
		const first = result.source();
		first.open();
		result.setNow(11);
		await vi.advanceTimersByTimeAsync(10);
		expect(first.closed).toBe(true);
		expect(result.recovery).toHaveBeenCalledWith("watchdog");
		expect(status).toHaveBeenCalledOnce();
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(50);
		expect(signal?.aborted).toBe(true);
		expect(result.statuses.at(-1)).toMatchObject({ state: "retrying", attempt: 1, retryDelayMs: 100 });
		await vi.advanceTimersByTimeAsync(100);
		expect(FakeEventSource.instances).toHaveLength(2);
		result.disconnect();
	});

	it("times out a hung transport validation into the same capped retry", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const status = vi.fn((candidateSignal?: AbortSignal) => {
			signal = candidateSignal;
			return new Promise<never>(() => {});
		});
		const result = setup({ status, statusTimeoutMs: 50 });
		result.source().error();
		expect(status).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(50);
		expect(signal?.aborted).toBe(true);
		expect(result.statuses.at(-1)).toMatchObject({ state: "retrying", attempt: 1, retryDelayMs: 100 });
		await vi.advanceTimersByTimeAsync(100);
		expect(FakeEventSource.instances).toHaveLength(2);
		result.disconnect();
	});

	it("aborts in-flight validation during cleanup and ignores its stale completion", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		let resolveStatus: (() => void) | undefined;
		const status = vi.fn((candidateSignal?: AbortSignal) => {
			signal = candidateSignal;
			return new Promise<void>((resolve) => {
				resolveStatus = resolve;
			});
		});
		const result = setup({ status, statusTimeoutMs: 50 });
		const first = result.source();
		first.error();
		await Promise.resolve();
		expect(status).toHaveBeenCalledOnce();
		expect(signal?.aborted).toBe(false);
		result.disconnect();
		expect(signal?.aborted).toBe(true);
		resolveStatus?.();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(FakeEventSource.instances).toHaveLength(1);
		expect(result.statuses.at(-1)?.state).toBe("disconnected");
	});

	it("validates immediately when returning to the foreground and removes its visibility listener", async () => {
		const visibility = new FakeVisibility();
		const status = vi.fn().mockResolvedValue({ mode: "local" });
		const result = setup({ visibility, status });
		result.source().open();
		visibility.visibilityState = "hidden";
		visibility.emit();
		visibility.visibilityState = "visible";
		visibility.emit();
		await Promise.resolve();
		expect(status).toHaveBeenCalledTimes(1);
		result.disconnect();
		visibility.emit();
		expect(status).toHaveBeenCalledTimes(1);
	});

	it("treats malformed envelopes and reducer failures as loud full recovery without cursor advancement", async () => {
		vi.useFakeTimers();
		const result = setup();
		result.source().open();
		result.source().message({ seq: "bad" });
		expect(result.recovery).toHaveBeenCalledWith("protocol");
		expect(result.statuses.some((status) => status.state === "resyncing")).toBe(true);
		const second = setup();
		second.onEnvelope.mockImplementation(() => {
			throw new Error("reducer failed");
		});
		second.source().open();
		second.source().message(envelope(1));
		expect(second.recovery).toHaveBeenCalledWith("handler");
		await vi.advanceTimersByTimeAsync(100);
		expect(second.source().url).toBe("/api/events");
		second.disconnect();
		result.disconnect();
	});

	it("ignores stale source callbacks and removes every named listener on close", async () => {
		vi.useFakeTimers();
		const result = setup();
		const first = result.source();
		const staleError = first.onerror!;
		first.error();
		await Promise.resolve();
		staleError(new Event("error"));
		await vi.advanceTimersByTimeAsync(100);
		expect(FakeEventSource.instances).toHaveLength(2);
		result.disconnect();
		expect(first.listeners.get("heartbeat")).toEqual([]);
		expect(first.listeners.get("connection")).toEqual([]);
	});

	it("treats a foreground 403 as auth_failed without scheduling another retry", async () => {
		vi.useFakeTimers();
		const visibility = new FakeVisibility();
		const status = vi.fn().mockRejectedValue(Object.assign(new Error("denied"), { status: 403 }));
		const result = setup({ visibility, status });
		result.source().open();
		visibility.visibilityState = "hidden";
		visibility.emit();
		visibility.visibilityState = "visible";
		visibility.emit();
		await Promise.resolve();
		await Promise.resolve();
		expect(result.statuses.at(-1)?.state).toBe("auth_failed");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(FakeEventSource.instances).toHaveLength(1);
		result.disconnect();
	});

	it("propagates successful foreground and reconnect auth status to the shared handler", async () => {
		vi.useFakeTimers();
		const visibility = new FakeVisibility();
		const authStatus = {
			mode: "remote" as const,
			needsPairing: false,
			identity: "alice@example.com",
			pairingExpiryWarning: { expiresAt: "2030-07-01T00:00:00.000Z" },
		};
		const status = vi.fn().mockResolvedValue(authStatus);
		const result = setup({ visibility, status });
		result.source().open();

		visibility.visibilityState = "hidden";
		visibility.emit();
		visibility.visibilityState = "visible";
		visibility.emit();
		await Promise.resolve();
		await Promise.resolve();
		expect(result.onAuthStatus).toHaveBeenCalledWith(authStatus);

		result.source().error();
		await Promise.resolve();
		await Promise.resolve();
		expect(result.onAuthStatus).toHaveBeenCalledTimes(2);
		result.disconnect();
	});

	it("reports terminal diagnostics for the old connection and measures event rate from connection start", async () => {
		vi.useFakeTimers();
		const diagnostic = vi.fn();
		const result = setup({ diagnostic });
		const first = result.source();
		first.open();
		first.named("connection", JSON.stringify({ connectionId: "old" }));
		first.message(envelope(1));
		result.setNow(60_000);
		first.named("heartbeat");
		first.error();
		await Promise.resolve();
		const terminal = diagnostic.mock.calls
			.map(([summary]) => summary)
			.find((summary) => summary.state === "disconnected");
		expect(terminal).toMatchObject({ connectionId: "old", eventRatePerMinute: 1 });
		await vi.advanceTimersByTimeAsync(100);
		const second = result.source();
		second.open();
		second.named("connection", JSON.stringify({ connectionId: "new" }));
		await Promise.resolve();
		expect(diagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: "new", state: "connected" }));
		result.disconnect();
	});

	it("uses named heartbeat liveness, foreground watchdog recovery, auth denial, and cleanup", async () => {
		vi.useFakeTimers();
		const status = vi.fn().mockRejectedValue(Object.assign(new Error("denied"), { status: 403 }));
		const result = setup({ status });
		const source = result.source();
		source.open();
		result.setNow(29_999);
		source.named("heartbeat");
		result.setNow(59_000);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(result.recovery).not.toHaveBeenCalled();
		result.setNow(90_000);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(result.recovery).toHaveBeenCalledWith("watchdog");
		// Transport error verifies /api/auth and stops retrying on a real denial.
		await vi.advanceTimersByTimeAsync(100);
		result.source().error();
		await Promise.resolve();
		await Promise.resolve();
		expect(status).toHaveBeenCalled();
		expect(result.statuses.at(-1)?.state).toBe("auth_failed");
		result.disconnect();
		expect(source.closed).toBe(true);
	});
});
