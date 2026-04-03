/**
 * Unit tests for BuddyComponent — rendering, speech bubbles, petting, state updates.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuddyState } from "../src/core/buddy/buddy-types.js";
import { Rarity, Stat } from "../src/core/buddy/buddy-types.js";
import { BuddyComponent } from "../src/modes/interactive/components/buddy-component.js";

// Mock theme to avoid needing initTheme()
vi.mock("../src/modes/interactive/theme/theme.js", () => ({
	theme: {
		bold: (s: string) => `**${s}**`,
		fg: (_color: string, s: string) => s,
	},
}));

// Minimal TUI mock
const mockRequestRender = vi.fn();
const mockUI = { requestRender: mockRequestRender } as any;

/** Helper to create a test buddy state */
function createTestState(overrides: Partial<BuddyState> = {}): BuddyState {
	return {
		species: "Duck",
		rarity: Rarity.COMMON,
		shiny: false,
		stats: {
			[Stat.DEBUGGING]: 50,
			[Stat.PATIENCE]: 60,
			[Stat.CHAOS]: 40,
			[Stat.WISDOM]: 70,
			[Stat.SNARK]: 30,
		},
		eyeStyle: "●",
		hat: "",
		rerollCount: 0,
		name: "TestDuck",
		personality: "A test duck.",
		backstory: "Once ruled a pond empire.",
		hatchedAt: new Date().toISOString(),
		visible: true,
		...overrides,
	};
}

beforeEach(() => {
	mockRequestRender.mockClear();
});

afterEach(() => {
	// Components may have intervals; nothing else to clean up since tests call dispose()
});

describe("BuddyComponent", () => {
	describe("render()", () => {
		it("returns array of strings for wide terminal", () => {
			const state = createTestState();
			const comp = new BuddyComponent(mockUI, state);
			const lines = comp.render(120);
			comp.dispose();

			expect(Array.isArray(lines)).toBe(true);
			expect(lines.length).toBeGreaterThan(0);
			// Should contain buddy name (bold-wrapped)
			const joined = lines.join("\n");
			expect(joined).toContain("TestDuck");
		});

		it("returns shorter output for narrow terminal", () => {
			const state = createTestState();
			const comp = new BuddyComponent(mockUI, state);
			const wideLines = comp.render(120);
			comp.invalidate();
			const narrowLines = comp.render(80);
			comp.dispose();

			// Narrow should have fewer lines than wide
			expect(narrowLines.length).toBeLessThan(wideLines.length);
			expect(narrowLines.length).toBeGreaterThanOrEqual(1);
			expect(narrowLines.length).toBeLessThanOrEqual(2);
		});
	});

	describe("showSpeech()", () => {
		it("adds speech bubble to output", () => {
			const state = createTestState();
			const comp = new BuddyComponent(mockUI, state);
			comp.showSpeech("Hello!");
			const lines = comp.render(120);
			comp.dispose();

			const joined = lines.join("\n");
			// Should contain the speech text
			expect(joined).toContain("Hello!");
			// Should contain bubble borders
			expect(joined).toContain("╭");
			expect(joined).toContain("╮");
			expect(joined).toContain("╰");
			expect(joined).toContain("╯");
			// requestRender should have been called
			expect(mockRequestRender).toHaveBeenCalled();
		});

		it("word-wraps long speech text", () => {
			const state = createTestState();
			const comp = new BuddyComponent(mockUI, state);
			const longText =
				"This is a very long speech that should definitely be wrapped across multiple lines because it exceeds the maximum width for the speech bubble display area.";
			comp.showSpeech(longText);
			const lines = comp.render(120);
			comp.dispose();

			// Full render has sprite + name + stats + bubble lines; bubble should have multiple content lines
			// Find the bubble lines (those with │ borders)
			const bubbleContentLines = lines.filter((l) => l.includes("│") && !l.includes("╭") && !l.includes("╰"));
			expect(bubbleContentLines.length).toBeGreaterThan(1);
		});
	});

	describe("pet()", () => {
		it("triggers petting state and requests render", () => {
			const state = createTestState();
			const comp = new BuddyComponent(mockUI, state);
			comp.pet();

			expect(mockRequestRender).toHaveBeenCalled();

			// Rendering should still work while petting
			const lines = comp.render(120);
			expect(lines.length).toBeGreaterThan(0);
			comp.dispose();
		});
	});

	describe("updateState()", () => {
		it("updates rendering with new species", () => {
			const state = createTestState({ species: "Duck", name: "TestDuck" });
			const comp = new BuddyComponent(mockUI, state);
			// Initial render
			comp.render(120);

			// Update to Cat
			const newState = createTestState({ species: "Cat", name: "TestCat" });
			comp.updateState(newState);

			expect(mockRequestRender).toHaveBeenCalled();
			const lines = comp.render(120);
			comp.dispose();

			const joined = lines.join("\n");
			expect(joined).toContain("Cat");
		});
	});

	describe("dispose()", () => {
		it("cleans up without crashing", () => {
			const state = createTestState();
			const comp = new BuddyComponent(mockUI, state);
			expect(() => comp.dispose()).not.toThrow();
		});

		it("stops animation interval", () => {
			const state = createTestState();
			const comp = new BuddyComponent(mockUI, state);

			// Access private interval to verify it was set
			const intervalBefore = (comp as any).interval;
			expect(intervalBefore).not.toBeNull();

			comp.dispose();

			const intervalAfter = (comp as any).interval;
			expect(intervalAfter).toBeNull();
		});
	});
});
