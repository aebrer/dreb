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
	/** Request a pin to the bottom (honored only while following and no gesture is active). */
	request: () => void;
	/** Call whenever transcript content changes (e.g. per store revision). */
	notifyContentChanged: () => void;
	/** Bind to the scroller's `scroll` event. */
	handleScroll: () => void;
	/** Bind to the scroller's `touchstart` event (suspends pinning during a drag). */
	handleTouchStart: () => void;
	/** Bind to the scroller's `touchend` event (re-evaluates follow state). */
	handleTouchEnd: () => void;
	/** Observe a content element so async growth (e.g. late tool output) re-pins. */
	observeContent: (element: Element | undefined) => void;
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
 * `scrollTop` on an up-scroll). A `ResizeObserver` re-pins when content grows
 * after the last envelope (e.g. throttled syntax highlighting of a long tool
 * output), and an active touch drag suspends pinning so the view never yanks
 * out from under the user's finger.
 */
export function createStickToBottom(options: StickToBottomOptions): StickToBottomController {
	const threshold = options.threshold ?? 40;
	const ResizeObserverImpl =
		options.ResizeObserverImpl ?? (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
	let following = true;
	let gestureActive = false;
	let lastTop = 0;
	let observer: ResizeObserver | undefined;

	const scroller = createCoalescedBottomScroller({
		element: options.scroller,
		shouldScroll: () => {
			if (!(following && !gestureActive)) return false;
			// About to pin to the bottom: record the target so the next genuine
			// user up-scroll is measured against the pinned position, not a stale
			// pre-pin one (which would otherwise fail to release follow).
			const el = options.scroller();
			if (el) lastTop = el.scrollHeight;
			return true;
		},
		requestAnimationFrame: options.requestAnimationFrame,
		cancelAnimationFrame: options.cancelAnimationFrame,
	});

	const atBottom = (): boolean => {
		const el = options.scroller();
		return !el || el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
	};

	function request(): void {
		scroller.request();
	}

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

	function handleTouchEnd(): void {
		gestureActive = false;
		following = atBottom();
	}

	function observeContent(element: Element | undefined): void {
		if (!element || !ResizeObserverImpl) return;
		observer?.disconnect();
		observer = new ResizeObserverImpl(() => {
			if (following && !gestureActive) scroller.request();
		});
		observer.observe(element);
	}

	function dispose(): void {
		observer?.disconnect();
		observer = undefined;
		scroller.cancel();
	}

	return {
		request,
		notifyContentChanged,
		handleScroll,
		handleTouchStart,
		handleTouchEnd,
		observeContent,
		isFollowing: () => following,
		dispose,
	};
}
