/**
 * ask_user question component.
 *
 * Renders a clarifying question with optional single- or multi-select options
 * and an optional free-text field, matching the approved cross-surface design.
 *
 * Keyboard model (settled in issue 396 discussion):
 *   ↑/↓        move a single cursor through the options and, last, the free-text field
 *   Space      toggle the highlighted checkbox (multi-select only)
 *   Enter      single-select: pick the highlighted option and submit;
 *              free-text field: submit the typed answer;
 *              multi-select: submit all checked options plus any free text
 *   Shift+Enter insert a newline in the multiline free-text field
 *   Esc        skip without answering (always safe)
 */

import { Container, Editor, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@dreb/tui";
import type { AskRequest, AskResult } from "../../../core/extensions/types.js";
import { getEditorTheme, theme } from "../theme/theme.js";
import { CountdownTimer } from "./countdown-timer.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

export interface AskUserComponentOptions {
	tui?: TUI;
	timeout?: number;
}

export class AskUserComponent extends Container implements Focusable {
	private options: string[];
	private allowFreeText: boolean;
	private multiSelect: boolean;
	private multiline: boolean;

	/** Cursor over [options..., freeTextRow?]. */
	private cursorIndex = 0;
	/** Checkbox state for multi-select, aligned to options. */
	private checked: boolean[];

	private onSubmitCallback: (result: AskResult) => void;
	private onCancelCallback: () => void;

	private titleText: Text;
	private baseTitle: string;
	private optionsContainer: Container;
	private fieldLabel: Text | undefined;
	private input: Input | undefined;
	private editor: Editor | undefined;
	private countdown: CountdownTimer | undefined;
	private submitted = false;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.syncFieldFocus();
	}

	private get freeTextRow(): number {
		return this.allowFreeText ? this.options.length : -1;
	}

	private get lastRow(): number {
		return this.allowFreeText ? this.options.length : this.options.length - 1;
	}

	private cursorOnField(): boolean {
		return this.allowFreeText && this.cursorIndex === this.freeTextRow;
	}

	constructor(
		request: AskRequest,
		onSubmit: (result: AskResult) => void,
		onCancel: () => void,
		opts?: AskUserComponentOptions,
	) {
		super();

		this.options = request.options ?? [];
		this.allowFreeText = request.allowFreeText !== false;
		this.multiSelect = request.multiSelect === true && this.options.length > 0;
		this.multiline = request.multiline === true;
		this.checked = this.options.map(() => false);
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;
		this.baseTitle = request.title?.trim() || "Question";

		// Start the cursor on the first option, or the free-text field when there
		// are no options.
		this.cursorIndex = this.options.length > 0 ? 0 : this.freeTextRow;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new Text(theme.fg("accent", theme.bold(this.baseTitle)), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		this.addChild(new Text(theme.fg("text", request.question), 1, 0));
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				() => this.cancel(),
			);
		}

		this.optionsContainer = new Container();
		this.addChild(this.optionsContainer);

		if (this.allowFreeText) {
			this.addChild(new Spacer(1));
			this.fieldLabel = new Text("", 1, 0);
			this.addChild(this.fieldLabel);
			if (this.multiline && opts?.tui) {
				this.editor = new Editor(opts.tui, getEditorTheme(), {});
				this.editor.onSubmit = () => this.submit();
				this.addChild(this.editor);
			} else {
				this.input = new Input();
				this.addChild(this.input);
			}
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(this.buildHint(), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.renderRows();
		this.syncFieldFocus();
	}

	private buildHint(): string {
		const parts = [rawKeyHint("↑↓", "move")];
		if (this.multiSelect) parts.push(rawKeyHint("Space", "toggle"));
		parts.push(keyHint("tui.select.confirm", "submit"));
		if (this.multiline) parts.push(keyHint("tui.input.newLine", "newline"));
		parts.push(keyHint("tui.select.cancel", "skip"));
		return parts.join("  ");
	}

	private renderRows(): void {
		this.optionsContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const focused = this.cursorIndex === i;
			const cursor = focused ? theme.fg("accent", "→ ") : "  ";
			const glyph = this.multiSelect ? (this.checked[i] ? "[x]" : "[ ]") : focused ? "(•)" : "( )";
			const label = focused ? theme.fg("accent", this.options[i]) : theme.fg("text", this.options[i]);
			const glyphColored = this.checked[i] || (!this.multiSelect && focused) ? theme.fg("accent", glyph) : glyph;
			this.optionsContainer.addChild(new Text(`${cursor}${glyphColored} ${label}`, 1, 0));
		}
		if (this.fieldLabel) {
			const focused = this.cursorOnField();
			const prefix = focused ? theme.fg("accent", "→ ") : "  ";
			const labelText = this.options.length > 0 ? "Or type your own answer:" : "Your answer:";
			this.fieldLabel.setText(prefix + (focused ? theme.fg("accent", labelText) : theme.fg("muted", labelText)));
		}
	}

	private syncFieldFocus(): void {
		const fieldFocused = this._focused && this.cursorOnField();
		if (this.input) this.input.focused = fieldFocused;
		if (this.editor) this.editor.focused = fieldFocused;
	}

	private moveCursor(delta: number): void {
		const first = this.options.length > 0 ? 0 : this.freeTextRow;
		const next = Math.max(first, Math.min(this.lastRow, this.cursorIndex + delta));
		if (next === this.cursorIndex) return;
		this.cursorIndex = next;
		this.renderRows();
		this.syncFieldFocus();
	}

	private fieldText(): string {
		if (this.editor) return this.editor.getText().trim();
		if (this.input) return this.input.getValue().trim();
		return "";
	}

	private currentAnswer(): AskResult | undefined {
		const customText = this.fieldText() || undefined;
		if (this.multiSelect) {
			const selected = this.options.filter((_, i) => this.checked[i]);
			if (selected.length === 0 && !customText) return undefined;
			return { selected, customText };
		}
		if (this.cursorOnField()) {
			if (!customText) return undefined;
			return { selected: [], customText };
		}
		const option = this.options[this.cursorIndex];
		// Single-select: submit the highlighted option together with any typed
		// free text, matching the Dashboard, which combines a radio selection with
		// custom text (and the tool's own combined-answer result formatting).
		return option ? { selected: [option], customText } : undefined;
	}

	private submit(): void {
		if (this.submitted) return;
		const answer = this.currentAnswer();
		if (!answer) return; // Nothing to submit yet — Esc skips instead.
		this.submitted = true;
		this.onSubmitCallback(answer);
	}

	private cancel(): void {
		if (this.submitted) return;
		this.submitted = true;
		this.onCancelCallback();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		if (this.cursorOnField()) {
			// Multiline editor: Enter submits (via onSubmit), Shift+Enter inserts a
			// newline, ↑ at the top line leaves to the options, everything else edits.
			if (this.editor) {
				if (kb.matches(keyData, "tui.select.up") && this.editor.getCursor().line === 0) {
					this.moveCursor(-1);
					return;
				}
				this.editor.handleInput(keyData);
				return;
			}
			// Single-line input: ↑ leaves to the options, Enter submits, else edits.
			if (this.input) {
				if (kb.matches(keyData, "tui.select.up")) {
					this.moveCursor(-1);
					return;
				}
				if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
					this.submit();
					return;
				}
				this.input.handleInput(keyData);
				return;
			}
			return;
		}

		// Cursor on an option row.
		if (kb.matches(keyData, "tui.select.up")) {
			this.moveCursor(-1);
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.moveCursor(1);
		} else if (this.multiSelect && keyData === " ") {
			this.checked[this.cursorIndex] = !this.checked[this.cursorIndex];
			this.renderRows();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.submit();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
