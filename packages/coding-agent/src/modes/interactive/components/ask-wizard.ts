/**
 * ask_user multi-question wizard.
 *
 * Renders one {@link AskRequest} — which carries one or more clarifying
 * questions — as a single native wizard and returns the batch of answers, one
 * {@link AskAnswer} per question, in order.
 *
 * Layout:
 *   - Single question (N==1): compact inline panel with no tab strip.
 *   - Multiple questions (N>=2): a compact tab strip at the top (one tab per
 *     question plus a trailing "✔ Submit" review tab). Only the active tab is
 *     rendered and receives keyboard input.
 *
 * Keyboard model:
 *   ↑/↓         move a single cursor through the options and, last, the field
 *   1..9        select (single) or toggle (multi) the numbered option
 *   Space       toggle the highlighted checkbox (multi-select only)
 *   Enter       single-select: pick the highlighted option, then advance/submit;
 *               free-text field: advance/submit the typed answer;
 *               review tab: submit the whole batch
 *   Shift+Enter insert a newline in a multiline free-text field
 *   Tab/Shift+Tab   switch to the next/previous tab (N>=2)
 *   ←/→         switch tabs when the cursor is not on the free-text field (N>=2)
 *   Esc         stop the current agent turn
 */

import {
	Container,
	Editor,
	type Focusable,
	getKeybindings,
	Input,
	Markdown,
	matchesKey,
	Text,
	type TUI,
} from "@dreb/tui";
import type { AskAnswer, AskQuestion, AskRequest, AskResult } from "../../../core/extensions/types.js";
import { getEditorTheme, getMarkdownTheme, theme } from "../theme/theme.js";
import { CountdownTimer } from "./countdown-timer.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

export interface AskWizardComponentOptions {
	tui?: TUI;
	timeout?: number;
}

/** Per-question draft state (selection + cursor). Free text lives in `fields`. */
interface Draft {
	selected: string[];
	cursorIndex: number;
}

export class AskWizardComponent extends Container implements Focusable {
	private questions: AskQuestion[];
	private drafts: Draft[];
	/** Stable per-question free-text fields, created once and reused. */
	private fields: (Input | Editor | undefined)[];
	private requestTitle: string | undefined;

	/** 0..N-1 are question tabs; index N is the review/Submit tab (N>=2 only). */
	private activeTab = 0;

	private onSubmitCallback: (result: AskResult) => void;
	private onStopCallback: () => void;
	private countdown: CountdownTimer | undefined;
	private countdownSeconds: number | undefined;
	private submitted = false;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.syncFieldFocus();
	}

	constructor(
		request: AskRequest,
		onSubmit: (result: AskResult) => void,
		onStop: () => void,
		opts?: AskWizardComponentOptions,
	) {
		super();

		this.questions = request.questions ?? [];
		this.requestTitle = request.title?.trim() || undefined;
		this.onSubmitCallback = onSubmit;
		this.onStopCallback = onStop;

		this.drafts = this.questions.map(() => ({ selected: [], cursorIndex: 0 }));

		this.fields = this.questions.map((q) => {
			const allowFree = q.allowFreeText !== false;
			if (!allowFree) return undefined;
			if (q.multiline && opts?.tui) {
				// Never wire editor.onSubmit — Enter is intercepted here so the editor
				// keeps its text (it clears itself on submit) across tab switches.
				return new Editor(opts.tui, getEditorTheme(), {});
			}
			return new Input();
		});

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => {
					this.countdownSeconds = s;
					this.rebuild();
				},
				() => this.stop(),
			);
		}

		this.rebuild();
		this.syncFieldFocus();
	}

	// --- Per-question helpers -------------------------------------------------

	private optionsFor(i: number): string[] {
		return this.questions[i]?.options ?? [];
	}

	private isMultiSelect(i: number): boolean {
		return this.questions[i]?.multiSelect === true && this.optionsFor(i).length > 0;
	}

	private allowFreeText(i: number): boolean {
		return this.questions[i]?.allowFreeText !== false;
	}

	/** Cursor row index of the free-text field, or -1 when there is none. */
	private freeTextRow(i: number): number {
		return this.allowFreeText(i) ? this.optionsFor(i).length : -1;
	}

	private lastRow(i: number): number {
		const opts = this.optionsFor(i).length;
		return this.allowFreeText(i) ? opts : opts - 1;
	}

	private cursorOnField(i: number): boolean {
		return this.allowFreeText(i) && this.drafts[i].cursorIndex === this.freeTextRow(i);
	}

	private fieldText(i: number): string {
		const field = this.fields[i];
		if (field instanceof Editor) return field.getText();
		if (field instanceof Input) return field.getValue();
		return "";
	}

	private isAnswered(i: number): boolean {
		return this.drafts[i].selected.length > 0 || this.fieldText(i).trim().length > 0;
	}

	private shortTitle(i: number): string {
		const q = this.questions[i];
		const raw = (q.title?.trim() || q.question || "").replace(/\s+/g, " ");
		return raw.length > 18 ? `${raw.slice(0, 17)}…` : raw;
	}

	private countdownSuffix(): string {
		return this.countdownSeconds != null ? theme.fg("muted", `  (${this.countdownSeconds}s)`) : "";
	}

	// --- Rendering ------------------------------------------------------------

	private rebuild(): void {
		this.clear();
		const n = this.questions.length;
		if (n === 1) {
			this.addChild(new Text(this.singleHeader(0), 1, 0));
			this.addQuestionPanel(0);
			return;
		}
		this.addChild(new Text(this.buildTabStrip(), 1, 0));
		if (this.activeTab < n) {
			this.addQuestionPanel(this.activeTab);
		} else {
			this.addReviewPanel();
		}
	}

	private singleHeader(i: number): string {
		const base = this.questions[i]?.title?.trim() || this.requestTitle || "Question";
		return theme.fg("accent", theme.bold(base)) + this.countdownSuffix();
	}

	private buildTabStrip(): string {
		const n = this.questions.length;
		const parts = this.questions.map((_, i) => {
			const marker = this.isAnswered(i) ? "●" : "○";
			const label = `${i + 1}.${marker} ${this.shortTitle(i)}`;
			return i === this.activeTab ? theme.fg("accent", theme.bold(label)) : theme.fg("muted", label);
		});
		const submitLabel = "✔ Submit";
		parts.push(this.activeTab === n ? theme.fg("accent", theme.bold(submitLabel)) : theme.fg("muted", submitLabel));
		return parts.join("  ") + this.countdownSuffix();
	}

	private addQuestionPanel(i: number): void {
		const q = this.questions[i];
		const draft = this.drafts[i];
		const opts = this.optionsFor(i);
		const multiSelect = this.isMultiSelect(i);

		this.addChild(new Markdown(q.question, 1, 0, getMarkdownTheme(), undefined, true));

		for (let j = 0; j < opts.length; j++) {
			const focused = draft.cursorIndex === j;
			const chosen = draft.selected.includes(opts[j]);
			const cursor = focused ? theme.fg("accent", "→ ") : "  ";
			const num = `${j + 1}.`;
			const glyph = multiSelect ? (chosen ? "[x]" : "[ ]") : focused ? "(•)" : "( )";
			const glyphColored = chosen || (!multiSelect && focused) ? theme.fg("accent", glyph) : glyph;
			const check = chosen ? theme.fg("accent", "✔ ") : "";
			const label = focused || chosen ? theme.fg("accent", opts[j]) : theme.fg("text", opts[j]);
			this.addChild(new Text(`${cursor}${num} ${glyphColored} ${check}${label}`, 1, 0));
		}

		if (this.allowFreeText(i)) {
			const onField = this.cursorOnField(i);
			const prefix = onField ? theme.fg("accent", "→ ") : "  ";
			const labelText = opts.length > 0 ? "Or type your own answer:" : "Your answer:";
			this.addChild(
				new Text(prefix + (onField ? theme.fg("accent", labelText) : theme.fg("muted", labelText)), 1, 0),
			);
			const field = this.fields[i];
			if (field) this.addChild(field);
		}

		this.addChild(new Text(this.buildHint(i), 1, 0));
	}

	private buildHint(i: number): string {
		const n = this.questions.length;
		const parts = [rawKeyHint("↑↓", "move")];
		if (this.isMultiSelect(i)) parts.push(rawKeyHint("Space", "toggle"));
		if (n >= 2) parts.push(rawKeyHint("⇥", "switch"));
		parts.push(keyHint("tui.select.confirm", n === 1 ? "submit" : "next"));
		if (this.questions[i]?.multiline) parts.push(keyHint("tui.input.newLine", "newline"));
		parts.push(keyHint("tui.select.cancel", "stop"));
		return parts.join("  ");
	}

	private addReviewPanel(): void {
		this.addChild(new Text(theme.fg("accent", theme.bold("Review your answers")) + this.countdownSuffix(), 1, 0));
		for (let i = 0; i < this.questions.length; i++) {
			this.addChild(new Text(theme.fg("muted", `• ${this.shortTitle(i)} → ${this.answerSummary(i)}`), 1, 0));
		}
		const hint = [
			keyHint("tui.select.confirm", "submit"),
			rawKeyHint("⇥", "switch"),
			keyHint("tui.select.cancel", "stop"),
		].join("  ");
		this.addChild(new Text(hint, 1, 0));
	}

	private answerSummary(i: number): string {
		const draft = this.drafts[i];
		const opts = this.optionsFor(i);
		const selected = this.isMultiSelect(i)
			? opts.filter((o) => draft.selected.includes(o))
			: draft.selected.slice(0, 1);
		const custom = this.fieldText(i).trim();
		const parts = [...selected];
		if (custom) parts.push(custom);
		return parts.length > 0 ? parts.join(", ") : "(unanswered)";
	}

	// --- Focus ----------------------------------------------------------------

	private syncFieldFocus(): void {
		this.fields.forEach((field, i) => {
			if (!field) return;
			field.focused = this._focused && this.activeTab === i && this.cursorOnField(i);
		});
	}

	// --- Navigation -----------------------------------------------------------

	private moveCursor(delta: number): void {
		const i = this.activeTab;
		const first = this.optionsFor(i).length > 0 ? 0 : Math.max(0, this.freeTextRow(i));
		const next = Math.max(first, Math.min(this.lastRow(i), this.drafts[i].cursorIndex + delta));
		if (next === this.drafts[i].cursorIndex) return;
		this.drafts[i].cursorIndex = next;
		this.rebuild();
		this.syncFieldFocus();
	}

	private switchTab(delta: number): void {
		const n = this.questions.length;
		if (n < 2) return;
		const total = n + 1; // question tabs + review tab
		this.activeTab = (this.activeTab + delta + total) % total;
		this.rebuild();
		this.syncFieldFocus();
	}

	/** Move to the next tab, or submit when there is nowhere left to go. */
	private advanceOrSubmit(i: number): void {
		if (this.questions.length === 1) {
			this.submit();
			return;
		}
		this.activeTab = i + 1; // next question, or the review tab (index N)
		this.rebuild();
		this.syncFieldFocus();
	}

	private toggle(i: number, option: string): void {
		const draft = this.drafts[i];
		const at = draft.selected.indexOf(option);
		if (at === -1) draft.selected.push(option);
		else draft.selected.splice(at, 1);
	}

	// --- Submit / stop --------------------------------------------------------

	private answerFor(i: number): AskAnswer {
		const draft = this.drafts[i];
		const opts = this.optionsFor(i);
		const customText = this.fieldText(i).trim() || undefined;
		if (this.isMultiSelect(i)) {
			const selected = opts.filter((o) => draft.selected.includes(o));
			if (selected.length === 0 && !customText) return { selected: [], skipped: true };
			return { selected, customText };
		}
		const selected = draft.selected.slice(0, 1);
		if (selected.length === 0 && !customText) return { selected: [], skipped: true };
		return { selected, customText };
	}

	private submit(): void {
		if (this.submitted) return;
		this.submitted = true;
		this.countdown?.dispose();
		const answers = this.questions.map((_, i) => this.answerFor(i));
		this.onSubmitCallback({ answers });
	}

	private stop(): void {
		if (this.submitted) return;
		this.submitted = true;
		this.countdown?.dispose();
		this.onStopCallback();
	}

	// --- Input ----------------------------------------------------------------

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const n = this.questions.length;

		if (kb.matches(keyData, "tui.select.cancel")) {
			this.stop();
			return;
		}

		// Tab / Shift+Tab switch tabs before any field sees the key so switching
		// works regardless of which sub-field currently holds focus.
		if (n >= 2) {
			if (matchesKey(keyData, "shift+tab") || keyData === "\x1b[Z") {
				this.switchTab(-1);
				return;
			}
			if (kb.matches(keyData, "tui.input.tab") || keyData === "\t") {
				this.switchTab(1);
				return;
			}
		}

		// Review tab: Enter submits; arrows switch tabs.
		if (n >= 2 && this.activeTab === n) {
			if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
				this.submit();
			} else if (keyData === "\x1b[D") {
				this.switchTab(-1);
			} else if (keyData === "\x1b[C") {
				this.switchTab(1);
			}
			return;
		}

		const i = this.activeTab;

		// Free-text field has focus: delegate editing, intercept Enter/leave keys.
		if (this.cursorOnField(i)) {
			const field = this.fields[i];
			if (field instanceof Editor) {
				if (kb.matches(keyData, "tui.select.up") && field.getCursor().line === 0) {
					this.moveCursor(-1);
					return;
				}
				// Shift+Enter (and bare LF newline) insert a line; real Enter advances.
				if (kb.matches(keyData, "tui.input.newLine") || keyData === "\n") {
					field.handleInput(keyData);
					return;
				}
				if (kb.matches(keyData, "tui.select.confirm")) {
					this.advanceOrSubmit(i);
					return;
				}
				field.handleInput(keyData);
				return;
			}
			if (field instanceof Input) {
				if (kb.matches(keyData, "tui.select.up")) {
					this.moveCursor(-1);
					return;
				}
				if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
					this.advanceOrSubmit(i);
					return;
				}
				field.handleInput(keyData);
				return;
			}
			return;
		}

		// Cursor on an option row (or an option-less field-only question handled above).
		const opts = this.optionsFor(i);

		// Numeric shortcuts select/toggle an option by its 1-based index.
		if (keyData.length === 1 && keyData >= "1" && keyData <= "9") {
			const index = keyData.charCodeAt(0) - 49; // '1' -> 0
			if (index < opts.length) {
				if (this.isMultiSelect(i)) {
					this.toggle(i, opts[index]);
				} else {
					this.drafts[i].selected = [opts[index]];
					this.drafts[i].cursorIndex = index;
				}
				this.rebuild();
				this.syncFieldFocus();
			}
			return;
		}

		if (kb.matches(keyData, "tui.select.up")) {
			this.moveCursor(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.moveCursor(1);
			return;
		}
		if (n >= 2 && keyData === "\x1b[D") {
			this.switchTab(-1);
			return;
		}
		if (n >= 2 && keyData === "\x1b[C") {
			this.switchTab(1);
			return;
		}
		if (this.isMultiSelect(i) && keyData === " ") {
			this.toggle(i, opts[this.drafts[i].cursorIndex]);
			this.rebuild();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
			const option = opts[this.drafts[i].cursorIndex];
			if (option !== undefined && !this.isMultiSelect(i)) {
				this.drafts[i].selected = [option];
			}
			this.advanceOrSubmit(i);
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
