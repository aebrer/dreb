import type { ThinkingLevel as AgentThinkingLevel } from "@dreb/agent-core";
import {
	type ThinkingLevel as AiThinkingLevel,
	type Model,
	supportsAdaptiveThinking,
	supportsMax,
	supportsXhigh,
} from "@dreb/ai";
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
	if (!model?.reasoning) return "off";
	if (effectiveThinkingLevel === "max" && !supportsMax(model)) return supportsXhigh(model) ? "xhigh" : "high";
	return effectiveThinkingLevel === "xhigh" && !supportsXhigh(model) ? "high" : effectiveThinkingLevel;
}

/** Convert an effective thinking level into the reasoning option passed to streamSimple. */
export function thinkingLevelToReasoning(thinkingLevel: AgentThinkingLevel): AiThinkingLevel | undefined {
	return thinkingLevel === "off" ? undefined : (thinkingLevel as AiThinkingLevel);
}

export type ThinkingLevelValidation = { ok: true } | { ok: false; error: string };

/**
 * Validate an explicit thinking override against a resolved model.
 *
 * Normal session defaults are still capability-clamped for backward compatibility.
 * Explicit subagent/arbiter choices use this stricter path so an unsupported request
 * fails before spawn instead of silently changing levels in the child.
 */
export function validateThinkingLevelForModel(
	model: Model<any> | undefined,
	thinkingLevel: AgentThinkingLevel,
): ThinkingLevelValidation {
	if (thinkingLevel === "off") return { ok: true };
	if (!model) {
		return {
			ok: false,
			error: `Cannot validate thinking level "${thinkingLevel}" because no concrete child model was resolved.`,
		};
	}
	const modelRef = `${model.provider}/${model.id}`;
	if (!model.reasoning) {
		return {
			ok: false,
			error: `Thinking level "${thinkingLevel}" is not supported by non-reasoning model "${modelRef}". Use "off" or choose a reasoning model.`,
		};
	}
	if (thinkingLevel === "max" && !supportsMax(model)) {
		return {
			ok: false,
			error: `Thinking level "max" is not supported by model "${modelRef}". Use "xhigh" or choose a max-capable GPT-5.6 model.`,
		};
	}
	if (thinkingLevel === "xhigh" && !supportsXhigh(model)) {
		return {
			ok: false,
			error: `Thinking level "xhigh" is not supported by model "${modelRef}". Use "high" or choose an xhigh-capable model.`,
		};
	}
	return { ok: true };
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
