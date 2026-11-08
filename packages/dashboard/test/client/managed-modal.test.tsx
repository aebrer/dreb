// @vitest-environment jsdom

import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "../../src/client/components/common.js";

const disposers: Array<() => void> = [];

function mount(content: () => JSX.Element, prepend = false) {
	const root = document.createElement("div");
	if (prepend) document.body.prepend(root);
	else document.body.append(root);
	const unmount = render(content, root);
	let mounted = true;
	const dispose = () => {
		if (!mounted) return;
		mounted = false;
		unmount();
		root.remove();
	};
	disposers.push(dispose);
	return {
		root,
		dispose,
		panel: root.querySelector<HTMLDivElement>('[role="dialog"]')!,
		backdrop: root.querySelector<HTMLDivElement>(".modal-backdrop")!,
	};
}

function key(target: EventTarget, value: string, shiftKey = false): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true });
	target.dispatchEvent(event);
	return event;
}

function outsideButton(): HTMLButtonElement {
	const button = document.createElement("button");
	button.textContent = "open";
	document.body.append(button);
	button.focus();
	return button;
}

function watchWindow() {
	const handler = vi.fn();
	window.addEventListener("keydown", handler);
	disposers.push(() => window.removeEventListener("keydown", handler));
	return handler;
}

afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("opted-in Modal focus ownership", () => {
	it("focuses the first enabled visible control once and exposes dialog semantics", () => {
		outsideButton();
		const [disabled, setDisabled] = createSignal(false);
		const { panel } = mount(() => (
			<Modal manageFocus title="New session" onDismiss={() => {}}>
				<input disabled />
				<input type="hidden" />
				<fieldset disabled>
					<input />
				</fieldset>
				<div hidden>
					<input />
				</div>
				<div inert>
					<input />
				</div>
				<div style={{ display: "none" }}>
					<input />
				</div>
				<div style={{ visibility: "hidden" }}>
					<input />
				</div>
				<input tabindex={-1} />
				<input id="first" disabled={disabled()} />
				<textarea id="typing" />
			</Modal>
		));
		const first = panel.querySelector<HTMLInputElement>("#first")!;
		const typing = panel.querySelector<HTMLTextAreaElement>("#typing")!;
		expect(panel.getAttribute("aria-modal")).toBe("true");
		expect(panel.getAttribute("tabindex")).toBe("-1");
		expect(panel.getAttribute("aria-label")).toBe("New session");
		expect(document.activeElement).toBe(first);
		typing.focus();
		typing.value = "keep typing";
		setDisabled(true);
		setDisabled(false);
		expect(document.activeElement).toBe(typing);
		expect(typing.value).toBe("keep typing");
	});

	it("contains Tab and Shift-Tab through native controls, links and tabindex controls", () => {
		const background = watchWindow();
		const { panel } = mount(() => (
			<Modal manageFocus title="Controls" onDismiss={() => {}} actions={<span tabindex={0}>custom control</span>}>
				<input />
				<select>
					<option>project</option>
				</select>
				<textarea />
				<button type="button">launch</button>
				<a href="#project">project</a>
			</Modal>
		));
		const controls = [...panel.querySelectorAll<HTMLElement>("input, select, textarea, button, a, span")];
		expect(document.activeElement).toBe(controls[0]);
		expect(key(controls[0], "Tab", true).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(controls.at(-1));
		key(document.activeElement!, "Tab");
		expect(document.activeElement).toBe(controls[0]);
		for (const next of controls.slice(1)) {
			key(document.activeElement!, "Tab");
			expect(document.activeElement).toBe(next);
		}
		key(document.activeElement!, "Tab", true);
		expect(document.activeElement).toBe(controls.at(-2));
		expect(background).not.toHaveBeenCalled();
	});

	it("rechecks disabled fieldsets and hidden/inert/styles on every Tab, with a panel fallback", () => {
		const [pending, setPending] = createSignal(false);
		const { panel } = mount(() => (
			<Modal manageFocus title="Launching" onDismiss={() => {}}>
				<fieldset disabled={pending()}>
					<input id="project" />
				</fieldset>
				<button type="button" disabled={pending()}>
					launch
				</button>
				<div id="visibility">
					<a href="#hidden">hidden later</a>
				</div>
			</Modal>
		));
		const input = panel.querySelector<HTMLInputElement>("input")!;
		const button = panel.querySelector<HTMLButtonElement>("button")!;
		const visibility = panel.querySelector<HTMLDivElement>("#visibility")!;
		visibility.hidden = true;
		key(input, "Tab");
		expect(document.activeElement).toBe(button);
		key(button, "Tab");
		expect(document.activeElement).toBe(input);
		visibility.hidden = false;
		visibility.setAttribute("inert", "");
		key(input, "Tab", true);
		expect(document.activeElement).toBe(button);
		visibility.removeAttribute("inert");
		visibility.style.display = "none";
		key(button, "Tab");
		expect(document.activeElement).toBe(input);
		visibility.style.display = "";
		visibility.style.visibility = "hidden";
		setPending(true);
		expect(input.matches(":disabled")).toBe(true);
		key(input, "Tab");
		expect(document.activeElement).toBe(panel);
		key(panel, "Tab", true);
		expect(document.activeElement).toBe(panel);
		setPending(false);
		key(panel, "Tab");
		expect(document.activeElement).toBe(input);
	});

	it("initially focuses the panel if no enabled controls exist", () => {
		const { panel } = mount(() => (
			<Modal manageFocus title="Pending" onDismiss={() => {}}>
				<button type="button" disabled>
					pending
				</button>
			</Modal>
		));
		expect(document.activeElement).toBe(panel);
	});

	it("dismisses once for Escape or the backdrop, never for panel clicks or while disabled", () => {
		const [pending, setPending] = createSignal(false);
		const dismiss = vi.fn();
		const background = watchWindow();
		const { panel, backdrop } = mount(() => (
			<Modal manageFocus dismissDisabled={pending()} title="Launch" onDismiss={dismiss}>
				<input />
			</Modal>
		));
		panel.click();
		expect(dismiss).not.toHaveBeenCalled();
		expect(key(document.activeElement!, "Escape").defaultPrevented).toBe(true);
		expect(dismiss).toHaveBeenCalledTimes(1);
		backdrop.click();
		expect(dismiss).toHaveBeenCalledTimes(2);
		setPending(true);
		key(document.activeElement!, "Escape");
		backdrop.click();
		expect(dismiss).toHaveBeenCalledTimes(2);
		setPending(false);
		// Even a key dispatched outside the panel is owned at document capture.
		key(document.body, "Escape");
		expect(dismiss).toHaveBeenCalledTimes(3);
		expect(background).not.toHaveBeenCalled();
	});

	it("stops number/letter/arrow/Enter shortcuts at the delegated backdrop, not input defaults or child handlers", () => {
		const background = watchWindow();
		const localKey = vi.fn();
		const inputEvent = vi.fn();
		const { panel, backdrop } = mount(() => (
			<Modal manageFocus title="Text entry" onDismiss={() => {}}>
				<input onKeyDown={localKey} onInput={inputEvent} />
				<button type="button">launch</button>
			</Modal>
		));
		const input = panel.querySelector<HTMLInputElement>("input")!;
		const button = panel.querySelector<HTMLButtonElement>("button")!;
		for (const target of [input, button, backdrop]) {
			for (const value of ["1", "a", "ArrowLeft", "Enter", " "]) {
				expect(key(target, value).defaultPrevented).toBe(false);
			}
		}
		expect(localKey).toHaveBeenCalledTimes(5);
		expect(background).not.toHaveBeenCalled();
		input.value = "a1";
		const event = new InputEvent("input", { data: "1", bubbles: true, cancelable: true });
		expect(input.dispatchEvent(event)).toBe(true);
		expect(inputEvent).toHaveBeenCalledTimes(1);
		expect(input.value).toBe("a1");
	});

	it("moves pending focus to the panel and restores the connected invoker on completion", () => {
		const invoker = outsideButton();
		const [pending, setPending] = createSignal(false);
		const { panel, dispose } = mount(() => (
			<Modal manageFocus dismissDisabled={pending()} title="Pending launch" onDismiss={() => {}}>
				<input disabled={pending()} />
				<button type="button" disabled={pending()} onClick={() => setPending(true)}>
					launch
				</button>
			</Modal>
		));
		const launch = panel.querySelector<HTMLButtonElement>("button")!;
		launch.focus();
		launch.click();
		expect(launch.disabled).toBe(true);
		expect(document.activeElement).toBe(panel);
		const backdropPress = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
		panel.parentElement!.dispatchEvent(backdropPress);
		expect(backdropPress.defaultPrevented).toBe(true);
		const controlPress = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
		launch.dispatchEvent(controlPress);
		expect(controlPress.defaultPrevented).toBe(false);
		dispose();
		expect(document.activeElement).toBe(invoker);
	});

	it("owns ordinary keys targeting body after silent focus loss without blocking input defaults", () => {
		const background = watchWindow();
		const localKey = vi.fn();
		const { panel } = mount(() => (
			<Modal manageFocus title="Escaped focus" onDismiss={() => {}}>
				<input onKeyDown={localKey} />
			</Modal>
		));
		for (const value of ["1", "a", "ArrowDown", "Enter", " "]) {
			(document.activeElement as HTMLElement).blur();
			expect(document.activeElement).toBe(document.body);
			expect(key(document.body, value).defaultPrevented).toBe(true);
			expect(panel.contains(document.activeElement)).toBe(true);
		}
		expect(background).not.toHaveBeenCalled();
		expect(localKey).not.toHaveBeenCalled();
		const input = panel.querySelector<HTMLInputElement>("input")!;
		expect(key(input, "a").defaultPrevented).toBe(false);
		expect(localKey).toHaveBeenCalledOnce();
		expect(background).not.toHaveBeenCalled();
	});

	it("does not steal pending focus from a newer managed modal", () => {
		const [pending, setPending] = createSignal(false);
		mount(() => (
			<Modal manageFocus dismissDisabled={pending()} title="Older" onDismiss={() => {}}>
				<input disabled={pending()} />
			</Modal>
		));
		const newer = mount(
			() => (
				<Modal manageFocus title="Newer" onDismiss={() => {}}>
					<input />
				</Modal>
			),
			true,
		);
		const input = newer.panel.querySelector<HTMLInputElement>("input")!;
		setPending(true);
		expect(document.activeElement).toBe(input);
	});

	it("returns outside focus to an enabled control or to the panel when all are disabled", () => {
		const outside = outsideButton();
		const [pending, setPending] = createSignal(false);
		const { panel } = mount(() => (
			<Modal manageFocus title="Focus" onDismiss={() => {}}>
				<input disabled={pending()} />
			</Modal>
		));
		outside.focus();
		expect(document.activeElement).toBe(panel.querySelector("input"));
		setPending(true);
		outside.focus();
		expect(document.activeElement).toBe(panel);
	});

	it("restores the connected invoker on disposal and removes capture/focus handlers", () => {
		const invoker = outsideButton();
		const { dispose } = mount(() => (
			<Modal manageFocus title="Focus" onDismiss={() => {}}>
				<input />
			</Modal>
		));
		const focus = vi.spyOn(invoker, "focus");
		dispose();
		expect(focus).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(invoker);
		const outside = outsideButton();
		expect(document.activeElement).toBe(outside);
		const background = watchWindow();
		expect(key(outside, "Tab").defaultPrevented).toBe(false);
		expect(key(outside, "Escape").defaultPrevented).toBe(false);
		expect(background).toHaveBeenCalledTimes(2);
	});

	it("does not try to restore a disconnected invoker", () => {
		const invoker = outsideButton();
		const { dispose } = mount(() => (
			<Modal manageFocus title="Focus" onDismiss={() => {}}>
				<input />
			</Modal>
		));
		const focus = vi.spyOn(invoker, "focus");
		invoker.remove();
		dispose();
		expect(focus).not.toHaveBeenCalled();
	});

	it("does not steal focus from a newer managed modal, even one earlier in DOM order", () => {
		const invoker = outsideButton();
		const firstDismiss = vi.fn();
		const first = mount(() => (
			<Modal manageFocus title="First" onDismiss={firstDismiss}>
				<input />
			</Modal>
		));
		const secondDismiss = vi.fn();
		const second = mount(
			() => (
				<Modal manageFocus title="Second" onDismiss={secondDismiss}>
					<input />
				</Modal>
			),
			true,
		);
		const secondInput = second.panel.querySelector<HTMLInputElement>("input")!;
		expect(document.activeElement).toBe(secondInput);
		first.panel.querySelector<HTMLInputElement>("input")!.focus();
		expect(document.activeElement).toBe(secondInput);
		key(secondInput, "Escape");
		expect(secondDismiss).toHaveBeenCalledOnce();
		expect(firstDismiss).not.toHaveBeenCalled();
		const focus = vi.spyOn(invoker, "focus");
		first.dispose();
		expect(focus).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(secondInput);
		second.dispose();
		expect(focus).not.toHaveBeenCalled();
	});

	it("returns to the older modal when the newer modal closes first", () => {
		outsideButton();
		const first = mount(() => (
			<Modal manageFocus title="First" onDismiss={() => {}}>
				<input />
			</Modal>
		));
		const firstInput = first.panel.querySelector<HTMLInputElement>("input")!;
		const second = mount(() => (
			<Modal manageFocus title="Second" onDismiss={() => {}}>
				<input />
			</Modal>
		));
		second.dispose();
		expect(document.activeElement).toBe(firstInput);
		outsideButton();
		expect(document.activeElement).toBe(firstInput);
	});

	it("does not restore over another active view after its panel has been detached", () => {
		const invoker = outsideButton();
		const { panel, dispose } = mount(() => (
			<Modal manageFocus title="Previous view" onDismiss={() => {}}>
				<input />
			</Modal>
		));
		const focus = vi.spyOn(invoker, "focus");
		panel.remove();
		const nextView = outsideButton();
		dispose();
		expect(focus).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(nextView);
	});
});

describe("unmanaged Modal compatibility", () => {
	it("does not focus, trap, isolate shortcuts, restore focus or add managed attributes by default", () => {
		const invoker = outsideButton();
		const dismiss = vi.fn();
		const background = watchWindow();
		const { panel, backdrop, dispose } = mount(() => (
			<Modal title="Existing modal" onDismiss={dismiss}>
				<input />
			</Modal>
		));
		expect(document.activeElement).toBe(invoker);
		expect(panel.getAttribute("aria-modal")).toBeNull();
		expect(panel.getAttribute("tabindex")).toBeNull();
		expect(panel.hasAttribute("data-managed-modal")).toBe(false);
		const backdropPress = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
		backdrop.dispatchEvent(backdropPress);
		expect(backdropPress.defaultPrevented).toBe(false);
		const input = panel.querySelector<HTMLInputElement>("input")!;
		input.focus();
		expect(key(input, "Tab").defaultPrevented).toBe(false);
		expect(key(input, "1").defaultPrevented).toBe(false);
		expect(key(input, "Escape").defaultPrevented).toBe(false);
		expect(background).toHaveBeenCalledTimes(3);
		expect(dismiss).toHaveBeenCalledOnce();
		backdrop.click();
		expect(dismiss).toHaveBeenCalledTimes(2);
		invoker.focus();
		expect(document.activeElement).toBe(invoker);
		input.focus();
		const focus = vi.spyOn(invoker, "focus");
		dispose();
		expect(focus).not.toHaveBeenCalled();
	});
});
