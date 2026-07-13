/**
 * Scroll helpers shared by live transcript surfaces.
 */

export interface CoalescedBottomScrollerOptions<T extends { scrollTop: number; scrollHeight: number }> {
	element: () => T | undefined;
	shouldScroll: () => boolean;
	requestAnimationFrame?: typeof requestAnimationFrame;
	cancelAnimationFrame?: typeof cancelAnimationFrame;
}

export interface CoalescedBottomScroller {
	request: () => void;
	cancel: () => void;
}

/**
 * Schedule a single double-rAF bottom scroll. Repeated requests while either
 * frame is pending are coalesced; the live conditions are re-read only at fire
 * time so stale effects cannot force a scroll after the user scrolls away.
 */
export function createCoalescedBottomScroller<T extends { scrollTop: number; scrollHeight: number }>(
	options: CoalescedBottomScrollerOptions<T>,
): CoalescedBottomScroller {
	const raf = options.requestAnimationFrame ?? requestAnimationFrame;
	const cancelRaf = options.cancelAnimationFrame ?? cancelAnimationFrame;
	let firstFrame: number | undefined;
	let secondFrame: number | undefined;

	function cancel(): void {
		if (firstFrame !== undefined) cancelRaf(firstFrame);
		if (secondFrame !== undefined) cancelRaf(secondFrame);
		firstFrame = undefined;
		secondFrame = undefined;
	}

	function request(): void {
		if (firstFrame !== undefined || secondFrame !== undefined) return;
		firstFrame = raf(() => {
			firstFrame = undefined;
			secondFrame = raf(() => {
				secondFrame = undefined;
				const element = options.element();
				if (element && options.shouldScroll()) element.scrollTop = element.scrollHeight;
			});
		});
	}

	return { request, cancel };
}

export interface StickToBottomOptions {
	/** The element that actually scrolls (its `scrollTop` is driven to the bottom). */
	scroller: () => HTMLElement | undefined;
	/** Distance from the bottom (px) still treated as "at the bottom". */
	threshold?: number;
	requestAnimationFrame?: typeof requestAnimationFrame;
	cancelAnimationFrame?: typeof cancelAnimationFrame;
	/** Injectable for tests; defaults to the global `ResizeObserver` when present. */
	ResizeObserverImpl?: typeof ResizeObserver;
	/** Injectable clock (ms) for the upward-intent fallback window; defaults to `Date.now`. */
	now?: () => number;
	/**
	 * Bounded FALLBACK for how long (ms) a discrete upward input (wheel-up /
	 * scroll-up key / lifted upward touch) can still authorize a follow release
	 * when the platform never delivers a `scrollend`. The primary clearing
	 * mechanism is sequence-scoped: `handleScrollEnd` (the scroll sequence
	 * settled) and any downward movement clear intent immediately. Defaults to
	 * 400ms.
	 */
	intentWindowMs?: number;
}

export interface StickToBottomController {
	/** Call whenever transcript content changes (e.g. per store revision). */
	notifyContentChanged: () => void;
	/** Bind to the scroller's `scroll` event. */
	handleScroll: () => void;
	/**
	 * Bind to the scroller's `scrollend` event — the scroll sequence settled, so
	 * any discrete upward intent is consumed and cleared.
	 */
	handleScrollEnd: () => void;
	/**
	 * Bind to the scroller's `wheel` event — arms upward intent when scrolling
	 * up. Pass the event target: a wheel over a nested inner scroller (e.g. a
	 * bash-output `<pre>` that can still scroll up) is consumed by that inner
	 * element and must NOT arm intent on this controller.
	 */
	handleWheel: (deltaY: number, target?: EventTarget | null) => void;
	/**
	 * Bind to a `keydown` event — arms directional user intent for scroll
	 * navigation keys. Pass the event target so a nested scrollable that will
	 * consume an upward key does not arm the outer controller. The caller is
	 * responsible for not forwarding keys consumed by an editable target.
	 */
	handleKeyDown: (key: string, shiftKey?: boolean, target?: EventTarget | null) => void;
	/**
	 * Bind to the scroller's `pointerdown`. Pass `onScrollbar: true` only when
	 * the press landed on the scrollbar region — a plain click / text-selection
	 * press must NOT arm upward intent (a concurrent layout reflow would
	 * otherwise be misread as a scrollbar up-drag).
	 */
	handlePointerDown: (onScrollbar: boolean) => void;
	/** Bind to `pointerup`/`pointercancel` (window-level so state cannot stick). */
	handlePointerUp: () => void;
	/** Bind to the scroller's `touchstart` event (suspends pinning during a drag). */
	handleTouchStart: (clientY?: number) => void;
	/**
	 * Bind to the scroller's `touchmove` event with the touch's `clientY` and
	 * event target. Directional: a finger moving DOWN the screen (clientY
	 * increasing) drags the content down, i.e. scrolls UP — that arms upward
	 * intent unless a nested scroller consumes it. Movement in the other
	 * direction arms downward intent under the same routing rule.
	 */
	handleTouchMove: (clientY: number, target?: EventTarget | null) => void;
	/** Bind to the scroller's `touchend` event (ends the drag and replays the pin). */
	handleTouchEnd: () => void;
	/** Bind to the scroller's `touchcancel` event (same finish path as touchend). */
	handleTouchCancel: () => void;
	/** Observe a content element so async growth (e.g. late tool output) re-pins. */
	observeContent: (element: Element | undefined) => void;
	/**
	 * Observe the scroll *viewport* element so that surrounding-chrome resizes
	 * (tasks list / subagent strip toggling, composer textarea auto-growing) that
	 * change `clientHeight` — without a content change or a scroll event — re-pin.
	 */
	observeViewport: (element: Element | undefined) => void;
	/** Current follow state — exposed for tests and diagnostics. */
	isFollowing: () => boolean;
	/** Tear down observers and pending frames. */
	dispose: () => void;
}

/**
 * Walk from an input event's target up to (but excluding) the scroller looking
 * for a nested scrollable element that can consume that direction. Both wheel
 * and keyboard events bubble from the focusable tool-output `<pre>`; when that
 * nested element will move, the outer scroller must not inherit its intent.
 */
function inputConsumedByNestedScroller(
	target: EventTarget | null | undefined,
	scroller: HTMLElement,
	direction: "up" | "down",
): boolean {
	let node: Node | null = target instanceof Node ? target : null;
	while (node && node !== scroller) {
		if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 1) {
			const canConsume =
				direction === "up" ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1;
			const overflowY = typeof getComputedStyle === "function" ? getComputedStyle(node).overflowY : "";
			if (canConsume && (overflowY === "auto" || overflowY === "scroll")) return true;
		}
		node = node.parentNode;
	}
	return false;
}

/**
 * Stick-to-bottom follow controller shared by live transcript surfaces.
 *
 * Follow intent is released only on a genuine user **up-scroll**, and never
 * re-derived from absolute at-bottom geometry. A release requires BOTH signals:
 *
 *  1. the scroller's `scrollTop` actually decreased (`top < lastTop - 1`), and
 *  2. a genuine upward user input authorized it — an upward touch drag, an
 *     active scrollbar drag, or a recent wheel-up / scroll-up key press whose
 *     scroll sequence has not yet settled.
 *
 * Requirement 1 alone is not enough: at an assistant→tool boundary the outer
 * transcript reflows (the streamed message is replaced by its authoritative
 * full-markdown render and a tool card is appended below), and the browser can
 * *lower* `scrollTop` during that relayout with no user input. Treating that
 * layout-induced decrease as a user up-scroll is exactly the silent follow
 * drop-out this controller exists to remove.
 *
 * Requirement 2 is **sequence-scoped**, not merely time-windowed:
 *  - a wheel-up arms intent only when the outer scroller (not a nested inner
 *    scroller that can still scroll up) will consume it;
 *  - intent is cleared as soon as the scroll sequence settles (`scrollend`) or
 *    any downward movement occurs;
 *  - a bounded time window remains only as a fallback for platforms without
 *    `scrollend`.
 *  - touch is directional: intent arms only while the finger movement would
 *    lower `scrollTop`, and survives past `touchend` through the inertial
 *    scroll until the sequence settles;
 *  - a pointer press arms only when it lands on the scrollbar region — plain
 *    clicks and text-selection drags never authorize a release.
 *
 * Appended content grows `scrollHeight` without decreasing `scrollTop`, so it
 * can never reach the release branch either way. Two `ResizeObserver`s keep the
 * view pinned when geometry changes without a scroll event: `observeContent`
 * re-pins when the transcript *content* grows after the last envelope (e.g.
 * throttled syntax highlighting of a long tool output), and `observeViewport`
 * re-pins when the scroll *viewport* itself resizes (surrounding chrome such as
 * the tasks list, subagent strip, or auto-growing composer changes
 * `clientHeight`). An active touch drag suspends pinning so the view never
 * yanks out from under the user's finger.
 */
export function createStickToBottom(options: StickToBottomOptions): StickToBottomController {
	const threshold = options.threshold ?? 40;
	const now = options.now ?? (() => Date.now());
	const intentWindowMs = options.intentWindowMs ?? 400;
	const ResizeObserverImpl =
		options.ResizeObserverImpl ?? (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
	let following = true;
	let gestureActive = false;
	// Directional touch state: the finger's last known clientY, and whether the
	// most recent movement expressed an up-scroll (finger moving DOWN the screen
	// lowers scrollTop). Only an upward touch authorizes a release; a stationary
	// hold or a downward drag never does.
	let lastTouchY: number | undefined;
	let touchUpwardIntent = false;
	let touchDownwardIntent = false;
	// True while a scrollbar drag is active (pointer pressed on the scrollbar
	// region). Plain clicks / text-selection presses do NOT set this.
	let scrollbarDragActive = false;
	// Timestamps of the last discrete input. Sequence-scoped clearing (scrollend
	// and movement in the opposite direction) is primary; these stamps plus
	// intentWindowMs are only the bounded fallback for platforms without scrollend.
	let lastUpwardIntentAt = Number.NEGATIVE_INFINITY;
	let lastDownwardIntentAt = Number.NEGATIVE_INFINITY;
	let lastTop = 0;
	// Keep the start of an upward sequence separate from lastTop. Precision
	// trackpads can emit fractional (or exactly 1px) decreases; advancing lastTop
	// after each of those jitter-sized events used to discard their cumulative
	// deliberate movement before it could release follow.
	let upwardSequenceBaseline = 0;
	let contentObserver: ResizeObserver | undefined;
	let viewportObserver: ResizeObserver | undefined;
	let warnedMissingObserver = false;

	const scroller = createCoalescedBottomScroller({
		element: options.scroller,
		shouldScroll: () => {
			if (!(following && !gestureActive)) return false;
			// About to pin to the bottom: record the *resting* scrollTop the browser
			// will settle at after `scrollTop = scrollHeight` (it clamps to
			// `scrollHeight - clientHeight`), NOT the raw scrollHeight. `lastTop` is
			// compared against real `scrollTop` values in handleScroll; seeding it
			// with a height leaves it ~clientHeight too high, so the pin's own async
			// echo scroll event — or a concurrent content growth before that echo
			// fires — reads as a user up-scroll and silently latches follow off.
			const el = options.scroller();
			if (el) {
				lastTop = Math.max(0, el.scrollHeight - el.clientHeight);
				upwardSequenceBaseline = lastTop;
			}
			return true;
		},
		requestAnimationFrame: options.requestAnimationFrame,
		cancelAnimationFrame: options.cancelAnimationFrame,
	});

	function armUpwardIntent(): void {
		// A new upward input supersedes any prior downward sequence.
		clearDownwardDiscreteIntent();
		if (now() - lastUpwardIntentAt > intentWindowMs) {
			// A first user input can precede this controller's first scroll event.
			// Seed from the live position, not the default zero, so its initial tiny
			// scroll deltas still accumulate against the true resting point.
			const top = options.scroller()?.scrollTop ?? lastTop;
			// Event listeners normally run before the browser applies the scroll, but
			// programmatic callers/tests may present the moved position first. The
			// higher known position is the only valid start for an up-scroll sequence.
			upwardSequenceBaseline = Math.max(lastTop, top);
		}
		lastUpwardIntentAt = now();
	}
	function armDownwardIntent(): void {
		// A new downward input supersedes any prior upward discrete sequence before
		// its scroll event arrives; otherwise a reflow between opposite-direction
		// keys/wheels could still consume the stale upward authorization.
		clearUpwardDiscreteIntent();
		upwardSequenceBaseline = lastTop;
		lastDownwardIntentAt = now();
	}
	function clearUpwardDiscreteIntent(): void {
		lastUpwardIntentAt = Number.NEGATIVE_INFINITY;
	}
	function clearDownwardDiscreteIntent(): void {
		lastDownwardIntentAt = Number.NEGATIVE_INFINITY;
	}
	function resetUpwardSequence(top: number): void {
		clearUpwardDiscreteIntent();
		upwardSequenceBaseline = top;
	}
	// A follow release is authorized only by a genuine upward user input: an
	// upward touch drag, an active scrollbar drag, or a discrete wheel/keyboard
	// up-scroll whose scroll sequence has not yet settled.
	function upwardIntentActive(): boolean {
		return (
			(gestureActive && touchUpwardIntent) || scrollbarDragActive || now() - lastUpwardIntentAt <= intentWindowMs
		);
	}
	// A released reader only re-engages after genuine downward input and an actual
	// downward scroll arrival at the bottom. Geometry-only clamp events caused by
	// content shrink must never turn follow back on.
	function downwardIntentActive(): boolean {
		return (
			(gestureActive && touchDownwardIntent) || scrollbarDragActive || now() - lastDownwardIntentAt <= intentWindowMs
		);
	}

	function notifyContentChanged(): void {
		if (following && !gestureActive) scroller.request();
	}
	function handleScroll(): void {
		const el = options.scroller();
		if (!el) return;
		const top = el.scrollTop;
		const anyDownwardMovement = top > lastTop;
		const atBottom = top + el.clientHeight >= el.scrollHeight - threshold;
		if (atBottom && (following || (anyDownwardMovement && downwardIntentActive()))) {
			// Initial/programmatic following stays engaged. Once released, however,
			// only a real downward user return to the bottom may re-engage it. Do not
			// consume an already-armed upward input merely because its first scroll
			// event still lies within the bottom threshold.
			following = true;
			if (!upwardIntentActive() || anyDownwardMovement) resetUpwardSequence(top);
		} else if (following && top < upwardSequenceBaseline - 1 && upwardIntentActive()) {
			// Moved up cumulatively from a stable sequence baseline AND a genuine
			// upward input authorized it — release follow. The separate baseline lets
			// fractional/exact-1px scroll events accumulate past the jitter threshold.
			following = false;
		} else if (anyDownwardMovement) {
			// Downward movement ends any upward sequence: a stale wheel-up/key stamp
			// must not survive an intervening down-scroll to authorize a later
			// layout-induced decrease.
			resetUpwardSequence(top);
		} else if (!upwardIntentActive()) {
			// With no live upward sequence, layout movement is merely a new resting
			// baseline; it must not contaminate a later genuine input sequence.
			upwardSequenceBaseline = top;
		}
		lastTop = top;
	}
	function handleScrollEnd(): void {
		// The scroll sequence settled — discrete input is consumed. This is the
		// primary clearing mechanism; intentWindowMs is only a fallback.
		clearUpwardDiscreteIntent();
		clearDownwardDiscreteIntent();
		upwardSequenceBaseline = lastTop;
	}

	const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
	function handleWheel(deltaY: number, target?: EventTarget | null): void {
		const el = options.scroller();
		if (deltaY < 0) {
			// Wheel/trackpad up. This only *arms* intent; a release still requires the
			// outer scroller's scrollTop to actually decrease. Additionally, a wheel
			// over a nested inner scroller (e.g. a bash-output <pre>) that can still
			// scroll up is consumed by that inner element — the outer scroller will not
			// move — so arming here would leave a live intent stamp that an unrelated
			// layout reflow could later hijack into a false release.
			if (el && target && inputConsumedByNestedScroller(target, el, "up")) return;
			armUpwardIntent();
		} else if (deltaY > 0) {
			if (el && target && inputConsumedByNestedScroller(target, el, "down")) return;
			armDownwardIntent();
		}
	}
	function handleKeyDown(key: string, shiftKey = false, target?: EventTarget | null): void {
		const el = options.scroller();
		if (SCROLL_UP_KEYS.has(key) || (shiftKey && key === " ")) {
			if (el && target && inputConsumedByNestedScroller(target, el, "up")) return;
			armUpwardIntent();
		} else if (key === "ArrowDown" || key === "PageDown" || key === "End" || (!shiftKey && key === " ")) {
			if (el && target && inputConsumedByNestedScroller(target, el, "down")) return;
			armDownwardIntent();
		}
	}
	function handlePointerDown(onScrollbar: boolean): void {
		// Only a scrollbar-region press can express scroll intent. A plain click or
		// text-selection press must not — otherwise a layout-induced scrollTop
		// decrease while the pointer happens to be held would falsely release.
		if (onScrollbar) scrollbarDragActive = true;
	}
	function handlePointerUp(): void {
		scrollbarDragActive = false;
	}

	function handleTouchStart(clientY?: number): void {
		gestureActive = true;
		lastTouchY = Number.isFinite(clientY) ? clientY : undefined;
		touchUpwardIntent = false;
		touchDownwardIntent = false;
	}

	function handleTouchMove(clientY: number, target?: EventTarget | null): void {
		if (!gestureActive || !Number.isFinite(clientY)) return;
		if (lastTouchY !== undefined) {
			const el = options.scroller();
			// Finger moving DOWN the screen drags content down = scrolls UP.
			if (clientY > lastTouchY + 1) {
				if (el && target && inputConsumedByNestedScroller(target, el, "up")) {
					touchUpwardIntent = false;
					touchDownwardIntent = false;
					clearUpwardDiscreteIntent();
					clearDownwardDiscreteIntent();
				} else {
					touchUpwardIntent = true;
					touchDownwardIntent = false;
					armUpwardIntent();
				}
			} else if (clientY < lastTouchY - 1) {
				if (el && target && inputConsumedByNestedScroller(target, el, "down")) {
					touchUpwardIntent = false;
					touchDownwardIntent = false;
					clearUpwardDiscreteIntent();
					clearDownwardDiscreteIntent();
				} else {
					touchUpwardIntent = false;
					touchDownwardIntent = true;
					armDownwardIntent();
				}
			}
		}
		lastTouchY = clientY;
	}

	function finishGesture(): void {
		gestureActive = false;
		lastTouchY = undefined;
		if (touchUpwardIntent) {
			// The finger lifted mid-up-scroll: inertial scrolling continues AFTER
			// touchend, and its first significant decrease must still be able to
			// release. Convert the directional touch intent into a discrete stamp
			// that survives until the sequence settles (scrollend) or the bounded
			// fallback expires.
			armUpwardIntent();
		} else if (touchDownwardIntent) {
			// Preserve a downward fling long enough for an actual arrival at bottom
			// to re-engage an intentionally released transcript.
			armDownwardIntent();
		}
		touchUpwardIntent = false;
		touchDownwardIntent = false;
		// Do NOT re-derive follow from absolute at-bottom geometry — that is the
		// latch-off bug this controller exists to remove. handleScroll (which fires
		// during the drag) already owns follow state via up-scroll detection, so if
		// the user did not scroll up, `following` is still true even when content
		// grew during the gesture. Just replay the pin that gestureActive suppressed.
		if (following) scroller.request();
	}

	function handleTouchEnd(): void {
		finishGesture();
	}

	function handleTouchCancel(): void {
		// touchcancel (system gesture takeover, too many touch points, etc.) fires
		// *instead of* touchend. Without clearing gestureActive here it would stay
		// true forever, silently suppressing every pin until the next complete touch
		// sequence — a real mobile follow drop-out. Same finish path as touchend.
		finishGesture();
	}

	function makeObserver(element: Element): ResizeObserver | undefined {
		if (!ResizeObserverImpl) {
			// The observer-driven re-pin is a core part of the follow fix; if the
			// platform lacks ResizeObserver we lose it silently. Surface that rather
			// than degrading quietly (repo convention: loud failure over silent
			// fallback). ResizeObserver is baseline in all target browsers, so this
			// should never fire in practice. Warn once per controller so a screen
			// with both content and viewport observers doesn't double-log.
			if (!warnedMissingObserver) {
				warnedMissingObserver = true;
				console.warn(
					"[dashboard] ResizeObserver unavailable — stick-to-bottom async re-pin disabled; the transcript may lag behind live output until the next envelope arrives.",
				);
			}
			return undefined;
		}
		const created = new ResizeObserverImpl(() => notifyContentChanged());
		created.observe(element);
		return created;
	}

	function observeContent(element: Element | undefined): void {
		if (!element) return;
		contentObserver?.disconnect();
		contentObserver = makeObserver(element);
	}

	function observeViewport(element: Element | undefined): void {
		if (!element) return;
		viewportObserver?.disconnect();
		viewportObserver = makeObserver(element);
	}

	function dispose(): void {
		contentObserver?.disconnect();
		viewportObserver?.disconnect();
		contentObserver = undefined;
		viewportObserver = undefined;
		scroller.cancel();
	}

	return {
		notifyContentChanged,
		handleScroll,
		handleScrollEnd,
		handleWheel,
		handleKeyDown,
		handlePointerDown,
		handlePointerUp,
		handleTouchStart,
		handleTouchMove,
		handleTouchEnd,
		handleTouchCancel,
		observeContent,
		observeViewport,
		isFollowing: () => following,
		dispose,
	};
}

export interface BindStickToBottomOptions {
	/**
	 * Live gate — when it returns false the events are ignored (e.g. a tool
	 * output pre whose auto-scroll preference is off).
	 */
	enabled?: () => boolean;
	/**
	 * Where to listen for scroll-up navigation keys:
	 *  - "window": a window-level listener with editable-target exclusion — used
	 *    by full-screen transcripts where the browser may scroll the transcript
	 *    from a key press that targets `body` or unrelated chrome.
	 *  - "element": listen on the scroller itself — used by nested scrollers
	 *    (focusable tool-output pres).
	 */
	keyboard: "window" | "element";
}

function isEditableTarget(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest("input, textarea, select, [contenteditable]") !== null;
}

/**
 * Bind a StickToBottomController to a live DOM scroller. This is THE wiring —
 * shared by the session screen, the subagent screen, the tool-output pre, and
 * the real-browser regression harness, so the exact listeners the app installs
 * are the ones the browser test exercises.
 *
 * Wiring notes:
 *  - `pointerdown` detects scrollbar presses via `offsetX >= clientWidth`
 *    (the vertical scrollbar renders outside the client box); `pointerup` /
 *    `pointercancel` are window-level so a press-in/release-out drag can never
 *    leave the drag state stuck on.
 *  - keyboard uses editable-target exclusion so keys consumed by the composer
 *    (or any input) never arm scroll intent.
 *
 * Returns a cleanup function that removes every listener.
 */
export function bindStickToBottom(
	controller: StickToBottomController,
	scroller: HTMLElement,
	options: BindStickToBottomOptions,
): () => void {
	const enabled = options.enabled ?? (() => true);
	const cleanups: Array<() => void> = [];
	function on<K extends keyof HTMLElementEventMap>(
		target: HTMLElement | Window,
		type: K,
		listener: (event: HTMLElementEventMap[K]) => void,
	): void {
		const wrapped = ((event: Event) => {
			if (enabled()) listener(event as HTMLElementEventMap[K]);
		}) as EventListener;
		target.addEventListener(type, wrapped, { passive: true });
		cleanups.push(() => target.removeEventListener(type, wrapped));
	}

	on(scroller, "scroll", () => controller.handleScroll());
	on(scroller, "scrollend", () => controller.handleScrollEnd());
	on(scroller, "wheel", (event) => controller.handleWheel(event.deltaY, event.target));
	on(scroller, "touchstart", (event) => controller.handleTouchStart(event.touches?.[0]?.clientY));
	on(scroller, "touchmove", (event) => {
		const y = event.touches?.[0]?.clientY;
		if (y !== undefined) controller.handleTouchMove(y, event.target);
	});
	on(scroller, "touchend", () => controller.handleTouchEnd());
	on(scroller, "touchcancel", () => controller.handleTouchCancel());
	on(scroller, "pointerdown", (event) => {
		controller.handlePointerDown(event.pointerType === "mouse" && event.offsetX >= scroller.clientWidth);
	});
	// Window-level: a scrollbar drag released outside the element (or canceled by
	// the system) must still end the drag state.
	on(window, "pointerup", () => controller.handlePointerUp());
	on(window, "pointercancel", () => controller.handlePointerUp());
	if (options.keyboard === "window") {
		on(window, "keydown", (event) => {
			if (isEditableTarget(event.target)) return;
			controller.handleKeyDown(event.key, event.shiftKey, event.target);
		});
	} else {
		on(scroller, "keydown", (event) => {
			if (isEditableTarget(event.target)) return;
			controller.handleKeyDown(event.key, event.shiftKey, event.target);
		});
	}

	return () => {
		for (const cleanup of cleanups) cleanup();
	};
}
