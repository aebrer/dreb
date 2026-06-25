import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

/**
 * Tests for the parent_paused_for_background_agents guardrail notification in InteractiveMode.
 *
 * The handler should render a friendly system-voiced status message and refresh the background
 * agent footer state without presenting the pause as an error.
 */

async function dispatchEvent(fakeThis: object, event: object): Promise<void> {
	return (InteractiveMode as any).prototype.handleEvent.call(fakeThis, event);
}

function makeFakeThis(): Record<string, unknown> {
	return {
		// Required by handleEvent() before the switch
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		// State/methods accessed by parent_paused_for_background_agents
		showStatus: vi.fn(),
		updateBackgroundAgentStatus: vi.fn(),
	};
}

function guardrailPauseEvent(runningAgentCount: number): object {
	return {
		type: "parent_paused_for_background_agents",
		runningAgentCount,
		turnsUsed: 3,
		turnLimit: 3,
	};
}

describe("parent_paused_for_background_agents handler", () => {
	test("renders friendly singular pause status and refreshes background agent status", async () => {
		const fakeThis = makeFakeThis();

		await dispatchEvent(fakeThis, guardrailPauseEvent(1));

		expect(fakeThis.showStatus).toHaveBeenCalledTimes(1);
		const message = (fakeThis.showStatus as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
		expect(message).toBe(
			"Paused automatically — 1 background agent still working. dreb will resume when they report back, or send a message to continue. (configure via backgroundAgents settings)",
		);
		expect(message).toContain("1 background agent still working");
		expect(message).not.toContain("1 background agents");
		expect(message).toContain("configure via backgroundAgents settings");
		expect(message.toLowerCase()).not.toContain("error");
		expect(message.toLowerCase()).not.toContain("failed");
		expect(fakeThis.updateBackgroundAgentStatus).toHaveBeenCalledTimes(1);
	});

	test("renders friendly plural pause status and refreshes background agent status", async () => {
		const fakeThis = makeFakeThis();

		await dispatchEvent(fakeThis, guardrailPauseEvent(2));

		expect(fakeThis.showStatus).toHaveBeenCalledTimes(1);
		const message = (fakeThis.showStatus as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
		expect(message).toBe(
			"Paused automatically — 2 background agents still working. dreb will resume when they report back, or send a message to continue. (configure via backgroundAgents settings)",
		);
		expect(message).toContain("2 background agents still working");
		expect(message).not.toContain("2 background agent still working");
		expect(message).toContain("configure via backgroundAgents settings");
		expect(message.toLowerCase()).not.toContain("error");
		expect(message.toLowerCase()).not.toContain("failed");
		expect(fakeThis.updateBackgroundAgentStatus).toHaveBeenCalledTimes(1);
	});
});
