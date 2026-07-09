// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { createCoalescedBottomScroller } from "../../src/client/scrolling.js";

function flushNextFrame(callbacks: FrameRequestCallback[]): void {
	const callback = callbacks.shift();
	if (!callback) throw new Error("no frame scheduled");
	callback(0);
}

describe("createCoalescedBottomScroller", () => {
	it("coalesces rapid requests and re-checks conditions at fire time", () => {
		const callbacks: FrameRequestCallback[] = [];
		const raf = vi.fn((callback: FrameRequestCallback) => {
			callbacks.push(callback);
			return callbacks.length;
		});
		const cancelRaf = vi.fn();
		let shouldScroll = true;
		const element = { scrollTop: 0, scrollHeight: 900 };
		const scroller = createCoalescedBottomScroller({
			element: () => element,
			shouldScroll: () => shouldScroll,
			requestAnimationFrame: raf,
			cancelAnimationFrame: cancelRaf,
		});

		for (let i = 0; i < 20; i++) scroller.request();
		expect(raf).toHaveBeenCalledTimes(1);

		flushNextFrame(callbacks);
		expect(raf).toHaveBeenCalledTimes(2);
		scroller.request();
		expect(raf).toHaveBeenCalledTimes(2);

		shouldScroll = false;
		flushNextFrame(callbacks);
		expect(element.scrollTop).toBe(0);

		shouldScroll = true;
		scroller.request();
		expect(raf).toHaveBeenCalledTimes(3);
		flushNextFrame(callbacks);
		flushNextFrame(callbacks);
		expect(element.scrollTop).toBe(900);
	});
});
