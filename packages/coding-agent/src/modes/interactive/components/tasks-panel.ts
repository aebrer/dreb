/**
 * Tasks panel component for the TUI.
 *
 * Renders the session task list with status indicators.
 * Visible by default when tasks exist, hidden when empty.
 */

import { Container, Text } from "@dreb/tui";
import type { SessionTask } from "../../../core/tools/tasks.js";

const MAX_DISPLAY_TASKS = 10;

const STATUS_INDICATORS: Record<string, string> = {
	pending: "☐",
	in_progress: "⧖",
	completed: "☑",
};

export class TasksPanelComponent extends Container {
	private _tasks: readonly SessionTask[] = [];
	private _visible = true;
	private _theme: any;

	constructor(theme: any) {
		super();
		this._theme = theme;
	}

	get visible(): boolean {
		return this._visible;
	}

	setVisible(visible: boolean): void {
		this._visible = visible;
		this._rebuild();
	}

	toggleVisible(): void {
		this._visible = !this._visible;
		this._rebuild();
	}

	update(tasks: readonly SessionTask[]): void {
		this._tasks = tasks;
		this._rebuild();
	}

	private _rebuild(): void {
		this.clear();

		const hasActiveTasks =
			this._tasks.length > 0 && this._tasks.some((t) => t.status !== "completed");
		if (!this._visible || !hasActiveTasks) {
			return;
		}

		const theme = this._theme;
		const displayTasks = this._tasks.slice(0, MAX_DISPLAY_TASKS);
		const lines: string[] = [];

		for (const task of displayTasks) {
			const indicator = STATUS_INDICATORS[task.status] ?? "?";
			const title = task.title;

			if (task.status === "completed") {
				lines.push(theme.fg("dim", `${indicator} ${title}`));
			} else if (task.status === "in_progress") {
				lines.push(theme.fg("accent", `${indicator} ${title}`));
			} else {
				lines.push(theme.fg("text", `${indicator} ${title}`));
			}
		}

		if (this._tasks.length > MAX_DISPLAY_TASKS) {
			const remaining = this._tasks.length - MAX_DISPLAY_TASKS;
			lines.push(theme.fg("muted", `  ... and ${remaining} more`));
		}

		this.addChild(new Text(lines.join("\n"), 0, 0));
	}
}
