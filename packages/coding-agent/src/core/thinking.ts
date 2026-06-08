import type { ThinkingLevel as AgentThinkingLevel } from "@dreb/agent-core";
import { type ThinkingLevel as AiThinkingLevel, type Model, supportsAdaptiveThinking } from "@dreb/ai";
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

/**
 * Resolve the thinkingDisplay option for a session/subagent.
 * Default-on policy: adaptive-thinking models (Opus 4.7+ default to "omitted" at the
 * API) get "summarized" so thinking is visible, unless the user stored an override for
 * this model id. Non-adaptive models return undefined (the AI layer ignores the field
 * for them anyway). Keyed by model id, so the main session and any subagent using the
 * same model resolve identically from shared settings.
 */
export function resolveThinkingDisplay(
	model: Model<any> | undefined,
	storedOverride: "summarized" | "omitted" | undefined,
): "summarized" | "omitted" | undefined {
	if (!model || !supportsAdaptiveThinking(model)) return undefined;
	return storedOverride ?? "summarized";
}
