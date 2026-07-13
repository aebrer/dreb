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
}

export interface StickToBottomController {
	/** Call whenever transcript content changes (e.g. per store revision). */
	notifyContentChanged: () => void;
	/** Bind to the scroller's `scroll` event. */
	handleScroll: () => void;
	/** Bind to the scroller's `touchstart` event (suspends pinning during a drag). */
	handleTouchStart: () => void;
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
 * Stick-to-bottom follow controller shared by live transcript surfaces.
 *
 * Follow intent is released only on a genuine user **up-scroll** (a decrease in
 * `scrollTop`), never re-derived from absolute at-bottom geometry. This is the
 * fix for the silent follow drop-out: appended content grows `scrollHeight`
 * without decreasing `scrollTop`, so it can no longer latch follow off — and the
 * delta signal is input-agnostic (wheel, touch, scrollbar, keyboard all lower
 * `scrollTop` on an up-scroll). Two `ResizeObserver`s keep the view pinned when
 * geometry changes without a scroll event: `observeContent` re-pins when the
 * transcript *content* grows after the last envelope (e.g. throttled syntax
 * highlighting of a long tool output), and `observeViewport` re-pins when the
 * scroll *viewport* itself resizes (surrounding chrome such as the tasks list,
 * subagent strip, or auto-growing composer changes `clientHeight`). An active
 * touch drag suspends pinning so the view never yanks out from under the user's
 * finger.
 */
export function createStickToBottom(options: StickToBottomOptions): StickToBottomController {
	const threshold = options.threshold ?? 40;
	const ResizeObserverImpl =
		options.ResizeObserverImpl ?? (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
	let following = true;
	let gestureActive = false;
	let lastTop = 0;
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
			if (el) lastTop = Math.max(0, el.scrollHeight - el.clientHeight);
			return true;
		},
		requestAnimationFrame: options.requestAnimationFrame,
		cancelAnimationFrame: options.cancelAnimationFrame,
	});

	function notifyContentChanged(): void {
		if (following && !gestureActive) scroller.request();
	}
	function handleScroll(): void {
		const el = options.scroller();
		if (!el) return;
		const top = el.scrollTop;
		if (top + el.clientHeight >= el.scrollHeight - threshold) {
			// Reached (or programmatically pinned to) the bottom — (re-)engage follow.
			following = true;
		} else if (top < lastTop - 1) {
			// Moved up on purpose — release follow. Content growth never decreases
			// scrollTop, so it cannot reach this branch.
			following = false;
		}
		lastTop = top;
	}

	function handleTouchStart(): void {
		gestureActive = true;
	}

	function finishGesture(): void {
		gestureActive = false;
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
		handleTouchStart,
		handleTouchEnd,
		handleTouchCancel,
		observeContent,
		observeViewport,
		isFollowing: () => following,
		dispose,
	};
}
