import { describe, expect, it, vi } from "vitest";
import type { AskResult } from "../src/core/extensions/types.js";
import {
	cancelPendingRpcExtensionRequests,
	createRpcExtensionUIContext,
	type PendingRpcExtensionRequest,
} from "../src/modes/rpc/rpc-mode.js";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../src/modes/rpc/rpc-types.js";

/**
 * Round-trip tests for the RPC `ask` batch wizard: request emission, response
 * mapping, cancellation, timeout, abort, and cleanup dedup. These exercise
 * `createRpcExtensionUIContext` directly (no CLI spawn) so the transport is
 * verified deterministically.
 */
function harness() {
	const emitted: RpcExtensionUIRequest[] = [];
	const handled: string[] = [];
	const pending = new Map<string, PendingRpcExtensionRequest>();
	const onAskStop = vi.fn();
	const output = (obj: any) => {
		if (obj?.type === "extension_ui_request") emitted.push(obj as RpcExtensionUIRequest);
		else if (obj?.type === "extension_ui_response_handled") handled.push(obj.id as string);
	};
	const ctx = createRpcExtensionUIContext(output, pending, onAskStop);
	// The only emitted request in these tests is the ask, so its id is the map key.
	const lastRequestId = () => emitted[emitted.length - 1]!.id;
	const respond = (response: Omit<RpcExtensionUIResponse, "id" | "type">) => {
		const id = lastRequestId();
		pending.get(id)?.resolve({ type: "extension_ui_response", id, ...response } as RpcExtensionUIResponse);
	};
	return { ctx, emitted, handled, pending, onAskStop, lastRequestId, respond };
}

describe("RPC ask batch round trip", () => {
	it("emits a single extension_ui_request carrying every question and defaults the title", async () => {
		const h = harness();
		const p = h.ctx.ask({
			questions: [
				{
					question: "Which DB?",
					title: "Storage",
					options: ["SQLite", "Postgres"],
					allowFreeText: true,
					multiSelect: false,
					multiline: false,
				},
				{ question: "Anything else?", multiline: true },
			],
		});
		expect(h.emitted).toHaveLength(1);
		const req = h.emitted[0] as Extract<RpcExtensionUIRequest, { method: "ask" }>;
		expect(req).toMatchObject({
			type: "extension_ui_request",
			method: "ask",
			title: "Question",
		});
		expect(req.questions).toHaveLength(2);
		expect(req.questions[0]).toMatchObject({
			question: "Which DB?",
			title: "Storage",
			options: ["SQLite", "Postgres"],
			allowFreeText: true,
			multiSelect: false,
			multiline: false,
		});
		expect(req.questions[1]).toMatchObject({ question: "Anything else?", multiline: true });
		expect(typeof req.id).toBe("string");
		h.respond({ answers: [{ selected: ["SQLite"] }, { selected: [], skipped: true }] } as any);
		await p;
	});

	it("emits the auto-skip duration and absolute deadline in the ask request", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		try {
			const h = harness();
			const p = h.ctx.ask({ questions: [{ question: "Which?", options: ["a"] }] }, { timeout: 30_000 });
			// The absolute deadline keeps a recovered Dashboard countdown aligned
			// with the already-running authoritative RPC timer.
			expect(h.emitted[0]).toMatchObject({ timeout: 30_000, expiresAt: 1_030_000 });
			h.respond({ answers: [{ selected: ["a"] }] } as any);
			await p;
		} finally {
			now.mockRestore();
		}
	});

	it("omits the timeout and deadline when none is provided", async () => {
		const h = harness();
		const p = h.ctx.ask({ questions: [{ question: "Which?", options: ["a"] }] });
		expect(h.emitted[0]).toMatchObject({ timeout: undefined, expiresAt: undefined });
		h.respond({ answers: [{ selected: ["a"] }] } as any);
		await p;
	});

	it("uses the provided title when set", async () => {
		const h = harness();
		const p = h.ctx.ask({ title: "Pick storage", questions: [{ question: "Which DB?", options: ["a"] }] });
		expect((h.emitted[0] as any).title).toBe("Pick storage");
		h.respond({ answers: [{ selected: ["a"] }] } as any);
		await p;
	});

	it("retains the emitted request payload while waiting for a response", async () => {
		const h = harness();
		const p = h.ctx.ask({ questions: [{ question: "Which?", options: ["a", "b"] }] });
		const id = h.lastRequestId();
		expect(h.pending.get(id)?.request).toBe(h.emitted[0]);
		h.respond({ answers: [{ selected: ["a"] }] } as any);
		await p;
	});

	it("maps a batch of answers into an AskResult, deriving skipped for empty entries", async () => {
		const h = harness();
		const p = h.ctx.ask({
			questions: [{ question: "Which?", options: ["a", "b"] }, { question: "Notes?" }, { question: "Other?" }],
		});
		h.respond({
			answers: [{ selected: ["b"], customText: "duckdb" }, { selected: [] }, { selected: [], customText: "   " }],
		} as any);
		const result = (await p) as AskResult;
		expect(result.answers).toHaveLength(3);
		expect(result.answers[0]).toMatchObject({ selected: ["b"], customText: "duckdb", skipped: false });
		// An empty answer is derived as skipped even without an explicit flag.
		expect(result.answers[1]).toMatchObject({ selected: [], skipped: true });
		// Whitespace-only custom text also counts as no answer.
		expect(result.answers[2]).toMatchObject({ selected: [], skipped: true });
	});

	it("stops the agent turn when the host cancels the ask", async () => {
		const h = harness();
		const p = h.ctx.ask({ questions: [{ question: "Which?", options: ["a"] }] });
		h.respond({ cancelled: true } as any);
		await expect(p).resolves.toBeUndefined();
		expect(h.onAskStop).toHaveBeenCalledTimes(1);
	});

	it("resolves an all-skipped batch without stopping the turn", async () => {
		// Answering with everything skipped is a valid submit, not a stop.
		const h = harness();
		const p = h.ctx.ask({ questions: [{ question: "Which?", options: ["a"] }] });
		h.respond({ answers: [{ selected: [] }] } as any);
		const result = (await p) as AskResult;
		expect(result.answers[0].skipped).toBe(true);
		expect(h.onAskStop).not.toHaveBeenCalled();
	});

	it.each([
		{ answers: "not-an-array" },
		{ answers: [{ selected: null }] },
		{ answers: [{ selected: ["a", 2] }] },
		{ answers: [{ selected: ["a"], customText: 42 }] },
		{ value: "wrong response variant" },
	])("rejects a malformed ask response: %o", async (response) => {
		const h = harness();
		const p = h.ctx.ask({ questions: [{ question: "Which?", options: ["a"] }] });
		const id = h.lastRequestId();
		h.pending.get(id)?.resolve({ type: "extension_ui_response", id, ...response } as any);
		await expect(p).rejects.toThrow("Invalid RPC ask response");
		expect(h.handled).toEqual([id]);
		expect(h.pending.has(id)).toBe(false);
	});

	it("emits extension_ui_response_handled exactly once on response and clears the pending entry", async () => {
		const h = harness();
		const p = h.ctx.ask({ questions: [{ question: "Which?", options: ["a"] }] });
		const id = h.lastRequestId();
		h.respond({ answers: [{ selected: ["a"] }] } as any);
		await p;
		expect(h.handled).toEqual([id]);
		expect(h.pending.has(id)).toBe(false);
	});

	it("ignores a duplicate/late response after the first settles", async () => {
		const h = harness();
		const p = h.ctx.ask({ questions: [{ question: "Which?", options: ["a", "b"] }] });
		const id = h.lastRequestId();
		const pending = h.pending.get(id)!;
		pending.resolve({ type: "extension_ui_response", id, answers: [{ selected: ["a"] }] });
		const result = (await p) as AskResult;
		// Second resolve must be a no-op (settled guard) — no throw, no re-handle.
		pending.resolve({ type: "extension_ui_response", id, answers: [{ selected: ["b"] }] });
		expect(result.answers[0]).toMatchObject({ selected: ["a"], skipped: false });
		expect(h.handled).toEqual([id]);
	});

	it("resolves undefined without emitting when the signal is already aborted", async () => {
		const h = harness();
		const controller = new AbortController();
		controller.abort();
		const p = h.ctx.ask({ questions: [{ question: "Which?", options: ["a"] }] }, { signal: controller.signal });
		await expect(p).resolves.toBeUndefined();
		expect(h.emitted).toHaveLength(0);
	});

	it("resolves undefined and cleans up when the signal aborts while pending", async () => {
		const h = harness();
		const controller = new AbortController();
		const p = h.ctx.ask({ questions: [{ question: "Which?", options: ["a"] }] }, { signal: controller.signal });
		const id = h.lastRequestId();
		expect(h.pending.has(id)).toBe(true);
		controller.abort();
		await expect(p).resolves.toBeUndefined();
		expect(h.handled).toEqual([id]);
		expect(h.pending.has(id)).toBe(false);
	});

	it("cancels pending dialogs exactly once during RPC shutdown", async () => {
		// Uses two non-serialized dialog types so both are concurrently pending;
		// ask requests serialize (covered separately below).
		const h = harness();
		const first = h.ctx.select("Pick", ["a", "b"]);
		const firstId = h.emitted[0]!.id;
		const second = h.ctx.input("Name");
		const secondId = h.emitted[1]!.id;

		cancelPendingRpcExtensionRequests(h.pending);

		await expect(first).resolves.toBeUndefined();
		await expect(second).resolves.toBeUndefined();
		expect(h.pending.size).toBe(0);
		expect(h.handled).toEqual([firstId, secondId]);
		cancelPendingRpcExtensionRequests(h.pending);
		expect(h.handled).toEqual([firstId, secondId]);
	});

	it("serializes concurrent ask requests so only one wizard is pending at a time", async () => {
		// Regression for the concurrent-ask hang: tool execution is parallel, so a
		// turn can issue several ask_user calls at once. Only one ask request may be
		// emitted at a time (mirroring the TUI's single-dialog queue) so the Dashboard,
		// which renders a single pending ask, never leaves a question invisible/hung.
		const h = harness();
		const first = h.ctx.ask({ questions: [{ question: "First?", options: ["a"] }] });
		expect(h.emitted).toHaveLength(1);
		const firstId = h.emitted[0]!.id;

		const second = h.ctx.ask({ questions: [{ question: "Second?", options: ["b"] }] });
		// The second ask is queued and must NOT emit while the first is pending.
		expect(h.emitted).toHaveLength(1);
		expect(h.pending.size).toBe(1);

		// Answering the first lets the queued second emit.
		h.pending
			.get(firstId)!
			.resolve({ type: "extension_ui_response", id: firstId, answers: [{ selected: ["a"] }] } as any);
		await first;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(h.emitted).toHaveLength(2);
		const secondId = h.emitted[1]!.id;
		expect(secondId).not.toBe(firstId);

		h.pending
			.get(secondId)!
			.resolve({ type: "extension_ui_response", id: secondId, answers: [{ selected: ["b"] }] } as any);
		await expect(second).resolves.toEqual({ answers: [{ selected: ["b"], customText: undefined, skipped: false }] });
	});

	it("settles a queued concurrent ask without emitting when the turn signal aborts", async () => {
		const h = harness();
		const controller = new AbortController();
		const first = h.ctx.ask({ questions: [{ question: "First?", options: ["a"] }] }, { signal: controller.signal });
		const second = h.ctx.ask({ questions: [{ question: "Second?", options: ["b"] }] }, { signal: controller.signal });
		expect(h.emitted).toHaveLength(1); // second is queued behind the first

		controller.abort(); // turn stop / shutdown aborts the shared signal

		await expect(first).resolves.toBeUndefined();
		await expect(second).resolves.toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The queued second never emitted — no orphaned request, no hang.
		expect(h.emitted).toHaveLength(1);
		expect(h.pending.size).toBe(0);
	});

	it("resolves undefined on timeout and emits the handled event", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const p = h.ctx.ask({ questions: [{ question: "Which?", options: ["a"] }] }, { timeout: 50 });
			const id = h.lastRequestId();
			vi.advanceTimersByTime(50);
			await expect(p).resolves.toBeUndefined();
			expect(h.handled).toEqual([id]);
			expect(h.pending.has(id)).toBe(false);
			expect(h.onAskStop).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
