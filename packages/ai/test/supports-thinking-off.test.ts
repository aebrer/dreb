import { describe, expect, it } from "vitest";
import {
	clampThinkingLevel,
	claudeThinksByDefault,
	getClaudeThinkingOffMode,
	getModel,
	supportsAdaptiveThinking,
	supportsMax,
	supportsThinkingOff,
	supportsXhigh,
} from "../src/models.js";
import type { Api, Model } from "../src/types.js";

const anthropicBase = getModel("anthropic", "claude-opus-4-6") as Model<Api>;
const bedrockBase = getModel("amazon-bedrock", "anthropic.claude-opus-4-8") as Model<Api>;
const vercelBase = getModel("vercel-ai-gateway", "anthropic/claude-opus-4.6") as Model<Api>;

interface Capabilities {
	adaptive: boolean;
	xhigh: boolean;
	max: boolean;
	off: boolean;
}

/** Per-model capabilities on Anthropic-native transports (the PR table). */
const NATIVE_TABLE: Array<[version: string, caps: Capabilities]> = [
	["opus-4-5", { adaptive: false, xhigh: false, max: false, off: true }],
	["sonnet-4-5", { adaptive: false, xhigh: false, max: false, off: true }],
	["haiku-4-5", { adaptive: false, xhigh: false, max: false, off: true }],
	["opus-4-6", { adaptive: true, xhigh: false, max: true, off: true }],
	["sonnet-4-6", { adaptive: true, xhigh: false, max: true, off: true }],
	["opus-4-7", { adaptive: true, xhigh: true, max: true, off: true }],
	["opus-4-8", { adaptive: true, xhigh: true, max: true, off: true }],
	["opus-5", { adaptive: true, xhigh: true, max: true, off: true }],
	["sonnet-5", { adaptive: true, xhigh: true, max: true, off: true }],
	["opus-5-5", { adaptive: true, xhigh: true, max: true, off: false }],
	["sonnet-5-5", { adaptive: true, xhigh: true, max: true, off: true }],
	["haiku-5-5", { adaptive: true, xhigh: true, max: true, off: true }],
];

/** Every id form that resolves to an Anthropic-native transport. */
function nativeIdForms(version: string): Array<[label: string, model: Model<Api>]> {
	const dotted = version.replace(/-(\d+)-(\d+)$/, "-$1.$2");
	return [
		["plain", { ...anthropicBase, id: `claude-${version}` }],
		["dated", { ...anthropicBase, id: `claude-${version}-20260101` }],
		["anthropic/ proxy prefix", { ...anthropicBase, provider: "custom-proxy", id: `anthropic/claude-${version}` }],
		["vercel dotted", { ...vercelBase, id: `anthropic/claude-${dotted}` }],
		["bedrock anthropic.", { ...bedrockBase, id: `anthropic.claude-${version}` }],
		["bedrock us. -v1:0", { ...bedrockBase, id: `us.anthropic.claude-${version}-v1:0` }],
		["bedrock global.", { ...bedrockBase, id: `global.anthropic.claude-${version}` }],
	];
}

describe("Claude thinking capabilities on Anthropic-native transports", () => {
	for (const [version, caps] of NATIVE_TABLE) {
		describe(version, () => {
			it.each(nativeIdForms(version))("%s form", (_label, model) => {
				expect({
					adaptive: supportsAdaptiveThinking(model),
					xhigh: supportsXhigh(model),
					max: supportsMax(model),
					off: supportsThinkingOff(model),
				}).toEqual(caps);
			});
		});
	}

	it.each(["claude-3-5-haiku-20241022", "claude-haiku-4-5", "haiku-4-5-20251001", "claude-3-haiku-20240307"])(
		"keeps legacy Haiku %s on budget thinking without xhigh/max",
		(id) => {
			const model = { ...anthropicBase, id };
			expect(supportsAdaptiveThinking(model)).toBe(false);
			expect(supportsXhigh(model)).toBe(false);
			expect(supportsMax(model)).toBe(false);
			expect(supportsThinkingOff(model)).toBe(true);
		},
	);

	it("matches the registry 5.5 entries", () => {
		const opus = getModel("anthropic", "claude-opus-5-5");
		const haiku = getModel("amazon-bedrock", "global.anthropic.claude-haiku-5-5");
		expect(supportsThinkingOff(opus)).toBe(false);
		expect(supportsMax(opus)).toBe(true);
		expect(supportsAdaptiveThinking(haiku)).toBe(true);
		expect(supportsXhigh(haiku)).toBe(true);
		expect(supportsMax(haiku)).toBe(true);
	});
});

describe("Claude thinking capabilities on GitHub Copilot follow the native rules", () => {
	it("routes Copilot Claude Opus/Sonnet/Haiku through Anthropic Messages and Fable through completions", () => {
		for (const id of [
			"claude-haiku-4.5",
			"claude-sonnet-4.6",
			"claude-opus-4.8",
			"claude-opus-5",
			"claude-opus-5.5",
			"claude-sonnet-5.5",
			"claude-haiku-5.5",
		] as const) {
			const model = getModel("github-copilot", id);
			expect(model.api, id).toBe("anthropic-messages");
			expect(model.compat, id).toBeUndefined();
		}
		expect(getModel("github-copilot", "claude-fable-5").api).toBe("openai-completions");
	});

	it.each([
		["claude-opus-4.8", { adaptive: true, xhigh: true, max: true, off: true }, "disabled"],
		["claude-sonnet-4.6", { adaptive: true, xhigh: false, max: true, off: true }, "disabled"],
		["claude-opus-5.5", { adaptive: true, xhigh: true, max: true, off: false }, "omit"],
		["claude-sonnet-5.5", { adaptive: true, xhigh: true, max: true, off: true }, "between_tools"],
		["claude-haiku-5.5", { adaptive: true, xhigh: true, max: true, off: true }, "disabled"],
	] as const)("Copilot %s", (id, caps, offMode) => {
		const model = getModel("github-copilot", id);
		expect({
			adaptive: supportsAdaptiveThinking(model),
			xhigh: supportsXhigh(model),
			max: supportsMax(model),
			off: supportsThinkingOff(model),
		}).toEqual(caps);
		expect(getClaudeThinkingOffMode(model)).toBe(offMode);
	});
});

describe("Claude thinking capabilities on OpenAI-compatible transports keep the legacy rules", () => {
	it.each([
		["anthropic/claude-opus-4.6", true],
		["anthropic/claude-opus-5.5", true],
		["anthropic/claude-haiku-5.5", false],
	] as const)("OpenRouter %s", (id, xhigh) => {
		const model = getModel("openrouter", id);
		expect(supportsXhigh(model)).toBe(xhigh);
		expect(supportsMax(model)).toBe(false);
		expect(supportsThinkingOff(model)).toBe(true);
		expect(getClaudeThinkingOffMode(model)).toBe("disabled");
	});
});

describe("advertised reasoningEfforts take precedence over model-id rules", () => {
	it("hides xhigh/max the provider does not advertise", () => {
		const model = { ...getModel("github-copilot", "claude-opus-5.5"), reasoningEfforts: ["low", "medium", "high"] };
		expect(supportsXhigh(model)).toBe(false);
		expect(supportsMax(model)).toBe(false);
		expect(clampThinkingLevel(model, "max")).toBe("high");
		expect(clampThinkingLevel(model, "xhigh")).toBe("high");
	});

	it("offers xhigh/max the provider advertises even when id rules would not", () => {
		const model = { ...getModel("github-copilot", "claude-sonnet-4.6"), reasoningEfforts: ["low", "xhigh", "max"] };
		expect(supportsXhigh(model)).toBe(true);
		expect(supportsMax(model)).toBe(true);
	});

	it("leaves thinking-off detection to the model-id rules", () => {
		const model = { ...getModel("github-copilot", "claude-opus-5.5"), reasoningEfforts: ["low", "max"] };
		expect(supportsThinkingOff(model)).toBe(false);
	});
});

describe("getClaudeThinkingOffMode", () => {
	it.each([
		["claude-opus-4-5", "disabled"],
		["claude-opus-4-8", "disabled"],
		["claude-opus-5", "disabled"],
		["claude-sonnet-5", "disabled"],
		["claude-haiku-5-5", "disabled"],
		["claude-sonnet-5-5", "between_tools"],
		["claude-opus-5-5", "omit"],
	] as const)("%s → %s", (id, mode) => {
		expect(getClaudeThinkingOffMode({ ...anthropicBase, id })).toBe(mode);
		expect(getClaudeThinkingOffMode({ ...bedrockBase, id: `us.anthropic.${id}-v1:0` })).toBe(mode);
	});
});

describe("claudeThinksByDefault", () => {
	it.each([
		["claude-opus-4-8", false],
		["claude-sonnet-4-6", false],
		["claude-haiku-4-5", false],
		["claude-opus-5", true],
		["claude-sonnet-5", true],
		["claude-opus-5-5", true],
		["claude-sonnet-5-5", true],
		["claude-haiku-5-5", true],
	] as const)("%s → %s", (id, expected) => {
		expect(claudeThinksByDefault({ ...anthropicBase, id })).toBe(expected);
	});
});

describe("clampThinkingLevel", () => {
	const model = (id: string, overrides: Partial<Model<Api>> = {}) => ({ ...anthropicBase, id, ...overrides });

	it("maps every level to off for non-reasoning models", () => {
		const nonReasoning = model("claude-opus-5-5", { reasoning: false });
		for (const level of ["off", "minimal", "high", "xhigh", "max"] as const) {
			expect(clampThinkingLevel(nonReasoning, level)).toBe("off");
		}
		expect(clampThinkingLevel(undefined, "high")).toBe("off");
	});

	it("maps off to minimal on Opus 5.5 and keeps off elsewhere", () => {
		expect(clampThinkingLevel(model("claude-opus-5-5"), "off")).toBe("minimal");
		expect(clampThinkingLevel(model("claude-sonnet-5-5"), "off")).toBe("off");
		expect(clampThinkingLevel(model("claude-haiku-5-5"), "off")).toBe("off");
	});

	it("clamps unsupported xhigh up to max on Opus/Sonnet 4.6", () => {
		expect(clampThinkingLevel(model("claude-opus-4-6"), "xhigh")).toBe("max");
		expect(clampThinkingLevel(model("claude-sonnet-4-6"), "xhigh")).toBe("max");
	});

	it("clamps unsupported xhigh down to high when max is unavailable", () => {
		expect(clampThinkingLevel(model("claude-opus-4-5"), "xhigh")).toBe("high");
	});

	it("falls max back through xhigh, then high", () => {
		expect(clampThinkingLevel(getModel("openai", "gpt-5.5"), "max")).toBe("xhigh");
		expect(clampThinkingLevel(getModel("openrouter", "anthropic/claude-opus-4.6"), "max")).toBe("xhigh");
		expect(clampThinkingLevel(model("claude-opus-4-5"), "max")).toBe("high");
	});

	it("passes supported levels through unchanged", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			expect(clampThinkingLevel(model("claude-haiku-5-5"), level)).toBe(level);
		}
		expect(clampThinkingLevel(model("claude-opus-4-6"), "max")).toBe("max");
	});
});
