/** @vitest-environment jsdom */
import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFleetStatsRefresh } from "../../src/client/state/fleet-stats-refresh.js";
import type { AppStore } from "../../src/client/state/store.js";

const disposers: Array<() => void> = [];
function mount(store: AppStore, visible: () => boolean = () => true) {
	return createRoot((dispose) => {
		disposers.push(dispose);
		createFleetStatsRefresh(store, visible);
		return dispose;
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
});
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.useRealTimers();
});

describe("visible fleet stats refresh cadence", () => {
	function store() {
		return { refreshFleetStats: vi.fn(async () => {}) } as unknown as AppStore;
	}

	it("refreshes every 30 seconds and stops on hide or unmount", async () => {
		const s = store();
		const [visible, setVisible] = createSignal(true);
		const dispose = mount(s, visible);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(s.refreshFleetStats).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(s.refreshFleetStats).toHaveBeenCalledTimes(1);
		setVisible(false);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(s.refreshFleetStats).toHaveBeenCalledTimes(1);
		setVisible(true);
		expect(s.refreshFleetStats).toHaveBeenCalledTimes(2);
		dispose();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(s.refreshFleetStats).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps the shared cadence across rapid session remounts and multiple surfaces", async () => {
		const s = store();
		let dispose = mount(s);
		for (let i = 0; i < 5; i++) {
			await vi.advanceTimersByTimeAsync(5_000);
			dispose();
			dispose = mount(s);
		}
		mount(s);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(s.refreshFleetStats).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(s.refreshFleetStats).toHaveBeenCalledTimes(2);
	});

	it("does not poll a mobile drawer until opened and isolates store lifetimes", async () => {
		const s = store();
		const [open, setOpen] = createSignal(false);
		mount(s, open);
		await vi.advanceTimersByTimeAsync(90_000);
		expect(s.refreshFleetStats).not.toHaveBeenCalled();
		setOpen(true);
		expect(s.refreshFleetStats).toHaveBeenCalledTimes(1);
		const fresh = store();
		mount(fresh);
		expect(fresh.refreshFleetStats).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fresh.refreshFleetStats).toHaveBeenCalledTimes(1);
	});
});
