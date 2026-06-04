import { setKeybindings } from "@dreb/tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AgentModelsSubmenu } from "../src/modes/interactive/components/settings-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	// Keybindings are a global singleton — reset for test isolation.
	setKeybindings(new KeybindingsManager());
});

// Key escape sequences
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const DELETE = "\x1b[3~";
const BACKSPACE = "\x7f";
const REORDER_DOWN = "]"; // RankedList: move selected item down
const REORDER_UP = "["; // RankedList: move selected item up

const AGENT_NAMES = ["explore", "plan"];
const AVAILABLE_MODELS = ["model-a", "model-b", "model-c"];

function makeSubmenu(agentModels: Record<string, string[]> = {}) {
	const onModelsChange = vi.fn();
	const onCancel = vi.fn();
	const submenu = new AgentModelsSubmenu(AGENT_NAMES, agentModels, AVAILABLE_MODELS, onModelsChange, onCancel);
	return { submenu, onModelsChange, onCancel };
}

describe("AgentModelsSubmenu — agent list view", () => {
	test("renders each agent with its current models, or 'default' when none configured", () => {
		const { submenu } = makeSubmenu({ explore: ["model-a", "model-b"] });
		const output = submenu.render(80).join("\n");

		expect(output).toContain("Agent Models");
		expect(output).toContain("explore");
		expect(output).toContain("plan");
		// explore has configured models -> joined as description
		expect(output).toContain("model-a, model-b");
		// plan has no configured models -> "default"
		expect(output).toContain("default");
	});

	test("selecting an agent with Enter transitions to the ranked view", () => {
		const { submenu } = makeSubmenu({ explore: ["model-a", "model-b"] });

		submenu.handleInput(ENTER); // first item ("explore")
		const output = submenu.render(80).join("\n");

		// Ranked view heading includes the agent name
		expect(output).toContain("Agent Models › explore");
		expect(output).toContain("model-a");
		expect(output).toContain("model-b");
	});

	test("Escape from agent list fires onCancel", () => {
		const { submenu, onCancel } = makeSubmenu();
		submenu.handleInput(ESC);
		expect(onCancel).toHaveBeenCalled();
	});
});

describe("AgentModelsSubmenu — ranked view", () => {
	test("reordering fires onModelsChange with the reordered values", () => {
		const { submenu, onModelsChange } = makeSubmenu({ explore: ["model-a", "model-b"] });

		submenu.handleInput(ENTER); // open explore
		// Selected index starts at 0 (model-a); move it down past model-b.
		submenu.handleInput(REORDER_DOWN);

		expect(onModelsChange).toHaveBeenCalledWith("explore", ["model-b", "model-a"]);
	});

	test("reorder up swaps the selected item upward", () => {
		const { submenu, onModelsChange } = makeSubmenu({ explore: ["model-a", "model-b"] });

		submenu.handleInput(ENTER); // open explore
		submenu.handleInput(DOWN); // navigate to model-b (index 1)
		submenu.handleInput(REORDER_UP); // move it up

		expect(onModelsChange).toHaveBeenCalledWith("explore", ["model-b", "model-a"]);
	});

	test("removing a model fires onModelsChange with the remaining values", () => {
		const { submenu, onModelsChange } = makeSubmenu({ explore: ["model-a", "model-b"] });

		submenu.handleInput(ENTER); // open explore
		submenu.handleInput(DELETE); // remove model-a (index 0)

		expect(onModelsChange).toHaveBeenCalledWith("explore", ["model-b"]);
	});

	test("removing the last model fires onModelsChange with []", () => {
		const { submenu, onModelsChange } = makeSubmenu({ explore: ["model-a"] });

		submenu.handleInput(ENTER); // open explore
		submenu.handleInput(DELETE); // remove the only model

		expect(onModelsChange).toHaveBeenCalledWith("explore", []);
	});

	test("Escape returns to the agent list and rebuilds descriptions to reflect changes", () => {
		const { submenu } = makeSubmenu({ explore: ["model-a", "model-b"] });

		submenu.handleInput(ENTER); // open explore
		submenu.handleInput(DELETE); // remove model-a -> explore now ["model-b"]
		submenu.handleInput(ESC); // back to agent list

		const output = submenu.render(80).join("\n");
		// Back on the agent list...
		expect(output).toContain("Select an agent to configure");
		// ...with a rebuilt description reflecting the removal.
		expect(output).toContain("model-b");
		expect(output).not.toContain("model-a, model-b");
	});
});

describe("AgentModelsSubmenu — add model picker", () => {
	test("Enter on the ranked list opens the add view when models remain", () => {
		const { submenu } = makeSubmenu({ explore: ["model-a", "model-b"] });

		submenu.handleInput(ENTER); // open explore (ranked view)
		submenu.handleInput(ENTER); // RankedList onSelect -> openAddModelPicker

		const output = submenu.render(80).join("\n");
		expect(output).toContain("Add Model");
		// Only model-c remains to add.
		expect(output).toContain("model-c");
	});

	test("when all available models are already added, it stays on the ranked view (no-op)", () => {
		const { submenu } = makeSubmenu({ explore: [...AVAILABLE_MODELS] });

		submenu.handleInput(ENTER); // open explore (ranked view)
		expect(() => submenu.handleInput(ENTER)).not.toThrow(); // attempt to add — should no-op

		const output = submenu.render(80).join("\n");
		// Still on ranked view, not the add view.
		expect(output).toContain("Agent Models › explore");
		expect(output).not.toContain("Add Model");
	});

	test("typing filters the add list and backspace trims the query", () => {
		const { submenu } = makeSubmenu({ plan: [] });

		submenu.handleInput(DOWN); // navigate to "plan"
		submenu.handleInput(ENTER); // open plan (empty ranked view)
		submenu.handleInput(ENTER); // open add picker with all three models

		// Type a query that narrows to model-c.
		for (const ch of "model-c") {
			submenu.handleInput(ch);
		}
		let output = submenu.render(80).join("\n");
		expect(output).toContain("Search: model-c");
		expect(output).toContain("model-c");
		expect(output).not.toContain("model-a");

		// Backspace trims the trailing char -> query "model-" matches all again.
		submenu.handleInput(BACKSPACE);
		output = submenu.render(80).join("\n");
		expect(output).toContain("Search: model-");
		expect(output).toContain("model-a");
	});

	test("selecting a model in the add view adds it and fires onModelsChange", () => {
		const { submenu, onModelsChange } = makeSubmenu({ plan: [] });

		submenu.handleInput(DOWN); // navigate to "plan"
		submenu.handleInput(ENTER); // open plan (empty ranked view)
		submenu.handleInput(ENTER); // open add picker

		// Narrow to model-c then select it.
		for (const ch of "model-c") {
			submenu.handleInput(ch);
		}
		submenu.handleInput(ENTER); // select model-c

		expect(onModelsChange).toHaveBeenCalledWith("plan", ["model-c"]);

		// Returns to the ranked view with the newly added model.
		const output = submenu.render(80).join("\n");
		expect(output).toContain("Agent Models › plan");
		expect(output).toContain("model-c");
	});
});

describe("AgentModelsSubmenu — handleInput routing", () => {
	test("reorder key in the agent list view is a no-op (routed to the agent list, not a ranked list)", () => {
		const { submenu, onModelsChange } = makeSubmenu({ explore: ["model-a", "model-b"] });

		// In the agents view, '[' / ']' have no meaning and must not reorder anything.
		submenu.handleInput(REORDER_DOWN);
		submenu.handleInput(REORDER_UP);
		expect(onModelsChange).not.toHaveBeenCalled();
		expect(submenu.render(80).join("\n")).toContain("Select an agent to configure");
	});

	test("input is routed to the ranked list while in the ranked view", () => {
		const { submenu, onModelsChange } = makeSubmenu({ explore: ["model-a", "model-b"] });

		submenu.handleInput(ENTER); // -> ranked view
		submenu.handleInput(REORDER_DOWN); // routed to RankedList
		expect(onModelsChange).toHaveBeenCalledWith("explore", ["model-b", "model-a"]);
	});

	test("input is routed to the add list while in the add view", () => {
		const { submenu } = makeSubmenu({ explore: ["model-a", "model-b"] });

		submenu.handleInput(ENTER); // -> ranked view
		submenu.handleInput(ENTER); // -> add view (only model-c remains)

		// Printable chars are consumed by the add-list search, not the ranked/agent list.
		submenu.handleInput("z"); // no model starts with "z"
		const output = submenu.render(80).join("\n");
		expect(output).toContain("Add Model");
		expect(output).toContain("Search: z");
	});
});
