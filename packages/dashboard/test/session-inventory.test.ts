import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@dreb/coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardSessionLister, resolveDashboardSessionInventoryRoot } from "../src/index.js";

const tempDirs: string[] = [];

function createFixture(): { root: string; agentDir: string; projectDir: string } {
	const root = mkdtempSync(join(tmpdir(), "dreb-dashboard-inventory-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".dreb"), { recursive: true });
	return { root, agentDir, projectDir };
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Dashboard main-session inventory selection", () => {
	it("uses only the global sessionDir even when project settings override the merged value", () => {
		const { agentDir, projectDir } = createFixture();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "./global-sessions" }));
		writeFileSync(join(projectDir, ".dreb", "settings.json"), JSON.stringify({ sessionDir: "./project-sessions" }));
		const settingsManager = SettingsManager.create(projectDir, agentDir);

		expect(settingsManager.getSessionDir()).toBe("./project-sessions");
		expect(resolveDashboardSessionInventoryRoot(settingsManager, projectDir)).toBe(
			join(projectDir, "global-sessions"),
		);
	});

	it("routes a custom startup snapshot through flat listing and defaults through nested listAll", async () => {
		const customSessions = [{ path: "/custom/one.jsonl" }];
		const defaultSessions = [{ path: "/default/project/one.jsonl" }];
		const inventory = {
			listAll: vi.fn(async () => defaultSessions),
			listAllFromDir: vi.fn(async () => customSessions),
		};

		const customLister = createDashboardSessionLister("/custom", inventory);
		await expect(customLister()).resolves.toEqual(customSessions);
		expect(inventory.listAllFromDir).toHaveBeenCalledWith("/custom");
		expect(inventory.listAll).not.toHaveBeenCalled();

		inventory.listAll.mockClear();
		inventory.listAllFromDir.mockClear();
		const defaultLister = createDashboardSessionLister(undefined, inventory);
		await expect(defaultLister()).resolves.toEqual(defaultSessions);
		expect(inventory.listAll).toHaveBeenCalledOnce();
		expect(inventory.listAllFromDir).not.toHaveBeenCalled();
	});
});
