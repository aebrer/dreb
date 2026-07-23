// @vitest-environment jsdom

import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { RpcClient } from "@dreb/coding-agent/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppStore } from "../../src/client/state/store.js";
import { DashboardAuth } from "../../src/server/auth.js";
import { RuntimePool } from "../../src/server/runtime-pool.js";
import { createDashboardServer } from "../../src/server/server.js";

class FakeEventSource {
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

	message(data: unknown): void {
		this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
	}
}

function makeRuntimeClient() {
	const emitter = new EventEmitter();
	const client = {
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		onEvent: vi.fn((listener: (event: unknown) => void) => {
			emitter.on("event", listener);
			return () => emitter.off("event", listener);
		}),
		onExit: vi.fn((listener: (info: unknown) => void) => {
			emitter.on("exit", listener);
			return () => emitter.off("exit", listener);
		}),
		getState: vi.fn(),
		getDashboardSnapshot: vi.fn(async () => {
			emitter.emit("event", { type: "dashboard_snapshot_barrier", snapshotId: "snapshot-1" });
			return {
				snapshotId: "snapshot-1",
				state: {
					sessionId: "s1",
					tasks: [],
					thinkingLevel: "medium",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "one-at-a-time",
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0,
				},
				messages: [],
				backgroundAgents: [],
			};
		}),
		getMessages: vi.fn(async () => []),
		getSessionStats: vi.fn(async () => ({
			sessionFile: undefined,
			sessionId: "s1",
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		})),
		getLastAssistantText: vi.fn(async () => undefined),
		listBackgroundAgents: vi.fn(async () => []),
		emit: (event: unknown) => emitter.emit("event", event),
	};
	return client as unknown as RpcClient & {
		getState: ReturnType<typeof vi.fn>;
		getDashboardSnapshot: ReturnType<typeof vi.fn>;
		getMessages: ReturnType<typeof vi.fn>;
		emit(event: unknown): void;
	};
}

const servers: Server[] = [];
const pools: RuntimePool[] = [];
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

afterEach(async () => {
	globalThis.fetch = originalFetch;
	globalThis.EventSource = originalEventSource;
	FakeEventSource.instances = [];
	window.location.hash = "#/";
	for (const pool of pools.splice(0)) await pool.stopAll();
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	vi.restoreAllMocks();
});

async function startHttpRuntime() {
	const client = makeRuntimeClient();
	const pool = new RuntimePool({
		cliPath: "/fake/cli.js",
		clientFactory: () => client,
		logger: () => {},
	});
	pools.push(pool);
	const app = createDashboardServer({
		auth: new DashboardAuth(),
		pool,
		listAllSessions: async () => [],
		deleteSession: async () => ({ method: "trash" }),
		logger: () => {},
	});
	const server = await new Promise<Server>((resolve) => {
		const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
	});
	servers.push(server);
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("server did not bind a TCP port");
	const base = `http://127.0.0.1:${address.port}`;
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const target = typeof input === "string" && input.startsWith("/") ? `${base}${input}` : input;
		return originalFetch(target, init);
	}) as typeof fetch;
	globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
	return { pool, client, base };
}

describe("dashboard hard-refresh task restoration", () => {
	it("restores non-empty tasks through the real HTTP runtime path despite startup SSE remount races", async () => {
		const { pool, client } = await startHttpRuntime();
		const tasks = [{ id: "restore", title: "restore task after refresh", status: "in_progress" as const }];
		vi.mocked(client.getDashboardSnapshot).mockImplementationOnce(async () => {
			client.emit({ type: "dashboard_snapshot_barrier", snapshotId: "snapshot-restore" });
			return {
				snapshotId: "snapshot-restore",
				state: {
					sessionId: "s1",
					tasks,
					thinkingLevel: "medium",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "one-at-a-time",
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0,
				},
				messages: [],
				backgroundAgents: [],
			};
		});
		const handle = await pool.create("/tmp/dashboard-hard-refresh");
		window.location.hash = `#/session/${handle.key}`;
		const store = createAppStore();

		await store.start();
		const source = FakeEventSource.instances.at(-1);
		if (!source) throw new Error("store did not create an EventSource");
		const hydrate = store.hydrateSession(handle.key);
		// A hard refresh can receive startup/live events before the atomic hydrate
		// settles. Those events must not make the store drop the runtime task snapshot.
		source.message({ seq: 1, key: handle.key, event: { type: "agent_start" } });
		await hydrate;
		// A later startup-ish event must not clear the restored task list either.
		source.message({ seq: 2, key: handle.key, event: { type: "agent_start" } });

		expect(store.sessions[handle.key]?.tasks).toEqual(tasks);
		expect(client.getDashboardSnapshot).toHaveBeenCalledOnce();
		expect(client.getMessages).not.toHaveBeenCalled();
		store.stop();
	});
});
