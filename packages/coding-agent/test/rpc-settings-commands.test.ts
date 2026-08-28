import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@dreb/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import * as outputGuard from "../src/core/output-guard.js";
import { SettingsManager, type SettingsStorage } from "../src/core/settings-manager.js";
import * as jsonl from "../src/modes/rpc/jsonl.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import {
	evaluateContextTrustForRpc,
	getFreshSettingsForRpc,
	getSettingsForRpc,
	listAgentTypesForRpc,
	removeTrustedContextFolderForRpc,
	runRpcMode,
	setSettingsForRpc,
	trustContextFolderForRpc,
	untrustContextFolderForRpc,
} from "../src/modes/rpc/rpc-mode.js";
import type { RpcSettingsSnapshot } from "../src/modes/rpc/rpc-types.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	// Canonicalize with realpath so expected paths match the implementation's
	// native-realpath output; on macOS os.tmpdir() lives under /var → /private/var.
	const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "dreb-rpc-settings-")));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function stubRegistry(models: Array<{ provider: string; id: string }>) {
	return {
		getAvailable: vi.fn(() => models as Model<any>[]),
	};
}

const anthropicSonnet = { provider: "anthropic", id: "claude-sonnet-4-5" };

describe("getSettingsForRpc", () => {
	it("returns defaults when nothing has been set", () => {
		const manager = SettingsManager.inMemory();

		const snapshot = getSettingsForRpc(manager);

		expect(snapshot).toEqual({
			defaultProvider: undefined,
			defaultModel: undefined,
			defaultThinkingLevel: undefined,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			compactionEnabled: true,
			continueAfterAutoCompaction: false,
			retryEnabled: true,
			maxConcurrentSubagents: 4,
			imageAutoResize: true,
			blockImages: false,
			enableSkillCommands: true,
			autoLoadNestedContext: false,
			trustedContextFolders: [],
			effectiveTrustedContextRoots: [],
			transport: "sse",
			hideThinkingBlock: false,
			agentModels: {},
			subagentArbiter: undefined,
			tabTitle: undefined,
			enabledModels: undefined,
			resolvedScopedModels: [],
			scopeWarnings: [],
			hasProjectEnabledModelsOverride: false,
			enabledModelsSource: "default",
		});
	});

	it("reflects values from the settings store", () => {
		const manager = SettingsManager.inMemory({
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "high",
			steeringMode: "all",
			followUpMode: "all",
			compaction: { enabled: false, continueAfterAutoCompaction: true },
			retry: { enabled: false },
			backgroundAgents: { maxConcurrentSubagents: 1 },
			images: { autoResize: false, blockImages: true },
			enableSkillCommands: false,
			context: { autoLoadNested: false },
			transport: "websocket",
			hideThinkingBlock: true,
			agentModels: { models: { Explore: ["anthropic/sonnet", "openai/gpt-5"] } },
			subagentArbiter: { enabled: true, model: "anthropic/claude-sonnet-4-5", thinking: "high" },
			tabTitle: {
				enabled: true,
				model: "anthropic/claude-sonnet-4-5",
				triggerAfter: 5,
				maxTitleLength: 80,
			},
		});

		expect(getSettingsForRpc(manager)).toEqual({
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "high",
			steeringMode: "all",
			followUpMode: "all",
			compactionEnabled: false,
			continueAfterAutoCompaction: true,
			retryEnabled: false,
			maxConcurrentSubagents: 1,
			imageAutoResize: false,
			blockImages: true,
			enableSkillCommands: false,
			autoLoadNestedContext: false,
			trustedContextFolders: [],
			effectiveTrustedContextRoots: [],
			transport: "websocket",
			hideThinkingBlock: true,
			agentModels: { Explore: ["anthropic/sonnet", "openai/gpt-5"] },
			subagentArbiter: { enabled: true, model: "anthropic/claude-sonnet-4-5", thinking: "high" },
			tabTitle: {
				enabled: true,
				model: "anthropic/claude-sonnet-4-5",
				triggerAfter: 5,
				maxTitleLength: 80,
			},
			enabledModels: undefined,
			resolvedScopedModels: [],
			scopeWarnings: [],
			hasProjectEnabledModelsOverride: false,
			enabledModelsSource: "default",
		});
	});

	it("reports configured global folders separately from enforceable roots and ignores project trust overrides", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		const trusted = join(dir, "trusted");
		const directFile = join(dir, "not-a-directory");
		mkdirSync(join(projectDir, ".dreb"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(trusted, { recursive: true });
		writeFileSync(directFile, "not a directory");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ context: { autoLoadNested: false, trustedFolders: [trusted, directFile] } }),
		);
		writeFileSync(
			join(projectDir, ".dreb", "settings.json"),
			JSON.stringify({ context: { autoLoadNested: true, trustedFolders: [projectDir] } }),
		);

		const snapshot = getSettingsForRpc(SettingsManager.create(projectDir, agentDir));
		expect(snapshot.autoLoadNestedContext).toBe(false);
		expect(snapshot.trustedContextFolders).toEqual([trusted, directFile]);
		expect(snapshot.effectiveTrustedContextRoots).toEqual([trusted]);
	});

	it("shows configured folders separately from fail-closed enforcement when autoLoadNested is malformed", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		const rootA = join(dir, "a");
		const rootB = join(dir, "b");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(rootA, { recursive: true });
		mkdirSync(rootB, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ context: { autoLoadNested: "yes", trustedFolders: [rootA, rootB] } }),
		);

		const snapshot = getSettingsForRpc(SettingsManager.create(projectDir, agentDir));

		expect(snapshot.autoLoadNestedContext).toBe(false);
		expect(snapshot.trustedContextFolders).toEqual([rootA, rootB]);
		expect(snapshot.effectiveTrustedContextRoots).toEqual([]);
	});

	it("keeps a legacy persisted empty scope distinct from implicit all", () => {
		const snapshot = getSettingsForRpc(SettingsManager.inMemory({ enabledModels: [] }), []);
		expect(snapshot.enabledModels).toEqual([]);
		expect(snapshot.enabledModelsSource).toBe("global");
		expect(snapshot.resolvedScopedModels).toEqual([]);
	});

	it("includes raw patterns, ordered core resolution diagnostics, and project source metadata", () => {
		const manager = SettingsManager.inMemory({ enabledModels: ["anthropic/*", "missing"] });
		vi.spyOn(manager, "hasProjectEnabledModelsOverride").mockReturnValue(true);
		const snapshot = getSettingsForRpc(manager, [
			{ provider: "anthropic", id: "second", name: "Second", reasoning: false },
			{ provider: "anthropic", id: "first", name: "First", reasoning: true },
		] as Model<any>[]);

		expect(snapshot.enabledModels).toEqual(["anthropic/*", "missing"]);
		expect(snapshot.resolvedScopedModels.map((model) => `${model.provider}/${model.id}`)).toEqual([
			"anthropic/second",
			"anthropic/first",
		]);
		expect(snapshot.scopeWarnings).toEqual([{ pattern: "missing", message: 'No models match pattern "missing"' }]);
		expect(snapshot.hasProjectEnabledModelsOverride).toBe(true);
		expect(snapshot.enabledModelsSource).toBe("project");
	});
});

describe("getFreshSettingsForRpc", () => {
	it("reloads durable global and project settings before snapshotting", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		mkdirSync(join(projectDir, ".dreb"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic" }));
		writeFileSync(join(projectDir, ".dreb", "settings.json"), JSON.stringify({ steeringMode: "all" }));
		const manager = SettingsManager.create(projectDir, agentDir);

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai" }));
		writeFileSync(join(projectDir, ".dreb", "settings.json"), JSON.stringify({ followUpMode: "all" }));

		await expect(getFreshSettingsForRpc(manager)).resolves.toMatchObject({
			ok: true,
			settings: { defaultProvider: "openai", steeringMode: "one-at-a-time", followUpMode: "all" },
		});
	});

	it("resolves durable legacy model patterns with the refreshed registry inventory", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["anthropic/*", "missing"] }));
		const manager = SettingsManager.create(projectDir, agentDir);
		const registry = stubRegistry([
			{ provider: "anthropic", id: "second" },
			{ provider: "openai", id: "gpt-5" },
			{ provider: "anthropic", id: "first" },
		]);

		const result = await getFreshSettingsForRpc(manager, registry);

		expect(registry.getAvailable).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			ok: true,
			settings: {
				enabledModels: ["anthropic/*", "missing"],
				resolvedScopedModels: [
					{ provider: "anthropic", id: "second" },
					{ provider: "anthropic", id: "first" },
				],
				scopeWarnings: [{ pattern: "missing", message: 'No models match pattern "missing"' }],
			},
		});
	});

	it("flushes queued writes before reload so they are not discarded", async () => {
		const manager = SettingsManager.inMemory();
		manager.setDefaultProvider("anthropic");

		const result = await getFreshSettingsForRpc(manager);

		expect(result).toMatchObject({ ok: true, settings: { defaultProvider: "anthropic" } });
	});

	it("fails loudly when a queued write error was already recorded before refresh", async () => {
		const manager = SettingsManager.inMemory();
		vi.spyOn(manager, "flush").mockResolvedValue(undefined);
		const drainSpy = vi.spyOn(manager, "drainErrors");
		drainSpy.mockReturnValueOnce([{ scope: "global", error: new Error("disk full") }]);

		const result = await getFreshSettingsForRpc(manager);

		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("disk full") });
		expect(drainSpy).toHaveBeenCalledTimes(1);
	});

	it("fails loudly rather than returning stale settings when a durable file is malformed", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic" }));
		const manager = SettingsManager.create(projectDir, agentDir);
		writeFileSync(join(agentDir, "settings.json"), "{ not json");

		const result = await getFreshSettingsForRpc(manager);

		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("Failed to reload settings: global:");
		expect(manager.getDefaultProvider()).toBe("anthropic");
	});

	it("fails loudly when a durable project settings file is malformed", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".dreb"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic" }));
		writeFileSync(join(projectDir, ".dreb", "settings.json"), JSON.stringify({ followUpMode: "all" }));
		const manager = SettingsManager.create(projectDir, agentDir);
		writeFileSync(join(projectDir, ".dreb", "settings.json"), "{ not json");

		const result = await getFreshSettingsForRpc(manager);

		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("Failed to reload settings: project:");
		expect(manager.hasProjectSettingsLoadError()).toBe(true);
	});

	it("fails loudly when reading durable project settings fails", async () => {
		let global = JSON.stringify({ defaultProvider: "anthropic" });
		let project = JSON.stringify({ followUpMode: "all" });
		let failProjectReads = false;
		const storage: SettingsStorage = {
			withLock(scope, fn) {
				if (failProjectReads && scope === "project") throw new Error("permission denied");
				const next = fn(scope === "global" ? global : project);
				if (next !== undefined) {
					if (scope === "global") {
						global = next;
					} else {
						project = next;
					}
				}
			},
		};
		const manager = SettingsManager.fromStorage(storage);
		failProjectReads = true;

		const result = await getFreshSettingsForRpc(manager);

		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("Failed to reload settings: project: permission denied");
		expect(manager.hasProjectSettingsLoadError()).toBe(true);
	});

	it("returns a get_settings RPC error when durable reload fails", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic" }));
		const manager = SettingsManager.create(projectDir, agentDir);
		writeFileSync(join(agentDir, "settings.json"), "{ not json");
		let handleInputLine: ((line: string) => void) | undefined;
		let resolveResponse: ((response: Record<string, unknown>) => void) | undefined;
		const existingEndListeners = new Set(process.stdin.listeners("end"));
		const existingErrorListeners = new Set(process.stdin.listeners("error"));

		vi.spyOn(outputGuard, "takeOverStdout").mockImplementation(() => {});
		vi.spyOn(outputGuard, "writeRawStdout").mockImplementation((line) => {
			resolveResponse?.(JSON.parse(line) as Record<string, unknown>);
		});
		vi.spyOn(jsonl, "attachJsonlLineReader").mockImplementation((_stream, onLine) => {
			handleInputLine = onLine;
			return () => {};
		});

		try {
			void runRpcMode({
				sessionFile: undefined,
				messages: [],
				settingsManager: manager,
				bindExtensions: async () => {},
				sessionManager: { getCwd: () => projectDir },
				subscribe: () => () => {},
			} as unknown as AgentSession);
			await vi.waitFor(() => expect(handleInputLine).toBeDefined());

			const response = new Promise<Record<string, unknown>>((resolve) => {
				resolveResponse = resolve;
			});
			handleInputLine!(JSON.stringify({ type: "get_settings", id: "stale-settings" }));

			await expect(response).resolves.toMatchObject({
				id: "stale-settings",
				type: "response",
				command: "get_settings",
				success: false,
				error: expect.stringContaining("Failed to reload settings: global:"),
			});
		} finally {
			for (const listener of process.stdin.listeners("end")) {
				if (!existingEndListeners.has(listener)) {
					process.stdin.off("end", listener as (...args: unknown[]) => void);
				}
			}
			for (const listener of process.stdin.listeners("error")) {
				if (!existingErrorListeners.has(listener)) {
					process.stdin.off("error", listener as (...args: unknown[]) => void);
				}
			}
		}
	});
});

describe("setSettingsForRpc validation", () => {
	it("rejects a missing settings object", async () => {
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([]), undefined);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("requires a settings object");
	});

	it("rejects an empty payload", async () => {
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([]), {});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("at least one setting");
	});

	it("rejects unknown keys, naming them", async () => {
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([]), {
			theme: "dark",
			bogus: 1,
		} as never);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("Unknown settings key(s): theme, bogus");
	});

	it("rejects an invalid thinking level, listing valid values", async () => {
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([]), {
			defaultThinkingLevel: "extreme" as never,
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain('Invalid defaultThinkingLevel: "extreme"');
		expect(result.error).toContain("off, minimal, low, medium, high, xhigh");
	});

	it.each(["steeringMode", "followUpMode"] as const)("rejects an invalid %s", async (key) => {
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([]), { [key]: "sometimes" } as never);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain(`Invalid ${key}`);
		expect(result.error).toContain("all, one-at-a-time");
	});

	it.each([
		"compactionEnabled",
		"continueAfterAutoCompaction",
		"retryEnabled",
		"imageAutoResize",
		"blockImages",
		"enableSkillCommands",
		"autoLoadNestedContext",
		"hideThinkingBlock",
	] as const)("rejects a non-boolean %s", async (key) => {
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([]), { [key]: "yes" } as never);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain(`Invalid ${key}`);
		expect(result.error).toContain("Must be a boolean");
	});

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1"])(
		"rejects invalid maxConcurrentSubagents value %s atomically",
		async (value) => {
			const manager = SettingsManager.inMemory({ backgroundAgents: { maxConcurrentSubagents: 2 } });
			const result = await setSettingsForRpc(manager, stubRegistry([]), {
				retryEnabled: false,
				maxConcurrentSubagents: value as never,
			});

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("unreachable");
			expect(result.error).toContain("Invalid maxConcurrentSubagents");
			expect(manager.getMaxConcurrentSubagents()).toBe(2);
			expect(manager.getRetryEnabled()).toBe(true);
		},
	);

	it("rejects an invalid transport, listing valid values", async () => {
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([]), { transport: "http" as never });

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain('Invalid transport: "http"');
		expect(result.error).toContain("sse, websocket, auto");
	});

	it("rejects an agentModels value that is not a plain object", async () => {
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([]), { agentModels: [] as never });

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("Invalid agentModels");
		expect(result.error).toContain("plain object");
	});

	it("rejects an agentModels entry whose value is not an array, naming the agent", async () => {
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([]), {
			agentModels: { Explore: "anthropic/sonnet" } as never,
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain('agentModels["Explore"]');
		expect(result.error).toContain("array of non-empty strings");
	});

	it("rejects an agentModels entry with a non-string model, naming the agent", async () => {
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([]), {
			agentModels: { Explore: ["anthropic/sonnet", 42] } as never,
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain('agentModels["Explore"]');
		expect(result.error).toContain("array of non-empty strings");
	});

	it("rejects a provider without a model (and vice versa)", async () => {
		const manager = SettingsManager.inMemory();

		const providerOnly = await setSettingsForRpc(manager, stubRegistry([anthropicSonnet]), {
			defaultProvider: "anthropic",
		});
		expect(providerOnly.ok).toBe(false);
		if (providerOnly.ok) throw new Error("unreachable");
		expect(providerOnly.error).toContain("must be set together");

		const modelOnly = await setSettingsForRpc(manager, stubRegistry([anthropicSonnet]), {
			defaultModel: "claude-sonnet-4-5",
		});
		expect(modelOnly.ok).toBe(false);
		if (modelOnly.ok) throw new Error("unreachable");
		expect(modelOnly.error).toContain("must be set together");
	});

	it("rejects a provider/model combo that is not available", async () => {
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([anthropicSonnet]), {
			defaultProvider: "openai",
			defaultModel: "gpt-42",
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("Model not found: openai/gpt-42");
	});

	it("rejects invalid trusted folders atomically", async () => {
		const dir = await createTempDir();
		const valid = join(dir, "valid");
		const file = join(dir, "file");
		mkdirSync(valid);
		writeFileSync(file, "file");
		const manager = SettingsManager.inMemory({ context: { trustedFolders: [valid] } });

		for (const folders of [["relative"], [""], [file], [join(dir, "missing")], [valid, file]]) {
			const result = await setSettingsForRpc(manager, stubRegistry([]), { trustedContextFolders: folders });
			expect(result.ok).toBe(false);
		}
		expect(getSettingsForRpc(manager).trustedContextFolders).toEqual([valid]);
	});

	it("validates global-only subagent arbiter configuration", async () => {
		const manager = SettingsManager.inMemory();
		const missingModel = await setSettingsForRpc(manager, stubRegistry([anthropicSonnet]), {
			subagentArbiter: { enabled: true },
		});
		expect(missingModel).toMatchObject({ ok: false, error: expect.stringContaining("requires") });

		const fuzzyModel = await setSettingsForRpc(manager, stubRegistry([anthropicSonnet]), {
			subagentArbiter: { enabled: true, model: "claude-sonnet-4-5" },
		});
		expect(fuzzyModel).toMatchObject({ ok: false, error: expect.stringContaining("exact provider/model") });

		const invalidKey = await setSettingsForRpc(manager, stubRegistry([anthropicSonnet]), {
			subagentArbiter: { enabled: false, extra: true } as never,
		});
		expect(invalidKey).toMatchObject({ ok: false, error: expect.stringContaining("Unknown subagentArbiter") });
	});

	it("validates tab title updates atomically", async () => {
		const manager = SettingsManager.inMemory({
			tabTitle: { enabled: true, triggerAfter: 9, maxTitleLength: 60 },
			retry: { enabled: true },
		});
		const registry = stubRegistry([anthropicSonnet]);
		const invalidUpdates = [
			{ tabTitle: [] },
			{ tabTitle: {} },
			{ tabTitle: { enabled: "yes" } },
			{ tabTitle: { triggerAfter: 0 } },
			{ tabTitle: { maxTitleLength: 1.5 } },
			{ tabTitle: { model: "claude-sonnet-4-5" } },
			{ tabTitle: { model: "openai/missing" } },
			{ tabTitle: { enabled: false, extra: true } },
			{ tabTitle: { model: null, maxTitleLength: 0 } },
		] as const;

		for (const update of invalidUpdates) {
			const result = await setSettingsForRpc(manager, registry, {
				retryEnabled: false,
				tabTitle: update.tabTitle as never,
			});
			expect(result.ok).toBe(false);
		}
		expect(manager.getRetryEnabled()).toBe(true);
		expect(manager.getTabTitleSettings()).toEqual({ enabled: true, triggerAfter: 9, maxTitleLength: 60 });
	});

	it("always permits explicit disablement with malformed retained fields", async () => {
		const manager = SettingsManager.inMemory({
			subagentArbiter: {
				enabled: true,
				model: "retired-provider/retired-model",
				thinking: "xhigh",
				guidePath: "~/routing.md",
			},
		});
		const registry = stubRegistry([]);

		const result = await setSettingsForRpc(manager, registry, {
			subagentArbiter: {
				enabled: false,
				model: "malformed-model-id",
				thinking: "invalid-thinking",
				guidePath: "",
			} as never,
		});

		expect(result).toMatchObject({
			ok: true,
			settings: {
				subagentArbiter: {
					enabled: false,
					model: "malformed-model-id",
					thinking: "invalid-thinking",
					guidePath: "",
				},
			},
		});
		expect(registry.getAvailable).toHaveBeenCalledTimes(1);
		const disabledPolicy = {
			enabled: false,
			model: "malformed-model-id",
			thinking: "invalid-thinking",
			guidePath: "",
		} as const;
		expect(manager.getGlobalSubagentArbiterSettings()).toEqual(disabledPolicy);

		const reEnabled = await setSettingsForRpc(manager, registry, {
			subagentArbiter: { ...disabledPolicy, enabled: true } as never,
		});
		expect(reEnabled).toMatchObject({ ok: false, error: expect.stringContaining("Invalid subagentArbiter") });
		expect(manager.getGlobalSubagentArbiterSettings()).toEqual(disabledPolicy);
	});

	it("rejects invalid enabledModels forms and leaves the prior scope unchanged", async () => {
		const manager = SettingsManager.inMemory({ enabledModels: ["anthropic/claude-sonnet-4-5"] });
		const registry = stubRegistry([anthropicSonnet, { provider: "openai", id: "gpt-5" }]);
		const invalidValues = [
			[],
			["sonnet"],
			["gpt-5"],
			["openai / gpt-5"],
			["anthropic/*"],
			["missing/model"],
			["anthropic/claude-sonnet-4-5", "ANTHROPIC/CLAUDE-SONNET-4-5"],
			[""],
			[" openai/gpt-5 "],
		] as unknown[];

		for (const enabledModels of invalidValues) {
			const result = await setSettingsForRpc(manager, registry, { enabledModels: enabledModels as never });
			expect(result.ok).toBe(false);
			expect(manager.getEnabledModels()).toEqual(["anthropic/claude-sonnet-4-5"]);
		}
	});

	it("validates enabledModels before applying unrelated fields", async () => {
		const manager = SettingsManager.inMemory({ retry: { enabled: true } });
		const result = await setSettingsForRpc(manager, stubRegistry([anthropicSonnet]), {
			retryEnabled: false,
			enabledModels: [],
		});
		expect(result.ok).toBe(false);
		expect(manager.getRetryEnabled()).toBe(true);
	});

	it("does not persist valid enabledModels when a later field is invalid", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		const settingsPath = join(agentDir, "settings.json");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			settingsPath,
			JSON.stringify({ enabledModels: ["anthropic/claude-sonnet-4-5"], retry: { enabled: true } }),
		);
		const manager = SettingsManager.create(projectDir, agentDir);

		const result = await setSettingsForRpc(
			manager,
			stubRegistry([anthropicSonnet, { provider: "openai", id: "gpt-5" }]),
			{
				enabledModels: ["openai/gpt-5"],
				retryEnabled: false,
				defaultProvider: "anthropic",
			},
		);

		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("must be set together") });
		expect(manager.getEnabledModels()).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(manager.getRetryEnabled()).toBe(true);
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
			enabledModels: ["anthropic/claude-sonnet-4-5"],
			retry: { enabled: true },
		});
	});

	it("applies nothing when any field is invalid (atomicity)", async () => {
		const manager = SettingsManager.inMemory({ retry: { enabled: true }, images: { autoResize: true } });
		const result = await setSettingsForRpc(manager, stubRegistry([]), {
			retryEnabled: false, // valid
			imageAutoResize: false, // valid
			steeringMode: "bogus" as never, // invalid
		});

		expect(result.ok).toBe(false);
		// The valid fields must NOT have been applied.
		expect(manager.getRetryEnabled()).toBe(true);
		expect(manager.getImageAutoResize()).toBe(true);
	});
});

describe("setSettingsForRpc writes", () => {
	it("canonicalizes ordered partial enabledModels and clears with null", async () => {
		const manager = SettingsManager.inMemory();
		const registry = stubRegistry([
			{ provider: "anthropic", id: "claude-sonnet-4-5" },
			{ provider: "openai", id: "gpt-5" },
			{ provider: "openrouter", id: "org/model:exact" },
		]);

		const partial = await setSettingsForRpc(manager, registry, {
			enabledModels: ["OPENAI/GPT-5", "OPENROUTER/org/model:exact"],
		});
		expect(partial).toMatchObject({
			ok: true,
			settings: {
				enabledModels: ["openai/gpt-5", "openrouter/org/model:exact"],
				resolvedScopedModels: [
					{ provider: "openai", id: "gpt-5" },
					{ provider: "openrouter", id: "org/model:exact" },
				],
			},
		});
		expect(manager.getEnabledModels()).toEqual(["openai/gpt-5", "openrouter/org/model:exact"]);

		const cleared = await setSettingsForRpc(manager, registry, { enabledModels: null });
		expect(cleared).toMatchObject({ ok: true, settings: { enabledModelsSource: "default" } });
		expect(manager.getEnabledModels()).toBeUndefined();
	});

	it("normalizes the complete authoritative inventory to implicit all", async () => {
		const manager = SettingsManager.inMemory();
		const models = [anthropicSonnet, { provider: "openai", id: "gpt-5" }];
		const result = await setSettingsForRpc(manager, stubRegistry(models), {
			enabledModels: ["openai/gpt-5", "anthropic/claude-sonnet-4-5"],
		});
		expect(result).toMatchObject({ ok: true, settings: { enabledModelsSource: "default" } });
		expect(manager.getEnabledModels()).toBeUndefined();
	});

	it("writes globally but returns the exact warning and effective project scope when shadowed", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".dreb"), { recursive: true });
		writeFileSync(
			join(projectDir, ".dreb", "settings.json"),
			JSON.stringify({ enabledModels: ["anthropic/claude-sonnet-4-5"] }),
		);
		const manager = SettingsManager.create(projectDir, agentDir);
		const result = await setSettingsForRpc(
			manager,
			stubRegistry([anthropicSonnet, { provider: "openai", id: "gpt-5" }]),
			{
				enabledModels: ["openai/gpt-5"],
			},
		);

		expect(result).toMatchObject({
			ok: true,
			settings: {
				enabledModels: ["anthropic/claude-sonnet-4-5"],
				enabledModelsSource: "project",
				hasProjectEnabledModelsOverride: true,
			},
			warnings: [
				"A project-level enabledModels value (.dreb/settings.json) takes precedence — this change to global settings will have no effect. Edit the project settings file to change it.",
			],
		});
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).enabledModels).toEqual([
			"openai/gpt-5",
		]);
	});

	it("persists and clears the complete global-only arbiter policy", async () => {
		const manager = SettingsManager.inMemory();
		const enabled = await setSettingsForRpc(manager, stubRegistry([anthropicSonnet]), {
			subagentArbiter: {
				enabled: true,
				model: "anthropic/claude-sonnet-4-5",
				thinking: "off",
				guidePath: "~/routing.md",
			},
		});
		expect(enabled).toMatchObject({
			ok: true,
			settings: {
				subagentArbiter: {
					enabled: true,
					model: "anthropic/claude-sonnet-4-5",
					thinking: "off",
					guidePath: "~/routing.md",
				},
			},
		});
		expect(manager.getGlobalSubagentArbiterSettings()?.enabled).toBe(true);

		const cleared = await setSettingsForRpc(manager, stubRegistry([anthropicSonnet]), { subagentArbiter: null });
		expect(cleared).toMatchObject({ ok: true, settings: { subagentArbiter: undefined } });
		expect(manager.getGlobalSubagentArbiterSettings()).toBeUndefined();
	});

	it("persists partial tab title updates without losing sibling settings", async () => {
		const titleModel = { provider: "openrouter", id: "vendor/title-model" };
		const manager = SettingsManager.inMemory({
			tabTitle: { enabled: true, triggerAfter: 7, maxTitleLength: 90 },
		});

		const selected = await setSettingsForRpc(manager, stubRegistry([titleModel]), {
			tabTitle: { model: "openrouter/vendor/title-model" },
		});
		expect(selected).toMatchObject({
			ok: true,
			settings: {
				tabTitle: {
					enabled: true,
					model: "openrouter/vendor/title-model",
					triggerAfter: 7,
					maxTitleLength: 90,
				},
			},
		});

		const disabled = await setSettingsForRpc(manager, stubRegistry([titleModel]), {
			tabTitle: { enabled: false },
		});
		expect(disabled).toMatchObject({
			ok: true,
			settings: {
				tabTitle: {
					enabled: false,
					model: "openrouter/vendor/title-model",
					triggerAfter: 7,
					maxTitleLength: 90,
				},
			},
		});
	});

	it("clears a pinned tab title model with model: null without losing sibling settings", async () => {
		const manager = SettingsManager.inMemory({
			tabTitle: { enabled: true, model: "openrouter/vendor/title-model", triggerAfter: 7, maxTitleLength: 90 },
		});

		const cleared = await setSettingsForRpc(manager, stubRegistry([]), {
			tabTitle: { model: null },
		});
		expect(cleared.ok).toBe(true);
		if (!cleared.ok) throw new Error("unreachable");
		expect(cleared.settings.tabTitle).toEqual({ enabled: true, triggerAfter: 7, maxTitleLength: 90 });
		expect(manager.getTabTitleSettings()).toEqual({ enabled: true, triggerAfter: 7, maxTitleLength: 90 });
	});

	it("removes a cleared tab title model from the global settings file", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ tabTitle: { enabled: true, model: "anthropic/claude-sonnet-4-5", triggerAfter: 6 } }),
			"utf8",
		);

		const manager = SettingsManager.create(projectDir, agentDir);
		const result = await setSettingsForRpc(manager, stubRegistry([anthropicSonnet]), {
			tabTitle: { model: null },
		});
		expect(result.ok).toBe(true);

		// The handler flushes, so the file no longer pins the model.
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(raw.tabTitle).toEqual({ enabled: true, triggerAfter: 6 });

		// A fresh manager over the same dirs (fresh runtime) observes the cleared model.
		const fresh = SettingsManager.create(projectDir, agentDir);
		expect(fresh.getTabTitleSettings()).toEqual({ enabled: true, triggerAfter: 6 });
	});

	it("expands home-directory trusted folders before persisting canonical roots", async () => {
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([]), { trustedContextFolders: ["~"] });

		expect(result).toMatchObject({
			ok: true,
			settings: {
				trustedContextFolders: [realpathSync.native(homedir())],
				effectiveTrustedContextRoots: [realpathSync.native(homedir())],
			},
		});
	});

	it("canonicalizes, deduplicates, and persists trusted context folders", async () => {
		const dir = await createTempDir();
		const parent = join(dir, "parent");
		const child = join(parent, "child");
		mkdirSync(child, { recursive: true });
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([]), {
			trustedContextFolders: [child, parent, child],
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error("unreachable");
		expect(result.settings.trustedContextFolders).toEqual([parent]);
		expect(result.settings.effectiveTrustedContextRoots).toEqual([parent]);
		expect(manager.getGlobalContextTrustPolicy().trustedFolders).toEqual([parent]);
	});

	it("applies every supported field and returns the post-write snapshot", async () => {
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([anthropicSonnet]), {
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "low",
			steeringMode: "all",
			followUpMode: "all",
			compactionEnabled: false,
			continueAfterAutoCompaction: true,
			retryEnabled: false,
			maxConcurrentSubagents: 0,
			imageAutoResize: false,
			blockImages: true,
			enableSkillCommands: false,
			autoLoadNestedContext: false,
			trustedContextFolders: ["~"],
			transport: "auto",
			hideThinkingBlock: true,
			agentModels: { Explore: ["anthropic/sonnet", "openai/gpt-5"] },
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.settings).toEqual({
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "low",
			steeringMode: "all",
			followUpMode: "all",
			compactionEnabled: false,
			continueAfterAutoCompaction: true,
			retryEnabled: false,
			maxConcurrentSubagents: 0,
			imageAutoResize: false,
			blockImages: true,
			enableSkillCommands: false,
			autoLoadNestedContext: false,
			trustedContextFolders: [realpathSync.native(homedir())],
			effectiveTrustedContextRoots: [realpathSync.native(homedir())],
			transport: "auto",
			hideThinkingBlock: true,
			agentModels: { Explore: ["anthropic/sonnet", "openai/gpt-5"] },
			subagentArbiter: undefined,
			tabTitle: undefined,
			enabledModels: undefined,
			resolvedScopedModels: [],
			scopeWarnings: [],
			hasProjectEnabledModelsOverride: false,
			enabledModelsSource: "default",
		});
		// Reflected in subsequent reads.
		expect(getSettingsForRpc(manager)).toEqual(result.settings);
	});

	it("writes and removes agent model fallback lists", async () => {
		const manager = SettingsManager.inMemory();

		const setResult = await setSettingsForRpc(manager, stubRegistry([]), {
			agentModels: { Explore: ["anthropic/sonnet", "openai/gpt-5"] },
		});
		expect(setResult.ok).toBe(true);
		if (!setResult.ok) throw new Error("unreachable");
		expect(setResult.settings.agentModels).toEqual({ Explore: ["anthropic/sonnet", "openai/gpt-5"] });
		expect(getSettingsForRpc(manager).agentModels).toEqual({ Explore: ["anthropic/sonnet", "openai/gpt-5"] });

		const removeResult = await setSettingsForRpc(manager, stubRegistry([]), {
			agentModels: { Explore: [] },
		});
		expect(removeResult.ok).toBe(true);
		if (!removeResult.ok) throw new Error("unreachable");
		expect(removeResult.settings.agentModels).toEqual({});
		expect(getSettingsForRpc(manager).agentModels).toEqual({});
	});

	it("warns when project agentModels override shadows a global write while still persisting the global change", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		mkdirSync(join(projectDir, ".dreb"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(projectDir, ".dreb", "settings.json"),
			JSON.stringify({ agentModels: { models: { Explore: ["project/model"] } } }),
			"utf8",
		);

		const manager = SettingsManager.create(projectDir, agentDir);
		const result = await setSettingsForRpc(manager, stubRegistry([]), {
			agentModels: { Explore: ["global/model"], "Code Reviewer": ["global/reviewer"] },
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.warnings).toEqual([
			'A project-level agentModels override for "Explore" (.dreb/settings.json) takes precedence — this change to global settings will have no effect. Edit the project settings file to change it.',
		]);
		expect(result.settings.agentModels).toEqual({
			Explore: ["project/model"],
			"Code Reviewer": ["global/reviewer"],
		});

		const rawGlobal = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(rawGlobal.agentModels.models.Explore).toEqual(["global/model"]);
		expect(rawGlobal.agentModels.models["Code Reviewer"]).toEqual(["global/reviewer"]);
	});

	it("persists to disk and is visible to a fresh SettingsManager (fresh-runtime simulation)", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		const trusted = join(dir, "trusted");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(trusted, { recursive: true });

		const manager = SettingsManager.create(projectDir, agentDir);
		const result = await setSettingsForRpc(manager, stubRegistry([anthropicSonnet]), {
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "medium",
			continueAfterAutoCompaction: true,
			retryEnabled: false,
			imageAutoResize: false,
			blockImages: true,
			enableSkillCommands: false,
			autoLoadNestedContext: false,
			trustedContextFolders: [trusted],
			transport: "websocket",
			hideThinkingBlock: true,
			agentModels: { Explore: ["anthropic/sonnet"] },
			tabTitle: {
				enabled: true,
				model: "anthropic/claude-sonnet-4-5",
				triggerAfter: 6,
				maxTitleLength: 72,
			},
		});
		expect(result.ok).toBe(true);

		// The handler flushes, so the file must exist with the written values.
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(raw.defaultProvider).toBe("anthropic");
		expect(raw.defaultModel).toBe("claude-sonnet-4-5");
		expect(raw.defaultThinkingLevel).toBe("medium");
		expect(raw.compaction.continueAfterAutoCompaction).toBe(true);
		expect(raw.retry.enabled).toBe(false);
		expect(raw.images.autoResize).toBe(false);
		expect(raw.images.blockImages).toBe(true);
		expect(raw.enableSkillCommands).toBe(false);
		expect(raw.context.autoLoadNested).toBe(false);
		expect(raw.context.trustedFolders).toEqual([trusted]);
		expect(raw.transport).toBe("websocket");
		expect(raw.hideThinkingBlock).toBe(true);
		expect(raw.agentModels.models.Explore).toEqual(["anthropic/sonnet"]);
		expect(raw.tabTitle).toEqual({
			enabled: true,
			model: "anthropic/claude-sonnet-4-5",
			triggerAfter: 6,
			maxTitleLength: 72,
		});

		// A fresh manager over the same dirs (fresh runtime) reads the same state.
		const fresh = SettingsManager.create(projectDir, agentDir);
		expect(getSettingsForRpc(fresh)).toEqual(getSettingsForRpc(manager));
	});

	it("fails loudly when the global settings file is corrupt instead of silently not saving", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{ not valid json", "utf8");

		const manager = SettingsManager.create(projectDir, agentDir);
		const result = await setSettingsForRpc(manager, stubRegistry([]), { retryEnabled: false });

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("settings file failed to load");
		// The corrupt file must not have been overwritten.
		expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe("{ not valid json");
	});

	it("surfaces write errors as explicit failures", async () => {
		const manager = SettingsManager.inMemory();
		// Simulate an I/O failure recorded during the queued write.
		// The handler calls drainErrors() twice: first to discard stale errors,
		// then after flush to check for this operation's errors.
		vi.spyOn(manager, "flush").mockResolvedValue(undefined);
		const drainSpy = vi.spyOn(manager, "drainErrors");
		drainSpy.mockReturnValueOnce([]); // first call: discard stale
		drainSpy.mockReturnValueOnce([{ scope: "global", error: new Error("disk full") }]); // second call: post-flush

		const result = await setSettingsForRpc(manager, stubRegistry([]), { retryEnabled: false });

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("Failed to persist settings");
		expect(result.error).toContain("disk full");
	});

	it("leaves the prior durable enabledModels scope when its write fails", async () => {
		let globalSettings = JSON.stringify({ enabledModels: ["anthropic/old"] });
		const storage: SettingsStorage = {
			withLock(scope, fn) {
				const next = fn(scope === "global" ? globalSettings : undefined);
				if (next === undefined || scope !== "global") return;
				if (JSON.parse(next).enabledModels?.includes("openai/gpt-5")) throw new Error("disk full");
				globalSettings = next;
			},
		};
		const manager = SettingsManager.fromStorage(storage);
		const result = await setSettingsForRpc(
			manager,
			stubRegistry([
				{ provider: "anthropic", id: "old" },
				{ provider: "openai", id: "gpt-5" },
			]),
			{ enabledModels: ["openai/gpt-5"] },
		);
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("disk full") });
		expect(JSON.parse(globalSettings).enabledModels).toEqual(["anthropic/old"]);
	});

	it("does not durably enable context trust when an ordinary-settings write fails", async () => {
		let globalSettings: string | undefined;
		const storage: SettingsStorage = {
			withLock(scope, fn) {
				const next = fn(scope === "global" ? globalSettings : undefined);
				if (next === undefined || scope !== "global") return;
				if (JSON.parse(next).transport !== undefined) throw new Error("disk full");
				globalSettings = next;
			},
		};
		const manager = SettingsManager.fromStorage(storage);

		const result = await setSettingsForRpc(manager, stubRegistry([]), {
			transport: "websocket",
			autoLoadNestedContext: true,
		});

		expect(result).toMatchObject({ ok: false });
		expect(manager.getGlobalContextTrustPolicy()).toEqual({ unrestricted: false, trustedFolders: [] });
		expect(JSON.parse(globalSettings ?? "{}").context).toBeUndefined();
	});

	it("keeps an ordinary phase-one update when the following context write fails", async () => {
		let globalSettings: string | undefined;
		const storage: SettingsStorage = {
			withLock(scope, fn) {
				const next = fn(scope === "global" ? globalSettings : undefined);
				if (next === undefined || scope !== "global") return;
				if (JSON.parse(next).context !== undefined) throw new Error("disk full");
				globalSettings = next;
			},
		};
		const manager = SettingsManager.fromStorage(storage);

		const result = await setSettingsForRpc(manager, stubRegistry([]), {
			transport: "websocket",
			autoLoadNestedContext: true,
			trustedContextFolders: [],
		});

		expect(result).toMatchObject({ ok: false });
		const fresh = SettingsManager.fromStorage(storage);
		expect(fresh.getGlobalContextTrustPolicy()).toEqual({ unrestricted: false, trustedFolders: [] });
		expect(fresh.getTransport()).toBe("websocket");
	});

	it.each([
		["unrestricted nested context", (_root: string) => ({ autoLoadNestedContext: true })],
		["a trusted context folder", (root: string) => ({ trustedContextFolders: [root] })],
	])("does not retain %s after a failed write", async (_label, createUpdate) => {
		const dir = await createTempDir();
		const root = join(dir, "root");
		mkdirSync(root);
		const storage: SettingsStorage = {
			withLock(_scope, fn) {
				const next = fn(undefined);
				if (next !== undefined) throw new Error("disk full");
			},
		};
		const manager = SettingsManager.fromStorage(storage);

		const result = await setSettingsForRpc(manager, stubRegistry([]), createUpdate(root));

		expect(result).toMatchObject({ ok: false });
		expect(manager.getGlobalContextTrustPolicy()).toEqual({ unrestricted: false, trustedFolders: [] });
		expect(evaluateContextTrustForRpc(manager, root)).toEqual({
			ok: true,
			evaluation: { canonicalTarget: root, state: "untrusted" },
		});
	});

	// chmod-based write-failure injection is bypassed by root (permissions don't apply)
	// and not enforced for directories on Windows.
	const cannotInjectWriteFailure =
		process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0);

	it.skipIf(cannotInjectWriteFailure)(
		"surfaces a real failed write loudly (no mocks — read-only agent dir)",
		async () => {
			const dir = await createTempDir();
			const agentDir = join(dir, "agent");
			const projectDir = join(dir, "project");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true } }), "utf8");

			// Load must succeed (writable dir) — only the queued write may fail.
			const manager = SettingsManager.create(projectDir, agentDir);
			// Now make the agent dir read-only: the write (which creates a lock entry
			// next to settings.json) fails with EACCES and must surface loudly through
			// the REAL recordError → drainErrors path, with no mocks.
			chmodSync(agentDir, 0o555);

			try {
				const result = await setSettingsForRpc(manager, stubRegistry([]), { retryEnabled: false });

				expect(result.ok).toBe(false);
				if (result.ok) throw new Error("unreachable");
				expect(result.error).toContain("Failed to persist settings");
				expect(result.error).toContain("global:");
				// The settings file must be unchanged.
				expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
					retry: { enabled: true },
				});
			} finally {
				// Restore permissions so afterEach temp-dir cleanup can delete the tree.
				chmodSync(agentDir, 0o755);
			}
		},
	);

	it("discards stale errors from prior commands instead of mis-attributing them", async () => {
		const manager = SettingsManager.inMemory();
		// Simulate a stale error left by a prior command (e.g. set_model with a failed write)
		// that was recorded in the shared error bucket but never drained.
		const drainSpy = vi.spyOn(manager, "drainErrors");
		drainSpy.mockReturnValueOnce([{ scope: "global", error: new Error("stale write error from set_model") }]); // first call: stale
		drainSpy.mockReturnValueOnce([]); // second call: this operation's write succeeded

		const result = await setSettingsForRpc(manager, stubRegistry([]), { retryEnabled: false });

		// The stale error must NOT cause this operation to report failure.
		expect(result.ok).toBe(true);
		expect(drainSpy).toHaveBeenCalledTimes(2);
	});

	it("serializes concurrent set_settings calls so errors are correctly attributed", async () => {
		const manager = SettingsManager.inMemory();

		// Track the order of operations to verify serialization.
		const ops: string[] = [];
		const realFlush = manager.flush.bind(manager);
		vi.spyOn(manager, "flush").mockImplementation(async () => {
			ops.push("flush-start");
			await realFlush();
			// Simulate a small delay so concurrency bugs would manifest.
			await new Promise((resolve) => setTimeout(resolve, 10));
			ops.push("flush-end");
		});

		// Launch two concurrent set_settings calls.
		const [result1, result2] = await Promise.all([
			setSettingsForRpc(manager, stubRegistry([]), { retryEnabled: false }),
			setSettingsForRpc(manager, stubRegistry([]), { compactionEnabled: false }),
		]);

		expect(result1.ok).toBe(true);
		expect(result2.ok).toBe(true);

		// Flushes must be serialized: the second flush-start must come after the first flush-end.
		expect(ops).toEqual(["flush-start", "flush-end", "flush-start", "flush-end"]);
	});
});

describe("context trust RPC commands", () => {
	it("evaluates exact and inherited trusted roots through the core matcher", async () => {
		const dir = await createTempDir();
		const root = join(dir, "root");
		const child = join(root, "child");
		const outside = join(dir, "outside");
		mkdirSync(child, { recursive: true });
		mkdirSync(outside, { recursive: true });
		const manager = SettingsManager.inMemory({ context: { trustedFolders: [root] } });

		expect(evaluateContextTrustForRpc(manager, root)).toEqual({
			ok: true,
			evaluation: { canonicalTarget: root, state: "trusted-root", grantingRoot: root },
		});
		expect(evaluateContextTrustForRpc(manager, child)).toEqual({
			ok: true,
			evaluation: { canonicalTarget: child, state: "trusted-root", grantingRoot: root },
		});
		expect(evaluateContextTrustForRpc(manager, outside)).toEqual({
			ok: true,
			evaluation: { canonicalTarget: outside, state: "untrusted" },
		});
		expect(evaluateContextTrustForRpc(manager, join(dir, "missing"))).toMatchObject({ ok: false });
	});

	it("rejects relative paths for evaluation and trust mutations", async () => {
		const dir = await createTempDir();
		const root = join(dir, "root");
		mkdirSync(root);
		const manager = SettingsManager.inMemory({ context: { trustedFolders: [root] } });

		for (const path of [".", "relative"]) {
			for (const result of [
				evaluateContextTrustForRpc(manager, path),
				await trustContextFolderForRpc(manager, path),
				await untrustContextFolderForRpc(manager, path),
			]) {
				expect(result).toMatchObject({ ok: false });
				if (!result.ok) expect(result.error).toContain("path must be absolute");
			}
		}
		expect(manager.getGlobalContextTrustPolicy().trustedFolders).toEqual([root]);
	});

	it("accepts settings-style home paths", () => {
		const manager = SettingsManager.inMemory();

		expect(evaluateContextTrustForRpc(manager, "~")).toEqual({
			ok: true,
			evaluation: { canonicalTarget: realpathSync.native(homedir()), state: "untrusted" },
		});
	});

	it("trusts a canonical root and untrusts the root granting inherited access", async () => {
		const dir = await createTempDir();
		const root = join(dir, "root");
		const child = join(root, "child");
		mkdirSync(child, { recursive: true });
		const manager = SettingsManager.inMemory();

		const trusted = await trustContextFolderForRpc(manager, root);
		expect(trusted).toMatchObject({
			ok: true,
			result: {
				addedRoot: root,
				evaluation: { canonicalTarget: root, state: "trusted-root", grantingRoot: root },
				settings: { trustedContextFolders: [root], effectiveTrustedContextRoots: [root] },
			},
		});

		const untrusted = await untrustContextFolderForRpc(manager, child);
		expect(untrusted).toMatchObject({
			ok: true,
			result: {
				removedRoot: root,
				evaluation: { canonicalTarget: child, state: "untrusted" },
				settings: { trustedContextFolders: [], effectiveTrustedContextRoots: [] },
			},
		});
	});

	it("durably trusts a root and removes it through a descendant across fresh managers", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		const root = join(dir, "root");
		const child = join(root, "child");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(child, { recursive: true });
		const canonicalRoot = realpathSync.native(root);
		const canonicalChild = realpathSync.native(child);

		const initial = SettingsManager.create(projectDir, agentDir);
		await expect(trustContextFolderForRpc(initial, root)).resolves.toMatchObject({
			ok: true,
			result: { addedRoot: canonicalRoot },
		});
		await initial.flush();

		const afterTrust = SettingsManager.create(projectDir, agentDir);
		expect(afterTrust.getGlobalContextTrustPolicy().trustedFolders).toEqual([canonicalRoot]);
		expect(evaluateContextTrustForRpc(afterTrust, child)).toEqual({
			ok: true,
			evaluation: { canonicalTarget: canonicalChild, state: "trusted-root", grantingRoot: canonicalRoot },
		});

		const afterTrustFresh = SettingsManager.create(projectDir, agentDir);
		await expect(untrustContextFolderForRpc(afterTrustFresh, child)).resolves.toMatchObject({
			ok: true,
			result: { removedRoot: canonicalRoot },
		});
		await afterTrustFresh.flush();

		const afterUntrust = SettingsManager.create(projectDir, agentDir);
		expect(afterUntrust.getGlobalContextTrustPolicy().trustedFolders).toEqual([]);
		expect(evaluateContextTrustForRpc(afterUntrust, root)).toEqual({
			ok: true,
			evaluation: { canonicalTarget: canonicalRoot, state: "untrusted" },
		});
	});

	it("removes configured trusted-folder strings without path resolution", async () => {
		const dir = await createTempDir();
		const root = join(dir, "root");
		mkdirSync(root, { recursive: true });
		const manager = SettingsManager.inMemory({
			context: { autoLoadNested: true, trustedFolders: [root, "relative/legacy"] },
		});

		await expect(removeTrustedContextFolderForRpc(manager, root)).resolves.toMatchObject({
			ok: true,
			result: {
				removedFolder: root,
				settings: { autoLoadNestedContext: true, trustedContextFolders: ["relative/legacy"] },
			},
		});
		expect(manager.getGlobalContextTrustPolicy().trustedFolders).toEqual(["relative/legacy"]);

		await expect(removeTrustedContextFolderForRpc(manager, "relative/legacy")).resolves.toMatchObject({
			ok: true,
			result: { removedFolder: "relative/legacy", settings: { trustedContextFolders: [] } },
		});
		expect(manager.getGlobalContextTrustPolicy().trustedFolders).toEqual([]);
	});

	it("removes one configured folder without wiping siblings when autoLoadNested is malformed on disk", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		const rootA = join(dir, "a");
		const rootB = join(dir, "b");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(rootA, { recursive: true });
		mkdirSync(rootB, { recursive: true });
		const canonicalRootB = realpathSync.native(rootB);
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ context: { autoLoadNested: "yes", trustedFolders: [rootA, rootB] } }),
		);
		const manager = SettingsManager.create(projectDir, agentDir);

		const result = await removeTrustedContextFolderForRpc(manager, rootA);

		expect(result).toMatchObject({
			ok: true,
			result: {
				removedFolder: rootA,
				settings: { trustedContextFolders: [rootB], effectiveTrustedContextRoots: [canonicalRootB] },
			},
		});
		const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
		expect(saved.context).toEqual({ autoLoadNested: false, trustedFolders: [rootB] });
		expect(SettingsManager.create(projectDir, agentDir).getGlobalContextTrustPolicy()).toEqual({
			unrestricted: false,
			trustedFolders: [rootB],
		});
	});

	it("trusts a new root without wiping configured siblings when autoLoadNested is malformed on disk", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		const rootA = join(dir, "a");
		const rootB = join(dir, "b");
		const rootC = join(dir, "c");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(rootA, { recursive: true });
		mkdirSync(rootB, { recursive: true });
		mkdirSync(rootC, { recursive: true });
		const canonicalRootA = realpathSync.native(rootA);
		const canonicalRootB = realpathSync.native(rootB);
		const canonicalRootC = realpathSync.native(rootC);
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ context: { autoLoadNested: "true", trustedFolders: [rootA, rootB] } }),
		);
		const manager = SettingsManager.create(projectDir, agentDir);

		const result = await trustContextFolderForRpc(manager, rootC);

		expect(result).toMatchObject({
			ok: true,
			result: {
				addedRoot: canonicalRootC,
				settings: {
					trustedContextFolders: [canonicalRootA, canonicalRootB, canonicalRootC],
					effectiveTrustedContextRoots: [canonicalRootA, canonicalRootB, canonicalRootC],
				},
			},
		});
		const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
		expect(saved.context).toEqual({
			autoLoadNested: false,
			trustedFolders: [canonicalRootA, canonicalRootB, canonicalRootC],
		});
	});

	it("rejects malformed configured-folder removal payloads without mutation", async () => {
		const manager = SettingsManager.inMemory({ context: { trustedFolders: ["relative/legacy"] } });

		for (const path of [null, [], {}, "", 123]) {
			const result = await removeTrustedContextFolderForRpc(manager, path);
			expect(result).toMatchObject({ ok: false });
			if (!result.ok) expect(result.error).toContain("non-empty string path");
		}
		expect(manager.getGlobalContextTrustPolicy().trustedFolders).toEqual(["relative/legacy"]);
	});

	it("dispatches context trust commands from JSONL and rejects malformed wire paths without mutation", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		const root = join(dir, "root");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(root, { recursive: true });
		const canonicalRoot = realpathSync.native(root);
		const manager = SettingsManager.create(projectDir, agentDir);
		const responseResolvers: Array<(response: Record<string, unknown>) => void> = [];
		let handleInputLine: ((line: string) => void) | undefined;
		const existingEndListeners = new Set(process.stdin.listeners("end"));
		const existingErrorListeners = new Set(process.stdin.listeners("error"));

		vi.spyOn(outputGuard, "takeOverStdout").mockImplementation(() => {});
		vi.spyOn(outputGuard, "writeRawStdout").mockImplementation((line) => {
			responseResolvers.shift()?.(JSON.parse(line) as Record<string, unknown>);
		});
		vi.spyOn(jsonl, "attachJsonlLineReader").mockImplementation((_stream, onLine) => {
			handleInputLine = onLine;
			return () => {};
		});

		try {
			// runRpcMode intentionally never resolves; this minimal session exercises its real
			// JSONL command dispatcher while the test captures only its stdin/stdout boundary.
			void runRpcMode({
				sessionFile: undefined,
				messages: [],
				settingsManager: manager,
				bindExtensions: async () => {},
				sessionManager: { getCwd: () => projectDir },
				subscribe: () => () => {},
			} as unknown as AgentSession);
			await vi.waitFor(() => expect(handleInputLine).toBeDefined());

			const send = async (command: object): Promise<Record<string, unknown>> => {
				const response = new Promise<Record<string, unknown>>((resolve) => responseResolvers.push(resolve));
				handleInputLine!(JSON.stringify(command));
				return response;
			};

			expect(await send({ type: "evaluate_context_trust", id: "evaluate-existing", path: root })).toEqual({
				id: "evaluate-existing",
				type: "response",
				command: "evaluate_context_trust",
				success: true,
				data: { canonicalTarget: canonicalRoot, state: "untrusted" },
			});
			expect(await send({ type: "trust_context_folder", id: "trust-existing", path: root })).toMatchObject({
				id: "trust-existing",
				type: "response",
				command: "trust_context_folder",
				success: true,
				data: { addedRoot: canonicalRoot },
			});
			expect(await send({ type: "untrust_context_folder", id: "untrust-existing", path: root })).toMatchObject({
				id: "untrust-existing",
				type: "response",
				command: "untrust_context_folder",
				success: true,
				data: { removedRoot: canonicalRoot },
			});
			expect(await send({ type: "trust_context_folder", id: "trust-before-remove", path: root })).toMatchObject({
				success: true,
			});
			expect(
				await send({ type: "remove_trusted_context_folder", id: "remove-configured", path: canonicalRoot }),
			).toMatchObject({
				id: "remove-configured",
				type: "response",
				command: "remove_trusted_context_folder",
				success: true,
				data: { removedFolder: canonicalRoot, settings: { trustedContextFolders: [] } },
			});

			// Establish the policy whose preservation malformed JSON payloads must prove.
			expect(await send({ type: "trust_context_folder", id: "trust-before-invalid", path: root })).toMatchObject({
				success: true,
			});
			const malformedPaths: Array<[string, unknown]> = [
				["null", null],
				["array", []],
				["object", {}],
				["empty", ""],
				["relative", "relative"],
				["missing", join(dir, "missing")],
			];
			for (const command of ["evaluate_context_trust", "trust_context_folder", "untrust_context_folder"] as const) {
				for (const [label, path] of malformedPaths) {
					const id = `${command}-${label}`;
					const response = await send({ type: command, id, path });
					expect(response).toMatchObject({ id, type: "response", command, success: false });
					expect(response.error).toEqual(expect.any(String));
				}
			}
			for (const [label, path] of [
				["null", null],
				["array", []],
				["object", {}],
				["empty", ""],
				["number", 123],
			] as const) {
				const id = `remove_trusted_context_folder-${label}`;
				const response = await send({ type: "remove_trusted_context_folder", id, path });
				expect(response).toMatchObject({
					id,
					type: "response",
					command: "remove_trusted_context_folder",
					success: false,
				});
				expect(response.error).toEqual(expect.any(String));
			}
			expect(manager.getGlobalContextTrustPolicy().trustedFolders).toEqual([canonicalRoot]);
		} finally {
			for (const listener of process.stdin.listeners("end")) {
				if (!existingEndListeners.has(listener)) {
					process.stdin.off("end", listener as (...args: unknown[]) => void);
				}
			}
			for (const listener of process.stdin.listeners("error")) {
				if (!existingErrorListeners.has(listener)) {
					process.stdin.off("error", listener as (...args: unknown[]) => void);
				}
			}
		}
	});

	it("reports unrestricted state and refuses to pretend a folder can be untrusted", async () => {
		const dir = await createTempDir();
		const root = join(dir, "root");
		mkdirSync(root);
		const manager = SettingsManager.inMemory({ context: { autoLoadNested: true, trustedFolders: [root] } });

		expect(evaluateContextTrustForRpc(manager, root)).toEqual({
			ok: true,
			evaluation: { canonicalTarget: root, state: "unrestricted" },
		});
		const result = await untrustContextFolderForRpc(manager, root);
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("Cannot untrust");
	});

	it("surfaces trust persistence failures without retaining an undurable root", async () => {
		const dir = await createTempDir();
		const root = join(dir, "root");
		mkdirSync(root);
		const storage: SettingsStorage = {
			withLock(_scope, fn) {
				const next = fn(undefined);
				if (next !== undefined) throw new Error("disk full");
			},
		};
		const manager = SettingsManager.fromStorage(storage);

		const result = await trustContextFolderForRpc(manager, root);
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("Failed to persist settings: global: disk full");
		// A failed write cannot leave an in-memory root effective as if it were durable.
		expect(manager.getGlobalContextTrustPolicy().trustedFolders).toEqual([]);
		expect(evaluateContextTrustForRpc(manager, root)).toEqual({
			ok: true,
			evaluation: { canonicalTarget: root, state: "untrusted" },
		});
	});

	it("restores the persisted root after an untrust write fails", async () => {
		const dir = await createTempDir();
		const root = join(dir, "root");
		mkdirSync(root);
		const global = JSON.stringify({ context: { trustedFolders: [root] } });
		const storage: SettingsStorage = {
			withLock(scope, fn) {
				const next = fn(scope === "global" ? global : undefined);
				if (next !== undefined) throw new Error("disk full");
			},
		};
		const manager = SettingsManager.fromStorage(storage);

		const result = await untrustContextFolderForRpc(manager, root);

		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("Failed to persist settings: global: disk full");
		expect(manager.getGlobalContextTrustPolicy().trustedFolders).toEqual([root]);
		expect(evaluateContextTrustForRpc(manager, root)).toEqual({
			ok: true,
			evaluation: { canonicalTarget: root, state: "trusted-root", grantingRoot: root },
		});
	});
});

describe("listAgentTypesForRpc", () => {
	it("discovers package and project agent types sorted by name", async () => {
		const cwd = await createTempDir();
		const agentsDir = join(cwd, ".dreb", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "test-agent.md"),
			`---
name: Test Agent
description: Project-local test agent
---

You are a test agent.
`,
			"utf8",
		);

		const agentTypes = listAgentTypesForRpc(cwd);
		const names = agentTypes.map((agent) => agent.name);

		expect(agentTypes).toContainEqual({ name: "Test Agent", description: "Project-local test agent" });
		expect(agentTypes).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Explore" })]));
		expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
	});
});

describe("RpcClient settings methods", () => {
	const snapshot: RpcSettingsSnapshot = {
		defaultProvider: "anthropic",
		defaultModel: "claude-sonnet-4-5",
		defaultThinkingLevel: "high",
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		compactionEnabled: true,
		continueAfterAutoCompaction: false,
		retryEnabled: true,
		maxConcurrentSubagents: 4,
		imageAutoResize: true,
		blockImages: false,
		enableSkillCommands: true,
		autoLoadNestedContext: false,
		trustedContextFolders: [],
		effectiveTrustedContextRoots: [],
		transport: "sse",
		hideThinkingBlock: false,
		agentModels: {},
		resolvedScopedModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
		scopeWarnings: [],
		hasProjectEnabledModelsOverride: false,
		enabledModelsSource: "global",
		enabledModels: ["anthropic/claude-sonnet-4-5"],
	};

	it("getSettings sends the get_settings command and unwraps the snapshot", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "get_settings",
			success: true,
			data: snapshot,
		});

		await expect(client.getSettings()).resolves.toEqual(snapshot);
		expect(client.send).toHaveBeenCalledWith({ type: "get_settings" });
	});

	it("setSettings sends the set_settings command and unwraps the post-write snapshot", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "set_settings",
			success: true,
			data: { ...snapshot, retryEnabled: false },
		});

		await expect(client.setSettings({ retryEnabled: false })).resolves.toEqual({
			...snapshot,
			retryEnabled: false,
		});
		expect(client.send).toHaveBeenCalledWith({ type: "set_settings", settings: { retryEnabled: false } });
	});

	it("setSettings passes through warnings from the server", async () => {
		const client = new RpcClient() as any;
		const warnings = [
			'A project-level agentModels override for "Explore" (.dreb/settings.json) takes precedence — this change to global settings will have no effect. Edit the project settings file to change it.',
		];
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "set_settings",
			success: true,
			data: { ...snapshot, warnings },
		});

		await expect(client.setSettings({ agentModels: { Explore: ["global/model"] } })).resolves.toEqual({
			...snapshot,
			warnings,
		});
	});

	it("context trust methods send typed commands and unwrap results", async () => {
		const client = new RpcClient() as any;
		const evaluation = {
			canonicalTarget: "/tmp/trusted",
			state: "trusted-root" as const,
			grantingRoot: "/tmp/trusted",
		};
		const mutation = { evaluation, settings: snapshot, addedRoot: "/tmp/trusted" };
		const removal = { settings: snapshot, removedFolder: "/tmp/trusted" };
		client.send = vi
			.fn()
			.mockResolvedValueOnce({
				type: "response",
				command: "evaluate_context_trust",
				success: true,
				data: evaluation,
			})
			.mockResolvedValueOnce({ type: "response", command: "trust_context_folder", success: true, data: mutation })
			.mockResolvedValueOnce({ type: "response", command: "untrust_context_folder", success: true, data: mutation })
			.mockResolvedValueOnce({
				type: "response",
				command: "remove_trusted_context_folder",
				success: true,
				data: removal,
			});

		await expect(client.evaluateContextTrust("/tmp/trusted")).resolves.toEqual(evaluation);
		await expect(client.trustContextFolder("/tmp/trusted")).resolves.toEqual(mutation);
		await expect(client.untrustContextFolder("/tmp/trusted")).resolves.toEqual(mutation);
		await expect(client.removeTrustedContextFolder("/tmp/trusted")).resolves.toEqual(removal);
		expect(client.send).toHaveBeenNthCalledWith(1, { type: "evaluate_context_trust", path: "/tmp/trusted" });
		expect(client.send).toHaveBeenNthCalledWith(2, { type: "trust_context_folder", path: "/tmp/trusted" });
		expect(client.send).toHaveBeenNthCalledWith(3, { type: "untrust_context_folder", path: "/tmp/trusted" });
		expect(client.send).toHaveBeenNthCalledWith(4, {
			type: "remove_trusted_context_folder",
			path: "/tmp/trusted",
		});
	});

	it("setSettings rejects with the RPC error message on failure", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "set_settings",
			success: false,
			error: "Unknown settings key(s): bogus",
		});

		await expect(client.setSettings({ bogus: true } as never)).rejects.toThrow("Unknown settings key(s): bogus");
	});

	it("listAgentTypes sends the list_agent_types command and unwraps agent types", async () => {
		const client = new RpcClient() as any;
		const agentTypes = [
			{ name: "Explore", description: "Explore the codebase" },
			{ name: "Test Agent", description: "Project-local test agent" },
		];
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "list_agent_types",
			success: true,
			data: { agentTypes },
		});

		await expect(client.listAgentTypes()).resolves.toEqual(agentTypes);
		expect(client.send).toHaveBeenCalledWith({ type: "list_agent_types" });
	});
});
