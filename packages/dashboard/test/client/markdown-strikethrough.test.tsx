// @vitest-environment jsdom
/**
 * Strikethrough must follow GitHub's GFM rules: a `~` that is "approximately"
 * (`~7 percent`) never strikes, a `~` inside a code span is never a delimiter,
 * and intentional `~~text~~` / `~text~` still strike.
 */

import { render } from "solid-js/web/dist/web.js";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownBody, Transcript } from "../../src/client/components/transcript.js";

const REPORTED =
	'Starting from the first ~ in "~7 percent vs ~12 percent", the 7 passes the lookahead, but the next `~` sits after a space, so nothing ends a valid match there.';

const disposers: Array<() => void> = [];

function mount(element: () => any): HTMLElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	disposers.push(render(element, container));
	return container;
}

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	document.body.innerHTML = "";
});

/** Inputs GitHub renders without any strikethrough, with their expected visible text and code spans. */
const NO_STRIKE_CASES: Array<{ input: string; text: string; code: string[] }> = [
	{
		input: REPORTED,
		text: 'Starting from the first ~ in "~7 percent vs ~12 percent", the 7 passes the lookahead, but the next ~ sits after a space, so nothing ends a valid match there.',
		code: ["~"],
	},
	{
		input: "about ~7 percent vs ~12 percent (see `~`)",
		text: "about ~7 percent vs ~12 percent (see ~)",
		code: ["~"],
	},
	{
		input: "(~7 percent) vs (~12 percent)",
		text: "(~7 percent) vs (~12 percent)",
		code: [],
	},
];

/** Inputs GitHub renders with strikethrough, with the expected struck spans. */
const STRIKE_CASES: Array<{ input: string; text: string; struck: string[] }> = [
	{ input: "range 5~7 and 10~12", text: "range 57 and 1012", struck: ["7 and 10"] },
	{
		input: "~~real strike~~ and ~single strike~",
		text: "real strike and single strike",
		struck: ["real strike", "single strike"],
	},
	{ input: "word ~~real strike~~ here", text: "word real strike here", struck: ["real strike"] },
	{ input: "a ~single~ b", text: "a single b", struck: ["single"] },
];

function texts(el: Element, selector: string): string[] {
	return [...el.querySelectorAll(selector)].map((node) => node.textContent ?? "");
}

describe("markdown strikethrough (GitHub GFM parity)", () => {
	describe("MarkdownBody", () => {
		for (const { input, text, code } of NO_STRIKE_CASES) {
			it(`does not strike: ${input}`, () => {
				const el = mount(() => <MarkdownBody text={input} />);
				const body = el.querySelector(".markdown-body")!;

				expect(body.querySelector("del")).toBeNull();
				expect(texts(body, "code")).toEqual(code);
				expect(body.textContent?.trim()).toBe(text);
				// A broken code span would leave bare backticks behind.
				expect(body.textContent).not.toContain("`");
			});
		}

		for (const { input, text, struck } of STRIKE_CASES) {
			it(`strikes: ${input}`, () => {
				const el = mount(() => <MarkdownBody text={input} />);
				const body = el.querySelector(".markdown-body")!;

				expect(texts(body, "del")).toEqual(struck);
				expect(body.textContent?.trim()).toBe(text);
			});
		}
	});

	describe("Transcript", () => {
		it("renders the reported thinking summary without strikethrough", () => {
			const el = mount(() => (
				<Transcript
					entries={[{ kind: "assistant", blocks: [{ kind: "thinking", text: REPORTED }], streaming: false }]}
				/>
			));
			const body = el.querySelector(".thinking-body")!;

			expect(body).not.toBeNull();
			expect(body.querySelector("del")).toBeNull();
			expect(texts(body, "code")).toEqual(["~"]);
			expect(body.textContent).toContain('"~7 percent vs ~12 percent"');
			expect(body.textContent).not.toContain("`");
		});

		it("renders the reported text in assistant output without strikethrough", () => {
			const el = mount(() => (
				<Transcript
					entries={[{ kind: "assistant", blocks: [{ kind: "text", text: REPORTED }], streaming: false }]}
				/>
			));
			const body = el.querySelector(".entry-body .markdown-body")!;

			expect(body).not.toBeNull();
			expect(body.querySelector("del")).toBeNull();
			expect(texts(body, "code")).toEqual(["~"]);
			expect(body.textContent).not.toContain("`");
		});

		it("still renders intentional strikethrough in assistant output", () => {
			const el = mount(() => (
				<Transcript
					entries={[
						{
							kind: "assistant",
							blocks: [{ kind: "text", text: "~~real strike~~ and ~single strike~" }],
							streaming: false,
						},
					]}
				/>
			));

			expect(texts(el, ".entry-body del")).toEqual(["real strike", "single strike"]);
		});
	});
});
