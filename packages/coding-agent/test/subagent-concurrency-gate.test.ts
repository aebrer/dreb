import { describe, expect, it } from "vitest";
import { createSubagentConcurrencyGate } from "../src/core/tools/subagent.js";

/**
 * Unit tests for the subagent concurrency gate. The gate is owned separately from the tool
 * definition so a single logical session keeps an accurate running-child count even when the
 * tool is rebuilt (e.g. on `/reload`) while children launched before the rebuild are still in
 * flight. See PR 468 review finding 1.
 */
describe("createSubagentConcurrencyGate", () => {
	it("rejects a non-positive or non-integer limit", () => {
		expect(() => createSubagentConcurrencyGate(0)).toThrow("positive whole number");
		expect(() => createSubagentConcurrencyGate(-1)).toThrow("positive whole number");
		expect(() => createSubagentConcurrencyGate(1.5)).toThrow("positive whole number");
		expect(() => createSubagentConcurrencyGate(Number.NaN)).toThrow("positive whole number");
	});

	it("bounds concurrent holders and releases queued waiters in order", async () => {
		const gate = createSubagentConcurrencyGate(2);
		const order: number[] = [];

		// First two acquisitions resolve immediately.
		await gate.acquire();
		await gate.acquire();

		// The next two queue behind the two held slots.
		let thirdResolved = false;
		let fourthResolved = false;
		const third = gate.acquire().then(() => {
			thirdResolved = true;
			order.push(3);
		});
		const fourth = gate.acquire().then(() => {
			fourthResolved = true;
			order.push(4);
		});

		await Promise.resolve();
		expect(thirdResolved).toBe(false);
		expect(fourthResolved).toBe(false);

		// Releasing one slot admits exactly one waiter (FIFO).
		gate.release();
		await third;
		expect(thirdResolved).toBe(true);
		expect(fourthResolved).toBe(false);

		gate.release();
		await fourth;
		expect(order).toEqual([3, 4]);
	});

	it("keeps distinct gate instances fully isolated", async () => {
		const gateA = createSubagentConcurrencyGate(1);
		const gateB = createSubagentConcurrencyGate(1);

		await gateA.acquire(); // gateA is now full

		// gateB is independent and must still admit a holder immediately.
		let gateBAdmitted = false;
		await gateB.acquire().then(() => {
			gateBAdmitted = true;
		});
		expect(gateBAdmitted).toBe(true);
	});

	it("a shared gate counts holders acquired across separate consumers (reload survival)", async () => {
		// Simulates the reload case: a session-owned gate is handed to a first tool definition,
		// then to a rebuilt tool definition. In-flight children still occupy slots the rebuilt
		// definition must respect rather than resetting the count to zero.
		const sharedGate = createSubagentConcurrencyGate(1);

		// "Pre-reload" consumer occupies the only slot.
		await sharedGate.acquire();

		// "Post-reload" consumer sharing the same gate must NOT get an immediate slot.
		let postReloadAdmitted = false;
		const postReload = sharedGate.acquire().then(() => {
			postReloadAdmitted = true;
		});
		await Promise.resolve();
		expect(postReloadAdmitted).toBe(false);

		// Once the pre-reload child releases, the post-reload consumer proceeds.
		sharedGate.release();
		await postReload;
		expect(postReloadAdmitted).toBe(true);
	});
});
