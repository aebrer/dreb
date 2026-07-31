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

/** Build a ctx whose ui.ask returns a scripted batch answer (or undefined when closed). */
function makeCtx(
	ask: (request: AskRequest, opts?: { signal?: AbortSignal; timeout?: number }) => Promise<AskResult | undefined>,
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

	it("validates the questions batch schema (1-10 questions, 2-4 nonblank options)", () => {
		const def = createAskUserToolDefinition();
		const props = (def.parameters as any).properties;
		expect(props.questions.minItems).toBe(1);
		expect(props.questions.maxItems).toBe(10);
		const question = props.questions.items;
		expect(question.properties.options.minItems).toBe(2);
		expect(question.properties.options.maxItems).toBe(4);
		expect(question.properties.options.items.pattern).toBe("^.*[^ \\t\\r\\n].*$");
		expect(question.properties.question.type).toBe("string");
		expect(Value.Check(def.parameters, { questions: [{ question: "Pick", options: ["A", "B"] }] })).toBe(true);
		expect(Value.Check(def.parameters, { questions: [{ question: "Pick", options: ["", "B"] }] })).toBe(false);
		expect(Value.Check(def.parameters, { questions: [{ question: "Pick", options: ["   ", "B"] }] })).toBe(false);
		expect(Value.Check(def.parameters, { questions: [{ question: "Pick", options: ["\t\r", "B"] }] })).toBe(false);
		// An empty batch is rejected.
		expect(Value.Check(def.parameters, { questions: [] })).toBe(false);
	});

	it("exposes a validated optional timeoutSeconds field in its schema", () => {
		const def = createAskUserToolDefinition();
		const props = (def.parameters as any).properties;
		expect(props.timeoutSeconds.minimum).toBe(5);
		expect(props.timeoutSeconds.maximum).toBe(3600);
	});

	it("returns a graceful non-blocking result when no UI is available", async () => {
		const def = createAskUserToolDefinition();
		const ask = vi.fn();
		const result = await run(
			def,
			{ questions: [{ question: "Which?" }, { question: "When?" }] },
			makeCtx(ask, false),
		);
		expect(ask).not.toHaveBeenCalled();
		expect(result.details?.unavailable).toBe(true);
		// Every question comes back skipped so nothing blocks the turn.
		expect(result.details?.answers).toHaveLength(2);
		expect(result.details?.answers.every((a) => a.skipped)).toBe(true);
		expect(result.content[0].text).toContain("not available");
	});

	it("returns unavailable when ctx is entirely absent", async () => {
		const def = createAskUserToolDefinition();
		const result = await run(def, { questions: [{ question: "Which?" }] }, undefined);
		expect(result.details?.unavailable).toBe(true);
		expect(result.details?.answers[0].skipped).toBe(true);
	});

	it("passes a batch {questions:[...]} request to the UI and maps the batch answers back", async () => {
		const def = createAskUserToolDefinition();
		let received: AskRequest | undefined;
		const ctx = makeCtx(async (request) => {
			received = request;
			return {
				answers: [{ selected: ["SQLite"] }, { selected: ["A", "B"], customText: "plus C" }],
			};
		});
		const result = await run(
			def,
			{
				questions: [
					{ question: "DB?", options: ["SQLite", "Postgres"] },
					{ question: "Pick", title: "Choices", options: ["A", "B"], multiSelect: true },
				],
			},
			ctx,
		);

		// A single {questions:[...]} request was forwarded to the UI layer.
		expect(received?.questions).toHaveLength(2);
		expect(received?.questions[0].question).toBe("DB?");
		expect(received?.questions[1].title).toBe("Choices");

		// Per-question result details are mapped in order.
		expect(result.details?.answers).toHaveLength(2);
		expect(result.details?.answers[0]).toMatchObject({ selected: ["SQLite"], skipped: false });
		expect(result.details?.answers[1]).toMatchObject({ selected: ["A", "B"], customText: "plus C", skipped: false });

		// Model-facing summary has one block per question.
		const text = result.content[0].text ?? "";
		const blocks = text.split("\n");
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toContain("SQLite");
		expect(blocks[1]).toContain("A, B");
		expect(blocks[1]).toContain('"plus C"');
	});

	it("handles a single-question batch", async () => {
		const def = createAskUserToolDefinition();
		const ctx = makeCtx(async () => ({ answers: [{ selected: [], customText: "my own answer" }] }));
		const result = await run(def, { questions: [{ question: "Name?" }] }, ctx);
		expect(result.details?.answers).toHaveLength(1);
		expect(result.details?.answers[0].customText).toBe("my own answer");
		expect(result.content[0].text).toContain('"my own answer"');
	});

	it("maps mixed answered/skipped answers in a batch submit", async () => {
		const def = createAskUserToolDefinition();
		const ctx = makeCtx(async () => ({
			answers: [{ selected: ["Yes"] }, { selected: [], skipped: true }, { selected: [], customText: "  " }],
		}));
		const result = await run(def, { questions: [{ question: "q1" }, { question: "q2" }, { question: "q3" }] }, ctx);
		expect(result.details?.answers[0].skipped).toBe(false);
		expect(result.details?.answers[0].selected).toEqual(["Yes"]);
		// Explicitly skipped, and an all-whitespace custom text, both count as skipped.
		expect(result.details?.answers[1].skipped).toBe(true);
		expect(result.details?.answers[2].skipped).toBe(true);
		const text = result.content[0].text ?? "";
		expect(text).toContain("(no answer)");
	});

	it("reports an undefined host answer as closed without an answer (all skipped)", async () => {
		const def = createAskUserToolDefinition();
		const ctx = makeCtx(async () => undefined);
		const result = await run(def, { questions: [{ question: "Which?" }, { question: "When?" }] }, ctx);
		expect(result.details?.answers.every((a) => a.skipped)).toBe(true);
		expect(result.details?.unavailable).toBe(false);
		expect(result.details?.failed).toBeUndefined();
		expect(result.content[0].text).toContain("closed without an answer");
	});

	it("settles without opening UI when the signal is already aborted (all skipped)", async () => {
		const def = createAskUserToolDefinition();
		const ask = vi.fn(async () => ({ answers: [{ selected: ["x"] }] }));
		const controller = new AbortController();
		controller.abort();
		const result = await run(def, { questions: [{ question: "Which?" }] }, makeCtx(ask), controller.signal);
		expect(ask).not.toHaveBeenCalled();
		expect(result.details?.answers.every((a) => a.skipped)).toBe(true);
		expect(result.details?.unavailable).toBe(false);
	});

	it("reports a host failure distinctly from questions closing", async () => {
		const def = createAskUserToolDefinition();
		const ctx = makeCtx(async () => {
			throw new Error("host exploded");
		});
		const result = await run(def, { questions: [{ question: "Which?" }, { question: "When?" }] }, ctx);
		expect(result.details?.failed).toBe(true);
		expect(result.details?.answers.every((a) => a.skipped)).toBe(true);
		expect(result.content[0].text).toContain("interactive UI or response protocol failed");
	});

	it("passes the abort signal through to the UI layer", async () => {
		const def = createAskUserToolDefinition();
		const controller = new AbortController();
		let receivedSignal: AbortSignal | undefined;
		const ctx = makeCtx(async (_req, opts) => {
			receivedSignal = opts?.signal;
			return { answers: [{ selected: ["x"] }] };
		});
		await run(def, { questions: [{ question: "Which?" }] }, ctx, controller.signal);
		expect(receivedSignal).toBe(controller.signal);
	});

	it("always offers free text when a question has no options (never unanswerable)", async () => {
		const def = createAskUserToolDefinition();
		let received: AskRequest | undefined;
		const ctx = makeCtx(async (request) => {
			received = request;
			return { answers: [{ selected: [], customText: "x" }] };
		});
		// allowFreeText:false with no options would leave only a Skip control —
		// the tool must normalize this so the question can always be answered.
		await run(def, { questions: [{ question: "Open ended?", allowFreeText: false }] }, ctx);
		expect(received?.questions[0].allowFreeText).toBe(true);
	});

	it("drops multiSelect and preserves free text when a question has no options", async () => {
		const def = createAskUserToolDefinition();
		let received: AskRequest | undefined;
		const ctx = makeCtx(async (request) => {
			received = request;
			return { answers: [{ selected: [], customText: "x" }] };
		});
		await run(def, { questions: [{ question: "Open ended?", multiSelect: true }] }, ctx);
		expect(received?.questions[0].multiSelect).toBeUndefined();
		expect(received?.questions[0].allowFreeText).toBe(true);
	});

	it("drops multiline when a question has no options and free text is disabled", async () => {
		const def = createAskUserToolDefinition();
		let received: AskRequest | undefined;
		const ctx = makeCtx(async (request) => {
			received = request;
			return { answers: [{ selected: ["a"] }] };
		});
		// With options and no free-text field there is no text area to make
		// multiline; the flag must be dropped rather than forwarded meaninglessly.
		await run(
			def,
			{ questions: [{ question: "Pick?", options: ["a", "b"], allowFreeText: false, multiline: true }] },
			ctx,
		);
		expect(received?.questions[0].multiline).toBeUndefined();
		expect(received?.questions[0].allowFreeText).toBe(false);
	});

	it("preserves multiline for an open-ended question with no options", async () => {
		const def = createAskUserToolDefinition();
		let received: AskRequest | undefined;
		const ctx = makeCtx(async (request) => {
			received = request;
			return { answers: [{ selected: [], customText: "line1\nline2" }] };
		});
		// No options → free text is always offered, so a multiline request must
		// survive normalization (otherwise open-ended answers silently collapse
		// to a single-line input on both surfaces).
		await run(def, { questions: [{ question: "Describe the bug", multiline: true }] }, ctx);
		expect(received?.questions[0].multiline).toBe(true);
		expect(received?.questions[0].allowFreeText).toBe(true);
	});

	it("normalizes each question in a batch independently", async () => {
		const def = createAskUserToolDefinition();
		let received: AskRequest | undefined;
		const ctx = makeCtx(async (request) => {
			received = request;
			return { answers: [{ selected: ["a"] }, { selected: [], customText: "x" }] };
		});
		await run(
			def,
			{
				questions: [
					{ question: "Pick?", options: ["a", "b"], multiSelect: true },
					{ question: "Open?", multiSelect: true, multiline: true },
				],
			},
			ctx,
		);
		// First question has options: multiSelect kept.
		expect(received?.questions[0].multiSelect).toBe(true);
		// Second question has no options: multiSelect dropped, free text forced, multiline kept.
		expect(received?.questions[1].multiSelect).toBeUndefined();
		expect(received?.questions[1].allowFreeText).toBe(true);
		expect(received?.questions[1].multiline).toBe(true);
	});

	it("forwards a single top-level timeout (seconds → milliseconds) to the UI layer", async () => {
		const def = createAskUserToolDefinition();
		let receivedOpts: { signal?: AbortSignal; timeout?: number } | undefined;
		const ctx = makeCtx(async (_req, opts) => {
			receivedOpts = opts;
			return { answers: [{ selected: ["x"] }] };
		});
		await run(def, { questions: [{ question: "?", options: ["a", "b"] }], timeoutSeconds: 30 }, ctx);
		expect(receivedOpts?.timeout).toBe(30_000);
	});

	it("passes no timeout when timeoutSeconds is omitted", async () => {
		const def = createAskUserToolDefinition();
		let receivedOpts: { signal?: AbortSignal; timeout?: number } | undefined;
		const ctx = makeCtx(async (_req, opts) => {
			receivedOpts = opts;
			return { answers: [{ selected: ["x"] }] };
		});
		await run(def, { questions: [{ question: "?", options: ["a", "b"] }] }, ctx);
		expect(receivedOpts?.timeout).toBeUndefined();
	});

	it("renders a call and result without throwing", () => {
		const def = createAskUserToolDefinition();
		const call = def.renderCall?.(
			{ questions: [{ question: "Which database?" }] } as any,
			mockTheme as any,
			{
				lastComponent: undefined,
			} as any,
		);
		expect(call).toBeDefined();

		const result = def.renderResult?.(
			{
				content: [{ type: "text", text: "done" }],
				details: {
					answers: [{ question: "q", selected: ["A"], skipped: false }],
					unavailable: false,
				},
			} as any,
			{} as any,
			mockTheme as any,
			{ lastComponent: undefined } as any,
		);
		expect(result).toBeDefined();
	});
});
