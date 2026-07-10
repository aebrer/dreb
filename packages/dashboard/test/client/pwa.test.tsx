// @vitest-environment jsdom
/**
 * PWA client tests — service worker registration guard + the
 * needs-attention notification dispatch gating (the Android `Illegal
 * constructor` fix: notifications now go through `registration.showNotification`
 * via the service worker, not the page-context `new Notification()`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the API + SSE so <App> mounts without a server. Mirrors screens.test.tsx.
vi.mock("../../src/client/api.js", () => ({
	api: {
		auth: vi.fn(async () => ({ mode: "local", needsPairing: false })),
		fleet: vi.fn(async () => ({ runtimes: [], diskSessions: [] })),
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
	},
	connectEvents: vi.fn(() => () => {}),
}));

import { render } from "solid-js/web/dist/web.js";
import { api, connectEvents } from "../../src/client/api.js";
import { App } from "../../src/client/app.js";

const disposers: Array<() => void> = [];
let showNotification: ReturnType<typeof vi.fn>;
let registerSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	// localStorage shim (jsdom may not provide it without --localstorage-file).
	const values = new Map<string, string>();
	if (!window.localStorage) {
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
	}

	// SW registration mock — `ready` resolves to a registration with a
	// `showNotification` spy so the app's notification code can call it.
	showNotification = vi.fn();
	registerSpy = vi.fn(async () => ({
		showNotification,
	}));
	// @ts-expect-error partial mock
	navigator.serviceWorker = {
		register: registerSpy,
		ready: Promise.resolve({ showNotification }),
		addEventListener: vi.fn(),
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
});

describe("PWA client — notification dispatch gating", () => {
	async function seedNeedsAttention(): Promise<void> {
		// Replace the fleet with a single runtime that needs attention so the
		// notification effect has something to fire on.
		vi.mocked(api.fleet).mockResolvedValue({
			runtimes: [
				{
					key: "att-1",
					cwd: "/tmp/p",
					state: {
						sessionId: "att-1",
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
					needsAttention: true,
					createdAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
				},
			],
			diskSessions: [],
		});
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

	it("does NOT fire when permission is not granted", async () => {
		setPermission("default");
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
});
