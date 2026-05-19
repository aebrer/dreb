import type { ThinkingLevel as AgentThinkingLevel } from "@dreb/agent-core";
import type { ThinkingLevel as AiThinkingLevel, Model } from "@dreb/ai";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";

/**
 * Resolve the effective thinking level for a model using the same capability
 * clamp as normal coding-agent sessions.
 */
export function resolveEffectiveThinkingLevel(
	model: Model<any> | undefined,
	thinkingLevel: AgentThinkingLevel | undefined,
	defaultThinkingLevel: AgentThinkingLevel = DEFAULT_THINKING_LEVEL,
): AgentThinkingLevel {
	const effectiveThinkingLevel = thinkingLevel ?? defaultThinkingLevel;
	return model?.reasoning ? effectiveThinkingLevel : "off";
}

/** Convert an effective thinking level into the reasoning option passed to streamSimple. */
export function thinkingLevelToReasoning(thinkingLevel: AgentThinkingLevel): AiThinkingLevel | undefined {
	return thinkingLevel === "off" ? undefined : (thinkingLevel as AiThinkingLevel);
}
