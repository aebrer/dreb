// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	connectEvents,
	type EventConnectionStatus,
	type EventSourceLike,
	type EventStreamDependencies,
} from "../../src/client/api.js";

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
	const recovery = vi.fn();
	const deps: EventStreamDependencies = {
		EventSource: FakeEventSource,
		now: () => now,
		random: () => 0.5,
		status: vi.fn().mockResolvedValue({ mode: "local" }),
		baseDelayMs: 100,
		maxDelayMs: 400,
		watchdogMs: 30_000,
		...overrides,
	};
	const disconnect = connectEvents(
		{ onEnvelope, onRecovery: recovery, onStatusChange: (status) => statuses.push(status) },
		deps,
	);
	return {
		statuses,
		onEnvelope,
		recovery,
		disconnect,
		source: () => FakeEventSource.instances.at(-1)!,
		setNow: (value: number) => {
			now = value;
		},
	};
}

afterEach(() => vi.useRealTimers());

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

	it("treats malformed envelopes and reducer failures as loud full recovery without cursor advancement", () => {
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
