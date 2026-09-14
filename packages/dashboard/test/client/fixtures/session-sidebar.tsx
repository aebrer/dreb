/**
 * Real-App fixture for the session fleet-sidebar browser regression suite.
 *
 * It renders the ACTUAL shipped `App` (keyed route lifecycle, store routing,
 * hydrate, and reducer) against production stylesheets. The only test-only
 * seam is a synthetic `EventSource` replacement plus a `window.__sse` event
 * injection helper: the real dashboard SSE endpoint is never contacted and no
 * runtime is ever created or stopped. Every REST call is faked at the network
 * layer by the test (see session-sidebar.browser.test.ts). Nothing here
 * instruments the production components.
 */

import { render } from "solid-js/web";
import { App } from "../../../src/client/app.js";
import "../../../src/client/styles/tokens.css";
import "../../../src/client/styles/app.css";
import "../../../src/client/styles/themes.css";

interface InjectableMessage {
	type: string;
	data: string;
}

/**
 * A minimal EventSource stand-in. It performs no network I/O; instead the test
 * drives the store's SSE reducer through `window.__sse`, which dispatches
 * envelopes onto the live instance the store most recently opened. The store's
 * own generation/cursor guards remain fully in force.
 */
class FakeEventSource implements EventSource {
	static readonly instances: FakeEventSource[] = [];

	readonly url: string;
	readonly withCredentials = false;
	readonly CONNECTING = 0 as const;
	readonly OPEN = 1 as const;
	readonly CLOSED = 2 as const;
	readyState = 0;
	onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
	onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
	onerror: ((this: EventSource, ev: Event) => unknown) | null = null;

	private readonly listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
	private closed = false;

	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
		// Open on a microtask so store setup (listener wiring) finishes first.
		queueMicrotask(() => {
			if (this.closed) return;
			this.readyState = this.OPEN;
			this.onopen?.call(this as unknown as EventSource, new Event("open"));
			this.deliver({ type: "connection", data: JSON.stringify({ connectionId: "fixture-connection" }) });
		});
	}

	addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
	}

	removeEventListener(type: string, listener: (ev: MessageEvent) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	dispatchEvent(): boolean {
		return true;
	}

	close(): void {
		this.closed = true;
		this.readyState = this.CLOSED;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	deliver(message: InjectableMessage): void {
		if (this.closed) return;
		const event = new MessageEvent(message.type, { data: message.data });
		if (message.type === "message") {
			this.onmessage?.call(this as unknown as EventSource, event);
		} else {
			for (const listener of this.listeners.get(message.type) ?? []) listener(event);
		}
	}
}

(window as unknown as { EventSource: typeof EventSource }).EventSource =
	FakeEventSource as unknown as typeof EventSource;

function activeSource(): FakeEventSource {
	for (let index = FakeEventSource.instances.length - 1; index >= 0; index -= 1) {
		const candidate = FakeEventSource.instances[index];
		if (!candidate.isClosed) return candidate;
	}
	throw new Error("session-sidebar fixture: no open EventSource to inject into");
}

let seq = 0;

interface SseHelper {
	emit(event: Record<string, unknown>, key?: string): void;
	fleetSnapshot(runtimes: unknown[]): void;
	runtimeRemoved(key: string): void;
}

const helper: SseHelper = {
	emit(event, key = "") {
		seq += 1;
		activeSource().deliver({ type: "message", data: JSON.stringify({ seq, key, event }) });
	},
	fleetSnapshot(runtimes) {
		this.emit({ type: "fleet_snapshot", runtimes }, "");
	},
	runtimeRemoved(key) {
		this.emit({ type: "runtime_removed" }, key);
	},
};

(window as unknown as { __sse: SseHelper }).__sse = helper;

render(() => <App />, document.getElementById("root")!);
