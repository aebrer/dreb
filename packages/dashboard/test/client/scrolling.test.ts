// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { createCoalescedBottomScroller, createStickToBottom } from "../../src/client/scrolling.js";

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

interface FakeScrollElement {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

/** Minimal controllable ResizeObserver: exposes the registered callback for manual firing. */
function createFakeResizeObserver() {
	let callback: ResizeObserverCallback | undefined;
	let observed = 0;
	let disconnected = 0;
	class FakeResizeObserver {
		constructor(cb: ResizeObserverCallback) {
			callback = cb;
		}
		observe(): void {
			observed++;
		}
		unobserve(): void {}
		disconnect(): void {
			disconnected++;
		}
	}
	return {
		Impl: FakeResizeObserver as unknown as typeof ResizeObserver,
		fire: () => callback?.([], {} as ResizeObserver),
		observedCount: () => observed,
		disconnectedCount: () => disconnected,
	};
}

describe("createStickToBottom", () => {
	it("keeps following through content growth when the user has not scrolled up", () => {
		const queue = createManualAnimationFrameQueue();
		const element: FakeScrollElement = { scrollTop: 400, scrollHeight: 500, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			requestAnimationFrame: queue.raf,
			cancelAnimationFrame: queue.cancelRaf,
		});

		// User is at the bottom.
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(true);

		// Content grows below without the user scrolling; a spurious scroll event
		// fires while the viewport now measures "not at bottom" (the old latch bug).
		element.scrollHeight = 900;
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(true);

		// Next content notification pins back to the new bottom.
		controller.notifyContentChanged();
		queue.flushAll();
		expect(element.scrollTop).toBe(900);
	});

	it("releases follow on a user up-scroll and re-engages at the bottom", () => {
		const queue = createManualAnimationFrameQueue();
		const element: FakeScrollElement = { scrollTop: 400, scrollHeight: 500, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			requestAnimationFrame: queue.raf,
			cancelAnimationFrame: queue.cancelRaf,
		});
		controller.handleScroll();

		// User scrolls up (scrollTop decreases) — follow releases.
		element.scrollHeight = 900;
		element.scrollTop = 200;
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(false);

		// Growth no longer pins while released.
		controller.notifyContentChanged();
		queue.flushAll();
		expect(element.scrollTop).toBe(200);

		// User returns to the bottom — follow re-engages and pins resume.
		element.scrollTop = 800;
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(true);
		element.scrollHeight = 1000;
		controller.notifyContentChanged();
		queue.flushAll();
		expect(element.scrollTop).toBe(1000);
	});

	it("suspends pinning during an active touch drag", () => {
		const queue = createManualAnimationFrameQueue();
		const element: FakeScrollElement = { scrollTop: 400, scrollHeight: 500, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			requestAnimationFrame: queue.raf,
			cancelAnimationFrame: queue.cancelRaf,
		});

		controller.handleTouchStart();
		element.scrollHeight = 900;
		controller.notifyContentChanged();
		queue.flushAll();
		// Finger down: no yank even though still following.
		expect(element.scrollTop).toBe(400);

		// Lifting the finger at the bottom re-enables pinning.
		element.scrollTop = 860;
		controller.handleTouchEnd();
		expect(controller.isFollowing()).toBe(true);
		controller.notifyContentChanged();
		queue.flushAll();
		expect(element.scrollTop).toBe(900);
	});

	it("re-pins on ResizeObserver growth while following but not after release", () => {
		const queue = createManualAnimationFrameQueue();
		const ro = createFakeResizeObserver();
		const element: FakeScrollElement = { scrollTop: 400, scrollHeight: 500, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			requestAnimationFrame: queue.raf,
			cancelAnimationFrame: queue.cancelRaf,
			ResizeObserverImpl: ro.Impl,
		});
		controller.observeContent({} as Element);
		expect(ro.observedCount()).toBe(1);

		// Async growth with no envelope re-pins.
		element.scrollHeight = 900;
		ro.fire();
		queue.flushAll();
		expect(element.scrollTop).toBe(900);

		// After a user up-scroll, observer growth must not yank the view back.
		element.scrollTop = 300;
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(false);
		element.scrollHeight = 1400;
		ro.fire();
		queue.flushAll();
		expect(element.scrollTop).toBe(300);

		controller.dispose();
		expect(ro.disconnectedCount()).toBeGreaterThanOrEqual(1);
	});

	it("keeps following when a pin's echo scroll fires after further growth (browser clamp mechanism)", () => {
		// Reproduces the real-browser mechanism the jsdom screen tests cannot: a
		// programmatic pin clamps `scrollTop` to `scrollHeight - clientHeight` and
		// fires an async echo `scroll` event. If content grows again before that
		// echo arrives, the echo must NOT be misread as a user up-scroll.
		const queue = createManualAnimationFrameQueue();
		const element: FakeScrollElement = { scrollTop: 0, scrollHeight: 500, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			requestAnimationFrame: queue.raf,
			cancelAnimationFrame: queue.cancelRaf,
		});

		// Parked at the resting bottom (scrollHeight - clientHeight).
		element.scrollTop = 400;
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(true);

		// A long tool output lands: content grows and the pin fires.
		element.scrollHeight = 900;
		controller.notifyContentChanged();
		queue.flushAll();
		// The browser clamps `scrollTop = scrollHeight` to `scrollHeight - clientHeight`.
		element.scrollTop = element.scrollHeight - element.clientHeight; // 800

		// Late syntax highlighting grows the block again BEFORE the pin's async echo
		// scroll event is delivered.
		element.scrollHeight = 1100;

		// The echo scroll arrives with the clamped (unchanged) scrollTop against the
		// grown height. The old code seeded `lastTop = scrollHeight` (900), so
		// `800 < 899` released follow here — the silent drop-out reported after a
		// `read` tool call. The fix seeds `lastTop = scrollHeight - clientHeight`.
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(true);

		// Follow survives, so the next growth re-pins to the true bottom.
		controller.notifyContentChanged();
		queue.flushAll();
		expect(element.scrollTop).toBe(1100);
	});

	it("touch end keeps following when content grew during the drag without an up-scroll", () => {
		const queue = createManualAnimationFrameQueue();
		const element: FakeScrollElement = { scrollTop: 400, scrollHeight: 500, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			requestAnimationFrame: queue.raf,
			cancelAnimationFrame: queue.cancelRaf,
		});
		controller.handleScroll(); // at bottom → following
		controller.handleTouchStart();

		// Content grows while the finger is down; the user never scrolls up, so the
		// viewport measures "not at bottom" purely because of the growth.
		element.scrollHeight = 900;

		// Lifting the finger must NOT re-derive follow from absolute at-bottom
		// geometry (the old bug), and must replay the pin suppressed during the drag.
		controller.handleTouchEnd();
		expect(controller.isFollowing()).toBe(true);
		queue.flushAll();
		expect(element.scrollTop).toBe(900);
	});

	it("observeContent rebinds to a replacement element and ignores undefined", () => {
		const queue = createManualAnimationFrameQueue();
		const ro = createFakeResizeObserver();
		const element: FakeScrollElement = { scrollTop: 400, scrollHeight: 500, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			requestAnimationFrame: queue.raf,
			cancelAnimationFrame: queue.cancelRaf,
			ResizeObserverImpl: ro.Impl,
		});

		// Undefined element (ref not ready yet) is a safe no-op.
		controller.observeContent(undefined);
		expect(ro.observedCount()).toBe(0);

		// First real element.
		controller.observeContent({} as Element);
		expect(ro.observedCount()).toBe(1);

		// Rebinding disconnects the prior observer and observes the replacement.
		controller.observeContent({} as Element);
		expect(ro.disconnectedCount()).toBe(1);
		expect(ro.observedCount()).toBe(2);

		// Only the current observer drives re-pins.
		element.scrollHeight = 900;
		ro.fire();
		queue.flushAll();
		expect(element.scrollTop).toBe(900);
	});

	it("warns loudly instead of silently disabling re-pin when ResizeObserver is unavailable", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const element: FakeScrollElement = { scrollTop: 400, scrollHeight: 500, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			ResizeObserverImpl: undefined,
		});
		controller.observeContent({} as Element);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("ResizeObserver unavailable");
		warn.mockRestore();
	});
});
