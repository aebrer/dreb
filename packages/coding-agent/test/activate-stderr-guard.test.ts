/**
 * Tests for the activateStderrGuard routing logic in InteractiveMode.
 *
 * Verifies that the callback installed by activateStderrGuard correctly:
 * - Routes level "error" → showError
 * - Routes level "warn" / undefined → showWarning
 * - Strips a single trailing newline before display
 * - Suppresses messages that become empty after trimming
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StderrCallback } from "../src/core/stderr-guard.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

// Mock stderr-guard to capture the callback passed to takeOverStderr
let capturedCallback: StderrCallback | undefined;

vi.mock("../src/core/stderr-guard.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/stderr-guard.js")>();
	return {
		...actual,
		takeOverStderr: (cb: StderrCallback) => {
			capturedCallback = cb;
		},
	};
});

type ActivateStderrGuardThis = {
	showError: (msg: string) => void;
	showWarning: (msg: string) => void;
};

type InteractiveModePrototypeWithActivateStderrGuard = {
	activateStderrGuard(this: ActivateStderrGuardThis): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown;

function callActivateStderrGuard(context: ActivateStderrGuardThis): void {
	(interactiveModePrototype as InteractiveModePrototypeWithActivateStderrGuard).activateStderrGuard.call(context);
}

describe("InteractiveMode.activateStderrGuard routing", () => {
	afterEach(() => {
		capturedCallback = undefined;
		vi.restoreAllMocks();
	});

	it("routes level 'error' to showError", () => {
		const context: ActivateStderrGuardThis = {
			showError: vi.fn(),
			showWarning: vi.fn(),
		};

		callActivateStderrGuard(context);
		expect(capturedCallback).toBeDefined();

		capturedCallback!("something went wrong", "error");

		expect(context.showError).toHaveBeenCalledWith("something went wrong");
		expect(context.showWarning).not.toHaveBeenCalled();
	});

	it("routes level 'warn' to showWarning", () => {
		const context: ActivateStderrGuardThis = {
			showError: vi.fn(),
			showWarning: vi.fn(),
		};

		callActivateStderrGuard(context);
		capturedCallback!("a warning message", "warn");

		expect(context.showWarning).toHaveBeenCalledWith("a warning message");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("routes undefined level to showWarning (raw third-party writes)", () => {
		const context: ActivateStderrGuardThis = {
			showError: vi.fn(),
			showWarning: vi.fn(),
		};

		callActivateStderrGuard(context);
		capturedCallback!("third-party output", undefined);

		expect(context.showWarning).toHaveBeenCalledWith("third-party output");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("routes level 'debug' to showWarning", () => {
		const context: ActivateStderrGuardThis = {
			showError: vi.fn(),
			showWarning: vi.fn(),
		};

		callActivateStderrGuard(context);
		capturedCallback!("debug info", "debug");

		expect(context.showWarning).toHaveBeenCalledWith("debug info");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("strips a single trailing newline before display", () => {
		const context: ActivateStderrGuardThis = {
			showError: vi.fn(),
			showWarning: vi.fn(),
		};

		callActivateStderrGuard(context);
		capturedCallback!("message with newline\n", "warn");

		expect(context.showWarning).toHaveBeenCalledWith("message with newline");
	});

	it("suppresses messages that become empty after trimming", () => {
		const context: ActivateStderrGuardThis = {
			showError: vi.fn(),
			showWarning: vi.fn(),
		};

		callActivateStderrGuard(context);
		capturedCallback!("\n", "warn");

		expect(context.showWarning).not.toHaveBeenCalled();
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("suppresses completely empty messages", () => {
		const context: ActivateStderrGuardThis = {
			showError: vi.fn(),
			showWarning: vi.fn(),
		};

		callActivateStderrGuard(context);
		capturedCallback!("", "error");

		expect(context.showError).not.toHaveBeenCalled();
		expect(context.showWarning).not.toHaveBeenCalled();
	});
});
