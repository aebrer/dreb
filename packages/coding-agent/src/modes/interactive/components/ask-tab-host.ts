/**
 * ask_user tabbed host.
 *
 * Hosts multiple concurrently-open {@link AskUserComponent} questions as
 * switchable tabs, used only when `askUserMode === "tabbed"`. In `"sequential"`
 * mode this host is never created — questions continue to use the single-slot
 * dialog path.
 *
 * Only the active tab's question is rendered and receives keyboard input; a
 * compact tab strip above it shows every pending question and highlights the
 * active one. Each hosted question keeps its own countdown timer and abort
 * listener, so switching tabs never pauses, resets, or orphans another
 * question — they all keep counting down and can resolve independently.
 *
 * Keyboard model (in addition to the active question's own keys):
 *   Tab        switch to the next question
 *   Shift+Tab  switch to the previous question
 */

import { Container, type Focusable, getKeybindings, matchesKey, Text, type TUI } from "@dreb/tui";
import { theme } from "../theme/theme.js";
import type { AskUserComponent } from "./ask-user.js";

interface AskTab {
	id: string;
	title: string;
	component: AskUserComponent;
}

export class AskTabHost extends Container implements Focusable {
	private tabs: AskTab[] = [];
	private activeIndex = 0;
	private tabStrip: Text;
	private tui: TUI | undefined;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		const active = this.activeComponent;
		if (active) active.focused = value;
	}

	constructor(tui?: TUI) {
		super();
		this.tui = tui;
		this.tabStrip = new Text("", 1, 0);
		this.rebuild();
	}

	get size(): number {
		return this.tabs.length;
	}

	hasTabs(): boolean {
		return this.tabs.length > 0;
	}

	private get activeComponent(): AskUserComponent | undefined {
		return this.tabs[this.activeIndex]?.component;
	}

	/** Add a new question tab and make it active. */
	addTab(id: string, title: string, component: AskUserComponent): void {
		this.tabs.push({ id, title, component });
		// Focus the newly opened question so a fresh concurrent ask is immediately
		// answerable without hunting for it.
		this.activeIndex = this.tabs.length - 1;
		this.syncFocus();
		this.rebuild();
		this.tui?.requestRender();
	}

	/**
	 * Remove a resolved question tab. Disposes the component (stopping its
	 * countdown). If the active tab was removed, an adjacent tab becomes active.
	 * Returns true when at least one tab remains.
	 */
	removeTab(id: string): boolean {
		const index = this.tabs.findIndex((t) => t.id === id);
		if (index === -1) return this.tabs.length > 0;
		this.tabs[index].component.dispose();
		this.tabs.splice(index, 1);
		if (this.activeIndex >= this.tabs.length) {
			this.activeIndex = Math.max(0, this.tabs.length - 1);
		}
		this.syncFocus();
		this.rebuild();
		this.tui?.requestRender();
		return this.tabs.length > 0;
	}

	private switchBy(delta: number): void {
		if (this.tabs.length <= 1) return;
		const count = this.tabs.length;
		this.activeIndex = (this.activeIndex + delta + count) % count;
		this.syncFocus();
		this.rebuild();
		this.tui?.requestRender();
	}

	private syncFocus(): void {
		// Only the active question holds focus; the others keep their state but
		// must not react to input or emit a cursor.
		this.tabs.forEach((tab, i) => {
			tab.component.focused = this._focused && i === this.activeIndex;
		});
	}

	private rebuild(): void {
		this.clear();
		if (this.tabs.length > 1) {
			this.tabStrip.setText(this.buildTabStrip());
			this.addChild(this.tabStrip);
		}
		const active = this.activeComponent;
		if (active) this.addChild(active);
	}

	private buildTabStrip(): string {
		const labels = this.tabs.map((tab, i) => {
			const shortTitle = tab.title.length > 24 ? `${tab.title.slice(0, 23)}…` : tab.title;
			const label = `${i + 1}. ${shortTitle}`;
			return i === this.activeIndex ? theme.fg("accent", theme.bold(`[${label}]`)) : theme.fg("muted", ` ${label} `);
		});
		const hint = theme.fg("muted", "(⇥ switch)");
		return ` ${labels.join(" ")}   ${hint}`;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Tab / Shift+Tab switch questions. Intercepted before the active
		// question sees the key so switching works regardless of which sub-field
		// (option row or free-text) currently holds focus.
		if (this.tabs.length > 1) {
			if (matchesKey(keyData, "shift+tab")) {
				this.switchBy(-1);
				return;
			}
			if (kb.matches(keyData, "tui.input.tab") || matchesKey(keyData, "tab")) {
				this.switchBy(1);
				return;
			}
		}
		this.activeComponent?.handleInput(keyData);
	}

	dispose(): void {
		for (const tab of this.tabs) tab.component.dispose();
		this.tabs = [];
	}
}
