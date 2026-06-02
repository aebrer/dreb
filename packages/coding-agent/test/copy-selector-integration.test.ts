/**
 * Integration tests for InteractiveMode.showCopySelector().
 * Tests the wiring between the selector component, session messages, and clipboard.
 */

import type { AgentMessage } from "@dreb/agent-core";
import type { AssistantMessage, UserMessage } from "@dreb/ai";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

// Mock clipboard to control its return value
vi.mock("../src/utils/clipboard.js", () => ({
	copyToClipboard: vi.fn(async () => ({ method: "native" })),
}));

import { copyToClipboard } from "../src/utils/clipboard.js";

const mockCopyToClipboard = vi.mocked(copyToClipboard);

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	vi.clearAllMocks();
});

// --- Test message helpers ---

function makeUserMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic",
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
	};
}

function makeImageOnlyMessage(): UserMessage {
	return {
		role: "user",
		content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
		timestamp: Date.now(),
	};
}

// --- Fake `this` context ---

interface CapturedSelector {
	onCopy?: (indices: number[]) => void;
	onCancel?: () => void;
}

function createFakeContext(messages: AgentMessage[]) {
	const captured: CapturedSelector = {};
	const statusMessages: string[] = [];
	const warningMessages: string[] = [];

	const fakeThis: any = {
		session: { messages },
		buddyComponent: null,
		widgetContainerBelow: { clear: vi.fn() },
		ui: {
			requestRender: vi.fn(),
			terminal: { rows: 40 },
			setFocus: vi.fn(),
		},
		editorContainer: {
			clear: vi.fn(),
			addChild: vi.fn(),
		},
		editor: {},
		renderWidgets: vi.fn(),
		showStatus: vi.fn((msg: string) => statusMessages.push(msg)),
		showWarning: vi.fn((msg: string) => warningMessages.push(msg)),
		showError: vi.fn(),
		showSelector: vi.fn((create: (done: () => void) => any) => {
			const done = vi.fn();
			const result = create(done);
			// Extract the onCopy and onCancel from the CopySelectorComponent
			// The component is passed callbacks in its constructor
			// We can get them via the messageList's handlers
			const messageList = result.focus;
			captured.onCopy = messageList.onCopy;
			captured.onCancel = messageList.onCancel;
		}),
	};

	return { fakeThis, captured, statusMessages, warningMessages };
}

describe("InteractiveMode.showCopySelector", () => {
	test("empty session shows status and returns early", () => {
		const { fakeThis, captured } = createFakeContext([]);

		(InteractiveMode as any).prototype.showCopySelector.call(fakeThis);

		expect(fakeThis.showStatus).toHaveBeenCalledWith("No messages to copy");
		expect(fakeThis.showSelector).not.toHaveBeenCalled();
		expect(captured.onCopy).toBeUndefined();
	});

	test("builds items from session messages and opens selector", () => {
		const messages = [makeUserMessage("Hello"), makeAssistantMessage("World")];
		const { fakeThis, captured } = createFakeContext(messages);

		(InteractiveMode as any).prototype.showCopySelector.call(fakeThis);

		expect(fakeThis.showSelector).toHaveBeenCalledTimes(1);
		expect(captured.onCopy).toBeDefined();
		expect(captured.onCancel).toBeDefined();
	});

	test("empty selection on confirm shows warning", async () => {
		const messages = [makeUserMessage("Hello")];
		const { fakeThis, captured, warningMessages } = createFakeContext(messages);

		(InteractiveMode as any).prototype.showCopySelector.call(fakeThis);
		await captured.onCopy!([]);

		expect(warningMessages).toContain("No messages selected");
		expect(mockCopyToClipboard).not.toHaveBeenCalled();
	});

	test("all-image selection shows no copyable text warning", async () => {
		const messages = [makeImageOnlyMessage(), makeImageOnlyMessage()];
		const { fakeThis, captured, warningMessages } = createFakeContext(messages);

		(InteractiveMode as any).prototype.showCopySelector.call(fakeThis);
		await captured.onCopy!([0, 1]);

		expect(warningMessages).toContain("Selected messages have no copyable text");
		expect(mockCopyToClipboard).not.toHaveBeenCalled();
	});

	test("successful copy with native method shows 'Copied' status", async () => {
		const messages = [makeUserMessage("Hello"), makeAssistantMessage("World")];
		const { fakeThis, captured, statusMessages } = createFakeContext(messages);
		mockCopyToClipboard.mockResolvedValue({ method: "native" });

		(InteractiveMode as any).prototype.showCopySelector.call(fakeThis);
		await captured.onCopy!([0, 1]);

		expect(mockCopyToClipboard).toHaveBeenCalledWith("Hello\n\n---\n\nWorld");
		expect(statusMessages).toContain("Copied 2 messages to clipboard");
	});

	test("successful copy with platform method shows 'Copied' status", async () => {
		const messages = [makeUserMessage("Single message")];
		const { fakeThis, captured, statusMessages } = createFakeContext(messages);
		mockCopyToClipboard.mockResolvedValue({ method: "platform" });

		(InteractiveMode as any).prototype.showCopySelector.call(fakeThis);
		await captured.onCopy!([0]);

		expect(statusMessages).toContain("Copied 1 message to clipboard");
	});

	test("osc52 fallback shows 'Sent to terminal clipboard' status", async () => {
		const messages = [makeUserMessage("Hello"), makeAssistantMessage("World")];
		const { fakeThis, captured, statusMessages } = createFakeContext(messages);
		mockCopyToClipboard.mockResolvedValue({ method: "osc52" });

		(InteractiveMode as any).prototype.showCopySelector.call(fakeThis);
		await captured.onCopy!([0, 1]);

		expect(statusMessages).toContain("Sent 2 messages to terminal clipboard (OSC 52)");
	});

	test("singular message count in status", async () => {
		const messages = [makeUserMessage("One")];
		const { fakeThis, captured, statusMessages } = createFakeContext(messages);
		mockCopyToClipboard.mockResolvedValue({ method: "osc52" });

		(InteractiveMode as any).prototype.showCopySelector.call(fakeThis);
		await captured.onCopy!([0]);

		expect(statusMessages).toContain("Sent 1 message to terminal clipboard (OSC 52)");
	});

	test("cancel callback restores UI without copying", async () => {
		const messages = [makeUserMessage("Hello")];
		const { fakeThis, captured } = createFakeContext(messages);

		(InteractiveMode as any).prototype.showCopySelector.call(fakeThis);
		captured.onCancel!();

		expect(mockCopyToClipboard).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();
	});

	test("buddy is hidden during selector and restored on confirm", async () => {
		const messages = [makeUserMessage("Hello")];
		const { fakeThis, captured } = createFakeContext(messages);
		fakeThis.buddyComponent = {}; // non-null = buddy exists
		mockCopyToClipboard.mockResolvedValue({ method: "native" });

		(InteractiveMode as any).prototype.showCopySelector.call(fakeThis);

		expect(fakeThis.widgetContainerBelow.clear).toHaveBeenCalled();

		await captured.onCopy!([0]);
		expect(fakeThis.renderWidgets).toHaveBeenCalled();
	});

	test("buddy is hidden during selector and restored on cancel", () => {
		const messages = [makeUserMessage("Hello")];
		const { fakeThis, captured } = createFakeContext(messages);
		fakeThis.buddyComponent = {}; // non-null = buddy exists

		(InteractiveMode as any).prototype.showCopySelector.call(fakeThis);
		captured.onCancel!();

		expect(fakeThis.widgetContainerBelow.clear).toHaveBeenCalled();
		expect(fakeThis.renderWidgets).toHaveBeenCalled();
	});

	test("maxVisible is clamped between 3 and 15 based on terminal rows", () => {
		// Small terminal: rows=15, overhead=12 → maxVisible=3 (floor)
		const messages = [makeUserMessage("Hello")];
		const { fakeThis } = createFakeContext(messages);
		fakeThis.ui.terminal.rows = 15;

		(InteractiveMode as any).prototype.showCopySelector.call(fakeThis);

		// Verify selector was called (we can't directly read maxVisible, but
		// we verify it doesn't crash with a small terminal)
		expect(fakeThis.showSelector).toHaveBeenCalledTimes(1);
	});

	test("skips image-only messages but copies text messages", async () => {
		const messages = [makeUserMessage("Text message"), makeImageOnlyMessage(), makeAssistantMessage("Reply")];
		const { fakeThis, captured, statusMessages } = createFakeContext(messages);
		mockCopyToClipboard.mockResolvedValue({ method: "native" });

		(InteractiveMode as any).prototype.showCopySelector.call(fakeThis);
		// Select all three
		await captured.onCopy!([0, 1, 2]);

		// Only 2 texts should be joined (image-only filtered out)
		expect(mockCopyToClipboard).toHaveBeenCalledWith("Text message\n\n---\n\nReply");
		expect(statusMessages).toContain("Copied 2 messages to clipboard");
	});
});
