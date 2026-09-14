import { createEffect, createMemo, onCleanup } from "solid-js";
import type { AppStore } from "./store.js";

const INTERVAL_MS = 30_000;
// Retain the cadence across route remounts, but never retain an abandoned store.
const clocks = new WeakMap<AppStore, { lastStarted: number }>();

/** Poll only while a fleet surface is visible; the store owns single-flight,
 * last-good values and surfaced errors. Navigation neither starves nor speeds
 * up the shared 30-second cadence. No inventory or transcript requests here. */
export function createFleetStatsRefresh(store: AppStore, enabled: () => boolean): void {
	const visible = createMemo(enabled);
	const clock = clocks.get(store) ?? { lastStarted: Date.now() };
	clocks.set(store, clock);
	createEffect(() => {
		if (!visible()) return;
		let timer: ReturnType<typeof setTimeout>;
		const tick = () => {
			if (Date.now() - clock.lastStarted >= INTERVAL_MS) {
				clock.lastStarted = Date.now();
				void store.refreshFleetStats();
			}
			timer = setTimeout(tick, Math.max(1, INTERVAL_MS - (Date.now() - clock.lastStarted)));
		};
		tick();
		onCleanup(() => clearTimeout(timer));
	});
}
