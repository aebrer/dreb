import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TabTitleDeps } from "../src/core/tab-title.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

const capturedDeps = vi.hoisted(() => [] as TabTitleDeps[]);

vi.mock("../src/core/tab-title.js", () => ({
	TabTitleGenerator: class {
		constructor(_settings: unknown, deps: TabTitleDeps) {
			capturedDeps.push(deps);
		}
	},
}));

beforeEach(() => capturedDeps.splice(0));

describe("interactive tab-title wiring", () => {
	it.each([false, true])("reads live single-model mode (initially %s) and parent identity", (initialMode) => {
		let singleModelMode = initialMode;
		const fakeThis = {
			settingsManager: {
				getTabTitleSettings: () => undefined,
				getSingleModelMode: () => singleModelMode,
				getAgentModelsForAgent: vi.fn(),
			},
			sessionManager: { getSessionName: () => undefined },
			session: {
				model: { provider: "parent-provider", id: "parent-model" },
				state: { messages: [] },
				modelRegistry: {},
			},
			ui: { terminal: { setTitle: vi.fn() } },
			footerDataProvider: { getGitBranch: () => undefined },
		};

		(InteractiveMode.prototype as any).initTabTitleGenerator.call(fakeThis);

		expect(capturedDeps).toHaveLength(1);
		const deps = capturedDeps[0];
		expect(deps.getSingleModelMode?.()).toBe(initialMode);
		expect(deps.getModel()).toBe(fakeThis.session.model);
		expect(deps.getProvider()).toBe("parent-provider");

		singleModelMode = !initialMode;
		fakeThis.session.model = { provider: "new-provider", id: "new-model" };
		expect(deps.getSingleModelMode?.()).toBe(!initialMode);
		expect(deps.getModel()).toBe(fakeThis.session.model);
		expect(deps.getProvider()).toBe("new-provider");
	});
});
