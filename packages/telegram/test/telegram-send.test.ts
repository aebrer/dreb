/**
 * Tests for safeSend, sendLong, and withTimeout in telegram.ts.
 *
 * Uses mock Api objects that simulate Telegram API responses
 * without actual network calls.
 */

import { describe, expect, it, vi } from "vitest";
import { safeSend, sendLong, withTimeout } from "../src/util/telegram.js";

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

describe("withTimeout", () => {
	it("resolves when promise settles before timeout", async () => {
		const result = await withTimeout(Promise.resolve(42), 1000);
		expect(result).toBe(42);
	});

	it("rejects when promise exceeds timeout", async () => {
		const slow = new Promise<number>((resolve) => setTimeout(() => resolve(42), 5000));
		await expect(withTimeout(slow, 50)).rejects.toThrow("Telegram API timeout after 50ms");
	});

	it("clears timer after successful resolution (no timer leak)", async () => {
		const clearSpy = vi.spyOn(global, "clearTimeout");
		await withTimeout(Promise.resolve("ok"), 15_000);
		expect(clearSpy).toHaveBeenCalled();
		clearSpy.mockRestore();
	});

	it("clears timer after rejection", async () => {
		const clearSpy = vi.spyOn(global, "clearTimeout");
		await withTimeout(Promise.reject(new Error("boom")), 15_000).catch(() => {});
		expect(clearSpy).toHaveBeenCalled();
		clearSpy.mockRestore();
	});

	it("propagates the original rejection error", async () => {
		const err = new Error("original error");
		await expect(withTimeout(Promise.reject(err), 1000)).rejects.toThrow("original error");
	});
});

// ---------------------------------------------------------------------------
// Mock API helpers
// ---------------------------------------------------------------------------

/** Create a mock Api with configurable sendMessage behavior */
function mockApi(sendFn: (chatId: number, text: string, opts?: any) => any): any {
	return {
		sendMessage: vi.fn(sendFn),
		editMessageText: vi.fn(),
		deleteMessage: vi.fn(),
	};
}

/** Simulate a successful Telegram send returning a message_id */
function successApi(startId = 100): any {
	let nextId = startId;
	return mockApi((_chatId, _text) => Promise.resolve({ message_id: nextId++ }));
}

/** Simulate a Telegram API that always fails */
function failApi(error?: Error): any {
	return mockApi(() => Promise.reject(error || new Error("network error")));
}

/**
 * Simulate a Telegram API that returns a 400 parse error on Markdown,
 * then succeeds on plain text retry.
 */
function markdownFailApi(startId = 100): any {
	let nextId = startId;
	return mockApi((_chatId, _text, opts) => {
		if (opts?.parse_mode === "Markdown") {
			const err: any = new Error("Bad Request: can't parse entities");
			err.error_code = 400;
			return Promise.reject(err);
		}
		return Promise.resolve({ message_id: nextId++ });
	});
}

// ---------------------------------------------------------------------------
// safeSend
// ---------------------------------------------------------------------------

describe("safeSend", () => {
	it("returns message_id on success", async () => {
		const api = successApi(42);
		const id = await safeSend(api, 1, "hello");
		expect(id).toBe(42);
	});

	it("falls back to plain text on Markdown parse error (400)", async () => {
		const api = markdownFailApi(55);
		const id = await safeSend(api, 1, "**bad markdown");
		expect(id).toBe(55);
		// Should have been called twice: Markdown then plain
		expect(api.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("does NOT retry as plain text on timeout/network error", async () => {
		// Simulates a timeout — not a parse error, so should return 0 without retry
		const api = mockApi(() => Promise.reject(new Error("Telegram API timeout after 15000ms")));
		const id = await safeSend(api, 1, "hello");
		expect(id).toBe(0);
		// Only one attempt — no plain-text fallback
		expect(api.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("does NOT retry as plain text on generic network error", async () => {
		const api = failApi(new Error("ECONNRESET"));
		const id = await safeSend(api, 1, "hello");
		expect(id).toBe(0);
		expect(api.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("returns 0 when both Markdown and plain text fail (parse error path)", async () => {
		const api = mockApi(() => Promise.reject(Object.assign(new Error("parse error"), { error_code: 400 })));
		const id = await safeSend(api, 1, "hello");
		expect(id).toBe(0);
		// Two attempts: Markdown parse error → plain text also fails
		expect(api.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("truncates text longer than 4000 chars", async () => {
		const api = successApi();
		const longText = "x".repeat(5000);
		await safeSend(api, 1, longText);
		const sentText = api.sendMessage.mock.calls[0][1];
		expect(sentText.length).toBeLessThanOrEqual(4000);
		expect(sentText).toContain("_(truncated)_");
	});
});

// ---------------------------------------------------------------------------
// sendLong
// ---------------------------------------------------------------------------

describe("sendLong", () => {
	it("returns empty string when all text is delivered", async () => {
		const api = successApi();
		const remaining = await sendLong(api, 1, "short message");
		expect(remaining).toBe("");
	});

	it("splits long text into chunks and delivers all", async () => {
		const api = successApi();
		// Create text that requires multiple chunks (>4000 chars)
		const longText = Array.from({ length: 3 }, (_, i) => `chunk${i}\n${"x".repeat(3000)}`).join("\n");
		const remaining = await sendLong(api, 1, longText);
		expect(remaining).toBe("");
		expect(api.sendMessage.mock.calls.length).toBeGreaterThan(1);
	});

	it("returns remaining text on first chunk failure", async () => {
		// Fails immediately — all text is remaining
		const api = failApi();
		const text = "hello world";
		const remaining = await sendLong(api, 1, text);
		expect(remaining).toBe(text);
	});

	it("stops on mid-delivery failure and returns only undelivered text", async () => {
		let callCount = 0;
		const api = mockApi(() => {
			callCount++;
			if (callCount <= 1) {
				// First chunk succeeds
				return Promise.resolve({ message_id: callCount });
			}
			// Second chunk fails
			return Promise.reject(new Error("network error"));
		});

		// Build text that needs 2+ chunks
		const chunk1 = "A".repeat(3500) + "\n";
		const chunk2 = "B".repeat(3500);
		const fullText = chunk1 + chunk2;

		const remaining = await sendLong(api, 1, fullText);
		// Should return non-empty (the undelivered tail)
		expect(remaining).not.toBe("");
		expect(remaining.length).toBeLessThan(fullText.length);
		// The remaining should contain the second chunk's content
		expect(remaining).toContain("B");
		// The first chunk should NOT be in the remaining (already delivered)
		expect(remaining.startsWith("A".repeat(3500))).toBe(false);
	});

	it("returns empty string for empty input", async () => {
		const api = successApi();
		const remaining = await sendLong(api, 1, "");
		expect(remaining).toBe("");
	});
});
