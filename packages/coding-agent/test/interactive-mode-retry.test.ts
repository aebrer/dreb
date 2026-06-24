import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * Tests for the stream_retry and length_retry event handlers in InteractiveMode.
 *
 * The key invariant: neither handler should clear the explicit agent-working state.
 * Keeping that state alive means ESC hits the default agent-working branch → `agent.abort()`,
 * which fires the same AbortController threaded through the retry backoff sleep in
 * agent-loop.ts. ESC cancels cleanly with no special wiring.
 */

async function dispatchEvent(fakeThis: object, event: object): Promise<void> {
	return (InteractiveMode as any).prototype.handleEvent.call(fakeThis, event);
}

function makeFakeThis(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		// Required by handleEvent() before the switch
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		// State accessed by stream_retry / length_retry cases
		chatContainer: { removeChild: vi.fn(), addChild: vi.fn() },
		isAgentWorking: true,
		retryLoader: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		// showWarning is called inside the handlers — mock it to isolate the assertion
		showWarning: vi.fn(),
		...overrides,
	};
}

describe("stream_retry handler", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("does not clear the agent-working state", async () => {
		const fakeThis = makeFakeThis();

		await dispatchEvent(fakeThis, {
			type: "stream_retry",
			attempt: 1,
			maxAttempts: 3,
			error: "connection reset",
		});

		expect(fakeThis.isAgentWorking).toBe(true);
	});

	test("does not create a retryLoader", async () => {
		const fakeThis = makeFakeThis();

		await dispatchEvent(fakeThis, {
			type: "stream_retry",
			attempt: 1,
			maxAttempts: 3,
			error: "connection reset",
		});

		expect(fakeThis.retryLoader).toBeUndefined();
	});

	test("calls showWarning with attempt and maxAttempts", async () => {
		const fakeThis = makeFakeThis();

		await dispatchEvent(fakeThis, {
			type: "stream_retry",
			attempt: 2,
			maxAttempts: 3,
			error: "connection reset",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		const message = (fakeThis.showWarning as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
		expect(message).toContain("2");
		expect(message).toContain("3");
	});

	test("removes ghost streamingComponent and clears streamingMessage", async () => {
		const mockComponent = { render: () => [], invalidate: () => {} };
		const fakeThis = makeFakeThis({
			streamingComponent: mockComponent,
			streamingMessage: "partial assistant text",
		});

		await dispatchEvent(fakeThis, {
			type: "stream_retry",
			attempt: 1,
			maxAttempts: 3,
			error: "connection reset",
		});

		expect((fakeThis.chatContainer as any).removeChild).toHaveBeenCalledWith(mockComponent);
		expect(fakeThis.streamingComponent).toBeUndefined();
		expect(fakeThis.streamingMessage).toBeUndefined();
	});

	test("removes pending tool components and clears the map", async () => {
		const mockTool = { render: () => [], invalidate: () => {} };
		const pendingTools = new Map([["tool-1", mockTool]]);
		const fakeThis = makeFakeThis({ pendingTools });

		await dispatchEvent(fakeThis, {
			type: "stream_retry",
			attempt: 1,
			maxAttempts: 3,
			error: "connection reset",
		});

		expect((fakeThis.chatContainer as any).removeChild).toHaveBeenCalledWith(mockTool);
		expect((fakeThis.pendingTools as Map<string, unknown>).size).toBe(0);
	});

	test("does not call chatContainer.removeChild when streamingComponent is absent", async () => {
		const fakeThis = makeFakeThis({ streamingComponent: undefined, pendingTools: new Map() });

		await dispatchEvent(fakeThis, {
			type: "stream_retry",
			attempt: 1,
			maxAttempts: 3,
			error: "connection reset",
		});

		expect((fakeThis.chatContainer as any).removeChild).not.toHaveBeenCalled();
	});
});

describe("length_retry handler", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("does not clear the agent-working state", async () => {
		const fakeThis = makeFakeThis();

		await dispatchEvent(fakeThis, {
			type: "length_retry",
			attempt: 1,
			maxAttempts: 2,
			previousMaxTokens: 4096,
			nextMaxTokens: 8192,
		});

		expect(fakeThis.isAgentWorking).toBe(true);
	});

	test("does not create a retryLoader", async () => {
		const fakeThis = makeFakeThis();

		await dispatchEvent(fakeThis, {
			type: "length_retry",
			attempt: 1,
			maxAttempts: 2,
			previousMaxTokens: 4096,
			nextMaxTokens: 8192,
		});

		expect(fakeThis.retryLoader).toBeUndefined();
	});

	test("calls showWarning with attempt and maxAttempts", async () => {
		const fakeThis = makeFakeThis();

		await dispatchEvent(fakeThis, {
			type: "length_retry",
			attempt: 1,
			maxAttempts: 2,
			previousMaxTokens: 4096,
			nextMaxTokens: 8192,
		});

		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		const message = (fakeThis.showWarning as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
		expect(message).toContain("1");
		expect(message).toContain("2");
	});

	test("removes ghost streamingComponent and clears streamingMessage", async () => {
		const mockComponent = { render: () => [], invalidate: () => {} };
		const fakeThis = makeFakeThis({
			streamingComponent: mockComponent,
			streamingMessage: "partial truncated text",
		});

		await dispatchEvent(fakeThis, {
			type: "length_retry",
			attempt: 1,
			maxAttempts: 2,
			previousMaxTokens: 4096,
			nextMaxTokens: 8192,
		});

		expect((fakeThis.chatContainer as any).removeChild).toHaveBeenCalledWith(mockComponent);
		expect(fakeThis.streamingComponent).toBeUndefined();
		expect(fakeThis.streamingMessage).toBeUndefined();
	});

	test("removes pending tool components and clears the map", async () => {
		const mockTool = { render: () => [], invalidate: () => {} };
		const pendingTools = new Map([["tool-1", mockTool]]);
		const fakeThis = makeFakeThis({ pendingTools });

		await dispatchEvent(fakeThis, {
			type: "length_retry",
			attempt: 1,
			maxAttempts: 2,
			previousMaxTokens: 4096,
			nextMaxTokens: 8192,
		});

		expect((fakeThis.chatContainer as any).removeChild).toHaveBeenCalledWith(mockTool);
		expect((fakeThis.pendingTools as Map<string, unknown>).size).toBe(0);
	});

	test("does not call chatContainer.removeChild when streamingComponent is absent", async () => {
		const fakeThis = makeFakeThis({ streamingComponent: undefined, pendingTools: new Map() });

		await dispatchEvent(fakeThis, {
			type: "length_retry",
			attempt: 1,
			maxAttempts: 2,
			previousMaxTokens: 4096,
			nextMaxTokens: 8192,
		});

		expect((fakeThis.chatContainer as any).removeChild).not.toHaveBeenCalled();
	});
});
