import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabTitleSettings } from "../src/core/settings-manager.js";
import { type TabTitleDeps, TabTitleGenerator } from "../src/core/tab-title.js";

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

const EXPLORE_MODEL = {
	...MOCK_MODEL,
	id: "explore-model",
	name: "Explore Model",
	provider: "explore-provider",
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
				find: (provider: string, modelId: string) =>
					[MOCK_MODEL].find((model) => model.provider === provider && model.id === modelId),
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

			for (let i = 0; i < 8; i++) gen.onToolEnd();

			expect(deps.setTitle).not.toHaveBeenCalled();
			expect(gen.hasFired).toBe(false);
			expect(gen.currentCount).toBe(8);
		});

		it("fires exactly at the default threshold (9)", async () => {
			const deps = createMockDeps();
			const gen = new TabTitleGenerator(undefined, deps);

			for (let i = 0; i < 9; i++) gen.onToolEnd();

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
		it("does not throw LLM errors from the fire-and-forget path", async () => {
			mockCompleteSimple.mockRejectedValue(new Error("API timeout"));

			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			expect(() => gen.onToolEnd()).not.toThrow();

			// Flush microtask queue to let the rejected promise chain settle
			await vi.waitFor(() => {
				expect(gen.hasFired).toBe(true);
			});
			expect(deps.setTitle).not.toHaveBeenCalled();
		});

		it("reports final failure via onError when Explore and parent model calls both fail", async () => {
			mockParseAgent.mockReturnValue({
				ok: true,
				config: {
					name: "Explore",
					description: "test",
					model: ["explore-provider/explore-model"],
					systemPrompt: "",
				},
			});
			mockResolveModel.mockResolvedValue({
				ok: true,
				modelId: "explore-model",
				provider: "explore-provider",
				skippedModels: [],
			});
			mockCompleteSimple
				.mockRejectedValueOnce(new Error("404 model-not-available"))
				.mockRejectedValueOnce(new Error("parent provider failed"));

			const registry = {
				getApiKey: vi.fn().mockResolvedValue("test-key"),
				getAvailable: () => [MOCK_MODEL, EXPLORE_MODEL],
				find: vi.fn((provider: string, modelId: string) =>
					[MOCK_MODEL, EXPLORE_MODEL].find((model) => model.provider === provider && model.id === modelId),
				),
			};
			const onError = vi.fn();
			const deps = createMockDeps({ getModelRegistry: () => registry as any, onError });
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			expect(() => gen.onToolEnd()).not.toThrow();

			await vi.waitFor(() => {
				expect(onError).toHaveBeenCalled();
			});

			expect(mockCompleteSimple).toHaveBeenCalledTimes(2);
			expect(deps.setTitle).not.toHaveBeenCalled();
			const reported = onError.mock.calls[0][0];
			expect(reported).toBeInstanceOf(Error);
			expect((reported as Error).message).toContain(
				"Tab title generation failed with model explore-provider/explore-model",
			);
			expect((reported as Error).message).toContain("Parent fallback test-provider/test-model also failed");
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

		it("includes only metadata when no events and no user messages", async () => {
			const deps = createMockDeps({
				getMessages: () => [],
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
		it("truncates titles longer than the hard cap (300)", async () => {
			mockCompleteSimple.mockResolvedValue(makeAssistantResponse("A".repeat(400)) as any);

			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(deps.setTitle).toHaveBeenCalled();
			});

			const title = (deps.setTitle as ReturnType<typeof vi.fn>).mock.calls[0][0];
			const titleContent = title.replace("dreb - ", "");
			expect(titleContent.length).toBe(300);
		});

		it("does not truncate titles under the hard cap (soft target is only a prompt hint)", async () => {
			mockCompleteSimple.mockResolvedValue(
				makeAssistantResponse("This is a longer descriptive title well over thirty characters") as any,
			);

			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(deps.setTitle).toHaveBeenCalled();
			});

			const title = (deps.setTitle as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(title).toBe("dreb - This is a longer descriptive title well over thirty characters");
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

		it("onMessageEnd with user message → no rolling-buffer entry (filtered out)", async () => {
			const deps = createMockDeps({
				getMessages: () => [],
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
			// Explicitly nullify all metadata getters, empty messages, and send no events
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

		it("uses provider-aware Explore resolution and falls back to parent model when the resolved model fails", async () => {
			mockParseAgent.mockReturnValue({
				ok: true,
				config: {
					name: "Explore",
					description: "test",
					model: ["explore-provider/explore-model"],
					systemPrompt: "",
				},
			});
			mockResolveModel.mockResolvedValue({
				ok: true,
				modelId: "explore-model",
				provider: "explore-provider",
				skippedModels: [],
			});
			mockCompleteSimple
				.mockRejectedValueOnce(new Error("404 model-not-available"))
				.mockResolvedValueOnce(makeAssistantResponse("Fix auth bug") as any);

			const wrongProviderSameIdModel = { ...EXPLORE_MODEL, provider: "wrong-provider" };
			const registry = {
				getApiKey: vi.fn().mockResolvedValue("test-key"),
				getAvailable: () => [wrongProviderSameIdModel, MOCK_MODEL, EXPLORE_MODEL],
				find: vi.fn((provider: string, modelId: string) =>
					[MOCK_MODEL, EXPLORE_MODEL].find((model) => model.provider === provider && model.id === modelId),
				),
			};
			const deps = createMockDeps({ getModelRegistry: () => registry as any });
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(deps.setTitle).toHaveBeenCalledWith("dreb - Fix auth bug");
			});

			expect(registry.find).toHaveBeenCalledWith("explore-provider", "explore-model");
			expect(mockCompleteSimple).toHaveBeenCalledTimes(2);
			expect(mockCompleteSimple.mock.calls[0][0]).toMatchObject({
				id: "explore-model",
				provider: "explore-provider",
			});
			expect(mockCompleteSimple.mock.calls[1][0]).toMatchObject({ id: "test-model", provider: "test-provider" });
			expect(deps.setSessionName).toHaveBeenCalledWith("Fix auth bug");
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

	describe("user intent priority", () => {
		it("titles from the user's request, not the branch slug", async () => {
			// Regression for issue 324: a dashboard-foundation branch must not override
			// an unrelated user request.
			const deps = createMockDeps({
				getMessages: () => [{ role: "user", content: "install the Playwright webapp-testing skill" }],
				getBranch: () => "feature/issue-307-dashboard-foundation",
				getRepo: () => "dreb",
				getCwd: () => "/home/user/dreb",
			});
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const context = mockCompleteSimple.mock.calls[0][1] as any;
			const content = context.messages[0].content as string;
			// User request appears, and leads the context ahead of metadata.
			expect(content).toContain("install the Playwright webapp-testing skill");
			expect(content.indexOf("install the Playwright")).toBeLessThan(content.indexOf("Branch:"));
			// Metadata is explicitly demoted to secondary.
			expect(content).toContain("secondary");
		});

		it("pins the first user request even after many tool calls (no buffer eviction)", async () => {
			const deps = createMockDeps({
				getMessages: () => [
					{ role: "user", content: "refactor the auth module to use JWT" },
					{ role: "assistant", content: [{ type: "text", text: "on it" }] },
				],
				getBranch: () => "main",
			});
			const gen = new TabTitleGenerator({ triggerAfter: 30 }, deps);

			// Flood the rolling buffer with unrelated tool activity.
			for (let i = 0; i < 30; i++) {
				gen.onToolEnd({ toolName: "bash", isError: false, result: { output: `noise ${i}` } });
			}

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const context = mockCompleteSimple.mock.calls[0][1] as any;
			expect(context.messages[0].content).toContain("refactor the auth module to use JWT");
		});

		it("includes both first and latest user request when they differ", async () => {
			const deps = createMockDeps({
				getMessages: () => [
					{ role: "user", content: "start building the export feature" },
					{ role: "assistant", content: [{ type: "text", text: "sure" }] },
					{ role: "user", content: "actually make it a CSV export" },
				],
				getBranch: () => "main",
			});
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const content = (mockCompleteSimple.mock.calls[0][1] as any).messages[0].content as string;
			expect(content).toContain("start building the export feature");
			expect(content).toContain("actually make it a CSV export");
		});

		it("de-duplicates when first and only user request equals the latest", async () => {
			const deps = createMockDeps({
				getMessages: () => [{ role: "user", content: "fix the flaky test" }],
				getBranch: () => "main",
			});
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const content = (mockCompleteSimple.mock.calls[0][1] as any).messages[0].content as string;
			expect(content.split("fix the flaky test").length - 1).toBe(1);
		});

		it("extracts text from structured (array) user content", async () => {
			const deps = createMockDeps({
				getMessages: () => [{ role: "user", content: [{ type: "text", text: "add dark mode toggle" }] }],
				getBranch: () => "main",
			});
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const content = (mockCompleteSimple.mock.calls[0][1] as any).messages[0].content as string;
			expect(content).toContain("add dark mode toggle");
		});

		it("caps each user message at MAX_USER_TEXT_CHARS (2000) in the context", async () => {
			// A giant pasted request must not bloat the title context. The head is kept,
			// the tail beyond 2000 chars is dropped.
			const head = "H".repeat(2000);
			const tail = "TAIL_SENTINEL";
			const deps = createMockDeps({
				getMessages: () => [{ role: "user", content: head + tail }],
				getBranch: () => "main",
			});
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const content = (mockCompleteSimple.mock.calls[0][1] as any).messages[0].content as string;
			// The first 2000 chars survive; the tail beyond the cap is truncated away.
			expect(content).toContain(head);
			expect(content).not.toContain(tail);
		});
	});

	describe("title length (soft target / hard cap)", () => {
		it("mentions the default soft target (60) in the prompt", async () => {
			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const context = mockCompleteSimple.mock.calls[0][1] as any;
			expect(context.systemPrompt).toContain("60");
		});

		it("honors a custom maxTitleLength as the soft target hint", async () => {
			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1, maxTitleLength: 120 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const context = mockCompleteSimple.mock.calls[0][1] as any;
			expect(context.systemPrompt).toContain("120");
		});

		it("clamps an over-large maxTitleLength to the hard cap in the prompt", async () => {
			const deps = createMockDeps();
			const gen = new TabTitleGenerator({ triggerAfter: 1, maxTitleLength: 9999 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(mockCompleteSimple).toHaveBeenCalled();
			});

			const context = mockCompleteSimple.mock.calls[0][1] as any;
			expect(context.systemPrompt).toContain("300");
			expect(context.systemPrompt).not.toContain("9999");
		});
	});

	describe("resumed / already-named session guard", () => {
		it("skips generation when the session already has a name", async () => {
			const deps = createMockDeps({ getSessionName: () => "Existing session name" });
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(gen.hasFired).toBe(true);
			});

			expect(mockCompleteSimple).not.toHaveBeenCalled();
			expect(deps.setTitle).not.toHaveBeenCalled();
			expect(deps.setSessionName).not.toHaveBeenCalled();
		});

		it("does not overwrite a name that appears during async generation", async () => {
			// Unnamed at fire time, but a name lands before the LLM call resolves.
			let name: string | undefined;
			let resolveCompletion: (v: unknown) => void = () => {};
			mockCompleteSimple.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveCompletion = resolve;
					}) as any,
			);

			const deps = createMockDeps({ getSessionName: () => name });
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();
			await vi.waitFor(() => expect(mockCompleteSimple).toHaveBeenCalled());

			// Name is set (e.g. user renamed) before completion resolves.
			name = "User chosen name";
			resolveCompletion(makeAssistantResponse("Auto title") as any);

			await vi.waitFor(() => expect(gen.hasFired).toBe(true));
			expect(deps.setTitle).not.toHaveBeenCalled();
			expect(deps.setSessionName).not.toHaveBeenCalled();
		});

		it("generates normally when getSessionName returns empty", async () => {
			const deps = createMockDeps({ getSessionName: () => undefined });
			const gen = new TabTitleGenerator({ triggerAfter: 1 }, deps);

			gen.onToolEnd();

			await vi.waitFor(() => {
				expect(deps.setTitle).toHaveBeenCalled();
			});
			expect(deps.setSessionName).toHaveBeenCalled();
		});
	});
});
