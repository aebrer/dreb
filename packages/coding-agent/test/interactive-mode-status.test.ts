import { Container } from "@dreb/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

describe("InteractiveMode working indicator", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	async function dispatchEvent(fakeThis: object, event: object): Promise<void> {
		return (InteractiveMode as any).prototype.handleEvent.call(fakeThis, event);
	}

	function createWorkingFakeThis() {
		const inlineStatuses: Array<string | null> = [];
		const editor = {
			setInlineStatus: vi.fn((text: string | null) => inlineStatuses.push(text)),
			setGhostText: vi.fn(),
		};
		const fakeThis: any = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			retryLoader: undefined,
			statusContainer: new Container(),
			defaultEditor: editor,
			editor,
			ui: { requestRender: vi.fn() },
			defaultWorkingMessage: "Working...",
			workingFrames: ["⠋", "⠙"],
			workingFrame: 0,
			workingInterval: undefined,
			isAgentWorking: false,
			currentWorkingMessage: "Working...",
			pendingWorkingMessage: undefined,
			streamingComponent: undefined,
			streamingMessage: undefined,
			pendingTools: new Map(),
			commitNeeded: false,
			checkShutdownRequested: vi.fn(async () => {}),
			buddyController: { handleEvent: vi.fn() },
			footerDataProvider: { refreshDailyCost: vi.fn(async () => {}) },
		};
		for (const method of [
			"defaultInterruptWorkingMessage",
			"setEditorInlineStatus",
			"renderWorkingIndicator",
			"startAgentWorking",
			"stopAgentWorking",
		]) {
			fakeThis[method] = (...args: unknown[]) => (InteractiveMode as any).prototype[method].call(fakeThis, ...args);
		}
		return { fakeThis, inlineStatuses };
	}

	test("agent_start renders working state through editor inline status, not statusContainer", async () => {
		const { fakeThis, inlineStatuses } = createWorkingFakeThis();

		await dispatchEvent(fakeThis, { type: "agent_start" });

		expect(fakeThis.statusContainer.children).toHaveLength(0);
		expect(fakeThis.isAgentWorking).toBe(true);
		expect(inlineStatuses.some((text) => text?.includes("Working"))).toBe(true);

		(InteractiveMode as any).prototype.stopAgentWorking.call(fakeThis);
	});

	test("agent_end clears editor inline status without removing a status row", async () => {
		const { fakeThis, inlineStatuses } = createWorkingFakeThis();

		await dispatchEvent(fakeThis, { type: "agent_start" });
		await dispatchEvent(fakeThis, { type: "agent_end" });

		expect(fakeThis.statusContainer.children).toHaveLength(0);
		expect(fakeThis.isAgentWorking).toBe(false);
		expect(inlineStatuses.at(-1)).toBeNull();
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		skills?: Array<{ filePath: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			session: {
				promptTemplates: [],
				extensionRunner: undefined,
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: [] }),
					getMemoryIndexes: () => ({
						global: [],
						project: [],
						globalMemoryDir: "/tmp/test/memory",
						projectMemoryDir: "/tmp/test/memory",
						dreamLastRun: null,
					}),
					refreshDreamLastRun: () => {},
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => p,
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			getShortPath: (p: string) => p,
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		return fakeThis;
	}

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});
});

// Regression for #243: /buddy off must persist across sessions. The startup
// site loads the buddy via start() but must NOT visually mount it when hidden.
// These tests exercise the actual mount-gate (mountExistingBuddyIfVisible) — if
// the `!hidden` guard regresses, they fail (the controller-contract tests in
// buddy-controller.test.ts would not catch a revert of the gate itself).
describe("InteractiveMode.mountExistingBuddyIfVisible", () => {
	function createFakeThis(startReturn: { hidden?: boolean } | null) {
		const mountBuddy = vi.fn();
		const fakeThis: any = {
			buddyController: { start: vi.fn(() => startReturn) },
			mountBuddy,
		};
		return { fakeThis, mountBuddy };
	}

	test("does not mount a hidden buddy at startup", () => {
		const { fakeThis, mountBuddy } = createFakeThis({ hidden: true });
		(InteractiveMode as any).prototype.mountExistingBuddyIfVisible.call(fakeThis);
		expect(mountBuddy).not.toHaveBeenCalled();
	});

	test("mounts a visible buddy at startup", () => {
		const visibleBuddy = { hidden: false };
		const { fakeThis, mountBuddy } = createFakeThis(visibleBuddy);
		(InteractiveMode as any).prototype.mountExistingBuddyIfVisible.call(fakeThis);
		expect(mountBuddy).toHaveBeenCalledWith(visibleBuddy);
	});

	test("mounts a buddy with no hidden flag (undefined) at startup", () => {
		const buddy = {}; // hidden never persisted
		const { fakeThis, mountBuddy } = createFakeThis(buddy);
		(InteractiveMode as any).prototype.mountExistingBuddyIfVisible.call(fakeThis);
		expect(mountBuddy).toHaveBeenCalledWith(buddy);
	});

	test("does nothing when no buddy is stored", () => {
		const { fakeThis, mountBuddy } = createFakeThis(null);
		(InteractiveMode as any).prototype.mountExistingBuddyIfVisible.call(fakeThis);
		expect(mountBuddy).not.toHaveBeenCalled();
	});
});
