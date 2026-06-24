import { type Component, Container, Editor, TUI } from "@dreb/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.js";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
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

class TestComponent implements Component {
	constructor(public lines: string[]) {}
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
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
			inlineStatusOwner: undefined,
			inlineStatusSpinner: (spinner: string) => spinner,
			warnedMissingInlineStatus: false,
			isAgentWorking: false,
			currentWorkingMessage: "Working...",
			pendingWorkingMessage: undefined,
			streamingComponent: undefined,
			streamingMessage: undefined,
			pendingTools: new Map(),
			commitNeeded: false,
			checkShutdownRequested: vi.fn(async () => {}),
			showWarning: vi.fn(),
			buddyController: { handleEvent: vi.fn() },
			footerDataProvider: { refreshDailyCost: vi.fn(async () => {}) },
		};
		for (const method of [
			"defaultInterruptWorkingMessage",
			"setEditorInlineStatus",
			"renderWorkingIndicator",
			"startInlineStatus",
			"stopInlineStatus",
			"startInlineLoader",
			"startAgentWorking",
			"stopAgentWorking",
			"stopAllInlineStatus",
			"setWorkingMessage",
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

	test("working indicator cycles frames on its interval", () => {
		vi.useFakeTimers();
		const { fakeThis, inlineStatuses } = createWorkingFakeThis();

		try {
			fakeThis.startAgentWorking("Cycling status");

			const initialFrame = fakeThis.workingFrame;
			const initialStatus = inlineStatuses.at(-1);
			expect(fakeThis.workingInterval).toBeDefined();

			vi.advanceTimersByTime(240);

			expect(fakeThis.workingFrame).not.toBe(initialFrame);
			expect(inlineStatuses.at(-1)).not.toBe(initialStatus);
			expect(inlineStatuses.at(-1)).toContain(fakeThis.workingFrames[fakeThis.workingFrame]);

			fakeThis.stopAgentWorking();
			expect(fakeThis.workingInterval).toBeUndefined();
			expect(inlineStatuses.at(-1)).toBeNull();
		} finally {
			fakeThis.stopAllInlineStatus();
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	test("agent_end clears editor inline status without removing a status row", async () => {
		vi.useFakeTimers();
		const { fakeThis, inlineStatuses } = createWorkingFakeThis();

		try {
			await dispatchEvent(fakeThis, { type: "agent_start" });
			await dispatchEvent(fakeThis, { type: "agent_end" });

			expect(fakeThis.statusContainer.children).toHaveLength(0);
			expect(fakeThis.isAgentWorking).toBe(false);
			expect(fakeThis.workingInterval).toBeUndefined();
			expect(inlineStatuses.at(-1)).toBeNull();
		} finally {
			fakeThis.stopAllInlineStatus();
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	test("queued setWorkingMessage flushes on agent_start", async () => {
		const { fakeThis, inlineStatuses } = createWorkingFakeThis();

		(InteractiveMode as any).prototype.setWorkingMessage.call(fakeThis, "Custom extension status");
		await dispatchEvent(fakeThis, { type: "agent_start" });

		expect(fakeThis.pendingWorkingMessage).toBeUndefined();
		expect(inlineStatuses.some((text) => text?.includes("Custom extension status"))).toBe(true);

		(InteractiveMode as any).prototype.stopAgentWorking.call(fakeThis);
	});

	test("setWorkingMessage updates active inline status", async () => {
		const { fakeThis, inlineStatuses } = createWorkingFakeThis();

		await dispatchEvent(fakeThis, { type: "agent_start" });
		(InteractiveMode as any).prototype.setWorkingMessage.call(fakeThis, "Updated status");

		expect(inlineStatuses.at(-1)).toContain("Updated status");

		(InteractiveMode as any).prototype.stopAgentWorking.call(fakeThis);
	});

	test("custom editor without inline status emits a warning", async () => {
		const { fakeThis } = createWorkingFakeThis();
		fakeThis.editor = { setGhostText: vi.fn() };

		await dispatchEvent(fakeThis, { type: "agent_start" });

		expect(fakeThis.showWarning).toHaveBeenCalledWith(expect.stringContaining("Custom editor component"));

		(InteractiveMode as any).prototype.stopAgentWorking.call(fakeThis);
	});

	test("auto-retry loader uses inline status without adding a status row", async () => {
		const { fakeThis, inlineStatuses } = createWorkingFakeThis();
		fakeThis.session = { abortRetry: vi.fn() };

		await dispatchEvent(fakeThis, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000 });

		expect(fakeThis.statusContainer.children).toHaveLength(0);
		expect(inlineStatuses.at(-1)).toContain("Retrying");

		await dispatchEvent(fakeThis, { type: "auto_retry_end", success: true, attempt: 1 });
		expect(inlineStatuses.at(-1)).toBeNull();
	});

	test("auto-compaction loader uses inline status without adding a status row", async () => {
		const { fakeThis, inlineStatuses } = createWorkingFakeThis();
		fakeThis.session = { abortCompaction: vi.fn() };

		await dispatchEvent(fakeThis, { type: "auto_compaction_start", reason: "overflow" });

		expect(fakeThis.statusContainer.children).toHaveLength(0);
		expect(inlineStatuses.at(-1)).toContain("Auto-compacting");

		(InteractiveMode as any).prototype.stopAllInlineStatus.call(fakeThis);
		expect(inlineStatuses.at(-1)).toBeNull();
	});

	test("non-agent inline loaders can update and clear branch summary, dream, and compaction statuses", () => {
		const { fakeThis, inlineStatuses } = createWorkingFakeThis();

		for (const [owner, label] of [
			["branchSummary", "Generating branch summary"],
			["dream", "Dreaming"],
			["compaction", "Compacting context"],
		] as const) {
			const loader = (InteractiveMode as any).prototype.startInlineLoader.call(fakeThis, owner, label);
			expect(fakeThis.statusContainer.children).toHaveLength(0);
			expect(inlineStatuses.at(-1)).toContain(label);
			loader.setText(`${label} updated`);
			expect(inlineStatuses.at(-1)).toContain("updated");
			loader.stop();
			expect(inlineStatuses.at(-1)).toBeNull();
		}
	});

	test("stopAllInlineStatus clears non-agent status and pending working message", () => {
		const { fakeThis, inlineStatuses } = createWorkingFakeThis();

		(InteractiveMode as any).prototype.setWorkingMessage.call(fakeThis, "Queued stale status");
		const loader = (InteractiveMode as any).prototype.startInlineLoader.call(fakeThis, "dream", "Dreaming");
		fakeThis.retryLoader = loader;

		(InteractiveMode as any).prototype.stopAllInlineStatus.call(fakeThis);

		expect(fakeThis.pendingWorkingMessage).toBeUndefined();
		expect(fakeThis.inlineStatusOwner).toBeUndefined();
		expect(fakeThis.workingInterval).toBeUndefined();
		expect(fakeThis.retryLoader).toBeUndefined();
		expect(inlineStatuses.at(-1)).toBeNull();
	});

	test("a superseded loader handle becomes inert once another owner takes over", () => {
		vi.useFakeTimers();
		const { fakeThis, inlineStatuses } = createWorkingFakeThis();

		try {
			// A background loader claims the inline status...
			const dreamLoader = (InteractiveMode as any).prototype.startInlineLoader.call(fakeThis, "dream", "Dreaming");
			expect(fakeThis.inlineStatusOwner).toBe("dream");

			// ...then an agent turn starts and takes ownership (as in executeDream → prompt → agent_start).
			fakeThis.startAgentWorking();
			expect(fakeThis.inlineStatusOwner).toBe("agent");
			const agentStatus = inlineStatuses.at(-1);
			expect(agentStatus).toContain("Working");
			const pushCountAfterTakeover = inlineStatuses.length;
			const intervalAfterTakeover = fakeThis.workingInterval;
			expect(intervalAfterTakeover).toBeDefined();

			// The stale dream handle must not clobber the active agent indicator.
			dreamLoader.setText("Dreaming updated");
			expect(inlineStatuses.length).toBe(pushCountAfterTakeover);
			expect(inlineStatuses.at(-1)).toBe(agentStatus);
			expect(fakeThis.currentWorkingMessage).not.toContain("Dreaming");

			// Stopping the stale handle must not tear down the agent's status or interval.
			dreamLoader.stop();
			expect(fakeThis.inlineStatusOwner).toBe("agent");
			expect(fakeThis.workingInterval).toBe(intervalAfterTakeover);
			expect(inlineStatuses.at(-1)).toBe(agentStatus);
		} finally {
			fakeThis.stopAllInlineStatus();
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	test("stopAllInlineStatus restores the auto-compaction escape handler", () => {
		const { fakeThis } = createWorkingFakeThis();
		const savedHandler = vi.fn();
		const liveHandler = vi.fn();
		fakeThis.defaultEditor.onEscape = liveHandler;
		fakeThis.autoCompactionEscapeHandler = savedHandler;

		(InteractiveMode as any).prototype.stopAllInlineStatus.call(fakeThis);

		expect(fakeThis.defaultEditor.onEscape).toBe(savedHandler);
		expect(fakeThis.autoCompactionEscapeHandler).toBeUndefined();
	});

	test("stopAllInlineStatus restores the retry escape handler", () => {
		const { fakeThis } = createWorkingFakeThis();
		const savedHandler = vi.fn();
		const liveHandler = vi.fn();
		fakeThis.defaultEditor.onEscape = liveHandler;
		fakeThis.retryEscapeHandler = savedHandler;

		(InteractiveMode as any).prototype.stopAllInlineStatus.call(fakeThis);

		expect(fakeThis.defaultEditor.onEscape).toBe(savedHandler);
		expect(fakeThis.retryEscapeHandler).toBeUndefined();
	});

	test("working status forwards to a custom editor that supports inline status", async () => {
		const { fakeThis } = createWorkingFakeThis();
		const customStatuses: Array<string | null> = [];
		fakeThis.editor = {
			setInlineStatus: vi.fn((text: string | null) => customStatuses.push(text)),
			setGhostText: vi.fn(),
		};

		await dispatchEvent(fakeThis, { type: "agent_start" });

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(fakeThis.editor.setInlineStatus).toHaveBeenCalled();
		expect(customStatuses.some((text) => text?.includes("Working"))).toBe(true);

		await dispatchEvent(fakeThis, { type: "agent_end" });

		expect(customStatuses.at(-1)).toBeNull();
	});

	test("agent_end while scrolled up preserves viewport and scrollback", async () => {
		const terminal = new LoggingVirtualTerminal(40, 8);
		const ui = new TUI(terminal);
		const committed = new Container();
		const live = new Container();
		const history = new TestComponent(Array.from({ length: 18 }, (_, i) => `HIST ${i}`));
		const editor = new Editor(ui, defaultEditorTheme);
		const footer = new TestComponent(["footer"]);

		committed.addChild(history);
		live.addChild(editor);
		live.addChild(footer);
		ui.addChild(committed);
		ui.addChild(live);
		ui.setCommittedChildCount(1);
		ui.start();
		await terminal.flush();
		ui.commit();

		const { fakeThis } = createWorkingFakeThis();
		Object.assign(fakeThis, {
			ui,
			defaultEditor: editor,
			editor,
			statusContainer: new Container(),
		});

		await dispatchEvent(fakeThis, { type: "agent_start" });
		await terminal.flush();
		terminal.scrollLines(-3);
		await terminal.flush();
		const viewportTopBefore = terminal.getViewportTop();
		terminal.clearWrites();

		await dispatchEvent(fakeThis, { type: "agent_end" });
		await terminal.flush();

		expect(terminal.getWrites()).not.toContain("\x1b[3J");
		expect(terminal.getWrites()).not.toContain("HIST 0");
		expect(terminal.getViewportTop()).toBe(viewportTopBefore);

		ui.stop();
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
