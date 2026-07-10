/**
 * Native TLS (HTTPS) CLI flag tests — `parseArgs` validation for `--https`,
 * `--cert`, `--key`. See `src/index.ts`. The dashboard terminates TLS itself
 * (no reverse proxy); this only checks the argument surface, not the live
 * handshake (which needs real cert files + a bound socket).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createShutdown,
	createTlsReloader,
	createTlsWatchers,
	insecureRemoteWarning,
	parseArgs,
	shouldReloadForFile,
} from "../src/index.js";

describe("dashboard native TLS — parseArgs", () => {
	it("defaults to plain HTTP (https off, no cert/key)", () => {
		const a = parseArgs([]);
		expect(a.https).toBe(false);
		expect(a.cert).toBeUndefined();
		expect(a.key).toBeUndefined();
	});

	it("accepts --https with --cert and --key", () => {
		const a = parseArgs(["--https", "--cert", "/etc/dreb/cert.pem", "--key", "/etc/dreb/key.pem"]);
		expect(a.https).toBe(true);
		expect(a.cert).toBe("/etc/dreb/cert.pem");
		expect(a.key).toBe("/etc/dreb/key.pem");
	});

	it("rejects --https without --cert (no silent HTTP fallback)", () => {
		expect(() => parseArgs(["--https", "--key", "/k.pem"])).toThrow(/--https requires --cert/);
	});

	it("rejects --https without --key", () => {
		expect(() => parseArgs(["--https", "--cert", "/c.pem"])).toThrow(/--https requires --key/);
	});

	it("rejects --cert with no value", () => {
		expect(() => parseArgs(["--https", "--cert"])).toThrow(/--cert requires/);
	});

	it("rejects --key with no value", () => {
		expect(() => parseArgs(["--https", "--cert", "/c.pem", "--key"])).toThrow(/--key requires/);
	});

	it("combines --https with --remote + --allow (remote Tailscale over TLS)", () => {
		const a = parseArgs(["--remote", "--allow", "me@example.com", "--https", "--cert", "/c.pem", "--key", "/k.pem"]);
		expect(a.https).toBe(true);
		expect(a.remote).toBe(true);
		expect(a.allow).toEqual(["me@example.com"]);
	});

	it("still rejects --remote without --allow when --https is present", () => {
		expect(() => parseArgs(["--remote", "--https", "--cert", "/c.pem", "--key", "/k.pem"])).toThrow(
			/--remote requires/,
		);
	});

	it("rejects unknown arguments", () => {
		expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument/);
	});
});

describe("dashboard insecure-context warning — insecureRemoteWarning", () => {
	it("warns when --remote is set without --https (plain HTTP over the tailnet)", () => {
		const warning = insecureRemoteWarning(parseArgs(["--remote", "--allow", "me@example.com"]));
		expect(warning).toBeDefined();
		expect(warning).toMatch(/INSECURE context/);
		expect(warning).toMatch(/--https/);
		expect(warning).toMatch(/tailscale cert/);
	});

	it("stays silent when --remote is paired with --https (secure tailnet)", () => {
		const args = parseArgs([
			"--remote",
			"--allow",
			"me@example.com",
			"--https",
			"--cert",
			"/c.pem",
			"--key",
			"/k.pem",
		]);
		expect(insecureRemoteWarning(args)).toBeUndefined();
	});

	it("stays silent in local mode (loopback is already a secure context)", () => {
		expect(insecureRemoteWarning(parseArgs([]))).toBeUndefined();
	});
});

describe("dashboard shutdown helper — createShutdown", () => {
	it("runs teardown exactly once and preserves the first exit code", async () => {
		const log = vi.fn();
		const clearReloadTimer = vi.fn();
		const watchers = [{ close: vi.fn() }, { close: vi.fn() }];
		const closeServer = vi.fn();
		const stopAll = vi.fn(() => Promise.resolve());
		const exit = vi.fn();
		const beginShutdown = createShutdown({
			log,
			clearReloadTimer,
			watchers,
			closeServer,
			stopAll,
			exit,
		});

		beginShutdown("restart requested — exiting for supervisor to respawn", 1);
		beginShutdown("shutting down…", 0);
		await Promise.resolve();

		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith("restart requested — exiting for supervisor to respawn");
		expect(clearReloadTimer).toHaveBeenCalledTimes(1);
		expect(watchers[0].close).toHaveBeenCalledTimes(1);
		expect(watchers[1].close).toHaveBeenCalledTimes(1);
		expect(closeServer).toHaveBeenCalledTimes(1);
		expect(stopAll).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(1);
	});
});

describe("dashboard native TLS hot reload helpers", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps the old secure context when cert/key re-read fails", () => {
		const readTlsOptions = vi
			.fn()
			.mockReturnValueOnce({ cert: "cert-v2", key: "key-v2" })
			.mockImplementationOnce(() => {
				throw new Error("EACCES");
			});
		const setSecureContext = vi.fn();
		const log = vi.fn();
		const warn = vi.fn();
		const reloadTls = createTlsReloader({ readTlsOptions, setSecureContext, log, warn });

		reloadTls();
		reloadTls();

		expect(setSecureContext).toHaveBeenCalledTimes(1);
		expect(setSecureContext).toHaveBeenCalledWith({ cert: "cert-v2", key: "key-v2" });
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith("tls certificate reloaded");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith("tls reload failed (keeping old cert): EACCES");
	});

	it("matches cert/key filenames and treats null filenames as reload-worthy", () => {
		expect(shouldReloadForFile("cert.pem", "cert.pem", "key.pem")).toBe(true);
		expect(shouldReloadForFile("key.pem", "cert.pem", "key.pem")).toBe(true);
		expect(shouldReloadForFile(null, "cert.pem", "key.pem")).toBe(true);
		expect(shouldReloadForFile("other.pem", "cert.pem", "key.pem")).toBe(false);
		expect(shouldReloadForFile(Buffer.from("cert.pem"), "cert.pem", "key.pem")).toBe(false);
	});

	it("debounces cert/key parent-directory events for 500ms", () => {
		vi.useFakeTimers();
		const harness = createWatchHarness();
		const reloadTls = vi.fn();

		createTlsWatchers({
			certPath: "/tls/cert.pem",
			keyPath: "/tls/key.pem",
			watchDirectory: harness.watchDirectory,
			reloadTls,
			warn: vi.fn(),
		});

		expect(harness.watchDirectory).toHaveBeenCalledTimes(1);
		expect(harness.watchDirectory).toHaveBeenCalledWith("/tls", expect.any(Function));
		harness.emit("/tls", "change", "cert.pem");
		vi.advanceTimersByTime(499);
		expect(reloadTls).not.toHaveBeenCalled();
		harness.emit("/tls", "rename", "key.pem");
		vi.advanceTimersByTime(499);
		expect(reloadTls).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(reloadTls).toHaveBeenCalledTimes(1);
	});

	it("falls through and reloads for macOS null filename events", () => {
		vi.useFakeTimers();
		const harness = createWatchHarness();
		const reloadTls = vi.fn();

		createTlsWatchers({
			certPath: "/tls/cert.pem",
			keyPath: "/tls/key.pem",
			watchDirectory: harness.watchDirectory,
			reloadTls,
			warn: vi.fn(),
		});

		harness.emit("/tls", "change", null);
		vi.advanceTimersByTime(500);

		expect(reloadTls).toHaveBeenCalledTimes(1);
	});

	it("ignores unrelated parent-directory filenames", () => {
		vi.useFakeTimers();
		const harness = createWatchHarness();
		const reloadTls = vi.fn();

		createTlsWatchers({
			certPath: "/tls/cert.pem",
			keyPath: "/tls/key.pem",
			watchDirectory: harness.watchDirectory,
			reloadTls,
			warn: vi.fn(),
		});

		harness.emit("/tls", "change", "unrelated.pem");
		vi.advanceTimersByTime(500);

		expect(reloadTls).not.toHaveBeenCalled();
	});

	it("warns on watcher errors without dropping the guard", () => {
		const harness = createWatchHarness();
		const warn = vi.fn();

		createTlsWatchers({
			certPath: "/tls/cert.pem",
			keyPath: "/tls/key.pem",
			watchDirectory: harness.watchDirectory,
			reloadTls: vi.fn(),
			warn,
		});

		harness.watchers[0]?.emitError(new Error("watch exploded"));

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith("tls cert watch error: watch exploded");
	});

	it("clears a pending reload timer when the controller is released", () => {
		vi.useFakeTimers();
		const harness = createWatchHarness();
		const reloadTls = vi.fn();
		const controller = createTlsWatchers({
			certPath: "/tls/cert.pem",
			keyPath: "/tls/key.pem",
			watchDirectory: harness.watchDirectory,
			reloadTls,
			warn: vi.fn(),
		});

		harness.emit("/tls", "change", "cert.pem");
		controller.clearReloadTimer();
		vi.advanceTimersByTime(500);

		expect(reloadTls).not.toHaveBeenCalled();
	});
});

type WatchListener = (event: string, filename: string | Buffer | null) => void;

class FakeWatcher {
	readonly close = vi.fn();
	readonly errorListeners: ((err: unknown) => void)[] = [];
	readonly on = vi.fn((event: string, listener: (err: unknown) => void) => {
		if (event === "error") this.errorListeners.push(listener);
		return this;
	});

	emitError(err: unknown): void {
		for (const listener of this.errorListeners) listener(err);
	}
}

function createWatchHarness() {
	const listeners = new Map<string, WatchListener>();
	const watchers: FakeWatcher[] = [];
	const watchDirectory = vi.fn((directory: string, listener: WatchListener) => {
		listeners.set(directory, listener);
		const watcher = new FakeWatcher();
		watchers.push(watcher);
		return watcher;
	});
	return {
		watchDirectory,
		watchers,
		emit: (directory: string, event: string, filename: string | Buffer | null) => {
			const listener = listeners.get(directory);
			if (!listener) throw new Error(`No watcher registered for ${directory}`);
			listener(event, filename);
		},
	};
}
