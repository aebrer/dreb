/**
 * Tests for copyToClipboard's clipboard-method selection (issue 286).
 *
 * Root cause of issue 286: on Linux the native clipboard module (clipboard-rs,
 * X11 backend) runs an in-process selection-serving thread that prints
 * "Somebody else owns the clipboard now" to stdout on SelectionClear, leaking
 * into the TUI. The fix prefers controlled-stdio subprocess tools (wl-copy /
 * xclip / xsel) on Linux and only falls back to the native module as a last
 * resort. These tests pin that ordering.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mutable state read by the mock factories (hoisted above the mocks).
const { state } = vi.hoisted(() => ({
	state: {
		clipboard: null as null | { setText: (text: string) => Promise<void> },
		platform: "linux" as NodeJS.Platform,
		wayland: true,
	},
}));

// Native clipboard module — getter so tests can toggle availability per case.
vi.mock("../src/utils/clipboard-native.js", () => ({
	get clipboard() {
		return state.clipboard;
	},
}));

// Wayland session detection — driven by state.wayland.
vi.mock("../src/utils/clipboard-image.js", () => ({ isWaylandSession: () => state.wayland }));

// Mock child_process spawn/execSync.
const spawnMock = vi.fn();
const execSyncMock = vi.fn();
vi.mock("child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
	execSync: (...args: unknown[]) => execSyncMock(...args),
}));

// platform() reads state.platform so individual tests can switch OS.
vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>();
	return { ...actual, platform: () => state.platform };
});

import { copyToClipboard } from "../src/utils/clipboard.js";

function makeFakeProc() {
	return {
		stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
		on: vi.fn(),
		unref: vi.fn(),
	};
}

const originalWaylandDisplay = process.env.WAYLAND_DISPLAY;
const originalX11Display = process.env.DISPLAY;
const originalTermux = process.env.TERMUX_VERSION;

beforeEach(() => {
	vi.clearAllMocks();
	state.clipboard = null;
	state.platform = "linux";
	state.wayland = true;
	process.env.WAYLAND_DISPLAY = "wayland-0";
	process.env.DISPLAY = ":0";
	delete process.env.TERMUX_VERSION;
	// `which wl-copy` succeeds by default.
	execSyncMock.mockReturnValue(Buffer.from(""));
	// OSC 52 write to stdout — swallow.
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
});

afterEach(() => {
	if (originalWaylandDisplay === undefined) delete process.env.WAYLAND_DISPLAY;
	else process.env.WAYLAND_DISPLAY = originalWaylandDisplay;
	if (originalX11Display === undefined) delete process.env.DISPLAY;
	else process.env.DISPLAY = originalX11Display;
	if (originalTermux === undefined) delete process.env.TERMUX_VERSION;
	else process.env.TERMUX_VERSION = originalTermux;
	vi.restoreAllMocks();
});

describe("copyToClipboard — Wayland wl-copy spawn", () => {
	test("spawns wl-copy detached with ignored stdio", async () => {
		const proc = makeFakeProc();
		spawnMock.mockReturnValue(proc);

		const result = await copyToClipboard("hello clipboard");

		expect(spawnMock).toHaveBeenCalledTimes(1);
		const [cmd, args, options] = spawnMock.mock.calls[0];
		expect(cmd).toBe("wl-copy");
		expect(args).toEqual([]);
		// detached: true → own session, survives our exit; ignored stderr is the
		// regression guard against any subprocess clipboard chatter.
		expect(options).toMatchObject({
			detached: true,
			stdio: ["pipe", "ignore", "ignore"],
		});
		// Reports osc52 since wl-copy success can't be confirmed before unref.
		expect(result).toEqual({ method: "osc52" });
	});

	test("writes the payload to wl-copy stdin and unrefs the process", async () => {
		const proc = makeFakeProc();
		spawnMock.mockReturnValue(proc);

		await copyToClipboard("payload text");

		expect(proc.stdin.write).toHaveBeenCalledWith("payload text");
		expect(proc.stdin.end).toHaveBeenCalledTimes(1);
		// unref so the detached daemon does not keep our event loop alive.
		expect(proc.unref).toHaveBeenCalledTimes(1);
	});
});

describe("copyToClipboard — native module ordering (issue 286)", () => {
	test("on Linux, the native module is NOT used when a CLI tool is available", async () => {
		const setText = vi.fn().mockResolvedValue(undefined);
		state.clipboard = { setText };
		const proc = makeFakeProc();
		spawnMock.mockReturnValue(proc);

		const result = await copyToClipboard("hello");

		// The leaky native path must be skipped in favor of wl-copy.
		expect(setText).not.toHaveBeenCalled();
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(spawnMock.mock.calls[0][0]).toBe("wl-copy");
		expect(result).toEqual({ method: "osc52" });
	});

	test("on Linux, the native module IS used as a last resort when no CLI tool exists", async () => {
		const setText = vi.fn().mockResolvedValue(undefined);
		state.clipboard = { setText };
		// No Wayland/X11/Termux tooling available.
		state.wayland = false;
		delete process.env.WAYLAND_DISPLAY;
		delete process.env.DISPLAY;

		const result = await copyToClipboard("fallback text");

		expect(spawnMock).not.toHaveBeenCalled();
		expect(setText).toHaveBeenCalledWith("fallback text");
		expect(result).toEqual({ method: "native" });
	});

	test("on Linux with no CLI tool and no native module, degrades to osc52", async () => {
		// No Wayland/X11/Termux tooling AND native module unavailable.
		state.clipboard = null;
		state.wayland = false;
		delete process.env.WAYLAND_DISPLAY;
		delete process.env.DISPLAY;

		const result = await copyToClipboard("nowhere to go");

		// Nothing to spawn/exec; the last-resort native branch finds no module and
		// the function falls through to the always-emitted OSC 52.
		expect(spawnMock).not.toHaveBeenCalled();
		expect(execSyncMock).not.toHaveBeenCalled();
		expect(result).toEqual({ method: "osc52" });
	});

	test("on Linux with no CLI tool and a throwing native module, degrades to osc52", async () => {
		// Native present as last resort but setText rejects — must not escape; the
		// swallowed failure falls through to OSC 52 rather than throwing.
		const setText = vi.fn().mockRejectedValue(new Error("native clipboard unavailable"));
		state.clipboard = { setText };
		state.wayland = false;
		delete process.env.WAYLAND_DISPLAY;
		delete process.env.DISPLAY;

		const result = await copyToClipboard("native throws");

		expect(spawnMock).not.toHaveBeenCalled();
		expect(setText).toHaveBeenCalledWith("native throws");
		expect(result).toEqual({ method: "osc52" });
	});

	test("on macOS, the native module is preferred (no serving-thread leak there)", async () => {
		const setText = vi.fn().mockResolvedValue(undefined);
		state.clipboard = { setText };
		state.platform = "darwin";

		const result = await copyToClipboard("mac text");

		expect(setText).toHaveBeenCalledWith("mac text");
		// pbcopy not reached because native succeeded first.
		expect(execSyncMock).not.toHaveBeenCalled();
		expect(result).toEqual({ method: "native" });
	});
});
