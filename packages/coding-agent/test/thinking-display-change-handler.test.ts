import { findModel, type Model, supportsAdaptiveThinking } from "@dreb/ai";
import { describe, expect, it, vi } from "vitest";
import {
	InMemorySettingsStorage,
	SettingsManager,
	type SettingsManager as SettingsManagerType,
} from "../src/core/settings-manager.js";
import { resolveThinkingDisplay } from "../src/core/thinking.js";

const adaptiveModel = findModel("anthropic", "opus-4-8")!;
const nonAdaptiveModel = findModel("anthropic", "sonnet-4-5")!;

type ThinkingDisplay = "summarized" | "omitted";

/**
 * Faithful re-implementation of the `onThinkingDisplayChange` handler body defined
 * inside `showSettingsSelector()` in interactive-mode.ts (~L3660). The handler is a
 * nested arrow function that closes over `this.session`, `this.settingsManager`, and
 * `this.showWarning`, so it cannot be invoked as a prototype method. We exercise the
 * exact same operations here against the same helpers it uses.
 */
function runHandler(
	model: Model<any> | undefined,
	display: ThinkingDisplay,
	settingsManager: SettingsManagerType,
	session: { agent: { thinkingDisplay: "summarized" | "omitted" | undefined } },
	showWarning: (message: string) => void,
): void {
	if (!model) return;
	settingsManager.setModelThinkingDisplay(model.id, display);
	const effective = resolveThinkingDisplay(model, settingsManager.getModelThinkingDisplay(model.id));
	session.agent.thinkingDisplay = effective;
	if (supportsAdaptiveThinking(model) && effective !== display) {
		showWarning(
			`Thinking display for "${model.id}" was not changed: a project-level "modelSettings" override in .dreb/settings.json takes precedence (effective: "${effective}"). Remove or edit that override to use this toggle.`,
		);
	}
}

/** Build a SettingsManager whose project scope is pre-seeded (mirrors .dreb/settings.json). */
function managerWithProjectOverride(projectSettings: object): SettingsManagerType {
	const storage = new InMemorySettingsStorage();
	storage.withLock("project", () => JSON.stringify(projectSettings));
	return SettingsManager.fromStorage(storage);
}

describe("onThinkingDisplayChange handler logic", () => {
	it("normal path: persists setting and refreshes agent.thinkingDisplay for adaptive model", () => {
		const sm = SettingsManager.inMemory();
		const session = { agent: { thinkingDisplay: "summarized" as "summarized" | "omitted" | undefined } };
		const showWarning = vi.fn();

		runHandler(adaptiveModel, "omitted", sm, session, showWarning);

		// Persisted to settings (global write).
		expect(sm.getModelThinkingDisplay(adaptiveModel.id)).toBe("omitted");
		// Live agent refreshed to the effective value.
		expect(session.agent.thinkingDisplay).toBe("omitted");
		// No conflict -> no warning.
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("warning path: project-level override shadows the global toggle write", () => {
		// Project pins "summarized"; the toggle writes "omitted" to global.
		const sm = managerWithProjectOverride({
			modelSettings: { [adaptiveModel.id]: { thinkingDisplay: "summarized" } },
		});
		const session = { agent: { thinkingDisplay: "summarized" as "summarized" | "omitted" | undefined } };
		const showWarning = vi.fn();

		runHandler(adaptiveModel, "omitted", sm, session, showWarning);

		// Global write happened, but project override wins on resolve.
		const effective = resolveThinkingDisplay(adaptiveModel, sm.getModelThinkingDisplay(adaptiveModel.id));
		expect(effective).toBe("summarized");
		// Agent reflects the effective (project-overridden) value, not the requested one.
		expect(session.agent.thinkingDisplay).toBe("summarized");
		// Fail loudly: warning fired because effective !== requested display.
		expect(showWarning).toHaveBeenCalledTimes(1);
		expect(showWarning.mock.calls[0][0]).toContain(adaptiveModel.id);
		expect(showWarning.mock.calls[0][0]).toContain("project-level");
	});

	it("no warning when there is no conflicting project override", () => {
		const sm = SettingsManager.inMemory();
		const session = { agent: { thinkingDisplay: "summarized" as "summarized" | "omitted" | undefined } };
		const showWarning = vi.fn();

		runHandler(adaptiveModel, "omitted", sm, session, showWarning);

		expect(session.agent.thinkingDisplay).toBe("omitted");
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("no warning for non-adaptive models even if effective !== display", () => {
		const sm = SettingsManager.inMemory();
		const session = { agent: { thinkingDisplay: "summarized" as "summarized" | "omitted" | undefined } };
		const showWarning = vi.fn();

		runHandler(nonAdaptiveModel, "omitted", sm, session, showWarning);

		// Non-adaptive models resolve to undefined regardless of the stored value.
		const effective = resolveThinkingDisplay(nonAdaptiveModel, sm.getModelThinkingDisplay(nonAdaptiveModel.id));
		expect(effective).toBeUndefined();
		expect(session.agent.thinkingDisplay).toBeUndefined();
		// supportsAdaptiveThinking gate suppresses the warning.
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("no-model guard: returns early without crashing or persisting", () => {
		const sm = SettingsManager.inMemory();
		const session = { agent: { thinkingDisplay: "summarized" as "summarized" | "omitted" | undefined } };
		const showWarning = vi.fn();

		expect(() => runHandler(undefined, "omitted", sm, session, showWarning)).not.toThrow();

		// Nothing persisted, agent untouched, no warning.
		expect(sm.getModelThinkingDisplay(adaptiveModel.id)).toBeUndefined();
		expect(session.agent.thinkingDisplay).toBe("summarized");
		expect(showWarning).not.toHaveBeenCalled();
	});
});
