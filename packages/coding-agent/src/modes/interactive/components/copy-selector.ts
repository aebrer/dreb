import { type Component, Container, getKeybindings, matchesKey, Spacer, Text, truncateToWidth } from "@dreb/tui";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

export interface CopyMessageItem {
	index: number; // Original index in messages array (for chronological ordering on copy)
	roleLabel: string; // e.g. "You", "Assistant", "Tool: read", "Bash"
	preview: string; // Single-line preview text (no ANSI)
}

/**
 * Inner list component with multi-select support.
 */
class CopyMessageList implements Component {
	private items: CopyMessageItem[];
	private selectedIndex: number; // cursor position
	private selected: Set<number>; // set of selected item array positions
	private maxVisible: number;

	public onCopy?: (selectedIndices: number[]) => void;
	public onCancel?: () => void;

	constructor(items: CopyMessageItem[], maxVisible: number = 15) {
		this.items = items;
		this.maxVisible = maxVisible;
		// Bottom-anchored: start at the last (most recent) item
		this.selectedIndex = Math.max(0, items.length - 1);
		this.selected = new Set();
	}

	getMaxVisible(): number {
		return this.maxVisible;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.items.length === 0) {
			lines.push(theme.fg("muted", "  No messages found"));
			return lines;
		}

		// Calculate consistent role label width
		const minRoleLabelWidth = 10;
		const maxRoleLabelWidth = Math.max(minRoleLabelWidth, ...this.items.map((item) => item.roleLabel.length));

		// Calculate visible range centered on selectedIndex
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.items.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i];
			const isCursor = i === this.selectedIndex;
			const isSelected = this.selected.has(i);

			// Build line: {cursor}{checkbox} {roleLabel}  {preview}
			const cursor = isCursor ? theme.fg("accent", "› ") : "  ";
			const checkbox = isSelected ? theme.fg("accent", "[×]") : theme.fg("muted", "[ ]");
			const paddedRole = item.roleLabel.padEnd(maxRoleLabelWidth);
			const roleStr = theme.fg("muted", paddedRole);

			// Calculate remaining width for preview
			// cursor(2) + checkbox(3) + space(1) + role(maxRoleLabelWidth) + gap(2)
			const prefixWidth = 2 + 3 + 1 + maxRoleLabelWidth + 2;
			const previewWidth = Math.max(10, width - prefixWidth);
			const truncatedPreview = truncateToWidth(item.preview, previewWidth);
			const previewStr = isCursor ? theme.bold(truncatedPreview) : truncatedPreview;

			lines.push(`${cursor}${checkbox} ${roleStr}  ${previewStr}`);
		}

		// Scroll indicator if items overflow viewport
		if (startIndex > 0 || endIndex < this.items.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.items.length})`);
			lines.push(scrollInfo);
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		// Up arrow - move cursor up, wrap at top to bottom
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
		}
		// Down arrow - move cursor down, wrap at bottom to top
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
		}
		// Page Up - jump up by maxVisible
		else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		}
		// Page Down - jump down by maxVisible
		else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + this.maxVisible);
		}
		// Space - toggle selection on current item
		else if (matchesKey(keyData, "space")) {
			if (this.selected.has(this.selectedIndex)) {
				this.selected.delete(this.selectedIndex);
			} else {
				this.selected.add(this.selectedIndex);
			}
		}
		// Ctrl+A - toggle all
		else if (matchesKey(keyData, "ctrl+a")) {
			if (this.selected.size === this.items.length) {
				// All selected → deselect all
				this.selected.clear();
			} else {
				// Select all
				for (let i = 0; i < this.items.length; i++) {
					this.selected.add(i);
				}
			}
		}
		// Enter - confirm copy
		else if (kb.matches(keyData, "tui.select.confirm")) {
			if (this.onCopy) {
				// Return original indices sorted chronologically
				const selectedIndices = Array.from(this.selected)
					.map((i) => this.items[i].index)
					.sort((a, b) => a - b);
				this.onCopy(selectedIndices);
			}
		}
		// Escape/Ctrl+C - cancel
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}
}

/**
 * Outer container that wraps the list with header and controls.
 */
export class CopySelectorComponent extends Container {
	private messageList: CopyMessageList;

	constructor(
		items: CopyMessageItem[],
		onCopy: (selectedIndices: number[]) => void,
		onCancel: () => void,
		maxVisible?: number,
	) {
		super();

		// Add header
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Copy Messages"), 1, 0));
		this.addChild(
			new Text(theme.fg("muted", "↑↓ Navigate · Space Toggle · Ctrl+A All · Enter Copy · Esc Cancel"), 1, 0),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Create message list
		this.messageList = new CopyMessageList(items, maxVisible);
		this.messageList.onCopy = onCopy;
		this.messageList.onCancel = onCancel;
		this.addChild(this.messageList);

		// Bottom border
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		// Auto-cancel if no items
		if (items.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	getMessageList(): CopyMessageList {
		return this.messageList;
	}
}
