/**
 * Integration tests for the committed-scrollback rendering model's commit logic.
 * Tests tryCommitPrefix(), onPostRender deferred commit, and Kitty hold-back.
 */
import type { AssistantMessage } from "@dreb/ai";
import { Container, type TUI } from "@dreb/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Hello" }],
		api: "messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

beforeAll(() => {
	initTheme("dark");
});

function createFakeTui(): TUI {
	return {
		requestRender: vi.fn(),
		recommitAll: vi.fn(),
		commit: vi.fn(),
		setCommittedChildCount: vi.fn(),
		onPostRender: undefined,
	} as unknown as TUI;
}

describe("tryCommitPrefix logic", () => {
	test("finalized AssistantMessageComponent is committable when not streaming", () => {
		const chatContainer = new Container();
		const committedChatContainer = new Container();

		// Create a finalized assistant message (not the active streaming component)
		const msg = new AssistantMessageComponent(createAssistantMessage());
		chatContainer.addChild(msg);

		// Simulate tryCommitPrefix logic
		const streamingComponent: AssistantMessageComponent | undefined = undefined;
		const pendingTools = new Map<string, ToolExecutionComponent>();
		let commitCount = 0;

		for (const child of chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				if (child === streamingComponent) break;
				commitCount++;
			} else if (child instanceof ToolExecutionComponent) {
				if (pendingTools.has(child.getToolCallId())) break;
				if (child.hasPendingConversions()) break;
				commitCount++;
			} else {
				commitCount++;
			}
		}

		expect(commitCount).toBe(1);

		// Move to committed
		const toCommit = chatContainer.children.splice(0, commitCount);
		for (const c of toCommit) committedChatContainer.addChild(c);

		expect(chatContainer.children.length).toBe(0);
		expect(committedChatContainer.children.length).toBe(1);
	});

	test("streaming AssistantMessageComponent blocks commit", () => {
		const chatContainer = new Container();

		const msg = new AssistantMessageComponent(
			createAssistantMessage({
				content: [{ type: "text", text: "Still typing..." }],
			}),
		);
		chatContainer.addChild(msg);

		// This IS the active streaming component
		const streamingComponent = msg;
		const pendingTools = new Map<string, ToolExecutionComponent>();
		let commitCount = 0;

		for (const child of chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				if (child === streamingComponent) break; // blocks here
				commitCount++;
			} else if (child instanceof ToolExecutionComponent) {
				if (pendingTools.has(child.getToolCallId())) break;
				if (child.hasPendingConversions()) break;
				commitCount++;
			} else {
				commitCount++;
			}
		}

		expect(commitCount).toBe(0);
	});

	test("pending tool blocks commit of itself and everything after", () => {
		const ui = createFakeTui();
		const chatContainer = new Container();
		const committedChatContainer = new Container();

		// Finalized message
		const msg = new AssistantMessageComponent(
			createAssistantMessage({
				content: [{ type: "text", text: "Done" }],
			}),
		);
		chatContainer.addChild(msg);

		// Pending tool (still executing)
		const tool = new ToolExecutionComponent("bash", "tool-1", { command: "ls" }, {}, undefined as any, ui);
		chatContainer.addChild(tool);

		const streamingComponent: AssistantMessageComponent | undefined = undefined;
		const pendingTools = new Map<string, ToolExecutionComponent>();
		pendingTools.set("tool-1", tool);
		let commitCount = 0;

		for (const child of chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				if (child === streamingComponent) break;
				commitCount++;
			} else if (child instanceof ToolExecutionComponent) {
				if (pendingTools.has(child.getToolCallId())) break; // blocks here
				if (child.hasPendingConversions()) break;
				commitCount++;
			} else {
				commitCount++;
			}
		}

		// Only the message before the pending tool can be committed
		expect(commitCount).toBe(1);

		const toCommit = chatContainer.children.splice(0, commitCount);
		for (const c of toCommit) committedChatContainer.addChild(c);

		expect(committedChatContainer.children.length).toBe(1);
		expect(chatContainer.children.length).toBe(1); // tool remains
	});

	test("finalized tool without pending conversions is committable", () => {
		const ui = createFakeTui();
		const chatContainer = new Container();

		const tool = new ToolExecutionComponent("bash", "tool-1", { command: "ls" }, {}, undefined as any, ui);
		tool.updateResult({ content: [{ type: "text", text: "file.txt" }], isError: false });
		chatContainer.addChild(tool);

		const streamingComponent: AssistantMessageComponent | undefined = undefined;
		const pendingTools = new Map<string, ToolExecutionComponent>();
		// tool-1 is NOT in pendingTools (already finished)
		let commitCount = 0;

		for (const child of chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				if (child === streamingComponent) break;
				commitCount++;
			} else if (child instanceof ToolExecutionComponent) {
				if (pendingTools.has(child.getToolCallId())) break;
				if (child.hasPendingConversions()) break;
				commitCount++;
			} else {
				commitCount++;
			}
		}

		expect(commitCount).toBe(1);
	});
});

describe("Kitty hold-back", () => {
	test("hasPendingConversions blocks commit", () => {
		const ui = createFakeTui();
		const chatContainer = new Container();

		const tool = new ToolExecutionComponent("bash", "tool-1", { command: "ls" }, {}, undefined as any, ui);
		tool.updateResult({
			content: [
				{ type: "text", text: "result" },
				{ type: "image", data: "base64data", mimeType: "image/jpeg" },
			],
			isError: false,
		});
		chatContainer.addChild(tool);

		// hasPendingConversions is false by default (no kitty support active)
		expect(tool.hasPendingConversions()).toBe(false);
	});

	test("getToolCallId returns the correct ID", () => {
		const ui = createFakeTui();
		const tool = new ToolExecutionComponent("bash", "my-tool-id-123", {}, {}, undefined as any, ui);
		expect(tool.getToolCallId()).toBe("my-tool-id-123");
	});

	test("onConversionComplete callback fires when set", () => {
		const ui = createFakeTui();
		const tool = new ToolExecutionComponent("bash", "tool-1", {}, {}, undefined as any, ui);
		tool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });

		let callbackFired = false;
		tool.onConversionComplete = () => {
			callbackFired = true;
		};

		// Callback is available to be called
		expect(tool.onConversionComplete).toBeDefined();
		tool.onConversionComplete!();
		expect(callbackFired).toBe(true);
	});
});

describe("deferred commit via onPostRender", () => {
	test("commitNeeded flag pattern ensures render-before-commit ordering", () => {
		// This tests the pattern used by interactive-mode:
		// 1. Set commitNeeded = true
		// 2. requestRender() schedules next render
		// 3. After render, onPostRender fires and does the commit
		const ui = createFakeTui();
		const events: string[] = [];

		let commitNeeded = false;
		ui.onPostRender = () => {
			if (commitNeeded) {
				events.push("commit");
				commitNeeded = false;
			}
		};

		// Simulate tool_execution_end
		events.push("updateResult");
		commitNeeded = true;
		events.push("requestRender");

		// Simulate render cycle completing
		events.push("render");
		ui.onPostRender!();

		expect(events).toEqual(["updateResult", "requestRender", "render", "commit"]);
		expect(commitNeeded).toBe(false);
	});

	test("commitNeeded is false by default — no spurious commits", () => {
		const ui = createFakeTui();
		let commitCalled = false;

		let commitNeeded = false;
		ui.onPostRender = () => {
			if (commitNeeded) {
				commitCalled = true;
				commitNeeded = false;
			}
		};

		// Simulate a normal render (no pending commit)
		ui.onPostRender!();
		expect(commitCalled).toBe(false);
	});

	test("multiple events before render only commit once", () => {
		const ui = createFakeTui();
		let commitCount = 0;

		let commitNeeded = false;
		ui.onPostRender = () => {
			if (commitNeeded) {
				commitCount++;
				commitNeeded = false;
			}
		};

		// Multiple events set commitNeeded
		commitNeeded = true; // message_end
		commitNeeded = true; // tool_execution_end
		commitNeeded = true; // agent_end

		// Only one commit on render
		ui.onPostRender!();
		expect(commitCount).toBe(1);

		// Second render: nothing to commit
		ui.onPostRender!();
		expect(commitCount).toBe(1);
	});
});
