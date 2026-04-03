/**
 * Unit tests for BuddyController — context buffer, idle timer, reactions,
 * name-call detection, activity gating, reaction budget, event handling,
 * command dispatch, and lifecycle.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BuddyCallbacks, BuddyController } from "../src/core/buddy/buddy-controller.js";
import { BuddyManager } from "../src/core/buddy/buddy-manager.js";

const TEST_DIR = join(tmpdir(), "dreb-buddy-controller-test");

/** Create a BuddyController with mock callbacks for testing */
function createTestController(config?: { activityGateMs?: number; reactionsPerHour?: number }) {
	const callbacks: BuddyCallbacks = {
		onSpeech: vi.fn(),
		onThinkingStart: vi.fn(),
		onThinkingEnd: vi.fn(),
	};

	const manager = new BuddyManager();
	const controller = new BuddyController(manager, callbacks, {
		idleTimeoutMs: 30000,
		reactionCooldownMs: 100, // short for testing
		contextMaxEntries: 5,
		activityGateMs: config?.activityGateMs ?? 0,
		reactionsPerHour: config?.reactionsPerHour ?? 0,
	});

	return { controller, callbacks, manager };
}

/** Write a stored buddy so manager.load() returns a state */
function writeStoredBuddy(
	overrides?: Partial<{ name: string; personality: string; backstory: string; rerollCount: number; visible: boolean }>,
) {
	const stored = {
		rerollCount: 0,
		name: "Testbud",
		personality: "A test buddy.",
		backstory: "Born in a test file.",
		hatchedAt: new Date().toISOString(),
		visible: true,
		...overrides,
	};
	// getAgentDir() returns DREB_CODING_AGENT_DIR directly; buddy.json goes inside it
	writeFileSync(join(TEST_DIR, "buddy.json"), JSON.stringify(stored));
}

beforeEach(() => {
	// Create test dir and set env
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DREB_CODING_AGENT_DIR = TEST_DIR;
});

afterEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	delete process.env.DREB_CODING_AGENT_DIR;
});

// ===========================================================================
// Context buffer
// ===========================================================================
describe("context buffer", () => {
	it("should append and build context", () => {
		const { controller } = createTestController();
		controller.appendContext("User: hello");
		controller.appendContext("Assistant: hi there");
		expect(controller.buildContext()).toBe("User: hello\nAssistant: hi there");
	});

	it("should evict oldest entries when at capacity", () => {
		const { controller } = createTestController(); // contextMaxEntries: 5
		for (let i = 0; i < 7; i++) {
			controller.appendContext(`Entry ${i}`);
		}
		const ctx = controller.buildContext();
		expect(ctx).toBe("Entry 2\nEntry 3\nEntry 4\nEntry 5\nEntry 6");
	});

	it("should return fallback text for empty buffer", () => {
		const { controller } = createTestController();
		expect(controller.buildContext()).toBe("No recent activity.");
	});
});

// ===========================================================================
// Activity & idle timer
// ===========================================================================
describe("activity tracking", () => {
	it("should mark activity time", () => {
		const { controller } = createTestController();
		const before = (controller as any).lastActivityTime;
		controller.markActivity();
		expect((controller as any).lastActivityTime).toBeGreaterThan(before);
	});

	it("should be within activity window after markActivity", () => {
		const { controller } = createTestController({ activityGateMs: 3600000 });
		controller.markActivity();
		expect(controller.isWithinActivityWindow()).toBe(true);
	});

	it("should be outside activity window with old activity", () => {
		const { controller } = createTestController({ activityGateMs: 100 });
		controller.markActivity();
		(controller as any).lastActivityTime = Date.now() - 1000; // simulate old activity
		expect(controller.isWithinActivityWindow()).toBe(false);
	});

	it("should not start idle timer when outside activity gate", () => {
		const { controller } = createTestController({ activityGateMs: 100 });
		controller.markActivity();
		(controller as any).lastActivityTime = Date.now() - 1000; // old activity
		controller.resetIdleTimer();
		expect((controller as any).idleTimer).toBeNull();
	});
});

// ===========================================================================
// Reaction throttle & budget
// ===========================================================================
describe("reactions", () => {
	it("should call onSpeech when reaction succeeds", async () => {
		writeStoredBuddy();
		const { controller, callbacks, manager } = createTestController();
		manager.load(); // need state loaded

		// Mock the react method to return a quip
		vi.spyOn(manager, "react").mockResolvedValue("That was hilarious!");

		await controller.triggerReaction("something happened");
		expect(callbacks.onThinkingStart).toHaveBeenCalled();
		expect(callbacks.onThinkingEnd).toHaveBeenCalled();
		expect(callbacks.onSpeech).toHaveBeenCalledWith("That was hilarious!");
	});

	it("should skip reaction during cooldown", async () => {
		writeStoredBuddy();
		const { controller, callbacks, manager } = createTestController();
		manager.load();

		const _spy = vi.spyOn(manager, "react").mockResolvedValue("quip");

		// First reaction
		await controller.triggerReaction("event 1");
		expect(callbacks.onSpeech).toHaveBeenCalledTimes(1);

		// Second reaction within cooldown (100ms) — should be skipped
		await controller.triggerReaction("event 2");
		expect(callbacks.onSpeech).toHaveBeenCalledTimes(1); // still 1
	});

	it("should respect reaction budget per hour", async () => {
		writeStoredBuddy();
		const { controller, callbacks, manager } = createTestController({ reactionsPerHour: 2 });
		manager.load();

		vi.spyOn(manager, "react").mockResolvedValue("quip");
		(controller as any).lastReactionTime = 0; // clear cooldown

		// First reaction
		await controller.triggerReaction("event 1");
		expect(callbacks.onSpeech).toHaveBeenCalledTimes(1);

		(controller as any).lastReactionTime = 0; // clear cooldown for test
		// Second reaction
		await controller.triggerReaction("event 2");
		expect(callbacks.onSpeech).toHaveBeenCalledTimes(2);

		(controller as any).lastReactionTime = 0; // clear cooldown for test
		// Third reaction — over budget
		await controller.triggerReaction("event 3");
		expect(callbacks.onSpeech).toHaveBeenCalledTimes(2); // still 2
	});

	it("should not call onSpeech when react returns null", async () => {
		writeStoredBuddy();
		const { controller, callbacks, manager } = createTestController();
		manager.load();

		vi.spyOn(manager, "react").mockResolvedValue(null);

		await controller.triggerReaction("something happened");
		expect(callbacks.onSpeech).not.toHaveBeenCalled();
	});

	it("should handle react errors gracefully", async () => {
		writeStoredBuddy();
		const { controller, callbacks, manager } = createTestController();
		manager.load();

		vi.spyOn(manager, "react").mockRejectedValue(new Error("Ollama down"));

		await controller.triggerReaction("something happened");
		expect(callbacks.onThinkingEnd).toHaveBeenCalled();
		expect(callbacks.onSpeech).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// Name-call detection
// ===========================================================================
describe("name-call detection", () => {
	it("should detect buddy name with word boundary", () => {
		writeStoredBuddy({ name: "Zorp" });
		const { controller, manager } = createTestController();
		manager.load();

		expect(controller.detectNameCall("Hey Zorp what's up")).toBe(true);
		expect(controller.detectNameCall("Zorp!")).toBe(true);
		expect(controller.detectNameCall("zorping around")).toBe(false);
		expect(controller.detectNameCall("thezorptest")).toBe(false);
	});

	it("should be case-insensitive", () => {
		writeStoredBuddy({ name: "Zorp" });
		const { controller, manager } = createTestController();
		manager.load();

		expect(controller.detectNameCall("hey ZORP")).toBe(true);
		expect(controller.detectNameCall("hey zorp")).toBe(true);
	});

	it("should return false when no buddy loaded", () => {
		const { controller } = createTestController();
		expect(controller.detectNameCall("anything")).toBe(false);
	});
});

describe("handleNameCall", () => {
	it("should call onSpeech with response", async () => {
		writeStoredBuddy();
		const { controller, callbacks, manager } = createTestController();
		manager.load();

		vi.spyOn(manager, "respondToNameCall").mockResolvedValue("Waddup!");

		await controller.handleNameCall("Hey Testbud!");
		expect(callbacks.onThinkingStart).toHaveBeenCalled();
		expect(callbacks.onThinkingEnd).toHaveBeenCalled();
		expect(callbacks.onSpeech).toHaveBeenCalledWith("Waddup!");
	});

	it("should not call onSpeech when response is null", async () => {
		writeStoredBuddy();
		const { controller, callbacks, manager } = createTestController();
		manager.load();

		vi.spyOn(manager, "respondToNameCall").mockResolvedValue(null);

		await controller.handleNameCall("Hey Testbud!");
		expect(callbacks.onSpeech).not.toHaveBeenCalled();
	});

	it("should handle no buddy gracefully", async () => {
		const { controller, callbacks } = createTestController();
		await controller.handleNameCall("Hey!");
		expect(callbacks.onThinkingStart).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// Event handling
// ===========================================================================
describe("handleEvent", () => {
	it("should capture assistant text from message_end", () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		controller.handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Here's your code" }],
			},
		});

		expect(controller.buildContext()).toContain("Assistant: Here's your code");
	});

	it("should capture tool calls from message_end", () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		controller.handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", name: "bash", id: "1" },
					{ type: "toolCall", name: "read", id: "2" },
				],
			},
		});

		expect(controller.buildContext()).toContain("Called tools: bash, read");
	});

	it("should capture tool results from tool_execution_end", () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		controller.handleEvent({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "1",
			result: { content: [{ type: "text", text: "command output" }] },
			isError: false,
		});

		expect(controller.buildContext()).toContain("Tool bash completed: command output");
	});

	it("should trigger reaction on tool error", () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		const reactSpy = vi.spyOn(manager, "react").mockResolvedValue("oops!");

		controller.handleEvent({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "1",
			result: { content: [{ type: "text", text: "command not found" }] },
			isError: true,
		});

		expect(reactSpy).toHaveBeenCalled();
	});

	it("should trigger reaction on agent_end", () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		const reactSpy = vi.spyOn(manager, "react").mockResolvedValue("nice work!");

		controller.handleEvent({ type: "agent_end", messages: [] });

		expect(reactSpy).toHaveBeenCalledWith("The agent finished responding.");
	});

	it("should skip events when no buddy loaded", () => {
		const { controller, manager } = createTestController();
		const reactSpy = vi.spyOn(manager, "react");

		controller.handleEvent({ type: "agent_end", messages: [] });
		expect(reactSpy).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// processUserMessage
// ===========================================================================
describe("processUserMessage", () => {
	it("should capture context and reset idle", () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		const idleSpy = vi.spyOn(controller, "resetIdleTimer");

		controller.processUserMessage("Hello world");

		expect(controller.buildContext()).toContain("User: Hello world");
		expect(idleSpy).toHaveBeenCalled();
	});

	it("should detect name-call", () => {
		writeStoredBuddy({ name: "Zorp" });
		const { controller, manager } = createTestController();
		manager.load();

		const nameCallSpy = vi.spyOn(controller, "handleNameCall").mockResolvedValue();

		controller.processUserMessage("Hey Zorp!");

		expect(nameCallSpy).toHaveBeenCalledWith("Hey Zorp!");
	});
});

// ===========================================================================
// Command handling
// ===========================================================================
describe("handleCommand", () => {
	it("should return warning for pet with no buddy", async () => {
		const { controller } = createTestController();
		const result = await controller.handleCommand("pet");
		expect(result.type).toBe("warning");
		if (result.type === "warning") expect(result.message).toContain("No buddy to pet");
	});

	it("should return pet result when buddy exists", async () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		const result = await controller.handleCommand("pet");
		expect(result.type).toBe("pet");
	});

	it("should return warning for stats with no buddy", async () => {
		const { controller } = createTestController();
		const result = await controller.handleCommand("stats");
		expect(result.type).toBe("warning");
	});

	it("should return stats result when buddy exists", async () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		const result = await controller.handleCommand("stats");
		expect(result.type).toBe("stats");
		if (result.type === "stats") {
			expect(result.state.name).toBe("Testbud");
		}
	});

	it("should return show result for existing buddy", async () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		const result = await controller.handleCommand("");
		expect(result.type).toBe("show");
		if (result.type === "show") {
			expect(result.state.name).toBe("Testbud");
		}
	});

	it("should return error for hatch with no model", async () => {
		const { controller } = createTestController();
		const result = await controller.handleCommand("");
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.message).toContain("No model");
	});

	it("should return off result and mark buddy invisible", async () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		const result = await controller.handleCommand("off");
		expect(result.type).toBe("off");
		expect(manager.getState()?.visible).toBe(false);
	});

	it("should return warning for reroll with no stored buddy", async () => {
		const { controller } = createTestController();
		const result = await controller.handleCommand("reroll");
		expect(result.type).toBe("warning");
	});
});

// ===========================================================================
// Lifecycle
// ===========================================================================
describe("lifecycle", () => {
	it("should start and load existing buddy", () => {
		writeStoredBuddy();
		const { controller } = createTestController();

		const state = controller.start();
		expect(state).not.toBeNull();
		expect(state!.name).toBe("Testbud");
	});

	it("should return null when no stored buddy", () => {
		const { controller } = createTestController();
		expect(controller.start()).toBeNull();
	});

	it("should return null for hidden buddy", () => {
		writeStoredBuddy({ visible: false });
		const { controller } = createTestController();
		expect(controller.start()).toBeNull();
	});

	it("should clear timers on stop", () => {
		const { controller } = createTestController();
		controller.resetIdleTimer();
		expect((controller as any).idleTimer).not.toBeNull();
		controller.stop();
		expect((controller as any).idleTimer).toBeNull();
	});

	it("should clear all state on reset", () => {
		writeStoredBuddy();
		const { controller } = createTestController();
		controller.start();
		controller.appendContext("test");
		(controller as any).lastReactionTime = Date.now();
		(controller as any).reactionTimestamps = [Date.now()];

		controller.reset();

		expect(controller.buildContext()).toBe("No recent activity.");
		expect((controller as any).lastReactionTime).toBe(0);
		expect((controller as any).reactionTimestamps).toHaveLength(0);
	});
});
