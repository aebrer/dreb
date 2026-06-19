/**
 * Tests for copyToClipboard's Wayland path (issue 286).
 * Verifies wl-copy is spawned fully detached so its stderr ("Somebody else owns
 * the clipboard now") can never leak into the controlling terminal / TUI.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Native clipboard module → null so the platform-tool path is exercised.
vi.mock("../src/utils/clipboard-native.js", () => ({ clipboard: null }));

// Force the Wayland branch regardless of the host environment.
vi.mock("../src/utils/clipboard-image.js", () => ({ isWaylandSession: () => true }));

// Mock child_process spawn/execSync.
const spawnMock = vi.fn();
const execSyncMock = vi.fn();
vi.mock("child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
	execSync: (...args: unknown[]) => execSyncMock(...args),
}));

// Force platform() to report linux.
vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>();
	return { ...actual, platform: () => "linux" };
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
const originalTermux = process.env.TERMUX_VERSION;

beforeEach(() => {
	vi.clearAllMocks();
	process.env.WAYLAND_DISPLAY = "wayland-0";
	delete process.env.TERMUX_VERSION;
	// `which wl-copy` succeeds.
	execSyncMock.mockReturnValue(Buffer.from(""));
	// OSC 52 write to stdout — swallow.
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
});

afterEach(() => {
	if (originalWaylandDisplay === undefined) delete process.env.WAYLAND_DISPLAY;
	else process.env.WAYLAND_DISPLAY = originalWaylandDisplay;
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
		// detached: true → new session, no controlling terminal → stderr cannot leak.
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
