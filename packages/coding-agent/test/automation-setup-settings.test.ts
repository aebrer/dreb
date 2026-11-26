import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfiguredDirectory } from "../src/config.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { getFreshSettingsForRpc, getSettingsForRpc, setSettingsForRpc } from "../src/modes/rpc/rpc-mode.js";
import type { RpcSettingsUpdate } from "../src/modes/rpc/rpc-types.js";

const registry = { getAvailable: () => [] };

describe("Dashboard automation setup settings", () => {
	let root: string;
	let startupCwd: string;
	let runtimeCwd: string;
	let agentDir: string;
	let globalFile: string;
	let projectFile: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "dreb-automation-setup-settings-"));
		startupCwd = join(root, "dashboard");
		runtimeCwd = join(root, "runtime");
		agentDir = join(root, "agent");
		globalFile = join(agentDir, "settings.json");
		projectFile = join(runtimeCwd, ".dreb", "settings.json");
		await mkdir(startupCwd);
		await mkdir(agentDir);
		await mkdir(join(runtimeCwd, ".dreb"), { recursive: true });
		await writeFile(projectFile, JSON.stringify({ automationSetupDir: "./project-override" }));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it.each([null, "   "])("persists globally and restores the home default with %j", async (clear) => {
		await writeFile(globalFile, JSON.stringify({ automationSetupDir: "~/previous", retry: { enabled: true } }));
		const dashboard = SettingsManager.create(startupCwd, agentDir);
		const runtime = SettingsManager.create(runtimeCwd, agentDir);
		expect(getSettingsForRpc(runtime).automationSetupDir).toBe("~/previous");

		// A separate process changes an unrelated setting between load and save.
		await writeFile(globalFile, JSON.stringify({ automationSetupDir: "~/previous", retry: { enabled: false } }));
		await expect(
			setSettingsForRpc(runtime, registry, { automationSetupDir: "  ./new setups  " }),
		).resolves.toMatchObject({
			ok: true,
			settings: { automationSetupDir: "./new setups" },
		});
		expect(JSON.parse(await readFile(globalFile, "utf8"))).toEqual({
			automationSetupDir: "./new setups",
			retry: { enabled: false },
		});
		dashboard.reload();
		expect(resolveConfiguredDirectory(dashboard.getGlobalAutomationSetupDir(), startupCwd)).toBe(
			join(startupCwd, "new setups"),
		);

		await expect(setSettingsForRpc(runtime, registry, { automationSetupDir: clear })).resolves.toMatchObject({
			ok: true,
			settings: { automationSetupDir: undefined },
		});
		expect(JSON.parse(await readFile(globalFile, "utf8"))).toEqual({ retry: { enabled: false } });
		expect(JSON.parse(await readFile(projectFile, "utf8"))).toEqual({ automationSetupDir: "./project-override" });
		await expect(getFreshSettingsForRpc(runtime)).resolves.toMatchObject({
			ok: true,
			settings: { automationSetupDir: undefined },
		});
		dashboard.reload();
		expect(resolveConfiguredDirectory(dashboard.getGlobalAutomationSetupDir(), startupCwd)).toBeUndefined();
	});

	it("rejects a non-string update before applying any changes", async () => {
		const manager = SettingsManager.inMemory({ automationSetupDir: "~/setup" });
		const update = { automationSetupDir: 123, retryEnabled: false } as unknown as RpcSettingsUpdate;
		await expect(setSettingsForRpc(manager, registry, update)).resolves.toEqual({
			ok: false,
			error: "Invalid automationSetupDir: must be a string or null",
		});
		expect(getSettingsForRpc(manager)).toMatchObject({ automationSetupDir: "~/setup", retryEnabled: true });
	});

	it("surfaces a durable write failure through the settings RPC", async () => {
		const runtime = SettingsManager.create(runtimeCwd, agentDir);
		await writeFile(globalFile, "{invalid JSON");
		await expect(setSettingsForRpc(runtime, registry, { automationSetupDir: "~/setup" })).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("Failed to persist settings: global:"),
		});
		expect(await readFile(globalFile, "utf8")).toBe("{invalid JSON");
	});
});
