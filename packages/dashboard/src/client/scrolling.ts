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
