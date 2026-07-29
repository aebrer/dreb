import { describe, expect, it, vi } from "vitest";
import type { AskResult } from "../src/core/extensions/types.js";
import {
	cancelPendingRpcExtensionRequests,
	createRpcExtensionUIContext,
	type PendingRpcExtensionRequest,
} from "../src/modes/rpc/rpc-mode.js";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../src/modes/rpc/rpc-types.js";

/**
 * Round-trip tests for the RPC `ask` dialog: request emission, response
 * mapping, cancellation, timeout, abort, and cleanup dedup. These exercise
 * `createRpcExtensionUIContext` directly (no CLI spawn) so the transport is
 * verified deterministically.
 */
function harness() {
	const emitted: RpcExtensionUIRequest[] = [];
	const handled: string[] = [];
	const pending = new Map<string, PendingRpcExtensionRequest>();
	const output = (obj: any) => {
		if (obj?.type === "extension_ui_request") emitted.push(obj as RpcExtensionUIRequest);
		else if (obj?.type === "extension_ui_response_handled") handled.push(obj.id as string);
	};
	const ctx = createRpcExtensionUIContext(output, pending);
	// The only emitted request in these tests is the ask, so its id is the map key.
	const lastRequestId = () => emitted[emitted.length - 1]!.id;
	const respond = (response: Omit<RpcExtensionUIResponse, "id" | "type">) => {
		const id = lastRequestId();
		pending.get(id)?.resolve({ type: "extension_ui_response", id, ...response } as RpcExtensionUIResponse);
	};
	return { ctx, emitted, handled, pending, lastRequestId, respond };
}

describe("RPC ask round trip", () => {
	it("emits an extension_ui_request with all ask fields and defaults the title", async () => {
		const h = harness();
		const p = h.ctx.ask({
			question: "Which DB?",
			options: ["SQLite", "Postgres"],
			allowFreeText: true,
			multiSelect: false,
			multiline: false,
		});
		expect(h.emitted).toHaveLength(1);
		const req = h.emitted[0]!;
		expect(req).toMatchObject({
			type: "extension_ui_request",
			method: "ask",
			title: "Question",
			question: "Which DB?",
			options: ["SQLite", "Postgres"],
			allowFreeText: true,
			multiSelect: false,
			multiline: false,
		});
		expect(typeof req.id).toBe("string");
		h.respond({ selected: ["SQLite"] } as any);
		await p;
	});

	it("uses the provided title when set", async () => {
		const h = harness();
		const p = h.ctx.ask({ title: "Pick storage", question: "Which DB?", options: ["a"] });
		expect((h.emitted[0] as any).title).toBe("Pick storage");
		h.respond({ selected: ["a"] } as any);
		await p;
	});

	it("retains the emitted request payload while waiting for a response", async () => {
		const h = harness();
		const p = h.ctx.ask({ question: "Which?", options: ["a", "b"] });
		const id = h.lastRequestId();
		expect(h.pending.get(id)?.request).toBe(h.emitted[0]);
		h.respond({ selected: ["a"] } as any);
		await p;
	});

	it("maps a selected + customText response into an AskResult", async () => {
		const h = harness();
		const p = h.ctx.ask({ question: "Which?", options: ["a", "b"] });
		h.respond({ selected: ["b"], customText: "duckdb" } as any);
		const result = (await p) as AskResult;
		expect(result).toEqual({ selected: ["b"], customText: "duckdb" });
	});

	it("maps a cancelled response to undefined (skip)", async () => {
		const h = harness();
		const p = h.ctx.ask({ question: "Which?", options: ["a"] });
		h.respond({ cancelled: true } as any);
		await expect(p).resolves.toBeUndefined();
	});

	it("emits extension_ui_response_handled exactly once on response and clears the pending entry", async () => {
		const h = harness();
		const p = h.ctx.ask({ question: "Which?", options: ["a"] });
		const id = h.lastRequestId();
		h.respond({ selected: ["a"] } as any);
		await p;
		expect(h.handled).toEqual([id]);
		expect(h.pending.has(id)).toBe(false);
	});

	it("ignores a duplicate/late response after the first settles", async () => {
		const h = harness();
		const p = h.ctx.ask({ question: "Which?", options: ["a", "b"] });
		const id = h.lastRequestId();
		const pending = h.pending.get(id)!;
		pending.resolve({ type: "extension_ui_response", id, selected: ["a"] });
		const result = (await p) as AskResult;
		// Second resolve must be a no-op (settled guard) — no throw, no re-handle.
		pending.resolve({ type: "extension_ui_response", id, selected: ["b"] });
		expect(result).toEqual({ selected: ["a"], customText: undefined });
		expect(h.handled).toEqual([id]);
	});

	it("resolves undefined without emitting when the signal is already aborted", async () => {
		const h = harness();
		const controller = new AbortController();
		controller.abort();
		const p = h.ctx.ask({ question: "Which?", options: ["a"] }, { signal: controller.signal });
		await expect(p).resolves.toBeUndefined();
		expect(h.emitted).toHaveLength(0);
	});

	it("resolves undefined and cleans up when the signal aborts while pending", async () => {
		const h = harness();
		const controller = new AbortController();
		const p = h.ctx.ask({ question: "Which?", options: ["a"] }, { signal: controller.signal });
		const id = h.lastRequestId();
		expect(h.pending.has(id)).toBe(true);
		controller.abort();
		await expect(p).resolves.toBeUndefined();
		expect(h.handled).toEqual([id]);
		expect(h.pending.has(id)).toBe(false);
	});

	it("cancels pending dialogs exactly once during RPC shutdown", async () => {
		const h = harness();
		const first = h.ctx.ask({ question: "First?", options: ["a"] });
		const firstId = h.lastRequestId();
		const second = h.ctx.ask({ question: "Second?", options: ["b"] });
		const secondId = h.lastRequestId();

		cancelPendingRpcExtensionRequests(h.pending);

		await expect(first).resolves.toBeUndefined();
		await expect(second).resolves.toBeUndefined();
		expect(h.pending.size).toBe(0);
		expect(h.handled).toEqual([firstId, secondId]);
		cancelPendingRpcExtensionRequests(h.pending);
		expect(h.handled).toEqual([firstId, secondId]);
	});

	it("resolves undefined on timeout and emits the handled event", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const p = h.ctx.ask({ question: "Which?", options: ["a"] }, { timeout: 50 });
			const id = h.lastRequestId();
			vi.advanceTimersByTime(50);
			await expect(p).resolves.toBeUndefined();
			expect(h.handled).toEqual([id]);
			expect(h.pending.has(id)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
