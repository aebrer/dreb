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

		// User scrolls up (scrollTop decreases) with a genuine wheel-up — follow releases.
		element.scrollHeight = 900;
		element.scrollTop = 200;
		controller.handleWheel(-1);
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
		controller.handleWheel(-1);
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

	it("warns only once when both content and viewport observers are attached without ResizeObserver", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const element: FakeScrollElement = { scrollTop: 400, scrollHeight: 500, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			ResizeObserverImpl: undefined,
		});
		// A screen attaches both a content and a viewport observer; the missing-RO
		// diagnostic must not double-log.
		controller.observeContent({} as Element);
		controller.observeViewport({} as Element);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("re-pins on viewport resize while following but not after release (observeViewport)", () => {
		// A dock/chrome resize (tasks list, subagent strip, composer auto-grow)
		// changes the scroller's clientHeight without a content change or a scroll
		// event. Only the viewport observer catches it.
		const queue = createManualAnimationFrameQueue();
		const ro = createFakeResizeObserver();
		const element: FakeScrollElement = { scrollTop: 400, scrollHeight: 900, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			requestAnimationFrame: queue.raf,
			cancelAnimationFrame: queue.cancelRaf,
			ResizeObserverImpl: ro.Impl,
		});
		controller.observeViewport({} as Element);
		expect(ro.observedCount()).toBe(1);

		// Viewport grows (dock shrank) — clientHeight increased with no scroll event.
		// While following, the observer must re-pin to the new resting bottom.
		element.clientHeight = 300;
		ro.fire();
		queue.flushAll();
		expect(element.scrollTop).toBe(900);

		// After a user up-scroll, a later viewport resize must not yank the view back.
		element.scrollTop = 200;
		controller.handleWheel(-1);
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(false);
		element.clientHeight = 100;
		ro.fire();
		queue.flushAll();
		expect(element.scrollTop).toBe(200);
	});

	it("touch cancel clears the gesture and re-enables pinning (touchcancel)", () => {
		const queue = createManualAnimationFrameQueue();
		const element: FakeScrollElement = { scrollTop: 400, scrollHeight: 500, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			requestAnimationFrame: queue.raf,
			cancelAnimationFrame: queue.cancelRaf,
		});
		controller.handleScroll(); // at bottom → following
		controller.handleTouchStart();

		// Finger down suppresses pinning even while following.
		element.scrollHeight = 900;
		controller.notifyContentChanged();
		queue.flushAll();
		expect(element.scrollTop).toBe(400);

		// The gesture is canceled (system takeover) instead of ending cleanly.
		// gestureActive must clear so pinning resumes — otherwise every future pin
		// is silently suppressed.
		controller.handleTouchCancel();
		controller.notifyContentChanged();
		queue.flushAll();
		expect(element.scrollTop).toBe(900);
	});

	it("dispose cancels a pending pin so a detached scroller is never mutated", () => {
		const queue = createManualAnimationFrameQueue();
		const element: FakeScrollElement = { scrollTop: 400, scrollHeight: 900, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			requestAnimationFrame: queue.raf,
			cancelAnimationFrame: queue.cancelRaf,
		});
		controller.handleScroll(); // following

		// Schedule a pin, then dispose before either frame fires.
		controller.notifyContentChanged();
		controller.dispose();
		queue.flushAll();
		// The pin was cancelled — scrollTop is untouched.
		expect(element.scrollTop).toBe(400);
	});

	it("dispose disconnects both the content and viewport observers", () => {
		const ro = createFakeResizeObserver();
		const element: FakeScrollElement = { scrollTop: 400, scrollHeight: 500, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			ResizeObserverImpl: ro.Impl,
		});
		controller.observeContent({} as Element);
		controller.observeViewport({} as Element);
		expect(ro.observedCount()).toBe(2);

		controller.dispose();
		expect(ro.disconnectedCount()).toBe(2);
	});

	it("keeps following on a layout-induced scrollTop decrease with no user input (assistant→tool boundary)", () => {
		// The core residual bug: at an assistant→tool boundary the transcript
		// reflows (streamed message replaced by full markdown, assistant-turn DOM
		// recreated) and the browser lowers scrollTop while a tool card is appended
		// below. That is NOT a user up-scroll — no wheel/touch/pointer/key input —
		// so follow must survive even though scrollTop decreased and the new bottom
		// is far away.
		const queue = createManualAnimationFrameQueue();
		const intentClock = 1000;
		const element: FakeScrollElement = { scrollTop: 800, scrollHeight: 900, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			requestAnimationFrame: queue.raf,
			cancelAnimationFrame: queue.cancelRaf,
			now: () => intentClock,
		});

		// Parked at the resting bottom, following.
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(true);

		// Reflow: assistant completion lowers scrollTop by 300 and a tool card adds
		// content far below (new bottom is 1400, >40px from the clamped top). No
		// input event preceded this scroll.
		element.scrollHeight = 1500;
		element.scrollTop = 500;
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(true);

		// The next content notification re-pins to the true new bottom.
		controller.notifyContentChanged();
		queue.flushAll();
		expect(element.scrollTop).toBe(1500);
	});

	it("releases on a wheel-up whose scroll sequence has not settled, but not after scrollend", () => {
		const intentClock = 1000;
		const element: FakeScrollElement = { scrollTop: 800, scrollHeight: 900, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			now: () => intentClock,
		});
		controller.handleScroll(); // following at bottom

		// A wheel-up whose scroll has not landed yet: no decrease, no release.
		controller.handleWheel(-1);
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(true);

		// The outer scroller then moves up under the same gesture — releases.
		element.scrollTop = 400;
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(false);
	});

	it("scrollend consumes discrete upward intent (sequence-scoped, not merely time-windowed)", () => {
		const intentClock = 1000;
		const element: FakeScrollElement = { scrollTop: 800, scrollHeight: 900, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			now: () => intentClock, // frozen clock — the 400ms fallback can NEVER expire
		});
		controller.handleScroll();

		// A wheel-up arms intent, its (no-op) scroll sequence settles…
		controller.handleWheel(-1);
		controller.handleScrollEnd();

		// …then a layout-induced reflow lowers scrollTop. Even though the fallback
		// window never expired (frozen clock), scrollend already consumed the
		// intent, so this must NOT release.
		element.scrollHeight = 1500;
		element.scrollTop = 500;
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(true);
	});

	it("downward movement clears discrete upward intent", () => {
		const intentClock = 1000;
		const element: FakeScrollElement = { scrollTop: 800, scrollHeight: 2000, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			now: () => intentClock,
		});
		element.scrollTop = 800;
		controller.handleScroll(); // not at bottom (2000-100=1900), lastTop=800
		expect(controller.isFollowing()).toBe(true);

		// Wheel-up arms, but the user then scrolls DOWN (still above the bottom).
		controller.handleWheel(-1);
		element.scrollTop = 1000;
		controller.handleScroll();
		// A later layout-induced decrease must not be released by the stale stamp.
		element.scrollTop = 700;
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(true);
	});

	it("wheel-up over a nested inner scroller that can still scroll up does NOT arm outer intent", () => {
		// The false-release coincidence: a wheel over the nested bash <pre> bubbles
		// to the outer scroller but is consumed by the pre (it scrolls up instead).
		// If that armed outer intent, an unrelated assistant→tool reflow within the
		// fallback window would satisfy both release conditions — the original
		// silent drop-out. The wheel handler must detect the consuming inner
		// scroller from the event target and refuse to arm.
		const intentClock = 1000;
		const outer = document.createElement("div");
		const inner = document.createElement("pre");
		inner.style.overflowY = "auto";
		outer.appendChild(inner);
		document.body.appendChild(outer);
		Object.defineProperty(inner, "scrollHeight", { configurable: true, value: 600 });
		Object.defineProperty(inner, "clientHeight", { configurable: true, value: 100 });
		inner.scrollTop = 250; // can still scroll up → consumes the wheel
		let outerScrollTop = 800;
		const element = {
			get scrollTop() {
				return outerScrollTop;
			},
			set scrollTop(v: number) {
				outerScrollTop = v;
			},
			scrollHeight: 900,
			clientHeight: 100,
		};
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			now: () => intentClock,
		});
		controller.handleScroll(); // following at bottom

		controller.handleWheel(-1, inner);
		// Reflow lowers outer scrollTop within the (frozen, never-expiring) window.
		element.scrollHeight = 1500;
		outerScrollTop = 500;
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(true);

		// Same wheel but the inner pre is already at its top → it cannot consume,
		// the outer will scroll, so intent DOES arm and a real decrease releases.
		inner.scrollTop = 0;
		outerScrollTop = 1400;
		controller.handleScroll(); // re-engage at the new bottom
		expect(controller.isFollowing()).toBe(true);
		controller.handleWheel(-1, inner);
		outerScrollTop = 900;
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(false);
		outer.remove();
	});

	it("touch is directional: an upward drag releases, a stationary hold plus reflow does not", () => {
		// Upward drag: finger moves DOWN the screen (clientY increases) → content
		// drags down → scrollTop decreases → release.
		const upEl: FakeScrollElement = { scrollTop: 800, scrollHeight: 900, clientHeight: 100 };
		const upCtl = createStickToBottom({ scroller: () => upEl as unknown as HTMLElement });
		upCtl.handleScroll();
		upCtl.handleTouchStart(300);
		upCtl.handleTouchMove(340);
		upEl.scrollTop = 700;
		upCtl.handleScroll();
		expect(upCtl.isFollowing()).toBe(false);

		// Stationary hold: finger down, no movement — a concurrent layout reflow
		// lowers scrollTop. That is NOT an up-scroll; follow must survive.
		const holdEl: FakeScrollElement = { scrollTop: 800, scrollHeight: 900, clientHeight: 100 };
		const holdCtl = createStickToBottom({ scroller: () => holdEl as unknown as HTMLElement });
		holdCtl.handleScroll();
		holdCtl.handleTouchStart(300);
		holdEl.scrollHeight = 1500;
		holdEl.scrollTop = 500;
		holdCtl.handleScroll();
		expect(holdCtl.isFollowing()).toBe(true);

		// Downward drag (finger moving UP the screen scrolls down): a concurrent
		// reflow decrease must not release either.
		const downEl: FakeScrollElement = { scrollTop: 800, scrollHeight: 2000, clientHeight: 100 };
		const downCtl = createStickToBottom({ scroller: () => downEl as unknown as HTMLElement });
		downEl.scrollTop = 1900;
		downCtl.handleScroll();
		downCtl.handleTouchStart(300);
		downCtl.handleTouchMove(260); // finger up = scroll down intent
		downEl.scrollHeight = 2600;
		downEl.scrollTop = 1700; // layout-induced decrease during the drag
		downCtl.handleScroll();
		expect(downCtl.isFollowing()).toBe(true);
	});

	it("touch intent survives past touchend through the inertial scroll until scrollend", () => {
		const intentClock = 1000;
		const element: FakeScrollElement = { scrollTop: 800, scrollHeight: 900, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			now: () => intentClock,
		});
		controller.handleScroll();

		// Upward flick: drag up, lift — the FIRST significant decrease arrives only
		// during post-touch inertia, after gestureActive already cleared.
		controller.handleTouchStart(300);
		controller.handleTouchMove(320);
		controller.handleTouchEnd();
		element.scrollTop = 600; // inertial decrease after the finger lifted
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(false);

		// After the inertial sequence settles, the carried intent is consumed: a
		// later layout-induced decrease cannot release.
		element.scrollTop = 800;
		controller.handleScroll(); // back at bottom → re-engage
		controller.handleScrollEnd();
		element.scrollHeight = 1500;
		element.scrollTop = 500;
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(true);
	});

	it("a plain (non-scrollbar) pointer press never authorizes a release", () => {
		const element: FakeScrollElement = { scrollTop: 800, scrollHeight: 900, clientHeight: 100 };
		const controller = createStickToBottom({ scroller: () => element as unknown as HTMLElement });
		controller.handleScroll();

		// Click / text-selection press (not on the scrollbar) while a reflow lowers
		// scrollTop — must NOT be misread as a scrollbar up-drag.
		controller.handlePointerDown(false);
		element.scrollHeight = 1500;
		element.scrollTop = 500;
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(true);
		controller.handlePointerUp();
	});

	it("does not release when the upward intent has gone stale", () => {
		let intentClock = 1000;
		const element: FakeScrollElement = { scrollTop: 800, scrollHeight: 900, clientHeight: 100 };
		const controller = createStickToBottom({
			scroller: () => element as unknown as HTMLElement,
			now: () => intentClock,
			intentWindowMs: 400,
		});
		controller.handleScroll();

		// A wheel-up happened long ago; by the time a layout-induced decrease fires
		// the intent window has elapsed, so it must not authorize a release.
		controller.handleWheel(-1);
		intentClock += 1000; // 1000ms later, window is 400ms
		element.scrollTop = 400;
		controller.handleScroll();
		expect(controller.isFollowing()).toBe(true);
	});

	it("releases on a scroll-up key press and on an active pointer (scrollbar) drag", () => {
		const intentClock = 1000;
		// Keyboard: at bottom first to seed lastTop, then a PageUp + decrease.
		const keyEl: FakeScrollElement = { scrollTop: 800, scrollHeight: 900, clientHeight: 100 };
		const keyCtl = createStickToBottom({ scroller: () => keyEl as unknown as HTMLElement, now: () => intentClock });
		keyCtl.handleScroll();
		keyCtl.handleKeyDown("PageUp");
		keyEl.scrollTop = 300;
		keyCtl.handleScroll();
		expect(keyCtl.isFollowing()).toBe(false);

		// Scrollbar drag: pointerdown on the scrollbar region, then an up movement.
		const ptrEl: FakeScrollElement = { scrollTop: 800, scrollHeight: 900, clientHeight: 100 };
		const ptrCtl = createStickToBottom({ scroller: () => ptrEl as unknown as HTMLElement, now: () => intentClock });
		ptrCtl.handleScroll();
		ptrCtl.handlePointerDown(true);
		ptrEl.scrollTop = 300;
		ptrCtl.handleScroll();
		expect(ptrCtl.isFollowing()).toBe(false);

		// After the pointer lifts, a later layout-induced decrease must not release.
		ptrCtl.handlePointerUp();
		ptrEl.scrollTop = 800;
		ptrCtl.handleScroll(); // back at bottom → re-engage
		expect(ptrCtl.isFollowing()).toBe(true);
		ptrEl.scrollHeight = 2000;
		ptrEl.scrollTop = 500;
		ptrCtl.handleScroll();
		expect(ptrCtl.isFollowing()).toBe(true);
	});
});
