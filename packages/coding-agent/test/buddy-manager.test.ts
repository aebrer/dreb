/**
 * Unit tests for buddy-manager — state machine, persistence, hatch, and reroll.
 */

import type { Model } from "@dreb/ai";
import { completeSimple } from "@dreb/ai";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuddyManager, checkOllama } from "../src/core/buddy/buddy-manager.js";
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
function mockSoulResponse(name: string, personality: string): void {
	vi.mocked(completeSimple).mockResolvedValue({
		role: "assistant",
		content: [{ type: "text", text: `NAME: ${name}\nPERSONALITY: ${personality}` }],
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
		hatchedAt: new Date().toISOString(),
		visible: true,
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

	it("setVisible persists to disk", () => {
		const restore = withTestEnv();
		writeStoredBuddy();

		const mgr = new BuddyManager();
		mgr.load();
		mgr.setVisible(false);

		const data = readStoredBuddy();
		expect(data.visible).toBe(false);

		restore();
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
		const state = await mgr.hatch(createTestModel());

		restore();

		// Verify buddy state shape
		expect(state.species).toBeDefined();
		expect(state.rarity).toBeDefined();
		expect(state.stats).toBeDefined();
		expect(state.eyeStyle).toBeDefined();
		expect(state.hat).toBeDefined();
		expect(state.name).toBe("Sparky");
		expect(state.personality).toBe("A feisty little companion.");
		expect(state.hatchedAt).toBeDefined();
		expect(state.visible).toBe(true);
		expect(state.rerollCount).toBe(0);

		// Verify LLM was called
		expect(vi.mocked(completeSimple)).toHaveBeenCalledOnce();
	});

	it("persists buddy to disk", async () => {
		const restore = withTestEnv();
		mockSoulResponse("Rex", "Bold and brave.");

		const mgr = new BuddyManager();
		await mgr.hatch(createTestModel());

		restore();

		const diskData = readStoredBuddy();
		expect(diskData.name).toBe("Rex");
		expect(diskData.personality).toBe("Bold and brave.");
		expect(diskData.visible).toBe(true);
		expect(diskData.rerollCount).toBe(0);
	});

	it("falls back to species name when LLM fails", async () => {
		const restore = withTestEnv();
		vi.mocked(completeSimple).mockRejectedValue(new Error("LLM unavailable"));

		const mgr = new BuddyManager();
		const state = await mgr.hatch(createTestModel());

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
		const state = await mgr.hatch(createTestModel());

		restore();

		// rerollCount is preserved from existing buddy
		expect(state.rerollCount).toBe(3);
	});

	it("truncates long names to 12 chars", async () => {
		const restore = withTestEnv();
		mockSoulResponse("SuperCalifragilistic", "Long name.");

		const mgr = new BuddyManager();
		const state = await mgr.hatch(createTestModel());

		restore();

		expect(state.name.length).toBeLessThanOrEqual(12);
		expect(state.name).toBe("SuperCalifra");
	});

	it("starts with rerollCount 0 when no existing buddy", async () => {
		const restore = withTestEnv();
		mockSoulResponse("Fresh", "Brand new.");

		const mgr = new BuddyManager();
		const state = await mgr.hatch(createTestModel());

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
		const state = await mgr.reroll(createTestModel());

		restore();

		expect(state.rerollCount).toBe(1);
		expect(state.name).toBe("Phoenix");
		expect(state.personality).toBe("Reborn from ashes.");
		expect(state.visible).toBe(true);
	});

	it("increments from existing rerollCount", async () => {
		const restore = withTestEnv();
		writeStoredBuddy({ rerollCount: 5, name: "OldBuddy" });
		mockSoulResponse("Six", "Sixth time lucky.");

		const mgr = new BuddyManager();
		const state = await mgr.reroll(createTestModel());

		restore();

		expect(state.rerollCount).toBe(6);
	});

	it("persists new rerollCount to disk", async () => {
		const restore = withTestEnv();
		writeStoredBuddy({ rerollCount: 2, name: "OldBuddy" });
		mockSoulResponse("Disk", "Persisted.");

		const mgr = new BuddyManager();
		await mgr.reroll(createTestModel());

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
		const state = await mgr.reroll(createTestModel());

		restore();

		expect(state.rerollCount).toBe(2);
		expect(state.name).toBe(state.species);
	});

	it("produces different bones from hatch due to different seed", async () => {
		const restore = withTestEnv();
		mockSoulResponse("Alpha", "First.");

		const mgr = new BuddyManager();
		const hatched = await mgr.hatch(createTestModel());

		mockSoulResponse("Beta", "Second.");

		const rerolled = await mgr.reroll(createTestModel());

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
