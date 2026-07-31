import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { AskRequest, AskResult, ExtensionContext } from "../../src/core/extensions/types.js";
import { type AskUserDetails, createAskUserToolDefinition } from "../../src/core/tools/ask-user.js";

const mockTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

interface ExecResult {
	content: Array<{ type: string; text?: string }>;
	details?: AskUserDetails;
	endTurn?: boolean;
}

/** Build a ctx whose ui.ask returns a scripted answer (or undefined when closed). */
function makeCtx(
	ask: (request: AskRequest, opts?: { signal?: AbortSignal }) => Promise<AskResult | undefined>,
	hasUI = true,
): ExtensionContext {
	return { hasUI, ui: { ask } } as unknown as ExtensionContext;
}

function run(
	def: ReturnType<typeof createAskUserToolDefinition>,
	params: Record<string, unknown>,
	ctx?: ExtensionContext,
	signal?: AbortSignal,
): Promise<ExecResult> {
	return (def.execute as any)("call-1", params, signal, undefined, ctx) as Promise<ExecResult>;
}

describe("ask_user tool", () => {
	it("exposes narrow usage guidance in prompt metadata", () => {
		const def = createAskUserToolDefinition();
		expect(def.name).toBe("ask_user");
		expect(def.promptSnippet).toBeTruthy();
		const guidelines = (def.promptGuidelines as string[]).join(" ").toLowerCase();
		expect(guidelines).toContain("only");
		expect(guidelines).toContain("blocked");
		expect(guidelines).toContain("stop");
	});

	it("validates option bounds (2-4) and rejects blank options in its schema", () => {
		const def = createAskUserToolDefinition();
		const props = (def.parameters as any).properties;
		expect(props.options.minItems).toBe(2);
		expect(props.options.maxItems).toBe(4);
		expect(props.question.type).toBe("string");
		expect(Value.Check(def.parameters, { question: "Pick", options: ["A", "B"] })).toBe(true);
		expect(Value.Check(def.parameters, { question: "Pick", options: ["", "B"] })).toBe(false);
		expect(Value.Check(def.parameters, { question: "Pick", options: ["   ", "B"] })).toBe(false);
	});

	it("returns a graceful non-blocking result when no UI is available", async () => {
		const def = createAskUserToolDefinition();
		const ask = vi.fn();
		const result = await run(def, { question: "Which?" }, makeCtx(ask, false));
		expect(ask).not.toHaveBeenCalled();
		expect(result.details?.unavailable).toBe(true);
		expect(result.details?.skipped).toBe(true);
		expect(result.content[0].text).toContain("not available");
	});

	it("returns unavailable when ctx is entirely absent", async () => {
		const def = createAskUserToolDefinition();
		const result = await run(def, { question: "Which?" }, undefined);
		expect(result.details?.unavailable).toBe(true);
	});

	it("formats a single selected option", async () => {
		const def = createAskUserToolDefinition();
		const ctx = makeCtx(async () => ({ selected: ["SQLite"] }));
		const result = await run(def, { question: "DB?", options: ["SQLite", "Postgres"] }, ctx);
		expect(result.details?.skipped).toBe(false);
		expect(result.details?.selected).toEqual(["SQLite"]);
		expect(result.content[0].text).toBe("The user selected: SQLite");
	});

	it("combines multiple selections with custom text", async () => {
		const def = createAskUserToolDefinition();
		const ctx = makeCtx(async () => ({ selected: ["A", "B"], customText: "plus C" }));
		const result = await run(def, { question: "Pick", options: ["A", "B"], multiSelect: true }, ctx);
		expect(result.details?.selected).toEqual(["A", "B"]);
		expect(result.details?.customText).toBe("plus C");
		expect(result.content[0].text).toContain("The user selected: A, B");
		expect(result.content[0].text).toContain('They also wrote: "plus C"');
	});

	it("formats a free-text-only answer", async () => {
		const def = createAskUserToolDefinition();
		const ctx = makeCtx(async () => ({ selected: [], customText: "my own answer" }));
		const result = await run(def, { question: "Name?" }, ctx);
		expect(result.content[0].text).toBe('The user answered: "my own answer"');
	});

	it("reports an undefined host answer as closed without an answer", async () => {
		const def = createAskUserToolDefinition();
		const ctx = makeCtx(async () => undefined);
		const result = await run(def, { question: "Which?" }, ctx);
		expect(result.details?.skipped).toBe(true);
		expect(result.details?.unavailable).toBe(false);
		expect(result.content[0].text).toContain("closed without an answer");
	});

	it("treats an empty answer as closed without an answer", async () => {
		const def = createAskUserToolDefinition();
		const ctx = makeCtx(async () => ({ selected: [], customText: "   " }));
		const result = await run(def, { question: "Which?" }, ctx);
		expect(result.details?.skipped).toBe(true);
	});

	it("settles without opening UI when the signal is already aborted", async () => {
		const def = createAskUserToolDefinition();
		const ask = vi.fn(async () => ({ selected: ["x"] }));
		const controller = new AbortController();
		controller.abort();
		const result = await run(def, { question: "Which?" }, makeCtx(ask), controller.signal);
		expect(ask).not.toHaveBeenCalled();
		expect(result.details?.skipped).toBe(true);
		expect(result.details?.unavailable).toBe(false);
	});

	it("reports a host failure distinctly from a question closing", async () => {
		const def = createAskUserToolDefinition();
		const ctx = makeCtx(async () => {
			throw new Error("host exploded");
		});
		const result = await run(def, { question: "Which?" }, ctx);
		expect(result.details?.failed).toBe(true);
		expect(result.details?.skipped).toBe(false);
		expect(result.content[0].text).toContain("interactive UI or response protocol failed");
		expect(result.content[0].text).not.toContain("question closed");
	});

	it("serializes concurrent calls strictly one at a time (FIFO)", async () => {
		const def = createAskUserToolDefinition();
		let active = 0;
		let maxActive = 0;
		const order: string[] = [];
		const ctx = makeCtx(async (request) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 10));
			order.push(request.question);
			active -= 1;
			return { selected: [request.question] };
		});

		const results = await Promise.all([
			run(def, { question: "first" }, ctx),
			run(def, { question: "second" }, ctx),
			run(def, { question: "third" }, ctx),
		]);

		expect(maxActive).toBe(1); // never two questions open at once
		expect(order).toEqual(["first", "second", "third"]);
		expect(results.map((r) => r.details?.selected?.[0])).toEqual(["first", "second", "third"]);
	});

	it("releases the queue after a failure so later calls still run", async () => {
		const def = createAskUserToolDefinition();
		let calls = 0;
		const ctx = makeCtx(async (request) => {
			calls += 1;
			if (request.question === "boom") throw new Error("fail");
			return { selected: [request.question] };
		});
		const [first, second] = await Promise.all([
			run(def, { question: "boom" }, ctx),
			run(def, { question: "ok" }, ctx),
		]);
		expect(calls).toBe(2);
		expect(first.details?.failed).toBe(true);
		expect(first.details?.skipped).toBe(false);
		expect(second.details?.selected).toEqual(["ok"]);
	});

	it("passes the abort signal through to the UI layer", async () => {
		const def = createAskUserToolDefinition();
		const controller = new AbortController();
		let receivedSignal: AbortSignal | undefined;
		const ctx = makeCtx(async (_req, opts) => {
			receivedSignal = opts?.signal;
			return { selected: ["x"] };
		});
		await run(def, { question: "Which?" }, ctx, controller.signal);
		expect(receivedSignal).toBe(controller.signal);
	});

	it("always offers free text when there are no options (never an unanswerable question)", async () => {
		const def = createAskUserToolDefinition();
		let received: AskRequest | undefined;
		const ctx = makeCtx(async (request) => {
			received = request;
			return { selected: [], customText: "x" };
		});
		// allowFreeText:false with no options would leave only a Skip button —
		// the tool must normalize this so the question can always be answered.
		await run(def, { question: "Open ended?", allowFreeText: false }, ctx);
		expect(received?.allowFreeText).toBe(true);
	});

	it("drops multiSelect and preserves free text when there are no options", async () => {
		const def = createAskUserToolDefinition();
		let received: AskRequest | undefined;
		const ctx = makeCtx(async (request) => {
			received = request;
			return { selected: [], customText: "x" };
		});
		await run(def, { question: "Open ended?", multiSelect: true }, ctx);
		expect(received?.multiSelect).toBeUndefined();
		expect(received?.allowFreeText).toBe(true);
	});

	it("drops multiline when options exist and free text is disabled", async () => {
		const def = createAskUserToolDefinition();
		let received: AskRequest | undefined;
		const ctx = makeCtx(async (request) => {
			received = request;
			return { selected: ["a"] };
		});
		// With options and no free-text field there is no text area to make
		// multiline; the flag must be dropped rather than forwarded meaninglessly.
		await run(def, { question: "Pick?", options: ["a", "b"], allowFreeText: false, multiline: true }, ctx);
		expect(received?.multiline).toBeUndefined();
		expect(received?.allowFreeText).toBe(false);
	});

	it("preserves multiline for an open-ended question with no options", async () => {
		const def = createAskUserToolDefinition();
		let received: AskRequest | undefined;
		const ctx = makeCtx(async (request) => {
			received = request;
			return { selected: [], customText: "line1\nline2" };
		});
		// No options → free text is always offered, so a multiline request must
		// survive normalization (otherwise open-ended answers silently collapse
		// to a single-line input on both surfaces).
		await run(def, { question: "Describe the bug", multiline: true }, ctx);
		expect(received?.multiline).toBe(true);
		expect(received?.allowFreeText).toBe(true);
	});

	it("exposes a validated optional timeoutSeconds field in its schema", () => {
		const def = createAskUserToolDefinition();
		const props = (def.parameters as any).properties;
		expect(props.timeoutSeconds.minimum).toBe(5);
		expect(props.timeoutSeconds.maximum).toBe(3600);
	});

	it("forwards an optional timeout (seconds → milliseconds) to the UI layer", async () => {
		const def = createAskUserToolDefinition();
		let receivedOpts: { signal?: AbortSignal; timeout?: number } | undefined;
		const ctx = makeCtx(async (_req, opts) => {
			receivedOpts = opts;
			return { selected: ["x"] };
		});
		await run(def, { question: "?", options: ["a", "b"], timeoutSeconds: 30 }, ctx);
		expect(receivedOpts?.timeout).toBe(30_000);
	});

	it("passes no timeout when timeoutSeconds is omitted", async () => {
		const def = createAskUserToolDefinition();
		let receivedOpts: { signal?: AbortSignal; timeout?: number } | undefined;
		const ctx = makeCtx(async (_req, opts) => {
			receivedOpts = opts;
			return { selected: ["x"] };
		});
		await run(def, { question: "?", options: ["a", "b"] }, ctx);
		expect(receivedOpts?.timeout).toBeUndefined();
	});

	it("aborts a call while it waits in the queue without ever opening UI", async () => {
		const def = createAskUserToolDefinition();
		const asked: string[] = [];
		let releaseFirst!: (result: AskResult) => void;
		const firstGate = new Promise<AskResult>((resolve) => {
			releaseFirst = resolve;
		});
		const ctx = makeCtx(async (request) => {
			asked.push(request.question);
			if (request.question === "first") return firstGate; // hangs until released
			return { selected: [request.question] };
		});

		const controller = new AbortController();
		const first = run(def, { question: "first" }, ctx);
		const second = run(def, { question: "second" }, ctx, controller.signal);
		const third = run(def, { question: "third" }, ctx);

		// Let the active first call open its UI; the others must wait behind it.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(asked).toEqual(["first"]);

		// Abort the second call while it is genuinely queued behind the active one.
		controller.abort();
		// Release the first so the queue can advance to the queued calls.
		releaseFirst({ selected: ["first"] });

		const [r1, r2, r3] = await Promise.all([first, second, third]);
		expect(r1.details?.selected).toEqual(["first"]);
		// The queued-then-aborted call settles and never opened the UI.
		expect(r2.details?.skipped).toBe(true);
		expect(r2.details?.unavailable).toBe(false);
		// A later call still advances after the aborted one is dequeued.
		expect(r3.details?.selected).toEqual(["third"]);
		expect(asked).toEqual(["first", "third"]);
	});

	it("renders a call and result without throwing", () => {
		const def = createAskUserToolDefinition();
		const call = def.renderCall?.(
			{ question: "Which database?" } as any,
			mockTheme as any,
			{
				lastComponent: undefined,
			} as any,
		);
		expect(call).toBeDefined();

		const result = def.renderResult?.(
			{
				content: [{ type: "text", text: "done" }],
				details: { question: "q", selected: ["A"], skipped: false, unavailable: false },
			} as any,
			{} as any,
			mockTheme as any,
			{ lastComponent: undefined } as any,
		);
		expect(result).toBeDefined();
	});
});
