import { describe, expect, it, vi } from "vitest";
import { commandMatches, dispatchBuiltinCommand, parseDashboardBuiltin } from "../../src/client/builtin-commands.js";
import type { CommandDto } from "../../src/shared/protocol.js";

const commands: CommandDto[] = [
	{ name: "fork", description: "Fork", source: "builtin", dashboard: true },
	{ name: "copy", description: "Copy", source: "builtin", dashboard: false },
	{ name: "hotkeys", description: "Hotkeys", source: "builtin", dashboard: false },
	{ name: "buddy", description: "Buddy mode", source: "builtin", dashboard: false },
	{ name: "review", description: "Extension review", source: "extension" },
];

describe("dashboard built-in command dispatch", () => {
	it("matches only a complete built-in first token and preserves arguments", () => {
		expect(parseDashboardBuiltin("/fork from here", commands)).toMatchObject({
			command: { name: "fork" },
			args: "from here",
		});
		expect(parseDashboardBuiltin("/forklift", commands)).toBeUndefined();
		expect(parseDashboardBuiltin("/unknown", commands)).toBeUndefined();
	});

	it("routes mapped commands and gives explicit notices for invalid and future commands", async () => {
		const fork = vi.fn();
		const notice = vi.fn();
		await dispatchBuiltinCommand(parseDashboardBuiltin("/fork", commands)!, { fork }, notice);
		expect(fork).toHaveBeenCalledWith("");
		expect(notice).not.toHaveBeenCalled();

		for (const name of ["copy", "hotkeys", "buddy"]) {
			await dispatchBuiltinCommand(parseDashboardBuiltin(`/${name}`, commands)!, {}, notice);
			expect(notice).toHaveBeenLastCalledWith(`/${name} is available only in the terminal UI.`);
		}

		await dispatchBuiltinCommand(
			{ command: { name: "future", source: "builtin", dashboard: true }, args: "" },
			{},
			notice,
		);
		expect(notice).toHaveBeenLastCalledWith("/future isn't implemented in the dashboard yet — use the terminal UI.");
	});

	it("deduplicates collisions with built-ins winning and preserves resource-first bare-slash ranking", () => {
		const matches = commandMatches(
			[
				{ name: "fork", source: "extension" },
				{ name: "fork", source: "builtin", dashboard: true },
				{ name: "plan", source: "prompt" },
				{ name: "copy", source: "builtin", dashboard: false },
				{ name: "hotkeys", source: "builtin", dashboard: false },
				{ name: "buddy", source: "builtin", dashboard: false },
			],
			"",
		);
		expect(matches.map((command) => `${command.name}:${command.source}`)).toEqual(["plan:prompt", "fork:builtin"]);
		expect(commandMatches(commands, "f").map((command) => command.name)).toEqual(["fork"]);
	});
});
