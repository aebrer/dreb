import { createEffect, createMemo, createSignal, type JSX, onCleanup } from "solid-js";
import {
	SESSION_SIDEBAR_WIDTH_MAX,
	SESSION_SIDEBAR_WIDTH_MIN,
	sessionSidebarWidth,
	setSessionSidebarWidth,
} from "../state/preferences.js";

const TRANSCRIPT_MIN_WIDTH = 360;
const HANDLE_WIDTH = 6;

/** Preferred width is persistent; viewport clamping and in-flight drags are not.
 * The separator is a sibling of the scrolling aside, so it never scrolls away. */
export function createFleetSidebarResize(active: () => boolean, container: () => HTMLElement | undefined) {
	const enabled = createMemo(active);
	const [containerWidth, setContainerWidth] = createSignal(window.innerWidth);
	const [dragWidth, setDragWidth] = createSignal<number>();
	let drag: { element: HTMLElement; pointerId: number; startX: number; startWidth: number } | undefined;
	const max = createMemo(() =>
		Math.max(0, Math.min(SESSION_SIDEBAR_WIDTH_MAX, containerWidth() - TRANSCRIPT_MIN_WIDTH - HANDLE_WIDTH)),
	);
	const min = createMemo(() => Math.min(SESSION_SIDEBAR_WIDTH_MIN, max()));
	const clamp = (value: number) => Math.min(max(), Math.max(min(), value));
	const width = createMemo(() => clamp(dragWidth() ?? sessionSidebarWidth()));

	function finish(commit: boolean) {
		const current = drag;
		if (!current) return;
		// Merely focusing/clicking a clamped splitter is not a new preference.
		if (commit && width() !== current.startWidth) setSessionSidebarWidth(width());
		drag = undefined;
		setDragWidth(undefined);
		if (current.element.hasPointerCapture(current.pointerId))
			current.element.releasePointerCapture(current.pointerId);
	}

	createEffect(() => {
		if (!enabled()) {
			finish(false);
			return;
		}
		const parent = container();
		const measure = () => setContainerWidth(parent?.getBoundingClientRect().width || window.innerWidth);
		measure();
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
		if (parent) observer?.observe(parent);
		window.addEventListener("resize", measure);
		onCleanup(() => {
			observer?.disconnect();
			window.removeEventListener("resize", measure);
			finish(false);
		});
	});
	onCleanup(() => finish(false));

	const pointerDown: JSX.EventHandler<HTMLElement, PointerEvent> = (event) => {
		if (!active() || event.button !== 0 || drag) return;
		event.preventDefault();
		event.currentTarget.focus();
		event.currentTarget.setPointerCapture(event.pointerId);
		drag = { element: event.currentTarget, pointerId: event.pointerId, startX: event.clientX, startWidth: width() };
		setDragWidth(width());
	};
	const pointerMove: JSX.EventHandler<HTMLElement, PointerEvent> = (event) => {
		if (drag?.pointerId === event.pointerId) setDragWidth(clamp(drag.startWidth + event.clientX - drag.startX));
	};
	const pointerUp: JSX.EventHandler<HTMLElement, PointerEvent> = (event) => {
		if (drag?.pointerId !== event.pointerId) return;
		pointerMove(event);
		finish(true);
	};
	const pointerCancel: JSX.EventHandler<HTMLElement, PointerEvent> = (event) => {
		if (drag?.pointerId === event.pointerId) finish(false);
	};
	const keyDown: JSX.EventHandler<HTMLElement, KeyboardEvent> = (event) => {
		if (!active()) return;
		const next =
			event.key === "ArrowLeft"
				? width() - 10
				: event.key === "ArrowRight"
					? width() + 10
					: event.key === "Home"
						? min()
						: event.key === "End"
							? max()
							: undefined;
		if (next === undefined) return;
		event.preventDefault();
		event.stopPropagation();
		finish(false);
		setSessionSidebarWidth(clamp(next));
	};

	return {
		width,
		min,
		max,
		dragging: () => dragWidth() !== undefined,
		pointerDown,
		pointerMove,
		pointerUp,
		pointerCancel,
		keyDown,
	};
}

export function FleetSidebarResizeHandle(props: {
	resize: ReturnType<typeof createFleetSidebarResize>;
	id: string;
}): JSX.Element {
	return (
		// biome-ignore lint/a11y/useSemanticElements: interactive window splitter with a range value, not a thematic hr break
		<div
			class="fleet-sidebar-resize"
			classList={{ dragging: props.resize.dragging() }}
			role="separator"
			tabIndex={0}
			aria-label="Fleet sidebar width"
			aria-orientation="vertical"
			aria-controls={props.id}
			aria-valuemin={Math.round(props.resize.min())}
			aria-valuemax={Math.round(props.resize.max())}
			aria-valuenow={Math.round(props.resize.width())}
			aria-valuetext={`${Math.round(props.resize.width())} pixels`}
			onPointerDown={props.resize.pointerDown}
			onPointerMove={props.resize.pointerMove}
			onPointerUp={props.resize.pointerUp}
			onPointerCancel={props.resize.pointerCancel}
			onLostPointerCapture={props.resize.pointerCancel}
			onKeyDown={props.resize.keyDown}
		/>
	);
}
