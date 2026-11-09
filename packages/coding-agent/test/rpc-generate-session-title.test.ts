import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dreb/ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dreb/ai")>()),
	completeSimple: vi.fn(),
}));

// Explore routing must not depend on whatever explore.md exists on the machine running the tests:
// resolution "fails" by default so the runtime model (the parent) is used unless a test overrides it.
vi.mock("../src/core/tools/subagent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/core/tools/subagent.js")>()),
	resolveModelForSubagentSpawn: vi.fn(),
}));

import { completeSimple } from "@dreb/ai";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { resolveModelForSubagentSpawn } from "../src/core/tools/subagent.js";
import { generateSessionTitleForRpc } from "../src/modes/rpc/rpc-mode.js";

const mockCompleteSimple = vi.mocked(completeSimple);
const mockResolveModel = vi.mocked(resolveModelForSubagentSpawn);

const RUNTIME_MODEL = {
	id: "runtime-model",
	name: "Runtime Model",
	api: "openai-completions" as const,
	provider: "runtime-provider",
	baseUrl: "https://api.test.com/v1",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

const EXPLORE_MODEL = { ...RUNTIME_MODEL, id: "explore-model", provider: "explore-provider" };

const tempDirs: string[] = [];

async function writeSessionFile(lines: Array<Record<string, unknown>>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-rpc-title-"));
	tempDirs.push(dir);
	const path = join(dir, "session.jsonl");
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
	return path;
}

function savedSession(): Array<Record<string, unknown>> {
	return [
		{
			type: "session",
			version: 3,
			id: "saved-session-id",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/work/project",
		},
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: "Add a rename button to past sessions", timestamp: 1 },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Editing the fleet screen." },
					{ type: "toolCall", id: "t1", name: "edit", arguments: {} },
				],
				stopReason: "toolUse",
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "edit",
				isError: false,
				content: [{ type: "text", text: "fleet.tsx updated" }],
				timestamp: 3,
			},
		},
	];
}

function makeRuntime(overrides: { model?: typeof RUNTIME_MODEL | undefined; agentModels?: string[] } = {}) {
	const registry = {
		getApiKey: vi.fn().mockResolvedValue("key"),
		getAvailable: () => [RUNTIME_MODEL, EXPLORE_MODEL],
		find: (provider: string, modelId: string) =>
			[RUNTIME_MODEL, EXPLORE_MODEL].find((model) => model.provider === provider && model.id === modelId),
		refresh: vi.fn(),
		getError: vi.fn((): string | undefined => undefined),
	};
	const settingsManager = {
		getTabTitleSettings: vi.fn(() => ({ enabled: false, maxTitleLength: 40 })),
		getAgentModelsForAgent: vi.fn((_name: string) => overrides.agentModels),
		flush: vi.fn(async () => {}),
		drainErrors: vi.fn(() => []),
		reload: vi.fn(),
		hasGlobalSettingsLoadError: vi.fn(() => false),
		hasProjectSettingsLoadError: vi.fn(() => false),
	};
	return {
		model: "model" in overrides ? overrides.model : RUNTIME_MODEL,
		modelRegistry: registry,
		settingsManager,
	} as any;
}

function titleResponse(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "runtime-provider",
		model: "runtime-model",
		usage: {},
		stopReason: "stop",
		timestamp: Date.now(),
	} as any;
}

beforeEach(() => {
	mockResolveModel.mockResolvedValue({ ok: false, error: "no explore model", skippedModels: [] });
	mockCompleteSimple.mockResolvedValue(titleResponse("Past session rename"));
});

afterEach(async () => {
	vi.clearAllMocks();
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("generateSessionTitleForRpc", () => {
	it("titles a saved session with the runtime's tab-title settings and model, without modifying it", async () => {
		const path = await writeSessionFile(savedSession());
		const before = readFileSync(path, "utf8");
		const runtime = makeRuntime();

		const result = await generateSessionTitleForRpc(runtime, path);

		expect(result).toEqual({ ok: true, title: "Past session rename" });
		expect(readFileSync(path, "utf8")).toBe(before);
		const [model, context, options] = mockCompleteSimple.mock.calls[0];
		expect(model).toMatchObject({ provider: "runtime-provider", id: "runtime-model" });
		expect((options as Record<string, unknown>).sessionId).toBe("saved-session-id");
		expect(context.systemPrompt).toContain("Aim for about 40 characters");
		const payload = context.messages[0].content as string;
		expect(payload).toContain("- Add a rename button to past sessions");
		expect(payload).toContain("Assistant: Editing the fleet screen.");
		expect(payload).toContain("Tool edit completed: fleet.tsx updated");
		expect(payload).toContain("Repo: project");
		expect(payload).toContain("Cwd: /work/project");
		expect(payload).not.toContain("Branch:");
	});

	it("routes through the runtime's Explore agentModels override", async () => {
		mockResolveModel.mockResolvedValue({
			ok: true,
			modelId: "explore-model",
			provider: "explore-provider",
			skippedModels: [],
		});
		const path = await writeSessionFile(savedSession());
		const runtime = makeRuntime({ agentModels: ["explore-provider/explore-model"] });

		await generateSessionTitleForRpc(runtime, path);

		expect(runtime.settingsManager.getAgentModelsForAgent).toHaveBeenCalledWith("Explore");
		expect(mockResolveModel.mock.calls[0][0]).toEqual(["explore-provider/explore-model"]);
		expect(mockResolveModel.mock.calls[0][1]).toBe("runtime-provider");
		expect(mockCompleteSimple.mock.calls[0][0]).toMatchObject({ provider: "explore-provider", id: "explore-model" });
	});

	it("rejects an invalid path without calling the model or touching the file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dreb-rpc-title-"));
		tempDirs.push(dir);
		const path = join(dir, "notes.jsonl");
		writeFileSync(path, "not a session\n", "utf8");

		const result = await generateSessionTitleForRpc(makeRuntime(), path);

		expect(result).toEqual({ ok: false, error: `Not a session file (missing or invalid session header): ${path}` });
		expect(readFileSync(path, "utf8")).toBe("not a session\n");
		expect(mockCompleteSimple).not.toHaveBeenCalled();
	});

	it("maps a missing model to an error", async () => {
		const path = await writeSessionFile(savedSession());

		const result = await generateSessionTitleForRpc(makeRuntime({ model: undefined }), path);

		expect(result).toEqual({
			ok: false,
			error: "Tab title generation failed: no model is available (set a default model or tabTitle.model)",
		});
	});

	it("maps a provider failure to an error carrying the provider message", async () => {
		mockCompleteSimple.mockResolvedValue({
			...titleResponse(""),
			content: [],
			stopReason: "error",
			errorMessage: "429 rate limited",
		});
		const path = await writeSessionFile(savedSession());

		const result = await generateSessionTitleForRpc(makeRuntime(), path);

		expect(result).toEqual({
			ok: false,
			error: "Tab title generation failed with model runtime-provider/runtime-model: 429 rate limited",
		});
	});

	describe("durable settings", () => {
		/** A long-lived utility runtime's settings plus a second runtime (or the TUI) sharing the same agent dir. */
		async function sharedSettings() {
			const root = await mkdtemp(join(tmpdir(), "dreb-rpc-title-settings-"));
			tempDirs.push(root);
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tabTitle: { maxTitleLength: 40 } }));
			return {
				agentDir,
				utility: SettingsManager.create(projectDir, agentDir),
				other: SettingsManager.create(root, agentDir),
			};
		}

		it("applies tabTitle model and length changes saved elsewhere after the runtime started", async () => {
			const { utility, other } = await sharedSettings();
			const runtime = { ...makeRuntime(), settingsManager: utility };
			const path = await writeSessionFile(savedSession());

			await generateSessionTitleForRpc(runtime, path);
			expect(mockCompleteSimple.mock.calls[0][0]).toMatchObject({
				provider: "runtime-provider",
				id: "runtime-model",
			});
			expect(mockCompleteSimple.mock.calls[0][1].systemPrompt).toContain("Aim for about 40 characters");

			other.setGlobalTabTitleSettings({ model: "explore-provider/explore-model", maxTitleLength: 77 });
			await other.flush();

			await expect(generateSessionTitleForRpc(runtime, path)).resolves.toEqual({
				ok: true,
				title: "Past session rename",
			});
			expect(mockCompleteSimple.mock.calls[1][0]).toMatchObject({
				provider: "explore-provider",
				id: "explore-model",
			});
			expect(mockCompleteSimple.mock.calls[1][1].systemPrompt).toContain("Aim for about 77 characters");
		});

		it("applies an Explore agentModels override saved elsewhere after the runtime started", async () => {
			const { utility, other } = await sharedSettings();
			const runtime = { ...makeRuntime(), settingsManager: utility };
			const path = await writeSessionFile(savedSession());

			other.setAgentModelsForAgent("Explore", ["explore-provider/explore-model"]);
			await other.flush();
			await generateSessionTitleForRpc(runtime, path);

			expect(mockResolveModel.mock.calls[0][0]).toEqual(["explore-provider/explore-model"]);
		});

		it("fails loudly instead of titling with stale settings when the reload fails", async () => {
			const { agentDir, utility } = await sharedSettings();
			const runtime = { ...makeRuntime(), settingsManager: utility };
			const path = await writeSessionFile(savedSession());
			writeFileSync(join(agentDir, "settings.json"), "{ not json", "utf8");

			const result = await generateSessionTitleForRpc(runtime, path);

			expect(result.ok).toBe(false);
			expect(result.ok === false && result.error).toMatch(/^Failed to reload settings: global: /);
			expect(mockCompleteSimple).not.toHaveBeenCalled();
		});
	});

	describe("models.json changes", () => {
		/** A long-lived utility runtime's real registry, loaded before models.json gains a model. */
		async function liveRegistry() {
			const root = await mkdtemp(join(tmpdir(), "dreb-rpc-title-models-"));
			tempDirs.push(root);
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			const modelsJsonPath = join(agentDir, "models.json");
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
			const registry = new ModelRegistry(AuthStorage.inMemory(), modelsJsonPath);
			return {
				modelsJsonPath,
				registry,
				utility: SettingsManager.create(projectDir, agentDir),
				other: SettingsManager.create(root, agentDir),
			};
		}

		function customProvider(modelIds: string[]) {
			return {
				providers: {
					custom: {
						baseUrl: "https://custom.test/v1",
						apiKey: "CUSTOM_KEY",
						api: "openai-completions",
						models: modelIds.map((id) => ({
							id,
							name: id,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 8000,
						})),
					},
				},
			};
		}

		it("uses a model pinned after it was added to models.json while the runtime was running", async () => {
			const { modelsJsonPath, registry, utility, other } = await liveRegistry();
			const runtime = { ...makeRuntime(), settingsManager: utility, modelRegistry: registry };
			const path = await writeSessionFile(savedSession());
			expect(registry.find("custom", "new-model")).toBeUndefined();

			writeFileSync(modelsJsonPath, JSON.stringify(customProvider(["new-model"])));
			other.setGlobalTabTitleSettings({ model: "custom/new-model" });
			await other.flush();

			await expect(generateSessionTitleForRpc(runtime, path)).resolves.toEqual({
				ok: true,
				title: "Past session rename",
			});
			expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
			expect(mockCompleteSimple.mock.calls[0][0]).toMatchObject({ provider: "custom", id: "new-model" });
		});

		it("fails loudly instead of titling with stale models when models.json cannot be loaded", async () => {
			const { modelsJsonPath, registry, utility } = await liveRegistry();
			const runtime = { ...makeRuntime(), settingsManager: utility, modelRegistry: registry };
			const path = await writeSessionFile(savedSession());
			writeFileSync(modelsJsonPath, "{ not json", "utf8");

			const result = await generateSessionTitleForRpc(runtime, path);

			expect(result.ok).toBe(false);
			expect(result.ok === false && result.error).toMatch(/^Failed to parse models\.json: /);
			expect(mockCompleteSimple).not.toHaveBeenCalled();
		});

		it("rejects a pinned model that is still unknown instead of titling with the runtime model", async () => {
			const { registry, utility, other } = await liveRegistry();
			const runtime = { ...makeRuntime(), settingsManager: utility, modelRegistry: registry };
			const path = await writeSessionFile(savedSession());
			other.setGlobalTabTitleSettings({ model: "custom/removed-model" });
			await other.flush();

			await expect(generateSessionTitleForRpc(runtime, path)).resolves.toEqual({
				ok: false,
				error:
					'Tab title generation failed: tabTitle.model "custom/removed-model" is not a known model ' +
					"(choose another Tab Title model in Settings, or add it to models.json)",
			});
			expect(mockCompleteSimple).not.toHaveBeenCalled();
		});
	});

	it("rejects a session with no requests or activity instead of titling its folder name", async () => {
		const [header] = savedSession();
		const path = await writeSessionFile([header]);

		const result = await generateSessionTitleForRpc(makeRuntime(), path);

		expect(result).toEqual({
			ok: false,
			error: "Tab title generation failed: the session has no requests or activity to title",
		});
		expect(mockCompleteSimple).not.toHaveBeenCalled();
	});
});
