/**
 * Harness that runs the REAL shipped export template.js and exposes its render
 * functions, so tests exercise the exact code that ships inside exported HTML.
 *
 * The template is one browser IIFE. `loadTemplateInternals()` decodes a session
 * payload exactly like the browser does, then injects a `return` statement
 * partway through the IIFE to hand back the internal render functions before
 * browser-only initialization (event listeners, navigateTo) runs. Only
 * lightweight `document`/`window`/`hljs` stubs are needed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getExportTemplateDir } from "../src/config.js";

export interface TemplateInternals {
	renderToolCall(call: { id: string; name: string; arguments: Record<string, unknown> }): string;
	renderEntry(entry: unknown): string;
	sanitizeImageDataUri(mimeType: unknown, data: unknown): string | null;
	renderImageTag(img: unknown, className: string): string;
}

export interface LoadTemplateOptions {
	/**
	 * Browser-global `marked` object (as installed by the vendored UMD bundle).
	 * When provided, the template's own `marked.use(...)` configuration runs
	 * before internals are returned, so markdown renders exactly as in an
	 * exported file. When omitted, the harness returns before that point and
	 * markdown rendering is unavailable.
	 */
	marked?: unknown;
}

/** Return before the browser-only "HEADER / STATS" section: no marked config or DOM init runs. */
const BEFORE_INIT_MARKER =
	"      // ============================================================\n      // HEADER / STATS";
/** Return right after `marked.use(...)` and `safeMarkedParse`, before DOM event wiring starts. */
const AFTER_MARKED_CONFIG_MARKER = "      // Search input";

/** Minimal DOM stub sufficient for the template's data-loading + escapeHtml(). */
function makeStubs(sessionBase64: string) {
	const documentStub = {
		getElementById(id: string) {
			if (id === "session-data") return { textContent: sessionBase64 };
			return null;
		},
		querySelector() {
			return null;
		},
		// escapeHtml() creates a <div>, sets textContent, reads innerHTML.
		createElement() {
			let value = "";
			return {
				set textContent(v: unknown) {
					value = String(v);
				},
				get textContent() {
					return value;
				},
				get innerHTML() {
					return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
				},
				set innerHTML(v: string) {
					value = v;
				},
			};
		},
	};
	const windowStub = { location: { search: "" } };
	const hljsStub = {
		highlight: (code: string) => ({ value: code }),
		highlightAuto: (code: string) => ({ value: code }),
		getLanguage: () => null,
	};
	return { documentStub, windowStub, hljsStub };
}

export function loadTemplateInternals(entries: unknown[], options: LoadTemplateOptions = {}): TemplateInternals {
	const templateJs = readFileSync(join(getExportTemplateDir(), "template.js"), "utf-8").trim();

	const marker = options.marked === undefined ? BEFORE_INIT_MARKER : AFTER_MARKED_CONFIG_MARKER;
	if (templateJs.split(marker).length !== 2) {
		throw new Error(`Expected exactly one ${JSON.stringify(marker)} marker in template.js — harness needs updating`);
	}
	const instrumented = templateJs.replace(
		marker,
		() => `      return { renderToolCall, renderEntry, sanitizeImageDataUri, renderImageTag };\n\n${marker}`,
	);

	const sessionData = { header: { id: "t" }, entries, leafId: null, systemPrompt: "", tools: [], renderedTools: {} };
	const sessionBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");
	const { documentStub, windowStub, hljsStub } = makeStubs(sessionBase64);

	// The template is an IIFE expression: `return` its value to obtain internals.
	const factory = new Function("document", "window", "hljs", "marked", `return ${instrumented}`) as (
		documentArg: unknown,
		windowArg: unknown,
		hljsArg: unknown,
		markedArg: unknown,
	) => TemplateInternals;

	return factory(documentStub, windowStub, hljsStub, options.marked);
}
