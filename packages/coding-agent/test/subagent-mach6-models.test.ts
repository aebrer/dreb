import { describe, expect, test } from "vitest";

/**
 * Tests for the mach6 settings-based model overrides for subagents (#219).
 *
 * These test the model resolution precedence:
 * 1. Per-invocation modelOverride (highest priority)
 * 2. agentModels from settings
 * 3. Agent definition model (lowest priority)
 */

function resolveModelSpec(
	modelOverride: string | undefined,
	agentModels: string[] | undefined,
	configModel: string | string[] | undefined,
): string | string[] | undefined {
	return modelOverride || (agentModels && agentModels.length > 0 ? agentModels : undefined) || configModel;
}

describe("subagent mach6 model settings", () => {
	describe("model resolution precedence", () => {
		const agentModel = "anthropic/claude-sonnet";
		const agentModels = ["openai/gpt-4o", "anthropic/claude-haiku"];

		test("agentModels takes precedence over agent definition model", () => {
			const result = resolveModelSpec(undefined, agentModels, agentModel);
			expect(result).toEqual(agentModels);
		});

		test("per-invocation modelOverride wins over agentModels", () => {
			const result = resolveModelSpec("anthropic/claude-opus", agentModels, agentModel);
			expect(result).toBe("anthropic/claude-opus");
		});

		test("undefined agentModels falls through to agent definition", () => {
			const result = resolveModelSpec(undefined, undefined, agentModel);
			expect(result).toBe(agentModel);
		});

		test("empty agentModels array falls through to agent definition", () => {
			const result = resolveModelSpec(undefined, [], agentModel);
			expect(result).toBe(agentModel);
		});

		test("agentModels used when agent has no model defined", () => {
			const result = resolveModelSpec(undefined, agentModels, undefined);
			expect(result).toEqual(agentModels);
		});

		test("no model when nothing is specified", () => {
			const result = resolveModelSpec(undefined, undefined, undefined);
			expect(result).toBeUndefined();
		});

		test("modelOverride used even when agent has no model and no agentModels", () => {
			const result = resolveModelSpec("anthropic/claude-opus", undefined, undefined);
			expect(result).toBe("anthropic/claude-opus");
		});

		test("agentModels preserves fallback list ordering", () => {
			const ordered = ["first/model", "second/model", "third/model"];
			const result = resolveModelSpec(undefined, ordered, agentModel);
			expect(result).toEqual(ordered);
		});
	});

	describe("settings manager integration", () => {
		// Test the getAgentModelsForAgent logic
		function getAgentModelsForAgent(
			settings: { agentModels?: { models?: Record<string, string[]> } },
			agentName: string,
		): string[] | undefined {
			const models = settings.agentModels?.models?.[agentName];
			return models && models.length > 0 ? [...models] : undefined;
		}

		test("returns undefined when no mach6 settings exist", () => {
			expect(getAgentModelsForAgent({}, "Explore")).toBeUndefined();
		});

		test("returns undefined when mach6.models is empty", () => {
			expect(getAgentModelsForAgent({ agentModels: { models: {} } }, "Explore")).toBeUndefined();
		});

		test("returns undefined for unknown agent name", () => {
			const settings = { agentModels: { models: { Explore: ["model/a"] } } };
			expect(getAgentModelsForAgent(settings, "Unknown")).toBeUndefined();
		});

		test("returns models for configured agent", () => {
			const settings = { agentModels: { models: { Explore: ["model/a", "model/b"] } } };
			expect(getAgentModelsForAgent(settings, "Explore")).toEqual(["model/a", "model/b"]);
		});

		test("returns undefined for agent with empty model array", () => {
			const settings = { agentModels: { models: { Explore: [] } } };
			expect(getAgentModelsForAgent(settings, "Explore")).toBeUndefined();
		});

		test("returns a copy (not a reference)", () => {
			const settings = { agentModels: { models: { Explore: ["model/a"] } } };
			const result = getAgentModelsForAgent(settings, "Explore");
			result!.push("model/b");
			expect(settings.agentModels.models.Explore).toEqual(["model/a"]);
		});
	});
});
