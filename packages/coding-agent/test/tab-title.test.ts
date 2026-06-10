import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabTitleSettings } from "../src/core/settings-manager.js";
import { type TabTitleDeps, TabTitleGenerator } from "../src/modes/interactive/tab-title.js";

// Mock @dreb/ai
vi.mock("@dreb/ai", () => ({
	completeSimple: vi.fn(),
}));

// Mock config to avoid filesystem access
vi.mock("../../coding-agent/src/config.js", () => ({
	getPackageDir: () => "/mock/package",
	CONFIG_DIR_NAME: ".dreb",
}));

// Mock fs.readFileSync for agent file reading.
// getExploreAgentModels() checks user (~/.dreb/agents/), project (.dreb/agents/),
// and package dirs in priority order. The mock readFileSync returns content for the
// package path; real reads of other paths succeed or throw ENOENT naturally.
// parseAgentFrontmatter is separately mocked, so real file reads still go through
// the mock parser which returns { ok: false } by default (blocking user overrides).
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: vi.fn((...args: any[]) => {
			const filePath = args[0] as string;
			if (filePath.includes("/mock/package/agents/explore.md")) {
				return "---\nname: Explore\nmodel: mock-model\n---\nExplore agent";
			}
			return actual.readFileSync(...(args as Parameters<typeof actual.readFileSync>));
		}),
	};
});

// Mock subagent to avoid filesystem access
vi.mock("../src/core/tools/subagent.js", () => ({
	parseAgentFrontmatter: vi.fn(),
	resolveModelForSubagentSpawn: vi.fn(),
}));

// Mock model-registry
vi.mock("../src/core/model-registry.js", () => ({}));

import { completeSimple } from "@dreb/ai";
import { parseAgentFrontmatter, resolveModelForSubagentSpawn } from "../src/core/tools/subagent.js";

const mockCompleteSimple = vi.mocked(completeSimple);
const mockResolveModel = vi.mocked(resolveModelForSubagentSpawn);
const mockParseAgent = vi.mocked(parseAgentFrontmatter);

const MOCK_MODEL = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions" as any,
	provider: "test-provider",
	baseUrl: "https://api.test.com/v1",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0.5, output: 1.5, cacheRead: 0.25, cacheWrite: 0.5 },
	contextWindow: 128000,
	maxTokens: 4096,
};

function createMockDeps(overrides: Partial<TabTitleDeps> = {}): TabTitleDeps {
	return {
		setTitle: vi.fn(),
		setSessionName: vi.fn(),
		getMessages: () => [
			{ role: "user", content: "Fix the authentication bug in login.ts" },
			{ role: "assistant", content: [{ type: "text", text: "I'll look into that." }] },
		],
		getModel: () => MOCK_MODEL,
		getModelRegistry: () =>
			({
				getApiKey: vi.fn().mockResolvedValue("test-key"),
				getAvailable: () => [MOCK_MODEL],
			}) as any,
		getProvider: () => "test-provider",
		getBranch: () => "main",
		getRepo: () => "test-repo",
		...overrides,
	};
}

function makeAssistantResponse(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: { inputTokens: 10, outputTokens: 5 },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("TabTitleGenerator", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: resolve to parent model (no explore agent file)
		mockParseAgent.mockReturnValue({ ok: false, error: "not found" });
		mockResolveModel.mockResolvedValue({
			ok: false,
			error: "no models",
			skippedModels: [],
		});
		mockCompleteSimple.mockResolvedValue(makeAssistantResponse("Fix auth bug") as any);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("threshold logic", () => {
		it("does not fire before threshold is reached", () => {
			const deps = createMockDeps();
			const gen = new TabTitleGenerator(undefined, deps);

			for (let i = 0; i < 11; i++) gen.onToolEnd();

			expect(deps.setTitle).not.toHaveBeenCalled();
			expect(gen.hasFired).toBe(false);
			expect(gen.currentCount).toBe(11);
		});

		it("fires exactly at the default threshold (12)", async () => {
			const deps = createMockDeps();
			const gen = new TabTitleGenerator(undefined, deps);

			for (let i = 0; i < 12; i++) gen.onToolEnd();

			// Wait for async generation
			await vi.waitFor(() => {
				expect(deps.setTitle).toHaveBeenCalled();
			});

			expect(gen.hasFired).toBe(true);
			expect(deps.setTitle).toHaveBeenCalledWith("dreb - Fix auth bug");
		});

		it("respects custom triggerAfter setting", async () => {
			const deps = createMockDeps();
			const settings: TabTitleSettings = { triggerAfter: 5 };
			const gen = new TabTitleGenerator(settings, deps);

			// Call 4 times — should not fire
			for (let i = 0; i < 4; i++) gen.onToolEnd();
			expect(gen.hasFired).toBe(false);

			// 5th call triggers
			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(deps.setTitle).toHaveBeenCalled();
			});

			expect(gen.hasFired).toBe(true);
		});
	});

	describe("once-only semantics", () => {
		it("does not fire again after first generation", async () => {
			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();
			await vi.waitFor(() => {
				expect(deps.setTitle).toHaveBeenCalledTimes(1);
			});

			// Additional tool calls should not fire again
			gen.onToolEnd();
			gen.onToolEnd();
			gen.onToolEnd();

			// Still only called once
			expect(deps.setTitle).toHaveBeenCalledTimes(1);
		});
	});

	describe("disabled setting", () => {
		it("skips entirely when tabTitle.enabled is false", () => {
			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ enabled: false }, deps);

			expect(gen.enabled).toBe(false);

			for (let i = 0; i < 10; i++) gen.onToolEnd();

			expect(gen.hasFired).toBe(false);
			expect(deps.setTitle).not.toHaveBeenCalled();
		});

		it("is enabled by default (undefined settings)", () => {
			const deps = createMockDeps();
			const gen = new TabTitleGenerator(undefined, deps);
			expect(gen.enabled).toBe(true);
		});

		it("is enabled when enabled is explicitly true", () => {
			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ enabled: true }, deps);
			expect(gen.enabled).toBe(true);
		});
	});

	describe("failure handling", () => {
		it("swallows LLM errors silently", async () => {
			mockCompleteSimple.mockRejectedValue(new Error("API timeout"));

			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			// Should not throw
			gen.onToolEnd();

			// Flush microtask queue to let the rejected promise chain settle
			await vi.waitFor(() => {
				expect(gen.hasFired).toBe(true);
			});
			expect(deps.setTitle).not.toHaveBeenCalled();
		});

		it("handles null/undefined model gracefully", async () => {
			const deps = createMockDeps({ getModel: () => undefined });
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(gen.hasFired).toBe(true);
			});
			expect(deps.setTitle).not.toHaveBeenCalled();
		});

		it("handles empty context gracefully", async () => {
			// No metadata deps and no events sent → buildContext returns undefined
			const deps = createMockDeps({
				getMessages: () => [],
				getBranch: () => null,
				getRepo: () => undefined,
				getCwd: () => undefined,
			});
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(gen.hasFired).toBe(true);
			});
			expect(deps.setTitle).not.toHaveBeenCalled();
		});
	});

	describe("prompt construction", () => {
		it("includes buffer content in context payload", async () => {
			const deps = createMockDeps({
				getBranch: () => "feature/fix-auth",
				getRepo: () => "my-project",
			});
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			// Feed an assistant message into the buffer
			gen.onMessageEnd({
				role: "assistant",
				content: [{ type: "text", text: "I'll look into that." }],
			});

			gen.onToolEnd({
				toolName: "bash",
				isError: false,
				result: { output: "ls output" },
			});

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const callArgs = mockCompleteSimple.mock.calls[0];
			const context = callArgs[1] as any;
			const content = context.messages[0].content;
			expect(content).toContain("Branch: feature/fix-auth");
			expect(content).toContain("Repo: my-project");
			expect(content).toContain("Assistant: I'll look into that.");
			expect(content).toContain("Tool bash completed: ls output");
		});

		it("includes only metadata when no events have been sent", async () => {
			const deps = createMockDeps({
				getBranch: () => "main",
				getRepo: () => "dreb",
				getCwd: () => "/home/user/dreb",
			});
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const callArgs = mockCompleteSimple.mock.calls[0];
			const context = callArgs[1] as any;
			const content = context.messages[0].content;
			expect(content).toContain("Branch: main");
			expect(content).toContain("Repo: dreb");
			expect(content).toContain("Cwd: /home/user/dreb");
		});
	});

	describe("title sanitization", () => {
		it("truncates titles longer than 30 characters", async () => {
			mockCompleteSimple.mockResolvedValue(
				makeAssistantResponse("This is a very long title that exceeds the limit") as any,
			);

			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(deps.setTitle).toHaveBeenCalled();
			});

			const title = (deps.setTitle as ReturnType<typeof vi.fn>).mock.calls[0][0];
			// "dreb - " is 7 chars, title content should be ≤30
			const titleContent = title.replace("dreb - ", "");
			expect(titleContent.length).toBeLessThanOrEqual(30);
		});

		it("strips surrounding double quotes from LLM response", async () => {
			mockCompleteSimple.mockResolvedValue(makeAssistantResponse('"Fix auth bug"') as any);

			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(deps.setTitle).toHaveBeenCalledWith("dreb - Fix auth bug");
			});
		});

		it("strips surrounding single quotes from LLM response", async () => {
			mockCompleteSimple.mockResolvedValue(makeAssistantResponse("'Fix auth bug'") as any);

			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(deps.setTitle).toHaveBeenCalledWith("dreb - Fix auth bug");
			});
		});

		it("removes newlines from title", async () => {
			mockCompleteSimple.mockResolvedValue(makeAssistantResponse("Fix auth\nbug") as any);

			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(deps.setTitle).toHaveBeenCalledWith("dreb - Fix auth bug");
			});
		});

		it("handles empty LLM response gracefully", async () => {
			mockCompleteSimple.mockResolvedValue(makeAssistantResponse("") as any);

			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(gen.hasFired).toBe(true);
			});
			expect(deps.setTitle).not.toHaveBeenCalled();
		});
	});

	describe("rolling context buffer", () => {
		it("onMessageEnd with assistant text → LLM payload includes labeled entry", async () => {
			const deps = createMockDeps({
				getBranch: () => "main",
			});
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onMessageEnd({
				role: "assistant",
				content: [{ type: "text", text: "Looking at the code now." }],
			});

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const context = mockCompleteSimple.mock.calls[0][1] as any;
			expect(context.messages[0].content).toContain("Assistant: Looking at the code now.");
		});

		it("onMessageEnd with user message → no entry (filtered out)", async () => {
			const deps = createMockDeps({
				getBranch: () => "main",
			});
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onMessageEnd({
				role: "user",
				content: [{ type: "text", text: "Please fix the bug" }],
			});

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const context = mockCompleteSimple.mock.calls[0][1] as any;
			expect(context.messages[0].content).not.toContain("User:");
			expect(context.messages[0].content).not.toContain("Please fix the bug");
		});

		it("onToolEnd(event) → LLM payload includes tool result", async () => {
			const deps = createMockDeps({
				getBranch: () => "main",
			});
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd({
				toolName: "bash",
				isError: false,
				result: { output: "file.ts" },
			});

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const context = mockCompleteSimple.mock.calls[0][1] as any;
			expect(context.messages[0].content).toContain("Tool bash completed: file.ts");
		});

		it("combines onMessageEnd + onToolEnd accumulating multiple entries", async () => {
			const deps = createMockDeps({
				getBranch: () => "feature/test",
			});
			const gen = new TabTitleGenerator({ triggerAfter: 2 }, deps);

			gen.onMessageEnd({
				role: "assistant",
				content: [{ type: "text", text: "Starting fix" }],
			});

			gen.onToolEnd({
				toolName: "read",
				isError: false,
				result: { output: "file content" },
			});

			gen.onMessageEnd({
				role: "assistant",
				content: [{ type: "text", text: "Now editing" }],
			});

			gen.onToolEnd({
				toolName: "edit",
				isError: false,
				result: { output: "done" },
			});

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const context = mockCompleteSimple.mock.calls[0][1] as any;
			const content = context.messages[0].content;
			expect(content).toContain("Assistant: Starting fix");
			expect(content).toContain("Tool read completed: file content");
			expect(content).toContain("Assistant: Now editing");
			expect(content).toContain("Tool edit completed: done");
			expect(content).toContain("Branch: feature/test");
		});

		it("buildContext includes branch/repo/cwd metadata", async () => {
			const deps = createMockDeps({
				getBranch: () => "feature/cool-thing",
				getRepo: () => "my-repo",
				getCwd: () => "/home/user/my-repo",
			});
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const context = mockCompleteSimple.mock.calls[0][1] as any;
			const content = context.messages[0].content;
			expect(content).toContain("Branch: feature/cool-thing");
			expect(content).toContain("Repo: my-repo");
			expect(content).toContain("Cwd: /home/user/my-repo");
		});

		it("buildContext returns undefined when buffer is empty and no metadata", async () => {
			// Explicitly nullify all metadata getters and send no events
			const deps = createMockDeps({
				getBranch: () => null,
				getRepo: () => undefined,
				getCwd: () => undefined,
			});
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(gen.hasFired).toBe(true);
			});
			// buildContext() returned undefined → generateTitle bails out
			expect(deps.setTitle).not.toHaveBeenCalled();
		});
	});

	describe("model resolution", () => {
		it("uses Explore agent model when available", async () => {
			mockParseAgent.mockReturnValue({
				ok: true,
				config: {
					name: "Explore",
					description: "test",
					model: ["cheap/model", "fallback/model"],
					systemPrompt: "",
				},
			});
			mockResolveModel.mockResolvedValue({
				ok: true,
				modelId: "test-model",
				skippedModels: [],
			});

			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockResolveModel).toHaveBeenCalledWith(
					["cheap/model", "fallback/model"],
					"test-provider",
					expect.anything(),
					"test-model",
					expect.any(AbortSignal),
					"[tab-title]",
				);
			});
		});

		it("uses agentModels settings override for Explore over .md frontmatter", async () => {
			// .md frontmatter would resolve to a different list; the override must win.
			mockParseAgent.mockReturnValue({
				ok: true,
				config: {
					name: "Explore",
					description: "test",
					model: ["frontmatter/model"],
					systemPrompt: "",
				},
			});
			mockResolveModel.mockResolvedValue({
				ok: true,
				modelId: "test-model",
				skippedModels: [],
			});

			const getAgentModelsOverride = vi.fn((name: string) =>
				name === "Explore" ? ["override/model-a", "override/model-b"] : undefined,
			);
			const deps = createMockDeps({ getAgentModelsOverride });
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockResolveModel).toHaveBeenCalledWith(
					["override/model-a", "override/model-b"],
					"test-provider",
					expect.anything(),
					"test-model",
					expect.any(AbortSignal),
					"[tab-title]",
				);
			});
			expect(getAgentModelsOverride).toHaveBeenCalledWith("Explore");
		});

		it("falls back to .md frontmatter when agentModels override is empty", async () => {
			mockParseAgent.mockReturnValue({
				ok: true,
				config: {
					name: "Explore",
					description: "test",
					model: ["frontmatter/model"],
					systemPrompt: "",
				},
			});
			mockResolveModel.mockResolvedValue({
				ok: true,
				modelId: "test-model",
				skippedModels: [],
			});

			const deps = createMockDeps({ getAgentModelsOverride: () => [] });
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockResolveModel).toHaveBeenCalledWith(
					["frontmatter/model"],
					"test-provider",
					expect.anything(),
					"test-model",
					expect.any(AbortSignal),
					"[tab-title]",
				);
			});
		});

		it("falls back to parent model when Explore resolution fails", async () => {
			mockParseAgent.mockReturnValue({ ok: false, error: "not found" });

			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			// Should still have been called with the parent model
			const callArgs = mockCompleteSimple.mock.calls[0];
			expect((callArgs[0] as any).id).toBe("test-model");
		});
	});

	describe("session name persistence", () => {
		it("calls setSessionName with the raw title (no prefix) on success", async () => {
			mockCompleteSimple.mockResolvedValue(makeAssistantResponse("Fix auth bug") as any);

			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(deps.setTitle).toHaveBeenCalled();
			});

			expect(deps.setTitle).toHaveBeenCalledWith("dreb - Fix auth bug");
			expect(deps.setSessionName).toHaveBeenCalledWith("Fix auth bug");
		});

		it("does not throw when setSessionName is not provided (undefined)", async () => {
			mockCompleteSimple.mockResolvedValue(makeAssistantResponse("Fix auth bug") as any);

			const deps = createMockDeps({ setSessionName: undefined });
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(deps.setTitle).toHaveBeenCalled();
			});

			// setTitle still works, and no error was thrown
			expect(deps.setTitle).toHaveBeenCalledWith("dreb - Fix auth bug");
		});

		it("does not call setSessionName when title generation fails", async () => {
			mockCompleteSimple.mockResolvedValue(makeAssistantResponse("") as any);

			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(gen.hasFired).toBe(true);
			});

			expect(deps.setTitle).not.toHaveBeenCalled();
			expect(deps.setSessionName).not.toHaveBeenCalled();
		});
	});
});
