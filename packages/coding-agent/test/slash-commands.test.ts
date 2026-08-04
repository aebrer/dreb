import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS, parseBuiltinSlashCommand } from "../src/core/slash-commands.js";

describe("built-in slash commands", () => {
	it.each([
		["/fork", "fork", ""],
		["/fork anything here", "fork", "anything here"],
		["  /compact summarize tests  ", "compact", "summarize tests"],
		["/dream backup /tmp/archive", "dream", "backup /tmp/archive"],
	])("parses %s on the first token", (text, name, args) => {
		expect(parseBuiltinSlashCommand(text)).toMatchObject({ command: { name }, args });
	});

	it.each(["/forklift", "/unknown", "fork", "/", "", "   "])("does not misclassify %j", (text) => {
		expect(parseBuiltinSlashCommand(text)).toBeUndefined();
	});

	it("keeps hidden development commands outside the public registry", () => {
		expect(parseBuiltinSlashCommand("/debug")).toBeUndefined();
		expect(parseBuiltinSlashCommand("/arminsayshi")).toBeUndefined();
	});

	it("opts only copy, hotkeys, and buddy out of dashboard autocomplete", () => {
		expect(
			BUILTIN_SLASH_COMMANDS.filter((command) => command.dashboard === false).map((command) => command.name),
		).toEqual(["copy", "hotkeys", "buddy"]);
	});
});
