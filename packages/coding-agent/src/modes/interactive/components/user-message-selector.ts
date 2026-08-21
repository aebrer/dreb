import { type Component, Container, getKeybindings, Spacer, Text, truncateToWidth } from "@dreb/tui";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

interface UserMessageItem {
	id: string; // Entry ID in the session
	text: string; // The message text (preview)
	role: "user" | "assistant"; // Whose message this is — drives fork semantics
	timestamp?: string; // Optional timestamp if available
}

/**
 * Custom message list component with selection. Lists both user and assistant
 * messages as fork points; the role determines the branch semantics:
 *   - assistant → continue from that answer (branch includes it)
 *   - user → rewind to before it and re-ask (editor pre-filled)
 */
class UserMessageList implements Component {
	private messages: UserMessageItem[] = [];
	private selectedIndex: number = 0;
	public onSelect?: (entryId: string) => void;
	public onCancel?: () => void;
	private maxVisible: number = 10; // Max messages visible

	constructor(messages: UserMessageItem[]) {
		// Store messages in chronological order (oldest to newest)
		this.messages = messages;
		// Start with the last (most recent) message selected
		this.selectedIndex = Math.max(0, messages.length - 1);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.messages.length === 0) {
			lines.push(theme.fg("muted", "  No messages found"));
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.messages.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.messages.length);

		// Render visible messages (2 lines per message + blank line)
		for (let i = startIndex; i < endIndex; i++) {
			const message = this.messages[i];
			const isSelected = i === this.selectedIndex;
			const isAssistant = message.role === "assistant";

			// Normalize message to single line
			const normalizedMessage = message.text.replace(/\n/g, " ").trim();

			// First line: cursor + role badge + message preview
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
			const badgeText = isAssistant ? "[Assistant] " : "[You] ";
			const badge = theme.fg(isAssistant ? "accent" : "muted", badgeText);
			const maxMsgWidth = width - 2 - badgeText.length; // cursor (2) + badge
			const truncatedMsg = truncateToWidth(normalizedMessage, Math.max(0, maxMsgWidth));
			const messageLine = cursor + badge + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);

			lines.push(messageLine);

			// Second line: position + what forking here does
			const position = i + 1;
			const hint = isAssistant ? "continue from here" : "rewind & re-ask";
			const metadata = `  Message ${position} of ${this.messages.length} · ${hint}`;
			lines.push(theme.fg("muted", metadata));
			lines.push(""); // Blank line between messages
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.messages.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.messages.length})`);
			lines.push(scrollInfo);
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow - go to previous (older) message, wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.messages.length - 1 : this.selectedIndex - 1;
		}
		// Down arrow - go to next (newer) message, wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.messages.length - 1 ? 0 : this.selectedIndex + 1;
		}
		// Enter - select message and branch
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.messages[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.id);
			}
		}
		// Escape - cancel
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}
}

/**
 * Component that renders a message selector for branching. Any user or assistant
 * message is a valid fork point.
 */
export class UserMessageSelectorComponent extends Container {
	private messageList: UserMessageList;

	constructor(messages: UserMessageItem[], onSelect: (entryId: string) => void, onCancel: () => void) {
		super();

		// Add header
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Branch from Message"), 1, 0));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"Pick any message: an assistant reply continues from that answer, a question rewinds to re-ask it",
				),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Create message list
		this.messageList = new UserMessageList(messages);
		this.messageList.onSelect = onSelect;
		this.messageList.onCancel = onCancel;

		this.addChild(this.messageList);

		// Add bottom border
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		// Auto-cancel if no messages
		if (messages.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	getMessageList(): UserMessageList {
		return this.messageList;
	}
}
