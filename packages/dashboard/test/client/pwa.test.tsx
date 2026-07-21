// @vitest-environment jsdom
/**
 * PWA client tests — service worker registration guard + the
 * needs-attention notification dispatch gating (the Android `Illegal
 * constructor` fix: notifications now go through `registration.showNotification`
 * via the service worker, not the page-context `new Notification()`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom lacks ResizeObserver; real browsers always have it. Install a no-op so
// the stick-to-bottom controller (mounted via <App>'s SessionScreen) attaches
// quietly instead of logging its (correct) "ResizeObserver unavailable" warning.
if (!(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver) {
	class NoopResizeObserver {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	}
	(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
		NoopResizeObserver as unknown as typeof ResizeObserver;
}

// Mock the API + SSE so <App> mounts without a server. Mirrors screens.test.tsx.
vi.mock("../../src/client/api.js", () => ({
	api: {
		auth: vi.fn(async () => ({ mode: "local", needsPairing: false })),
		fleet: vi.fn(async () => ({ runtimes: [], diskSessions: [] })),
		sessions: vi.fn(async () => ({ sessions: [] })),
		hydrate: vi.fn(async (key: string) => ({
			key,
			state: {
				sessionId: key,
				tasks: [],
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				autoCompactionEnabled: true,
				messageCount: 0,
				pendingMessageCount: 0,
			},
			messages: [],
			backgroundAgents: [],
			barrierSeq: 0,
		})),
		messages: vi.fn(async () => ({ messages: [] })),
		backgroundAgents: vi.fn(async () => ({ agents: [] })),
		subagentMessages: vi.fn(async () => ({ agent: null, messages: [] })),
		models: vi.fn(async () => ({ models: [] })),
		settingsModels: vi.fn(async () => ({ models: [] })),
		agentTypes: vi.fn(async () => ({ agentTypes: [] })),
		settings: vi.fn(async () => ({ defaultProvider: "test", defaultModel: "m1" })),
		devices: vi.fn(async () => ({ devices: [] })),
		pairingCode: vi.fn(async () => ({ enabled: false })),
		version: vi.fn(async () => ({ version: "0.0.0-test" })),
		serverInfo: vi.fn(async () => ({
			version: "0.0.0-test",
			startedAt: new Date().toISOString(),
			supervised: false,
			restartable: true,
		})),
		stats: vi.fn(async () => ({
			sessionId: "s1",
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		})),
		performance: vi.fn(async () => ({ models: [] })),
		resources: vi.fn(async () => ({
			contextFiles: [],
			skills: [],
			extensions: [],
			promptTemplates: [],
			systemPromptPresent: false,
		})),
		transportChoices: vi.fn(async () => ({})),
		// SessionScreen on mount hits branch/dailyCost/commands/pending/runtime
		// (called sync inside refreshRuntimeDetails before allSettled, so a missing
		// stub throws synchronously and leaks an unhandled rejection when the
		// badge test drives a routed session). Stubbed to safe defaults mirroring
		// screens.test.tsx.
		branch: vi.fn(async () => ({ branch: null })),
		dailyCost: vi.fn(async () => ({ cost: 0 })),
		commands: vi.fn(async () => ({ commands: [] })),
		pending: vi.fn(async () => ({ steering: [], followUp: [] })),
		dequeue: vi.fn(async () => ({ steering: [], followUp: [] })),
		runtime: vi.fn(async (key: string) => ({
			key,
			cwd: "/tmp/p",
			state: {
				sessionId: key,
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				autoCompactionEnabled: true,
				messageCount: 0,
				pendingMessageCount: 0,
			},
			backgroundAgents: [],
			needsAttention: false,
			createdAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
		})),
		exportHtmlUrl: (key: string) => `/api/runtimes/${key}/export-html`,
	},
	connectEvents: vi.fn(() => () => {}),
}));

import { render } from "solid-js/web/dist/web.js";
import { api, connectEvents } from "../../src/client/api.js";
import { App } from "../../src/client/app.js";

const disposers: Array<() => void> = [];
let showNotification: ReturnType<typeof vi.fn>;
let registerSpy: ReturnType<typeof vi.fn>;
// SW message listeners registered via navigator.serviceWorker.addEventListener.
// Kept real (not a vi.fn() spy that swallows registrations) so tests can dispatch
// synthetic MessageEvents on the recorded handler — mirrors how the SW posts
// navigate-session messages to the open dashboard client.
let swMessageHandlers: Array<(event: MessageEvent) => void>;

beforeEach(() => {
	// Always install a Map-backed localStorage shim. jsdom's own storage can be
	// present-but-broken (e.g. when node is launched with a bad
	// `--localstorage-file`, its methods aren't functions), so a `!localStorage`
	// guard would leave those broken methods in place. Redefining unconditionally
	// (the property is configurable) is deterministic and functionally identical
	// where jsdom's storage works.
	const values = new Map<string, string>();
	Object.defineProperty(window, "localStorage", {
		configurable: true,
		value: {
			getItem: (k: string) => values.get(k) ?? null,
			setItem: (k: string, v: string) => values.set(k, String(v)),
			removeItem: (k: string) => values.delete(k),
			clear: () => values.clear(),
			key: (i: number) => [...values.keys()][i] ?? null,
			get length() {
				return values.size;
			},
		},
	});

	// SW registration mock — `ready` resolves to a registration with a
	// `showNotification` spy so the app's notification code can call it.
	showNotification = vi.fn();
	registerSpy = vi.fn(async () => ({
		showNotification,
	}));
	swMessageHandlers = [];
	// @ts-expect-error partial mock
	navigator.serviceWorker = {
		register: registerSpy,
		ready: Promise.resolve({ showNotification }),
		// Real recorder — stores the handler so tests can dispatch synthetic
		// MessageEvents on it (app.tsx registers the navigate-session listener
		// here during onMount). A vi.fn() spy would swallow the registration.
		addEventListener: (type: string, handler: (event: MessageEvent) => void) => {
			if (type === "message") swMessageHandlers.push(handler);
		},
	};

	// Notification global mock — permission controllable per-test via setPermission().
	(globalThis as { Notification?: unknown }).Notification = function Notification() {};
	setPermission("default");
});

afterEach(() => {
	vi.useRealTimers();
	for (const dispose of disposers.splice(0)) dispose();
	document.body.innerHTML = "";
	window.location.hash = "#/";
	window.localStorage.clear();
	vi.mocked(connectEvents).mockImplementation(() => () => {});
	vi.mocked(api.auth).mockResolvedValue({ mode: "local", needsPairing: false });
	vi.mocked(api.fleet).mockResolvedValue({ runtimes: [], diskSessions: [] });
	vi.mocked(api.messages).mockResolvedValue({ messages: [] });
	vi.restoreAllMocks();
});

function setPermission(p: NotificationPermission): void {
	Object.defineProperty(globalThis.Notification, "permission", {
		configurable: true,
		value: p,
	});
}

function setHidden(hidden: boolean): void {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: hidden ? "hidden" : "visible",
	});
}

function makeRuntime(key: string, needsAttention = false) {
	return {
		key,
		cwd: "/tmp/p",
		state: {
			sessionId: key,
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		},
		backgroundAgents: [],
		needsAttention,
		createdAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
	};
}

/** Mount <App> and flush Solid effects + the SW.ready microtask chain. */
async function mountAppAndFlush(): Promise<void> {
	const root = document.createElement("div");
	document.body.appendChild(root);
	disposers.push(render(() => <App />, root));
	// Let Solid effects run + SW.ready promise chain settle.
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
}

/**
 * Capture the SSE `onEnvelope` handler the store registers via connectEvents
 * so a test can push synthetic envelopes (session_name_changed, agent_start,
 * …) to drive session-state + fleet-refresh reactions. mockImplementationOnce
 * is consumed by the single connectEvents call App's start() makes on mount.
 */
function captureEnvelopeHandler(): {
	push: (env: { seq: number; key: string; event: Record<string, unknown> }) => void;
} {
	let onEnvelope: ((e: { seq: number; key: string; event: Record<string, unknown> }) => void) | undefined;
	vi.mocked(connectEvents).mockImplementationOnce((handlers) => {
		onEnvelope = handlers.onEnvelope;
		return () => {};
	});
	return { push: (env) => onEnvelope?.(env) };
}

async function flushEffects(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
}

/** Runtime with an explicit display name + a long session id (for truncation tests). */
function makeNamedRuntime(key: string, name: string | undefined, needsAttention: boolean) {
	const rt = makeRuntime(key, needsAttention);
	(rt.state as { sessionName?: string }).sessionName = name;
	(rt.state as { sessionId: string }).sessionId = `${key}longsuffix1234`;
	return rt;
}

describe("PWA client — service worker registration", () => {
	it("registers /sw.js when navigator.serviceWorker exists", async () => {
		await mountAppAndFlush();
		expect(registerSpy).toHaveBeenCalledWith("./sw.js");
	});

	it("does not throw when navigator.serviceWorker is absent", async () => {
		// @ts-expect-error remove the mock
		delete (navigator as { serviceWorker?: unknown }).serviceWorker;
		await expect(mountAppAndFlush()).resolves.toBeUndefined();
	});

	it("logs and keeps the dashboard usable when SW registration rejects", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		registerSpy.mockRejectedValueOnce(new Error("registration failed"));

		await expect(mountAppAndFlush()).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith("dashboard: service worker registration failed", expect.any(Error));
		warnSpy.mockRestore();
	});
});

describe("PWA client — navigate-session SW→app message bridge", () => {
	it("registers a message listener on navigator.serviceWorker", async () => {
		const addSpy = vi.spyOn(navigator.serviceWorker, "addEventListener");
		await mountAppAndFlush();
		expect(addSpy).toHaveBeenCalledWith("message", expect.any(Function));
	});

	it("navigates the store to the session screen on a navigate-session message for a known session", async () => {
		vi.mocked(api.fleet).mockResolvedValue({
			runtimes: [makeRuntime("test-123")],
			diskSessions: [],
		});
		await mountAppAndFlush();
		expect(swMessageHandlers.length).toBeGreaterThan(0);
		const handler = swMessageHandlers[swMessageHandlers.length - 1];
		handler(new MessageEvent("message", { data: { type: "navigate-session", sessionKey: "test-123" } }));
		// store.navigate({screen:'session', key}) sets window.location.hash to
		// `#/session/<key>` (see state/store.ts routeToHash); the hashchange
		// listener then updates the route signal.
		expect(window.location.hash).toBe("#/session/test-123");
	});

	it("routes to fleet instead of a blank session view when the navigate-session key is stale", async () => {
		window.location.hash = "#/settings";
		await mountAppAndFlush();
		const handler = swMessageHandlers[swMessageHandlers.length - 1];
		handler(new MessageEvent("message", { data: { type: "navigate-session", sessionKey: "deleted-456" } }));
		expect(window.location.hash).toBe("#/");
	});

	it("ignores messages that are not navigate-session events", async () => {
		await mountAppAndFlush();
		const handler = swMessageHandlers[swMessageHandlers.length - 1];
		handler(new MessageEvent("message", { data: { type: "something-else", sessionKey: "no-456" } }));
		expect(window.location.hash).toBe("#/");
		handler(new MessageEvent("message", { data: { type: "navigate-session" } }));
		expect(window.location.hash).toBe("#/");
	});
});

describe("PWA client — notification dispatch gating", () => {
	async function seedNeedsAttention(): Promise<void> {
		// Replace the fleet with a single runtime that needs attention so the
		// notification effect has something to fire on. Use a fresh object on each
		// api.fleet() call so later forced refreshes can re-trigger Solid effects.
		vi.mocked(api.fleet).mockImplementation(async () => ({
			runtimes: [makeRuntime("att-1", true)],
			diskSessions: [],
		}));
		vi.mocked(api.auth).mockResolvedValue({ mode: "local", needsPairing: false });
	}

	it("fires registration.showNotification when permission granted and page hidden", async () => {
		setPermission("granted");
		setHidden(true);
		await seedNeedsAttention();
		await mountAppAndFlush();
		expect(showNotification).toHaveBeenCalled();
		const call = showNotification.mock.calls[0];
		expect(call?.[0]).toContain("dreb");
		const opts = call?.[1] as { data?: { sessionKey?: string } };
		expect(opts?.data?.sessionKey).toBe("att-1");
	});

	it("fires for store.sessions UI requests with the request title as the reason", async () => {
		setPermission("granted");
		setHidden(true);
		const stream = captureEnvelopeHandler();
		await mountAppAndFlush();

		stream.push({ seq: 1, key: "sess-ui", event: { type: "session_name_changed", name: "Review Session" } });
		stream.push({
			seq: 2,
			key: "sess-ui",
			event: { type: "extension_ui_request", id: "req-1", method: "confirm", title: "Approve deploy" },
		});
		await flushEffects();

		expect(document.title).toContain("◆");
		expect(showNotification).toHaveBeenCalledWith(
			"dreb — Review Session",
			expect.objectContaining({
				body: "waiting for input — Approve deploy",
				tag: "sess-ui",
				data: { sessionKey: "sess-ui" },
			}),
		);
	});

	it("fires for store.sessions error status entries with the error text as the reason", async () => {
		setPermission("granted");
		setHidden(true);
		const stream = captureEnvelopeHandler();
		await mountAppAndFlush();

		stream.push({ seq: 1, key: "sess-error", event: { type: "session_name_changed", name: "Error Session" } });
		stream.push({
			seq: 2,
			key: "sess-error",
			event: { type: "auto_retry_end", success: false, finalError: "model failed hard" },
		});
		await flushEffects();

		expect(showNotification).toHaveBeenCalledWith(
			"dreb — Error Session",
			expect.objectContaining({
				body: "model failed hard",
				tag: "sess-error",
				data: { sessionKey: "sess-error" },
			}),
		);
	});

	it("does NOT fire when permission is not granted", async () => {
		setPermission("default");
		setHidden(true);
		await seedNeedsAttention();
		await mountAppAndFlush();
		expect(showNotification).not.toHaveBeenCalled();
	});

	it("does NOT fire when permission is denied", async () => {
		setPermission("denied");
		setHidden(true);
		await seedNeedsAttention();
		await mountAppAndFlush();
		expect(showNotification).not.toHaveBeenCalled();
	});

	it("does NOT fire when the page is visible (the title ◆ badge is the in-tab signal)", async () => {
		setPermission("granted");
		setHidden(false);
		await seedNeedsAttention();
		await mountAppAndFlush();
		expect(showNotification).not.toHaveBeenCalled();
		// Tab-title badge still present as the no-SW / visible fallback.
		expect(document.title).toContain("◆");
	});

	it("does NOT re-fire for the same attention key (dedup via notifiedAttention)", async () => {
		setPermission("granted");
		setHidden(true);
		await seedNeedsAttention();
		await mountAppAndFlush();
		expect(showNotification).toHaveBeenCalledTimes(1);
		// Re-flush effects — the same key should not produce a second notification.
		await new Promise((r) => setTimeout(r, 10));
		expect(showNotification).toHaveBeenCalledTimes(1);
	});

	it("retries a needs-attention notification after showNotification rejects", async () => {
		setPermission("granted");
		setHidden(true);
		await seedNeedsAttention();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		showNotification.mockRejectedValueOnce(new Error("permission revoked mid-flight"));
		showNotification.mockResolvedValueOnce(undefined);

		await mountAppAndFlush();
		expect(showNotification).toHaveBeenCalledTimes(1);
		// First attempt rejected and must NOT mark the key as notified; force a
		// reactive rerun with the same attention key by changing the route (the
		// notification effect depends on store.route()). If the key had been added
		// before the rejection, this second run would skip the retry.
		window.location.hash = "#/settings";
		window.dispatchEvent(new HashChangeEvent("hashchange"));
		await Promise.resolve();
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));

		expect(showNotification).toHaveBeenCalledTimes(2);
		expect(warnSpy).toHaveBeenCalledWith("dashboard: showNotification failed", expect.any(Error));
		warnSpy.mockRestore();
	});
});

describe("PWA client — browser tab ◆ attention badge", () => {
	// The ◆ prefix on document.title is the primary in-tab attention signal and
	// the no-SW fallback. Prior rounds had only a single `toContain("◆")`
	// assertion; these cover badge presence for a fleet-runtime attention flag,
	// name formatting ("◆ <name> — dreb"), the no-name "◆ dreb" form, and badge
	// removal once attention clears.

	it("shows a plain title with no ◆ when nothing needs attention", async () => {
		vi.mocked(api.fleet).mockResolvedValue({ runtimes: [], diskSessions: [] });
		await mountAppAndFlush();
		expect(document.title).toBe("dreb");
		expect(document.title).not.toContain("◆");
	});

	it("badges the title with the runtime's sessionName when a runtime needs attention and is open", async () => {
		// Routed to the session: displayName comes from currentRuntime.state.sessionName.
		vi.mocked(api.fleet).mockResolvedValue({
			runtimes: [makeNamedRuntime("k1", "Deploy", true)],
			diskSessions: [],
		});
		vi.mocked(api.hydrate).mockResolvedValueOnce({
			key: "k1",
			state: { ...makeNamedRuntime("k1", "Deploy", true).state, tasks: [] },
			messages: [],
			backgroundAgents: [],
			barrierSeq: 0,
		});
		window.location.hash = "#/session/k1";
		try {
			await mountAppAndFlush();
			expect(document.title).toBe("◆ Deploy — dreb");
		} finally {
			window.location.hash = "#/";
		}
	});

	it("shows `◆ dreb` for a fleet runtime needing attention when not viewing a named session", async () => {
		// Routed to fleet (no current session): displayName is undefined → base "dreb".
		// The badge still fires because attention is global across runtimes/sessions,
		// not gated on the current route.
		vi.mocked(api.fleet).mockResolvedValue({
			runtimes: [makeNamedRuntime("k2", undefined, true)],
			diskSessions: [],
		});
		await mountAppAndFlush();
		expect(document.title).toBe("◆ dreb");
	});

	it("removes the ◆ badge once attention clears (fleet runtime no longer needs attention)", async () => {
		// Seed attention, then apply the no-attention fleet SSE snapshot.
		vi.mocked(api.fleet).mockResolvedValue({
			runtimes: [makeNamedRuntime("k3", undefined, true)],
			diskSessions: [],
		});
		const stream = captureEnvelopeHandler();
		await mountAppAndFlush();
		expect(document.title).toContain("◆");

		// The authoritative fleet snapshot clears the runtime's attention state.
		stream.push({
			seq: 1,
			key: "",
			event: { type: "fleet_snapshot", runtimes: [makeNamedRuntime("k3", undefined, false)] },
		});
		await flushEffects();

		expect(document.title).not.toContain("◆");
		expect(document.title).toBe("dreb");
	});
});

describe("PWA client — notification title name fallback", () => {
	it("notifies with `dreb — <id.slice(0,8)>` when the attention runtime has no sessionName", async () => {
		// item.name = runtime.state.sessionName ?? runtime.state.sessionId.slice(0, 8).
		// With no sessionName the notification title falls back to the truncated id
		// (first 8 chars), so a still-unnamed session shows a meaningful label.
		setPermission("granted");
		setHidden(true);
		const rt = makeRuntime("abcdef1234567890", true); // sessionId === key
		vi.mocked(api.fleet).mockResolvedValue({ runtimes: [rt], diskSessions: [] });
		await mountAppAndFlush();
		expect(showNotification).toHaveBeenCalled();
		const title = showNotification.mock.calls[0]?.[0] as string;
		expect(title).toContain("abcdef12"); // first 8 chars of the session id
		expect(title).toContain("dreb");
	});
});
