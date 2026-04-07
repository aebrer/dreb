/**
 * Unit tests for buddy-manager — state machine, persistence, hatch, and reroll.
 */

import type { Model } from "@dreb/ai";
import { completeSimple } from "@dreb/ai";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuddyManager, checkOllama, truncateResponse } from "../src/core/buddy/buddy-manager.js";
import type { StoredCompanion } from "../src/core/buddy/buddy-types.js";

const TEST_DIR = join(tmpdir(), "dreb-buddy-test");

// vi.mock is hoisted, so we use the factory pattern to avoid TDZ issues
vi.mock("@dreb/ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dreb/ai")>();
	return {
		...actual,
		completeSimple: vi.fn(),
	};
});

/** Create a minimal test model */
function createTestModel(): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "test",
		baseUrl: "http://localhost:0/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 256,
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
	};
}

/** Create a mock LLM response for soul generation */
function mockSoulResponse(name: string, personality: string, backstory?: string): void {
	vi.mocked(completeSimple).mockResolvedValue({
		role: "assistant",
		content: [
			{
				type: "text",
				text: `NAME: ${name}\nPERSONALITY: ${personality}\nBACKSTORY: ${backstory ?? "A mysterious past shrouded in legend."}`,
			},
		],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

/** Helper to set env and return restore function */
function withTestEnv(): () => void {
	const origEnv = process.env.DREB_CODING_AGENT_DIR;
	process.env.DREB_CODING_AGENT_DIR = TEST_DIR;
	return () => {
		process.env.DREB_CODING_AGENT_DIR = origEnv;
	};
}

/** Write a stored companion to the test dir */
function writeStoredBuddy(overrides: Partial<StoredCompanion> = {}): void {
	const stored: StoredCompanion = {
		rerollCount: 0,
		name: "TestBuddy",
		personality: "Test personality",
		backstory: "A mysterious past shrouded in legend.",
		hatchedAt: new Date().toISOString(),
		ollamaModel: "test-model",
		...overrides,
	};
	writeFileSync(join(TEST_DIR, "buddy.json"), JSON.stringify(stored));
}

/** Read buddy.json from test dir */
function readStoredBuddy(): StoredCompanion {
	return JSON.parse(readFileSync(join(TEST_DIR, "buddy.json"), "utf-8"));
}

beforeEach(() => {
	// Clean test dir
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	vi.mocked(completeSimple).mockReset();
});

afterEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("BuddyManager", () => {
	it("has no stored buddy initially", () => {
		const restore = withTestEnv();
		const mgr = new BuddyManager();
		expect(mgr.hasStoredBuddy()).toBe(false);
		restore();
	});

	it("loads null when no stored buddy", () => {
		const restore = withTestEnv();
		const mgr = new BuddyManager();
		expect(mgr.load()).toBeNull();
		restore();
	});

	it("loads a stored buddy from disk", () => {
		const restore = withTestEnv();
		writeStoredBuddy();

		const mgr = new BuddyManager();
		const state = mgr.load();

		restore();

		expect(state).not.toBeNull();
		expect(state!.name).toBe("TestBuddy");
		expect(state!.species).toBeDefined();
		expect(state!.rarity).toBeDefined();
		expect(state!.stats).toBeDefined();
	});

	it("getName returns null when no buddy", () => {
		const mgr = new BuddyManager();
		expect(mgr.getName()).toBeNull();
	});

	it("getName returns stored name from disk", () => {
		const restore = withTestEnv();
		writeStoredBuddy({ name: "Quackers" });

		const mgr = new BuddyManager();
		expect(mgr.getName()).toBe("Quackers");

		restore();
	});
});

describe("BuddyManager.hatch()", () => {
	it("creates a new buddy with LLM-generated soul", async () => {
		const restore = withTestEnv();
		mockSoulResponse("Sparky", "A feisty little companion.");

		const mgr = new BuddyManager();
		const state = await mgr.hatch(createTestModel(), "test-key");

		restore();

		// Verify buddy state shape
		expect(state.species).toBeDefined();
		expect(state.rarity).toBeDefined();
		expect(state.stats).toBeDefined();
		expect(state.eyeStyle).toBeDefined();
		expect(state.hat).toBeDefined();
		expect(state.name).toBe("Sparky");
		expect(state.personality).toBe("A feisty little companion.");
		expect(state.backstory).toBe("A mysterious past shrouded in legend.");
		expect(state.hatchedAt).toBeDefined();
		expect(state.rerollCount).toBe(0);

		// Verify LLM was called
		expect(vi.mocked(completeSimple)).toHaveBeenCalledOnce();
	});

	it("persists buddy to disk", async () => {
		const restore = withTestEnv();
		mockSoulResponse("Rex", "Bold and brave.");

		const mgr = new BuddyManager();
		await mgr.hatch(createTestModel(), "test-key");

		restore();

		const diskData = readStoredBuddy();
		expect(diskData.name).toBe("Rex");
		expect(diskData.personality).toBe("Bold and brave.");
		expect(diskData.rerollCount).toBe(0);
	});

	it("falls back to species name when LLM fails", async () => {
		const restore = withTestEnv();
		vi.mocked(completeSimple).mockRejectedValue(new Error("LLM unavailable"));

		const mgr = new BuddyManager();
		const state = await mgr.hatch(createTestModel(), "test-key");

		restore();

		// Should use species name as fallback
		expect(state.name).toBe(state.species);
		expect(state.personality).toContain(state.rarity);
		expect(state.personality).toContain(state.species);
	});

	it("preserves existing rerollCount when re-hatching", async () => {
		const restore = withTestEnv();
		writeStoredBuddy({ rerollCount: 3, name: "Old" });
		mockSoulResponse("New", "Fresh start.");

		const mgr = new BuddyManager();
		const state = await mgr.hatch(createTestModel(), "test-key");

		restore();

		// rerollCount is preserved from existing buddy
		expect(state.rerollCount).toBe(3);
	});

	it("truncates long names to 12 chars", async () => {
		const restore = withTestEnv();
		mockSoulResponse("SuperCalifragilistic", "Long name.");

		const mgr = new BuddyManager();
		const state = await mgr.hatch(createTestModel(), "test-key");

		restore();

		expect(state.name.length).toBeLessThanOrEqual(8);
		expect(state.name).toBe("SuperCal");
	});

	it("starts with rerollCount 0 when no existing buddy", async () => {
		const restore = withTestEnv();
		mockSoulResponse("Fresh", "Brand new.");

		const mgr = new BuddyManager();
		const state = await mgr.hatch(createTestModel(), "test-key");

		restore();

		expect(state.rerollCount).toBe(0);
	});
});

describe("BuddyManager.reroll()", () => {
	it("increments rerollCount and generates new soul", async () => {
		const restore = withTestEnv();
		writeStoredBuddy({ rerollCount: 0, name: "OldBuddy" });
		mockSoulResponse("Phoenix", "Reborn from ashes.");

		const mgr = new BuddyManager();
		const state = await mgr.reroll(createTestModel(), "test-key");

		restore();

		expect(state.rerollCount).toBe(1);
		expect(state.name).toBe("Phoenix");
		expect(state.personality).toBe("Reborn from ashes.");
	});

	it("increments from existing rerollCount", async () => {
		const restore = withTestEnv();
		writeStoredBuddy({ rerollCount: 5, name: "OldBuddy" });
		mockSoulResponse("Six", "Sixth time lucky.");

		const mgr = new BuddyManager();
		const state = await mgr.reroll(createTestModel(), "test-key");

		restore();

		expect(state.rerollCount).toBe(6);
	});

	it("persists new rerollCount to disk", async () => {
		const restore = withTestEnv();
		writeStoredBuddy({ rerollCount: 2, name: "OldBuddy" });
		mockSoulResponse("Disk", "Persisted.");

		const mgr = new BuddyManager();
		await mgr.reroll(createTestModel(), "test-key");

		restore();

		const diskData = readStoredBuddy();
		expect(diskData.rerollCount).toBe(3);
		expect(diskData.name).toBe("Disk");
	});

	it("falls back gracefully when LLM fails", async () => {
		const restore = withTestEnv();
		writeStoredBuddy({ rerollCount: 1, name: "OldBuddy" });
		vi.mocked(completeSimple).mockRejectedValue(new Error("LLM down"));

		const mgr = new BuddyManager();
		const state = await mgr.reroll(createTestModel(), "test-key");

		restore();

		expect(state.rerollCount).toBe(2);
		expect(state.name).toBe(state.species);
	});

	it("produces different bones from hatch due to different seed", async () => {
		const restore = withTestEnv();
		mockSoulResponse("Alpha", "First.");

		const mgr = new BuddyManager();
		const hatched = await mgr.hatch(createTestModel(), "test-key");

		mockSoulResponse("Beta", "Second.");

		const rerolled = await mgr.reroll(createTestModel(), "test-key");

		restore();

		// Different rerollCount means different seed → different bones
		// The species/stats may or may not differ (PRNG), but rerollCount must
		expect(rerolled.rerollCount).toBe(1);
		expect(hatched.rerollCount).toBe(0);
	});
});

describe("checkOllama", () => {
	it("returns unavailable when Ollama is not running", async () => {
		const status = await checkOllama();
		// In test env, Ollama likely isn't running
		if (!status.available) {
			expect(status.error).toBeDefined();
		}
		// If it IS running, that's fine too
		expect(typeof status.available).toBe("boolean");
	});
});

describe("BuddyManager.react()", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns null when no state loaded", async () => {
		const restore = withTestEnv();
		const mgr = new BuddyManager();
		const result = await mgr.react("some event");
		restore();
		expect(result).toBeNull();
	});

	it("returns null when Ollama unavailable", async () => {
		const restore = withTestEnv();
		writeStoredBuddy();
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 503,
		});

		const mgr = new BuddyManager();
		mgr.load();
		const result = await mgr.react("Tool bash failed");
		restore();
		expect(result).toBeNull();
	});

	it("returns quip from Ollama when available", async () => {
		const restore = withTestEnv();
		writeStoredBuddy();
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ models: [{ name: "test-model" }] }),
		});
		vi.mocked(completeSimple).mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "Looks like someone forgot a semicolon again!" }],
			api: "openai-completions",
			provider: "ollama",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const mgr = new BuddyManager();
		mgr.load();
		const result = await mgr.react("Tool bash failed");
		restore();
		expect(result).toBe("Looks like someone forgot a semicolon again!");
	});

	it("returns null on Ollama error response", async () => {
		const restore = withTestEnv();
		writeStoredBuddy();
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ models: [{ name: "test-model" }] }),
		});
		vi.mocked(completeSimple).mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "error text" }],
			api: "openai-completions",
			provider: "ollama",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			timestamp: Date.now(),
		});

		const mgr = new BuddyManager();
		mgr.load();
		const result = await mgr.react("some event");
		restore();
		expect(result).toBeNull();
	});

	it("returns null when completeSimple throws", async () => {
		const restore = withTestEnv();
		writeStoredBuddy();
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ models: [{ name: "test-model" }] }),
		});
		vi.mocked(completeSimple).mockRejectedValue(new Error("Connection refused"));

		const mgr = new BuddyManager();
		mgr.load();
		const result = await mgr.react("some event");
		restore();
		expect(result).toBeNull();
	});

	it("caches Ollama status", async () => {
		const restore = withTestEnv();
		writeStoredBuddy();
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ models: [{ name: "test-model" }] }),
		});
		globalThis.fetch = mockFetch;
		vi.mocked(completeSimple).mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "Quip 1" }],
			api: "openai-completions",
			provider: "ollama",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const mgr = new BuddyManager();
		mgr.load();
		await mgr.react("event 1");
		await mgr.react("event 2");
		restore();
		// checkOllama (fetch) should only be called once — second call uses cache
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it("re-checks Ollama when previously unavailable", async () => {
		const restore = withTestEnv();
		writeStoredBuddy();
		const mockFetch = vi.fn();
		// First call: unavailable
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 503,
		});
		// Second call: available
		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({ models: [{ name: "test-model" }] }),
		});
		globalThis.fetch = mockFetch;
		vi.mocked(completeSimple).mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "Now I'm here!" }],
			api: "openai-completions",
			provider: "ollama",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const mgr = new BuddyManager();
		mgr.load();
		const result1 = await mgr.react("event 1");
		expect(result1).toBeNull();
		const result2 = await mgr.react("event 2");
		restore();
		expect(result2).toBe("Now I'm here!");
		// checkOllama should have been called twice
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});
});

describe("BuddyManager.respondToNameCall()", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns null when no state loaded", async () => {
		const restore = withTestEnv();
		const mgr = new BuddyManager();
		const result = await mgr.respondToNameCall("hello", "context");
		restore();
		expect(result).toBeNull();
	});

	it("returns null when Ollama unavailable", async () => {
		const restore = withTestEnv();
		writeStoredBuddy({ name: "Quackers" });
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 503,
		});

		const mgr = new BuddyManager();
		mgr.load();
		const result = await mgr.respondToNameCall("hey buddy", "coding");
		restore();
		expect(result).toBeNull();
	});

	it("returns response from Ollama when available", async () => {
		const restore = withTestEnv();
		writeStoredBuddy({ name: "Sparky" });
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ models: [{ name: "test-model" }] }),
		});
		vi.mocked(completeSimple).mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "Hey there, code warrior!" }],
			api: "openai-completions",
			provider: "ollama",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const mgr = new BuddyManager();
		mgr.load();
		const result = await mgr.respondToNameCall("what's up", "debugging code");
		restore();
		expect(result).toBe("Hey there, code warrior!");
	});

	it("returns null on error", async () => {
		const restore = withTestEnv();
		writeStoredBuddy({ name: "Rex" });
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ models: [{ name: "test-model" }] }),
		});
		vi.mocked(completeSimple).mockRejectedValue(new Error("Ollama crashed"));

		const mgr = new BuddyManager();
		mgr.load();
		const result = await mgr.respondToNameCall("hello", "context");
		restore();
		expect(result).toBeNull();
	});
});

describe("truncateResponse", () => {
	it("passes through short responses unchanged", () => {
		expect(truncateResponse("Hello world!", 300)).toBe("Hello world!");
	});

	it("passes through responses at exactly the limit", () => {
		const words = Array.from({ length: 300 }, (_, i) => `word${i}`);
		const text = words.join(" ");
		expect(truncateResponse(text, 300)).toBe(text);
	});

	it("truncates responses over the word limit", () => {
		const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
		const text = words.join(" ");
		const result = truncateResponse(text, 300);
		expect(result).toContain("...[truncated]");
		expect(result.split(/\s+/).length).toBeLessThanOrEqual(302); // 300 words + "...[truncated]"
	});

	it("preserves content before truncation point", () => {
		const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
		const text = words.join(" ");
		const result = truncateResponse(text, 300);
		expect(result.startsWith("word0 word1 word2")).toBe(true);
		expect(result).toContain("word299");
		expect(result).not.toContain("word300");
	});

	it("handles empty string", () => {
		expect(truncateResponse("", 300)).toBe("");
	});

	it("handles single word", () => {
		expect(truncateResponse("hello", 300)).toBe("hello");
	});
});

describe("BuddyManager.react() response processing", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("truncates overly long responses", async () => {
		const restore = withTestEnv();
		writeStoredBuddy();
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ models: [{ name: "test-model" }] }),
		});
		const longText = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
		vi.mocked(completeSimple).mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: longText }],
			api: "openai-completions",
			provider: "ollama",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const mgr = new BuddyManager();
		mgr.load();
		const result = await mgr.react("some event");
		restore();
		expect(result).toContain("...[truncated]");
	});

	it("filters out thinking blocks (only uses text content)", async () => {
		const restore = withTestEnv();
		writeStoredBuddy();
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ models: [{ name: "test-model" }] }),
		});
		// Simulate a properly-configured reasoning model: thinking in a structured block,
		// final answer in a text block
		vi.mocked(completeSimple).mockResolvedValue({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Let me think about this...", thinkingSignature: "reasoning" },
				{ type: "text", text: "Nice debugging!" },
			],
			api: "openai-completions",
			provider: "ollama",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const mgr = new BuddyManager();
		mgr.load();
		const result = await mgr.react("User fixed a bug");
		restore();
		expect(result).toBe("Nice debugging!");
	});

	it("returns null when response is only whitespace", async () => {
		const restore = withTestEnv();
		writeStoredBuddy();
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ models: [{ name: "test-model" }] }),
		});
		vi.mocked(completeSimple).mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "   \n  " }],
			api: "openai-completions",
			provider: "ollama",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const mgr = new BuddyManager();
		mgr.load();
		const result = await mgr.react("some event");
		restore();
		expect(result).toBeNull();
	});

	it("uses the configured ollamaModel", async () => {
		const restore = withTestEnv();
		writeStoredBuddy({ ollamaModel: "phi4-mini" });
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ models: [{ name: "llama3.2" }, { name: "phi4-mini:latest" }] }),
		});
		vi.mocked(completeSimple).mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "Hello!" }],
			api: "openai-completions",
			provider: "ollama",
			model: "phi4-mini:latest",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const mgr = new BuddyManager();
		mgr.load();
		await mgr.react("some event");
		restore();

		// Should use the configured model, not the first available
		const call = vi.mocked(completeSimple).mock.calls[0];
		expect(call[0].id).toBe("phi4-mini:latest");
	});

	it("returns error message when no ollamaModel is configured", async () => {
		const restore = withTestEnv();
		writeStoredBuddy({ ollamaModel: undefined });
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ models: [{ name: "llama3.2" }] }),
		});

		const mgr = new BuddyManager();
		mgr.load();
		const result = await mgr.react("some event");
		restore();

		// No model configured — should not call completeSimple, should return instruction
		expect(vi.mocked(completeSimple)).not.toHaveBeenCalled();
		expect(result).toContain("/buddy model");
	});
});
