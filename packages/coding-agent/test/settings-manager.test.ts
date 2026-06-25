import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("SettingsManager", () => {
	const testDir = join(process.cwd(), "test-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		// Clean up and create fresh directories
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".dreb"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Create initial settings file
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					defaultModel: "claude-sonnet",
				}),
			);

			// Create SettingsManager (simulates dreb starting up)
			const manager = SettingsManager.create(projectDir, agentDir);

			// Simulate user editing settings.json externally to add enabledModels
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.enabledModels = ["claude-opus-4-5", "gpt-5.2-codex"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes thinking level via Shift+Tab
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// Verify enabledModels is preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe("high");
			expect(savedSettings.theme).toBe("dark");
			expect(savedSettings.defaultModel).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing theme", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					defaultModel: "claude-sonnet",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User adds custom settings externally
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.shellPath = "/bin/zsh";
			currentSettings.extensions = ["/path/to/extension.ts"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes theme
			manager.setTheme("light");
			await manager.flush();

			// Verify all settings preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toBe("light");
		});

		it("should let in-memory changes override file changes for same key", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User externally sets thinking level to "low"
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.defaultThinkingLevel = "low";
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// But then changes it via UI to "high"
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// In-memory change should win
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.defaultThinkingLevel).toBe("high");
		});
	});

	describe("packages migration", () => {
		it("should keep local-only extensions in extensions array", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					extensions: ["/local/ext.ts", "./relative/ext.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getPackages()).toEqual([]);
			expect(manager.getExtensionPaths()).toEqual(["/local/ext.ts", "./relative/ext.ts"]);
		});

		it("should handle packages with filtering objects", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					packages: [
						"npm:simple-pkg",
						{
							source: "npm:shitty-extensions",
							extensions: ["extensions/oracle.ts"],
							skills: [],
						},
					],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const packages = manager.getPackages();
			expect(packages).toHaveLength(2);
			expect(packages[0]).toBe("npm:simple-pkg");
			expect(packages[1]).toEqual({
				source: "npm:shitty-extensions",
				extensions: ["extensions/oracle.ts"],
				skills: [],
			});
		});
	});

	describe("reload", () => {
		it("should reload global settings from disk", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					extensions: ["/before.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "light",
					extensions: ["/after.ts"],
					defaultModel: "claude-sonnet",
				}),
			);

			manager.reload();

			expect(manager.getTheme()).toBe("light");
			expect(manager.getExtensionPaths()).toEqual(["/after.ts"]);
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
		});

		it("should keep previous settings when file is invalid", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(settingsPath, "{ invalid json");
			manager.reload();

			expect(manager.getTheme()).toBe("dark");
		});
	});

	describe("error tracking", () => {
		it("should collect and clear load errors via drainErrors", () => {
			const globalSettingsPath = join(agentDir, "settings.json");
			const projectSettingsPath = join(projectDir, ".dreb", "settings.json");
			writeFileSync(globalSettingsPath, "{ invalid global json");
			writeFileSync(projectSettingsPath, "{ invalid project json");

			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();

			expect(errors).toHaveLength(2);
			expect(errors.map((e) => e.scope).sort()).toEqual(["global", "project"]);
			expect(manager.drainErrors()).toEqual([]);
		});
	});

	describe("project settings directory creation", () => {
		it("should not create .dreb folder when only reading project settings", () => {
			// Create agent dir with global settings, but NO .dreb folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .dreb folder that beforeEach created
			rmSync(join(projectDir, ".dreb"), { recursive: true });

			// Create SettingsManager (reads both global and project settings)
			const manager = SettingsManager.create(projectDir, agentDir);

			// .dreb folder should NOT have been created just from reading
			expect(existsSync(join(projectDir, ".dreb"))).toBe(false);

			// Settings should still be loaded from global
			expect(manager.getTheme()).toBe("dark");
		});

		it("should create .dreb folder when writing project settings", async () => {
			// Create agent dir with global settings, but NO .dreb folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .dreb folder that beforeEach created
			rmSync(join(projectDir, ".dreb"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);

			// .dreb folder should NOT exist yet
			expect(existsSync(join(projectDir, ".dreb"))).toBe(false);

			// Write a project-specific setting
			manager.setProjectPackages([{ source: "npm:test-pkg" }]);
			await manager.flush();

			// Now .dreb folder should exist
			expect(existsSync(join(projectDir, ".dreb"))).toBe(true);

			// And settings file should be created
			expect(existsSync(join(projectDir, ".dreb", "settings.json"))).toBe(true);
		});
	});

	describe("autoLoadNestedContext", () => {
		it("defaults to true when unset", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getAutoLoadNestedContext()).toBe(true);
		});

		it("loads false from settings", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ context: { autoLoadNested: false } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getAutoLoadNestedContext()).toBe(false);
		});

		it("persists the setting and preserves unrelated settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.setAutoLoadNestedContext(false);
			await manager.flush();

			const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(saved.context.autoLoadNested).toBe(false);
			expect(saved.theme).toBe("dark");

			const reloaded = SettingsManager.create(projectDir, agentDir);
			expect(reloaded.getAutoLoadNestedContext()).toBe(false);
		});
	});

	describe("shellCommandPrefix", () => {
		it("should load shellCommandPrefix from settings", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBe("shopt -s expand_aliases");
		});

		it("should return undefined when shellCommandPrefix is not set", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBeUndefined();
		});

		it("should preserve shellCommandPrefix when saving unrelated settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setTheme("light");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellCommandPrefix).toBe("shopt -s expand_aliases");
			expect(savedSettings.theme).toBe("light");
		});
	});

	describe("getSessionDir", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBeUndefined();
		});

		it("should return global sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/tmp/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("/tmp/sessions");
		});

		it("should return project sessionDir, overriding global", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/global/sessions" }));
			writeFileSync(join(projectDir, ".dreb", "settings.json"), JSON.stringify({ sessionDir: "./sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("./sessions");
		});
	});

	describe("agentModels", () => {
		it("should roundtrip set then getAgentModelsForAgent", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setAgentModelsForAgent("Explore", ["model-a", "model-b"]);
			expect(manager.getAgentModelsForAgent("Explore")).toEqual(["model-a", "model-b"]);
		});

		it("should return undefined after set then remove", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setAgentModelsForAgent("Explore", ["model-a"]);
			manager.removeAgentModelsForAgent("Explore");
			expect(manager.getAgentModelsForAgent("Explore")).toBeUndefined();
		});

		it("should be a safe no-op when removing a non-existent key (no write)", async () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);

			// Removing a key that was never set should not throw and should not write
			expect(() => manager.removeAgentModelsForAgent("Nonexistent")).not.toThrow();
			await manager.flush();

			// The settings file should be unchanged (no agentModels key written)
			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.agentModels).toBeUndefined();
			expect(savedSettings.theme).toBe("dark");
		});

		it("should return a deep copy from getAgentModels (mutation does not leak)", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setAgentModelsForAgent("Explore", ["model-a"]);

			const first = manager.getAgentModels();
			first.Explore.push("mutated");

			const second = manager.getAgentModels();
			expect(second.Explore).toEqual(["model-a"]);
		});

		it("should treat empty array as no override (returns undefined)", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setAgentModelsForAgent("Explore", []);
			expect(manager.getAgentModelsForAgent("Explore")).toBeUndefined();
		});

		it("should merge global and project agentModels at the per-agent level (finding 1)", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ agentModels: { models: { Sandbox: ["global-model"] } } }),
			);
			writeFileSync(
				join(projectDir, ".dreb", "settings.json"),
				JSON.stringify({ agentModels: { models: { Explore: ["project-model"] } } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			const merged = manager.getAgentModels();

			// Both agents must be present — neither should clobber the other
			expect(merged.Sandbox).toEqual(["global-model"]);
			expect(merged.Explore).toEqual(["project-model"]);
			expect(manager.getAgentModelsForAgent("Sandbox")).toEqual(["global-model"]);
			expect(manager.getAgentModelsForAgent("Explore")).toEqual(["project-model"]);
		});

		it("should let project override global for the same agent key", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ agentModels: { models: { Explore: ["global-model"] } } }),
			);
			writeFileSync(
				join(projectDir, ".dreb", "settings.json"),
				JSON.stringify({ agentModels: { models: { Explore: ["project-model"] } } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getAgentModelsForAgent("Explore")).toEqual(["project-model"]);
		});

		it("should persist agentModels.models structure after set + flush", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setAgentModelsForAgent("Explore", ["model-a", "model-b"]);
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.agentModels).toEqual({ models: { Explore: ["model-a", "model-b"] } });
		});

		describe("hasProjectAgentModelOverride", () => {
			it("returns true when a project-level entry exists for the agent", () => {
				writeFileSync(
					join(projectDir, ".dreb", "settings.json"),
					JSON.stringify({ agentModels: { models: { Explore: ["project-model"] } } }),
				);
				const manager = SettingsManager.create(projectDir, agentDir);
				expect(manager.hasProjectAgentModelOverride("Explore")).toBe(true);
			});

			it("returns false when only a global entry exists for the agent", () => {
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ agentModels: { models: { Explore: ["global-model"] } } }),
				);
				const manager = SettingsManager.create(projectDir, agentDir);
				expect(manager.hasProjectAgentModelOverride("Explore")).toBe(false);
			});

			it("returns false when no agentModels are configured at all", () => {
				const manager = SettingsManager.create(projectDir, agentDir);
				expect(manager.hasProjectAgentModelOverride("Explore")).toBe(false);
			});

			it("returns false for an agent absent from a populated project entry", () => {
				writeFileSync(
					join(projectDir, ".dreb", "settings.json"),
					JSON.stringify({ agentModels: { models: { Explore: ["project-model"] } } }),
				);
				const manager = SettingsManager.create(projectDir, agentDir);
				expect(manager.hasProjectAgentModelOverride("Sandbox")).toBe(false);
			});
		});
	});

	describe("modelSettings (per-model thinking display)", () => {
		it("should roundtrip set then getModelThinkingDisplay", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setModelThinkingDisplay("claude-opus-4-8", "omitted");
			expect(manager.getModelThinkingDisplay("claude-opus-4-8")).toBe("omitted");
		});

		it("should return undefined for a model with no stored setting", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getModelThinkingDisplay("claude-opus-4-8")).toBeUndefined();
			expect(manager.getModelSettings("claude-opus-4-8")).toBeUndefined();
		});

		it("should delete the setting when set to undefined", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setModelThinkingDisplay("claude-opus-4-8", "omitted");
			manager.setModelThinkingDisplay("claude-opus-4-8", undefined);
			expect(manager.getModelThinkingDisplay("claude-opus-4-8")).toBeUndefined();
		});

		it("should be a safe no-op when deleting a non-existent setting (no write)", async () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(() => manager.setModelThinkingDisplay("claude-opus-4-8", undefined)).not.toThrow();
			await manager.flush();

			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(saved.modelSettings).toBeUndefined();
			expect(saved.theme).toBe("dark");
		});

		it("should let project override global per model id", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ modelSettings: { "claude-opus-4-8": { thinkingDisplay: "summarized" } } }),
			);
			writeFileSync(
				join(projectDir, ".dreb", "settings.json"),
				JSON.stringify({ modelSettings: { "claude-opus-4-8": { thinkingDisplay: "omitted" } } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getModelThinkingDisplay("claude-opus-4-8")).toBe("omitted");
		});

		it("should merge global and project at the per-model level (no clobber)", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ modelSettings: { "claude-opus-4-8": { thinkingDisplay: "summarized" } } }),
			);
			writeFileSync(
				join(projectDir, ".dreb", "settings.json"),
				JSON.stringify({ modelSettings: { "claude-sonnet-4-6": { thinkingDisplay: "omitted" } } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getModelThinkingDisplay("claude-opus-4-8")).toBe("summarized");
			expect(manager.getModelThinkingDisplay("claude-sonnet-4-6")).toBe("omitted");
		});

		it("should persist only the touched model key (two-level markModified)", async () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ modelSettings: { "claude-sonnet-4-6": { thinkingDisplay: "summarized" } } }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setModelThinkingDisplay("claude-opus-4-8", "omitted");
			await manager.flush();

			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			// The untouched model key must survive, and the new key must be added.
			expect(saved.modelSettings["claude-sonnet-4-6"]).toEqual({ thinkingDisplay: "summarized" });
			expect(saved.modelSettings["claude-opus-4-8"]).toEqual({ thinkingDisplay: "omitted" });
		});

		it("should write thinking display to global scope", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setModelThinkingDisplay("claude-opus-4-8", "omitted");
			await manager.flush();

			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(saved.modelSettings).toEqual({ "claude-opus-4-8": { thinkingDisplay: "omitted" } });
		});
	});

	describe("background-agent guardrail settings", () => {
		it("defaults to enabled with a turn limit of 3", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getBackgroundAgentGuardrailEnabled()).toBe(true);
			expect(manager.getBackgroundAgentGuardrailSettings()).toEqual({ enabled: true, turnLimit: 3 });
		});

		it("reads parentTurnGuardrail and parentTurnLimit from settings.json", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ backgroundAgents: { parentTurnGuardrail: false, parentTurnLimit: 7 } }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getBackgroundAgentGuardrailSettings()).toEqual({ enabled: false, turnLimit: 7 });
		});

		it("falls back to the default limit for invalid parentTurnLimit values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ backgroundAgents: { parentTurnLimit: 0 } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getBackgroundAgentGuardrailSettings().turnLimit).toBe(3);
		});

		it("persists the guardrail toggle to global scope", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setBackgroundAgentGuardrailEnabled(false);
			await manager.flush();

			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(saved.backgroundAgents).toEqual({ parentTurnGuardrail: false });
			expect(manager.getBackgroundAgentGuardrailEnabled()).toBe(false);
		});
	});
});
