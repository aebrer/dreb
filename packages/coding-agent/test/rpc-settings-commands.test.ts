import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@dreb/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { getSettingsForRpc, setSettingsForRpc } from "../src/modes/rpc/rpc-mode.js";
import type { RpcSettingsSnapshot } from "../src/modes/rpc/rpc-types.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-rpc-settings-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function stubRegistry(models: Array<{ provider: string; id: string }>) {
	return {
		getAvailable: () => models as Model<any>[],
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
			retryEnabled: true,
		});
	});

	it("reflects values from the settings store", () => {
		const manager = SettingsManager.inMemory({
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "high",
			steeringMode: "all",
			followUpMode: "all",
			compaction: { enabled: false },
			retry: { enabled: false },
		});

		expect(getSettingsForRpc(manager)).toEqual({
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "high",
			steeringMode: "all",
			followUpMode: "all",
			compactionEnabled: false,
			retryEnabled: false,
		});
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

	it.each(["compactionEnabled", "retryEnabled"] as const)("rejects a non-boolean %s", async (key) => {
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([]), { [key]: "yes" } as never);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain(`Invalid ${key}`);
		expect(result.error).toContain("Must be a boolean");
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

	it("applies nothing when any field is invalid (atomicity)", async () => {
		const manager = SettingsManager.inMemory({ retry: { enabled: true } });
		const result = await setSettingsForRpc(manager, stubRegistry([]), {
			retryEnabled: false, // valid
			steeringMode: "bogus" as never, // invalid
		});

		expect(result.ok).toBe(false);
		// The valid field must NOT have been applied.
		expect(manager.getRetryEnabled()).toBe(true);
	});
});

describe("setSettingsForRpc writes", () => {
	it("applies every supported field and returns the post-write snapshot", async () => {
		const manager = SettingsManager.inMemory();
		const result = await setSettingsForRpc(manager, stubRegistry([anthropicSonnet]), {
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "low",
			steeringMode: "all",
			followUpMode: "all",
			compactionEnabled: false,
			retryEnabled: false,
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
			retryEnabled: false,
		});
		// Reflected in subsequent reads.
		expect(getSettingsForRpc(manager)).toEqual(result.settings);
	});

	it("persists to disk and is visible to a fresh SettingsManager (fresh-runtime simulation)", async () => {
		const dir = await createTempDir();
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

		const manager = SettingsManager.create(projectDir, agentDir);
		const result = await setSettingsForRpc(manager, stubRegistry([anthropicSonnet]), {
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "medium",
			retryEnabled: false,
		});
		expect(result.ok).toBe(true);

		// The handler flushes, so the file must exist with the written values.
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(raw.defaultProvider).toBe("anthropic");
		expect(raw.defaultModel).toBe("claude-sonnet-4-5");
		expect(raw.defaultThinkingLevel).toBe("medium");
		expect(raw.retry.enabled).toBe(false);

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
		vi.spyOn(manager, "flush").mockResolvedValue(undefined);
		vi.spyOn(manager, "drainErrors").mockReturnValue([{ scope: "global", error: new Error("disk full") }]);

		const result = await setSettingsForRpc(manager, stubRegistry([]), { retryEnabled: false });

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("Failed to persist settings");
		expect(result.error).toContain("disk full");
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
		retryEnabled: true,
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
});
