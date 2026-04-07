/**
 * Unit tests for BuddyController — context buffer, idle timer, reactions,
 * name-call detection, activity gating, reaction budget, event handling,
 * command dispatch, and lifecycle.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BuddyCallbacks, BuddyController } from "../src/core/buddy/buddy-controller.js";
import { BuddyManager, checkOllama } from "../src/core/buddy/buddy-manager.js";
import { type BuddyState, Rarity } from "../src/core/buddy/buddy-types.js";

vi.mock("../src/core/buddy/buddy-manager.js", async () => {
	const actual = await vi.importActual("../src/core/buddy/buddy-manager.js");
	return { ...actual, checkOllama: vi.fn() };
});

const TEST_DIR = join(tmpdir(), "dreb-buddy-controller-test");

/** Create a BuddyController with mock callbacks for testing */
function createTestController(config?: { activityGateMs?: number; reactionsPerHour?: number }) {
	const onHatch = vi.fn();
	const onReroll = vi.fn();

	const callbacks: BuddyCallbacks = {
		onSpeech: vi.fn(),
		onThinkingStart: vi.fn(),
		onThinkingEnd: vi.fn(),
		onHatch,
		onReroll,
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

/** A valid BuddyState for mocking hatch/reroll results */
function createMockBuddyState(overrides?: Partial<BuddyState>): BuddyState {
	return {
		species: "Duck",
		rarity: Rarity.COMMON,
		shiny: false,
		eyeStyle: "●",
		hat: "",
		stats: {
			DEBUGGING: 5,
			PATIENCE: 7,
			CHAOS: 3,
			WISDOM: 6,
			SNARK: 4,
		},
		personality: "A test buddy.",
		backstory: "Born in a test file.",
		name: "Testbud",
		rerollCount: 0,
		hatchedAt: new Date().toISOString(),
		...overrides,
	};
}

/** Write a stored buddy so manager.load() returns a state */
function writeStoredBuddy(
	overrides?: Partial<{
		name: string;
		personality: string;
		backstory: string;
		rerollCount: number;
		ollamaModel: string;
	}>,
) {
	const stored = {
		rerollCount: 0,
		name: "Testbud",
		personality: "A test buddy.",
		backstory: "Born in a test file.",
		hatchedAt: new Date().toISOString(),
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
// Enabled flag gating
// ===========================================================================
describe("enabled flag", () => {
	it("should be true by default", () => {
		const { controller } = createTestController();
		expect(controller.enabled).toBe(true);
	});

	it("should be set to false by handleCommand('off')", async () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		await controller.handleCommand("off");
		expect(controller.enabled).toBe(false);
	});

	it("should suppress triggerReaction when disabled", async () => {
		writeStoredBuddy();
		const { controller, callbacks, manager } = createTestController();
		manager.load();

		const reactSpy = vi.spyOn(manager, "react").mockResolvedValue("quip");
		controller.enabled = false;

		await controller.triggerReaction("something happened");
		expect(reactSpy).not.toHaveBeenCalled();
		expect(callbacks.onThinkingStart).not.toHaveBeenCalled();
		expect(callbacks.onSpeech).not.toHaveBeenCalled();
	});

	it("should suppress detectNameCall when disabled", () => {
		writeStoredBuddy({ name: "Zorp" });
		const { controller, manager } = createTestController();
		manager.load();

		controller.enabled = false;
		expect(controller.detectNameCall("Hey Zorp!")).toBe(false);
	});

	it("should suppress handleNameCall when disabled", async () => {
		writeStoredBuddy({ name: "Zorp" });
		const { controller, callbacks, manager } = createTestController();
		manager.load();

		const nameCallSpy = vi.spyOn(manager, "respondToNameCall");
		controller.enabled = false;

		await controller.handleNameCall("Hey Zorp!");
		expect(nameCallSpy).not.toHaveBeenCalled();
		expect(callbacks.onThinkingStart).not.toHaveBeenCalled();
	});

	it("should suppress resetIdleTimer when disabled", () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		controller.enabled = false;
		controller.resetIdleTimer();
		expect((controller as any).idleTimer).toBeNull();
	});

	it("should still capture context in handleEvent when disabled", () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		controller.enabled = false;

		controller.handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hello" }],
			},
		});

		expect(controller.buildContext()).toContain("Assistant: Hello");
	});

	it("should suppress reaction in handleEvent when disabled (tool error)", () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		const reactSpy = vi.spyOn(manager, "react").mockResolvedValue("quip");
		controller.enabled = false;

		controller.handleEvent({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "1",
			result: { content: [{ type: "text", text: "error!" }] },
			isError: true,
		});

		// Context still captured
		expect(controller.buildContext()).toContain("Tool bash failed");
		// But no reaction
		expect(reactSpy).not.toHaveBeenCalled();
	});

	it("should suppress reaction in handleEvent when disabled (agent_end)", () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		const reactSpy = vi.spyOn(manager, "react").mockResolvedValue("quip");
		controller.enabled = false;

		controller.handleEvent({ type: "agent_end", messages: [] });
		expect(reactSpy).not.toHaveBeenCalled();
	});

	it("should re-enable via handleCommand default", async () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		// Disable via off
		await controller.handleCommand("off");
		expect(controller.enabled).toBe(false);

		// Re-enable via default (bare /buddy)
		const result = await controller.handleCommand("");
		expect(result.type).toBe("show");
		expect(controller.enabled).toBe(true);
	});

	it("should re-enable reactions after re-enable", async () => {
		writeStoredBuddy();
		const { controller, callbacks, manager } = createTestController();
		manager.load();

		// Disable
		await controller.handleCommand("off");

		// Re-enable
		await controller.handleCommand("");

		// Now reactions should work
		vi.spyOn(manager, "react").mockResolvedValue("I'm back!");
		await controller.triggerReaction("test event");
		expect(callbacks.onSpeech).toHaveBeenCalledWith("I'm back!");
	});

	it("should load any existing buddy via start() regardless of stored data", () => {
		writeStoredBuddy();
		const { controller } = createTestController();

		const result = controller.start();
		expect(result).not.toBeNull();
		expect(result!.name).toBe("Testbud");
		expect(controller.enabled).toBe(true);
	});

	it("should persist hidden=true on off and clear on re-enable", async () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		// Off should persist hidden
		await controller.handleCommand("off");
		const stored = JSON.parse(readFileSync(join(TEST_DIR, "buddy.json"), "utf-8"));
		expect(stored.hidden).toBe(true);

		// Re-enable should clear hidden
		await controller.handleCommand("");
		const stored2 = JSON.parse(readFileSync(join(TEST_DIR, "buddy.json"), "utf-8"));
		expect(stored2.hidden).toBeFalsy();
	});

	it("should start with enabled=false when stored buddy has hidden=true", () => {
		writeStoredBuddy();
		const { controller } = createTestController();

		// Manually set hidden
		const stored = JSON.parse(readFileSync(join(TEST_DIR, "buddy.json"), "utf-8"));
		stored.hidden = true;
		writeFileSync(join(TEST_DIR, "buddy.json"), JSON.stringify(stored));

		const state = controller.start();
		expect(state).not.toBeNull(); // buddy loaded from disk
		expect(controller.enabled).toBe(false); // but disabled
	});

	it("should keep buddy disabled after reset() when /buddy off was called", async () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();
		controller.start();

		// /buddy off — sets enabled=false and persists hidden=true
		await controller.handleCommand("off");
		expect(controller.enabled).toBe(false);

		// Simulate bridge reconnect — reset() should respect hidden state
		controller.reset();
		expect(controller.enabled).toBe(false); // stays disabled
	});
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

	it("should not start idle timer when outside activity gate", () => {
		const { controller } = createTestController({ activityGateMs: 100 });
		controller.markActivity();
		(controller as any).lastActivityTime = Date.now() - 1000; // old activity
		controller.resetIdleTimer();
		expect((controller as any).idleTimer).toBeNull();
	});

	it("should not start idle timer when no buddy loaded", () => {
		const { controller } = createTestController();
		// No buddy loaded, no stored buddy
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

	it("should call onThinkingEnd and not call onSpeech when respondToNameCall throws", async () => {
		writeStoredBuddy();
		const { controller, callbacks, manager } = createTestController();
		manager.load();

		vi.spyOn(manager, "respondToNameCall").mockRejectedValue(new Error("Ollama crashed"));

		await controller.handleNameCall("Hey Testbud!");
		expect(callbacks.onThinkingStart).toHaveBeenCalled();
		expect(callbacks.onThinkingEnd).toHaveBeenCalled();
		expect(callbacks.onSpeech).not.toHaveBeenCalled();
	});

	it("should load from disk when handling name-call with no in-memory state", async () => {
		writeStoredBuddy({ name: "Zorp" });
		const { controller, callbacks, manager } = createTestController();
		// Don't call manager.load() — simulate disk-only buddy (hatched in another frontend)

		vi.spyOn(manager, "respondToNameCall").mockResolvedValue("Hello from disk!");

		await controller.handleNameCall("Hey Zorp!");
		expect(callbacks.onThinkingStart).toHaveBeenCalled();
		expect(callbacks.onSpeech).toHaveBeenCalledWith("Hello from disk!");
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

	it("should trigger reaction on tool error with result.error string", () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		const reactSpy = vi.spyOn(manager, "react").mockResolvedValue("ouch!");

		controller.handleEvent({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "1",
			result: { error: "permission denied" },
			isError: true,
		});

		// Context should capture the error text
		expect(controller.buildContext()).toContain("Tool bash failed");
		// Reaction should be triggered with the error string
		expect(reactSpy).toHaveBeenCalled();
		expect(reactSpy).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
	});

	it("should trigger reaction on agent_end with context", () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		// Seed some context so we can verify it's passed through
		controller.appendContext("User: fix the bug");
		controller.appendContext("Assistant: I found the issue");

		const reactSpy = vi.spyOn(manager, "react").mockResolvedValue("nice work!");

		controller.handleEvent({ type: "agent_end", messages: [] });

		expect(reactSpy).toHaveBeenCalledWith(
			"The agent finished responding. Recent activity:\nUser: fix the bug\nAssistant: I found the issue",
		);
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

	it("should return false when no name-call detected", () => {
		writeStoredBuddy({ name: "Zorp" });
		const { controller, manager } = createTestController();
		manager.load();

		const result = controller.processUserMessage("Hello world");

		expect(result).toBe(false);
	});

	it("should return true when name-call detected", () => {
		writeStoredBuddy({ name: "Zorp" });
		const { controller, manager } = createTestController();
		manager.load();

		vi.spyOn(controller, "handleNameCall").mockResolvedValue();

		const result = controller.processUserMessage("Hey Zorp!");

		expect(result).toBe(true);
	});

	it("should detect name-call", () => {
		writeStoredBuddy({ name: "Zorp" });
		const { controller, manager } = createTestController();
		manager.load();

		const nameCallSpy = vi.spyOn(controller, "handleNameCall").mockResolvedValue();

		controller.processUserMessage("Hey Zorp!");

		expect(nameCallSpy).toHaveBeenCalledWith("Hey Zorp!");
	});

	it("should call handleNameCall when name detected via processUserMessage", async () => {
		writeStoredBuddy({ name: "Zorp" });
		const { controller, callbacks, manager } = createTestController();
		manager.load();

		vi.spyOn(manager, "respondToNameCall").mockResolvedValue("Hey!");

		controller.processUserMessage("Hey Zorp, what's up?");

		// Wait for the async handleNameCall
		await vi.waitFor(() => {
			expect(callbacks.onSpeech).toHaveBeenCalledWith("Hey!");
		});
	});

	it("should still capture context and reset idle even for name-calls", async () => {
		writeStoredBuddy({ name: "Zorp" });
		const { controller, manager } = createTestController();
		manager.load();

		const idleSpy = vi.spyOn(controller, "resetIdleTimer");
		controller.processUserMessage("Hey Zorp, what's up?");

		expect(controller.buildContext()).toContain("User: Hey Zorp, what's up?");
		expect(idleSpy).toHaveBeenCalled();
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

	it("should return error for hatch when onHatch throws", async () => {
		const { controller, callbacks } = createTestController();
		(callbacks.onHatch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("No model available"));
		const result = await controller.handleCommand("");
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.message).toContain("No model available");
	});

	it("should return off result, set enabled=false, and stop idle timer", async () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		// Set up an idle timer so we can verify it gets cleared
		controller.resetIdleTimer();
		expect((controller as any).idleTimer).not.toBeNull();

		const result = await controller.handleCommand("off");
		expect(result.type).toBe("off");
		expect(controller.enabled).toBe(false);
		expect((controller as any).idleTimer).toBeNull();
	});

	it("should return warning for reroll with no stored buddy", async () => {
		const { controller } = createTestController();
		const result = await controller.handleCommand("reroll");
		expect(result.type).toBe("warning");
	});

	it("should hatch new buddy when no stored buddy exists", async () => {
		const { controller, callbacks } = createTestController();
		const mockState = createMockBuddyState();
		(callbacks.onHatch as ReturnType<typeof vi.fn>).mockResolvedValue(mockState);

		const result = await controller.handleCommand("");
		expect(result.type).toBe("hatch");
		if (result.type === "hatch") {
			expect(result.state.name).toBe("Testbud");
		}
		expect(callbacks.onHatch).toHaveBeenCalledWith(controller.manager);
		expect(callbacks.onThinkingStart).toHaveBeenCalled();
		expect(callbacks.onThinkingEnd).toHaveBeenCalled();
		expect(controller.enabled).toBe(true);
	});

	it("should reroll when stored buddy exists", async () => {
		writeStoredBuddy();
		const { controller, callbacks, manager } = createTestController();
		manager.load();
		const mockState = createMockBuddyState({ name: "Newbud" });
		(callbacks.onReroll as ReturnType<typeof vi.fn>).mockResolvedValue(mockState);

		const result = await controller.handleCommand("reroll");
		expect(result.type).toBe("reroll");
		if (result.type === "reroll") {
			expect(result.state.name).toBe("Newbud");
		}
		expect(callbacks.onReroll).toHaveBeenCalledWith(controller.manager);
		expect(callbacks.onThinkingStart).toHaveBeenCalled();
		expect(callbacks.onThinkingEnd).toHaveBeenCalled();
		expect(controller.enabled).toBe(true);
	});

	it("should return error for reroll when onReroll throws", async () => {
		writeStoredBuddy();
		const { controller, callbacks, manager } = createTestController();
		manager.load();
		(callbacks.onReroll as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Ollama unavailable"));

		const result = await controller.handleCommand("reroll");
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.message).toContain("Reroll failed");
		expect(callbacks.onThinkingStart).toHaveBeenCalled();
		expect(callbacks.onThinkingEnd).toHaveBeenCalled();
	});
});

// ===========================================================================
// Idle timer firing
// ===========================================================================
describe("idle timer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("should trigger reaction when idle timer fires", async () => {
		writeStoredBuddy();
		const { controller, callbacks, manager } = createTestController({
			idleTimeoutMs: undefined,
		} as any);
		// Override config for short timeout
		(controller as any).config.idleTimeoutMs = 5000;
		manager.load();

		vi.spyOn(manager, "react").mockResolvedValue("Still here!");

		// Seed context so the timer callback has something to report
		controller.appendContext("User: wrote some code");
		controller.markActivity();
		controller.resetIdleTimer();

		// Timer should not have fired yet
		expect(callbacks.onSpeech).not.toHaveBeenCalled();

		// Advance past the idle timeout
		vi.advanceTimersByTime(5000);

		// Wait for the async reaction to complete
		await vi.runAllTimersAsync();

		expect(callbacks.onThinkingStart).toHaveBeenCalled();
		expect(callbacks.onThinkingEnd).toHaveBeenCalled();
		expect(callbacks.onSpeech).toHaveBeenCalledWith("Still here!");
	});
});

// ===========================================================================
// Lifecycle
// ===========================================================================
describe("lifecycle", () => {
	it("should return null when no stored buddy", () => {
		const { controller } = createTestController();
		expect(controller.start()).toBeNull();
	});

	it("should load buddy from stored data regardless of stored fields", () => {
		writeStoredBuddy();
		const { controller } = createTestController();

		const state = controller.start();
		expect(state).not.toBeNull();
		expect(state!.name).toBe("Testbud");
		expect(controller.enabled).toBe(true);
	});

	it("should clear timers on stop", () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

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

// ===========================================================================
// Model command
// ===========================================================================
describe("handleCommand — model", () => {
	afterEach(() => {
		vi.mocked(checkOllama).mockReset();
	});

	it("should show Ollama not running when checking models", async () => {
		vi.mocked(checkOllama).mockResolvedValue({
			available: false,
			models: [],
			error: "Ollama is not running. Start it with: ollama serve",
		});

		const { controller } = createTestController();
		const result = await controller.handleCommand("model");

		expect(result.type).toBe("model");
		if (result.type === "model") {
			expect(result.message).toContain("Ollama is not running");
		}
	});

	it("should show 'no models installed' when Ollama running but empty", async () => {
		vi.mocked(checkOllama).mockResolvedValue({
			available: false,
			models: [],
			error: "No models installed. Run: ollama pull llama3.2",
		});

		const { controller } = createTestController();
		const result = await controller.handleCommand("model");

		expect(result.type).toBe("model");
		if (result.type === "model") {
			expect(result.message).toContain("No models installed");
		}
	});

	it("should show current model and available models", async () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		vi.spyOn(manager, "getOllamaModel").mockReturnValue("test-model");
		vi.mocked(checkOllama).mockResolvedValue({
			available: true,
			models: ["test-model", "other-model"],
		});

		const result = await controller.handleCommand("model");

		expect(result.type).toBe("model");
		if (result.type === "model") {
			expect(result.message).toContain("Current model: test-model");
			expect(result.message).toContain("other-model");
		}
	});

	it("should show 'No model set' when no model configured", async () => {
		vi.mocked(checkOllama).mockResolvedValue({
			available: true,
			models: ["llama3.2:latest"],
		});

		const { controller, manager } = createTestController();
		vi.spyOn(manager, "getOllamaModel").mockReturnValue(null);

		const result = await controller.handleCommand("model");

		expect(result.type).toBe("model");
		if (result.type === "model") {
			expect(result.message).toContain("No model set");
			expect(result.message).toContain("llama3.2:latest");
		}
	});

	it("should set model when valid name provided", async () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		vi.mocked(checkOllama).mockResolvedValue({
			available: true,
			models: ["test-model:latest"],
		});
		const setModelSpy = vi.spyOn(manager, "setOllamaModel");

		const result = await controller.handleCommand("model test-model");

		expect(result.type).toBe("model");
		if (result.type === "model") {
			expect(result.message).toBe("Buddy model set to: test-model:latest");
		}
		expect(setModelSpy).toHaveBeenCalledWith("test-model:latest");
	});

	it("should return error when model not found", async () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		vi.mocked(checkOllama).mockResolvedValue({
			available: true,
			models: ["llama3.2:latest", "mistral:latest"],
		});

		const result = await controller.handleCommand("model nonexistent");

		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.message).toContain("not found");
		}
	});

	it("should return warning when setting model before hatching", async () => {
		// No writeStoredBuddy() — no buddy exists
		const { controller } = createTestController();

		const result = await controller.handleCommand("model test-model");

		expect(result.type).toBe("warning");
		if (result.type === "warning") {
			expect(result.message).toContain("No buddy yet");
		}
	});

	it("should return error when setting model with Ollama not running", async () => {
		writeStoredBuddy();
		const { controller, manager } = createTestController();
		manager.load();

		vi.mocked(checkOllama).mockResolvedValue({
			available: false,
			models: [],
			error: "Ollama is not running. Start it with: ollama serve",
		});

		const result = await controller.handleCommand("model test-model");

		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.message).toContain("not running");
		}
	});
});

// ===========================================================================
// getModelNudge
// ===========================================================================
describe("getModelNudge", () => {
	it("should return null when model is configured", () => {
		writeStoredBuddy({ ollamaModel: "test-model" });
		const { controller, manager } = createTestController();
		manager.load();

		expect(controller.getModelNudge()).toBeNull();
	});

	it("should return nudge string when no model configured", () => {
		writeStoredBuddy({ ollamaModel: undefined });
		const { controller, manager } = createTestController();
		manager.load();

		const nudge = controller.getModelNudge();
		expect(nudge).not.toBeNull();
		expect(nudge).toContain("/buddy model");
	});

	it("should return nudge string when no buddy exists", () => {
		const { controller } = createTestController();

		const nudge = controller.getModelNudge();
		expect(nudge).not.toBeNull();
		expect(nudge).toContain("/buddy model");
	});
});
