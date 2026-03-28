import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "vitest";

/**
 * Tests for the subagent per-invocation model parameter (#23).
 *
 * These test the schema validation and config override logic without spawning
 * real subagent processes.
 */

// Replicate the schemas from subagent.ts to test validation
const taskItemSchema = Type.Object({
	agent: Type.Optional(Type.String()),
	task: Type.String(),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
});

const subagentSchema = Type.Object({
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String({ minLength: 1 })),
	model: Type.Optional(Type.String()),
	tasks: Type.Optional(Type.Array(taskItemSchema, { minItems: 1, maxItems: 8 })),
	chain: Type.Optional(Type.Array(taskItemSchema, { minItems: 1 })),
	background: Type.Optional(Type.Boolean()),
});

// Replicate the config override logic from executeSingle
interface AgentTypeConfig {
	name: string;
	description: string;
	tools?: string;
	model?: string;
	systemPrompt: string;
}

function applyModelOverride(config: AgentTypeConfig, modelOverride?: string): AgentTypeConfig {
	return modelOverride ? { ...config, model: modelOverride } : config;
}

describe("subagent model parameter", () => {
	describe("schema validation", () => {
		test("accepts model in single mode", () => {
			const input = { task: "do something", model: "haiku" };
			expect(Value.Check(subagentSchema, input)).toBe(true);
		});

		test("accepts model in single mode with agent", () => {
			const input = { task: "do something", agent: "Explore", model: "opus" };
			expect(Value.Check(subagentSchema, input)).toBe(true);
		});

		test("accepts model omitted (backward compat)", () => {
			const input = { task: "do something" };
			expect(Value.Check(subagentSchema, input)).toBe(true);
		});

		test("accepts model in parallel task items", () => {
			const input = {
				tasks: [
					{ task: "cheap task", model: "haiku" },
					{ task: "expensive task", model: "opus" },
				],
			};
			expect(Value.Check(subagentSchema, input)).toBe(true);
		});

		test("accepts model in chain steps", () => {
			const input = {
				chain: [
					{ task: "research", model: "haiku" },
					{ task: "synthesize {previous}", model: "opus" },
				],
			};
			expect(Value.Check(subagentSchema, input)).toBe(true);
		});

		test("accepts mixed model/no-model in parallel tasks", () => {
			const input = {
				tasks: [{ task: "with model", model: "haiku" }, { task: "without model" }],
			};
			expect(Value.Check(subagentSchema, input)).toBe(true);
		});
	});

	describe("model override precedence", () => {
		const baseConfig: AgentTypeConfig = {
			name: "TestAgent",
			description: "test",
			model: "sonnet",
			systemPrompt: "you are a test agent",
		};

		const configWithoutModel: AgentTypeConfig = {
			name: "TestAgent",
			description: "test",
			systemPrompt: "you are a test agent",
		};

		test("per-invocation model overrides agent definition model", () => {
			const effective = applyModelOverride(baseConfig, "haiku");
			expect(effective.model).toBe("haiku");
		});

		test("agent definition model preserved when no override", () => {
			const effective = applyModelOverride(baseConfig, undefined);
			expect(effective.model).toBe("sonnet");
		});

		test("per-invocation model applied when agent has no model", () => {
			const effective = applyModelOverride(configWithoutModel, "opus");
			expect(effective.model).toBe("opus");
		});

		test("no model when neither agent nor override specifies one", () => {
			const effective = applyModelOverride(configWithoutModel, undefined);
			expect(effective.model).toBeUndefined();
		});

		test("override does not mutate original config", () => {
			const effective = applyModelOverride(baseConfig, "haiku");
			expect(effective.model).toBe("haiku");
			expect(baseConfig.model).toBe("sonnet");
		});
	});
});
