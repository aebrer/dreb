import { getKeybindings } from "../keybindings.js";
import type { Component } from "../tui.js";
import { truncateToWidth } from "../utils.js";

export interface RankedItem {
	value: string;
	label: string;
	description?: string;
}

export interface RankedListTheme {
	selectedText: (text: string) => string;
	rank: (text: string) => string;
	description: (text: string) => string;
	hint: (text: string) => string;
	empty: (text: string) => string;
}

export class RankedList implements Component {
	private items: RankedItem[];
	private selectedIndex: number = 0;
	private maxVisible: number;
	private theme: RankedListTheme;

	public onReorder?: (items: RankedItem[]) => void;
	public onRemove?: (item: RankedItem, items: RankedItem[]) => void;
	public onSelect?: () => void; // signals "add item" intent to parent
	public onCancel?: () => void;

	constructor(items: RankedItem[], maxVisible: number, theme: RankedListTheme) {
		this.items = [...items];
		this.maxVisible = maxVisible;
		this.theme = theme;
	}

	getItems(): RankedItem[] {
		return [...this.items];
	}

	setItems(items: RankedItem[]): void {
		this.items = [...items];
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.items.length - 1));
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.items.length === 0) {
			lines.push(this.theme.empty("  No models configured"));
			lines.push("");
			lines.push(this.theme.hint("  Enter: add model • Esc: done"));
			return lines;
		}

		// Calculate visible range with scrolling (same algorithm as SelectList)
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.items.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			const rank = this.theme.rank(`${i + 1}. `);
			const prefix = isSelected ? "→ " : "  ";
			const label = truncateToWidth(item.label, width - 8, "");
			if (isSelected) {
				lines.push(this.theme.selectedText(`${prefix}${rank}${label}`));
			} else {
				lines.push(`${prefix}${rank}${label}`);
			}
		}

		// Scroll indicator
		if (startIndex > 0 || endIndex < this.items.length) {
			lines.push(this.theme.description(`  (${this.selectedIndex + 1}/${this.items.length})`));
		}

		lines.push("");
		lines.push(this.theme.hint("  ↑↓: navigate • [/]: reorder • Del: remove • Enter: add • Esc: done"));

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		// Reorder: Shift+Up/Down, Alt+Up/Down, or [ / ] as universal fallback
		// Shift+Up: \x1b[1;2A, Alt+Up: \x1b[1;3A, Ctrl+Up: \x1b[1;5A
		// Shift+Down: \x1b[1;2B, Alt+Down: \x1b[1;3B, Ctrl+Down: \x1b[1;5B
		if (keyData === "\x1b[1;2A" || keyData === "\x1b[1;3A" || keyData === "\x1b[1;5A" || keyData === "[") {
			this.moveItemUp();
			return;
		}
		if (keyData === "\x1b[1;2B" || keyData === "\x1b[1;3B" || keyData === "\x1b[1;5B" || keyData === "]") {
			this.moveItemDown();
			return;
		}

		// Regular navigation
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.items.length === 0) return;
			this.selectedIndex = this.selectedIndex <= 0 ? this.items.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(keyData, "tui.select.down")) {
			if (this.items.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			this.onSelect?.();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
		} else if (keyData === "\x1b[3~" || keyData === "\x7f" || keyData === "\x08") {
			// Delete, Backspace
			this.removeSelectedItem();
		}
	}

	private moveItemUp(): void {
		if (this.items.length < 2 || this.selectedIndex === 0) return;
		const temp = this.items[this.selectedIndex - 1]!;
		this.items[this.selectedIndex - 1] = this.items[this.selectedIndex]!;
		this.items[this.selectedIndex] = temp;
		this.selectedIndex--;
		this.onReorder?.([...this.items]);
	}

	private moveItemDown(): void {
		if (this.items.length < 2 || this.selectedIndex === this.items.length - 1) return;
		const temp = this.items[this.selectedIndex + 1]!;
		this.items[this.selectedIndex + 1] = this.items[this.selectedIndex]!;
		this.items[this.selectedIndex] = temp;
		this.selectedIndex++;
		this.onReorder?.([...this.items]);
	}

	private removeSelectedItem(): void {
		if (this.items.length === 0) return;
		const removed = this.items.splice(this.selectedIndex, 1)[0]!;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.items.length - 1));
		this.onRemove?.(removed, [...this.items]);
	}
}
