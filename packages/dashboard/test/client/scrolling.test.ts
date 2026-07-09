// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { createCoalescedBottomScroller } from "../../src/client/scrolling.js";

function flushNextFrame(callbacks: FrameRequestCallback[]): void {
	const callback = callbacks.shift();
	if (!callback) throw new Error("no frame scheduled");
	callback(0);
}

interface QueuedFrame {
	handle: number;
	callback: FrameRequestCallback;
}

function createManualAnimationFrameQueue() {
	let nextHandle = 1;
	const callbacks: QueuedFrame[] = [];
	const raf = vi.fn((callback: FrameRequestCallback) => {
		const handle = nextHandle++;
		callbacks.push({ handle, callback });
		return handle;
	});
	const cancelRaf = vi.fn((handle: number) => {
		const index = callbacks.findIndex((frame) => frame.handle === handle);
		if (index !== -1) callbacks.splice(index, 1);
	});
	const flushNext = () => {
		const frame = callbacks.shift();
		if (!frame) throw new Error("no frame scheduled");
		frame.callback(0);
	};
	const flushAll = () => {
		while (callbacks.length > 0) flushNext();
	};
	return { callbacks, raf, cancelRaf, flushNext, flushAll };
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

	it("cancels a pending first frame without scrolling or scheduling another frame", () => {
		const queue = createManualAnimationFrameQueue();
		const element = { scrollTop: 0, scrollHeight: 900 };
		const scroller = createCoalescedBottomScroller({
			element: () => element,
			shouldScroll: () => true,
			requestAnimationFrame: queue.raf,
			cancelAnimationFrame: queue.cancelRaf,
		});

		scroller.request();
		expect(queue.raf).toHaveBeenCalledTimes(1);
		expect(queue.callbacks.map((frame) => frame.handle)).toEqual([1]);

		scroller.cancel();
		expect(queue.cancelRaf).toHaveBeenCalledTimes(1);
		expect(queue.cancelRaf).toHaveBeenCalledWith(1);

		queue.flushAll();
		expect(element.scrollTop).toBe(0);
		expect(queue.raf).toHaveBeenCalledTimes(1);
		expect(queue.callbacks).toHaveLength(0);
	});

	it("cancels a pending second frame without scrolling", () => {
		const queue = createManualAnimationFrameQueue();
		const element = { scrollTop: 0, scrollHeight: 900 };
		const scroller = createCoalescedBottomScroller({
			element: () => element,
			shouldScroll: () => true,
			requestAnimationFrame: queue.raf,
			cancelAnimationFrame: queue.cancelRaf,
		});

		scroller.request();
		queue.flushNext();
		expect(queue.raf).toHaveBeenCalledTimes(2);
		expect(queue.callbacks.map((frame) => frame.handle)).toEqual([2]);

		scroller.cancel();
		expect(queue.cancelRaf).toHaveBeenCalledTimes(1);
		expect(queue.cancelRaf).toHaveBeenCalledWith(2);

		queue.flushAll();
		expect(element.scrollTop).toBe(0);
		expect(queue.raf).toHaveBeenCalledTimes(2);
		expect(queue.callbacks).toHaveLength(0);
	});

	it("allows a fresh request after cancel", () => {
		const queue = createManualAnimationFrameQueue();
		const element = { scrollTop: 0, scrollHeight: 900 };
		const scroller = createCoalescedBottomScroller({
			element: () => element,
			shouldScroll: () => true,
			requestAnimationFrame: queue.raf,
			cancelAnimationFrame: queue.cancelRaf,
		});

		scroller.request();
		scroller.cancel();
		expect(queue.cancelRaf).toHaveBeenCalledWith(1);

		scroller.request();
		expect(queue.raf).toHaveBeenCalledTimes(2);
		expect(queue.callbacks.map((frame) => frame.handle)).toEqual([2]);

		queue.flushAll();
		expect(element.scrollTop).toBe(900);
		expect(queue.raf).toHaveBeenCalledTimes(3);
		expect(queue.callbacks).toHaveLength(0);
	});
});
