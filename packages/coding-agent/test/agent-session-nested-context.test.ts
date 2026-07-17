import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@dreb/agent-core";
import type { Context, ToolResultMessage } from "@dreb/ai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createHarnessWithExtensions, type Harness } from "./test-harness.js";
import { createTestResourceLoader } from "./utilities.js";

const readTool: AgentTool = {
	name: "read",
	label: "Read",
	description: "Test read tool",
	parameters: Type.Object({ path: Type.String() }),
	execute: async () => ({
		content: [{ type: "text", text: "ok" }],
		details: {},
	}),
};

function failingReadTool(message: string): AgentTool {
	return {
		name: "read",
		label: "Read",
		description: "Test failing read tool",
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => {
			throw new Error(message);
		},
	};
}

function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function makeExtraTempDir(prefix: string, extraDirs: string[]): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	// Canonicalize so expected paths match the implementation's native-realpath
	// output; on macOS os.tmpdir() lives under /var → /private/var.
	const canonical = realpathSync.native(dir);
	extraDirs.push(canonical);
	return canonical;
}

function getContext(harness: Harness, index: number): Context {
	const context = harness.faux.contexts[index];
	expect(context).toBeDefined();
	return context;
}

function getToolResults(context: Context): ToolResultMessage[] {
	return context.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

function getTextBlocks(message: ToolResultMessage): string[] {
	return message.content.filter((item) => item.type === "text").map((item) => item.text);
}

function getToolResultText(message: ToolResultMessage): string {
	return getTextBlocks(message).join("\n");
}

function enableUnrestrictedNestedContext(harness: Harness): void {
	harness.settingsManager.setAutoLoadNestedContext(true);
}

describe("AgentSession nested context auto-load", () => {
	let harness: Harness | undefined;
	let extraDirs: string[] = [];

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		for (const dir of extraDirs) {
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
		extraDirs = [];
	});

	it("appends nested context on first touch without extension handlers and does not re-inject for the same directory", async () => {
		harness = createHarness({
			responses: [
				{ toolCalls: [{ name: "read", args: { path: join("nested", "file.txt") } }] },
				{ toolCalls: [{ name: "read", args: { path: join("nested", "second.txt") } }] },
				"done",
			],
			baseToolsOverride: { read: readTool },
		});
		const nestedDir = join(harness.tempDir, "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(join(nestedDir, "CLAUDE.md"), "# Nested instructions\nUse the nested context.");
		writeFileSync(join(nestedDir, "file.txt"), "file contents");
		writeFileSync(join(nestedDir, "second.txt"), "second contents");

		enableUnrestrictedNestedContext(harness);
		await harness.session.prompt("read twice");

		const afterFirstTool = getToolResults(getContext(harness, 1));
		expect(afterFirstTool).toHaveLength(1);
		const firstTextBlocks = getTextBlocks(afterFirstTool[0]);
		expect(firstTextBlocks).toHaveLength(2);
		expect(firstTextBlocks[0]).toBe("ok");
		expect(firstTextBlocks[1]).toContain("Auto-loaded project context");
		expect(firstTextBlocks[1]).toContain("# Nested instructions");
		expect(countOccurrences(firstTextBlocks[1], "Auto-loaded project context")).toBe(1);

		const afterSecondTool = getToolResults(getContext(harness, 2));
		expect(afterSecondTool).toHaveLength(2);
		const allToolText = afterSecondTool.map(getToolResultText).join("\n");
		expect(countOccurrences(allToolText, "Auto-loaded project context")).toBe(1);
		expect(getToolResultText(afterSecondTool[1])).toBe("ok");
	});

	it("does not append nested context by default", async () => {
		harness = createHarness({
			responses: [{ toolCalls: [{ name: "read", args: { path: join("nested", "file.txt") } }] }, "done"],
			baseToolsOverride: { read: readTool },
		});
		const nestedDir = join(harness.tempDir, "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(join(nestedDir, "CLAUDE.md"), "# Default-off context");
		writeFileSync(join(nestedDir, "file.txt"), "file contents");

		await harness.session.prompt("read once");
		expect(getToolResultText(getToolResults(getContext(harness, 1))[0])).toBe("ok");
	});

	it("refreshes global trusted folders for a previously blocked target", () => {
		harness = createHarness({ baseToolsOverride: { read: readTool } });
		const nestedDir = join(harness.tempDir, "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(join(nestedDir, "CLAUDE.md"), "# Refreshed trust context");
		writeFileSync(join(nestedDir, "file.txt"), "file contents");
		const compute = (
			harness.session as unknown as {
				_computeNestedContextBlock: (toolName: string, args: Record<string, unknown>) => string | null;
			}
		)._computeNestedContextBlock.bind(harness.session);

		expect(compute("read", { path: join(nestedDir, "file.txt") })).toBeNull();
		writeFileSync(
			join(harness.tempDir, "settings.json"),
			JSON.stringify({ context: { trustedFolders: [nestedDir] } }),
		);
		expect(compute("read", { path: join(nestedDir, "file.txt") })).toContain("# Refreshed trust context");
	});

	it("fails closed when an AgentSession has no settings manager", () => {
		harness = createHarness({ baseToolsOverride: { read: readTool } });
		const nestedDir = join(harness.tempDir, "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(join(nestedDir, "CLAUDE.md"), "# Must not load");
		writeFileSync(join(nestedDir, "file.txt"), "file contents");
		const session = harness.session as unknown as {
			settingsManager?: undefined;
			_computeNestedContextBlock: (toolName: string, args: Record<string, unknown>) => string | null;
		};
		session.settingsManager = undefined;
		expect(session._computeNestedContextBlock("read", { path: join(nestedDir, "file.txt") })).toBeNull();
	});

	it("does not append nested context when context.autoLoadNested is disabled", async () => {
		harness = createHarness({
			responses: [{ toolCalls: [{ name: "read", args: { path: join("nested", "file.txt") } }] }, "done"],
			settings: { context: { autoLoadNested: false } },
			baseToolsOverride: { read: readTool },
		});
		const nestedDir = join(harness.tempDir, "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(join(nestedDir, "CLAUDE.md"), "# Disabled context");
		writeFileSync(join(nestedDir, "file.txt"), "file contents");

		await harness.session.prompt("read once");

		const [toolResult] = getToolResults(getContext(harness, 1));
		expect(getTextBlocks(toolResult)).toEqual(["ok"]);
		expect(getToolResultText(toolResult)).not.toContain("Auto-loaded project context");
		expect(getToolResultText(toolResult)).not.toContain("# Disabled context");
	});

	it("appends nested context after a successful tool_result extension rewrites content", async () => {
		harness = await createHarnessWithExtensions({
			responses: [{ toolCalls: [{ name: "read", args: { path: join("nested", "file.txt") } }] }, "done"],
			extensionFactories: [
				(dreb) => {
					dreb.on("tool_result", async () => ({
						content: [{ type: "text", text: "rewritten by extension" }],
						details: { rewritten: true },
					}));
				},
			],
			baseToolsOverride: { read: readTool },
		});
		const nestedDir = join(harness.tempDir, "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(join(nestedDir, "CLAUDE.md"), "# Extension success context");
		writeFileSync(join(nestedDir, "file.txt"), "file contents");

		enableUnrestrictedNestedContext(harness);
		await harness.session.prompt("read once");

		const [toolResult] = getToolResults(getContext(harness, 1));
		const textBlocks = getTextBlocks(toolResult);
		expect(textBlocks).toHaveLength(2);
		expect(textBlocks[0]).toBe("rewritten by extension");
		expect(textBlocks[1]).toContain("Auto-loaded project context");
		expect(textBlocks[1]).toContain("# Extension success context");
	});

	it("appends nested context to original content when tool_result extension handlers return falsy or throw", async () => {
		harness = await createHarnessWithExtensions({
			responses: [{ toolCalls: [{ name: "read", args: { path: join("nested", "file.txt") } }] }, "done"],
			extensionFactories: [
				(dreb) => {
					dreb.on("tool_result", async () => undefined);
					dreb.on("tool_result", async () => {
						throw new Error("tool_result boom");
					});
				},
			],
			baseToolsOverride: { read: readTool },
		});
		const nestedDir = join(harness.tempDir, "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(join(nestedDir, "CLAUDE.md"), "# Extension falsy context");
		writeFileSync(join(nestedDir, "file.txt"), "file contents");

		enableUnrestrictedNestedContext(harness);
		await harness.session.prompt("read once");

		const [toolResult] = getToolResults(getContext(harness, 1));
		const textBlocks = getTextBlocks(toolResult);
		expect(textBlocks).toHaveLength(2);
		expect(textBlocks[0]).toBe("ok");
		expect(textBlocks[1]).toContain("Auto-loaded project context");
		expect(textBlocks[1]).toContain("# Extension falsy context");
	});

	it("appends nested context to scrubbed errored tool output and ignores extension content overrides", async () => {
		const token = `ghp_${"B".repeat(36)}`;
		let extensionSawError = false;
		harness = await createHarnessWithExtensions({
			responses: [{ toolCalls: [{ name: "read", args: { path: join("nested", "file.txt") } }] }, "done"],
			extensionFactories: [
				(dreb) => {
					dreb.on("tool_result", async (event) => {
						extensionSawError = event.isError;
						return {
							content: [{ type: "text", text: "extension override must be ignored" }],
							details: { extensionOverride: true },
						};
					});
				},
			],
			baseToolsOverride: { read: failingReadTool(`read failed with ${token}`) },
		});
		const nestedDir = join(harness.tempDir, "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(join(nestedDir, "CLAUDE.md"), "# Tool error context");
		writeFileSync(join(nestedDir, "file.txt"), "file contents");

		enableUnrestrictedNestedContext(harness);
		await harness.session.prompt("read once");

		const [toolResult] = getToolResults(getContext(harness, 1));
		expect(extensionSawError).toBe(true);
		expect(toolResult.isError).toBe(true);
		const textBlocks = getTextBlocks(toolResult);
		expect(textBlocks).toHaveLength(2);
		expect(textBlocks[0]).toContain("read failed with");
		expect(textBlocks[0]).toContain("<REDACTED:github_token>");
		expect(textBlocks[0]).not.toContain(token);
		expect(textBlocks[1]).toContain("Auto-loaded project context");
		expect(textBlocks[1]).toContain("# Tool error context");
		expect(getToolResultText(toolResult)).not.toContain("extension override must be ignored");
	});

	it("seeds already-loaded context from resourceLoader.getAgentsFiles before scanning nested dirs", async () => {
		const agentsFiles: Array<{ path: string; content: string }> = [];
		harness = createHarness({
			responses: [{ toolCalls: [{ name: "read", args: { path: join("nested", "file.txt") } }] }, "done"],
			resourceLoader: createTestResourceLoader({ agentsFiles }),
			baseToolsOverride: { read: readTool },
		});
		const rootClaude = join(harness.tempDir, "CLAUDE.md");
		const nestedDir = join(harness.tempDir, "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(rootClaude, "# Root context already loaded");
		writeFileSync(join(nestedDir, "CLAUDE.md"), "# Nested context newly loaded");
		writeFileSync(join(nestedDir, "file.txt"), "file contents");
		agentsFiles.push({ path: rootClaude, content: "# Root context already loaded" });

		enableUnrestrictedNestedContext(harness);
		await harness.session.prompt("read once");

		const [toolResult] = getToolResults(getContext(harness, 1));
		const text = getToolResultText(toolResult);
		expect(text).toContain("Auto-loaded project context");
		expect(text).toContain("# Nested context newly loaded");
		expect(text).not.toContain("# Root context already loaded");
		expect(text).not.toContain(`BEGIN project context: ${rootClaude}`);
	});

	it("scrubs default secret patterns from injected nested context", async () => {
		const token = `ghp_${"A".repeat(36)}`;
		harness = createHarness({
			responses: [{ toolCalls: [{ name: "read", args: { path: join("nested", "file.txt") } }] }, "done"],
			baseToolsOverride: { read: readTool },
		});
		const nestedDir = join(harness.tempDir, "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(join(nestedDir, "CLAUDE.md"), `# Secret context\nToken: ${token}`);
		writeFileSync(join(nestedDir, "file.txt"), "file contents");

		enableUnrestrictedNestedContext(harness);
		await harness.session.prompt("read once");

		const [toolResult] = getToolResults(getContext(harness, 1));
		const text = getToolResultText(toolResult);
		expect(text).toContain("Auto-loaded project context");
		expect(text).toContain("<REDACTED:github_token>");
		expect(text).not.toContain(token);
	});

	it("loads context from a different repo outside cwd and stops at that repo's git root", async () => {
		const otherParent = makeExtraTempDir("dreb-nested-repo-parent", extraDirs);
		const repoB = join(otherParent, "repo-b");
		const repoBSubdir = join(repoB, "subdir");
		mkdirSync(join(repoB, ".git"), { recursive: true });
		mkdirSync(repoBSubdir, { recursive: true });
		writeFileSync(join(otherParent, "CLAUDE.md"), "# Above repo context must not load");
		writeFileSync(join(repoB, "CLAUDE.md"), "# Repo B context");
		writeFileSync(join(repoBSubdir, "file.txt"), "file contents");

		harness = createHarness({
			responses: [{ toolCalls: [{ name: "read", args: { path: join(repoBSubdir, "file.txt") } }] }, "done"],
			baseToolsOverride: { read: readTool },
		});

		enableUnrestrictedNestedContext(harness);
		await harness.session.prompt("read outside cwd");

		const [toolResult] = getToolResults(getContext(harness, 1));
		const text = getToolResultText(toolResult);
		expect(text).toContain("Auto-loaded project context");
		expect(text).toContain("# Repo B context");
		expect(text).toContain(`BEGIN project context: ${join(repoB, "CLAUDE.md")}`);
		expect(text).not.toContain("# Above repo context must not load");
		expect(text).not.toContain(`BEGIN project context: ${join(otherParent, "CLAUDE.md")}`);
	});
});
