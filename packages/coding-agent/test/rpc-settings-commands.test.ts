import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
