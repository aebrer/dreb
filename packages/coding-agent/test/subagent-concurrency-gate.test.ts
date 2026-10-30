import { describe, expect, it } from "vitest";
import { createSubagentConcurrencyGate, SubagentSlotWaitAbortedError } from "../src/core/tools/subagent.js";

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
	it("an aborted waiter leaves the queue without taking a slot; the next waiter still gets it", async () => {
		const gate = createSubagentConcurrencyGate(1);
		await gate.acquire(); // the only slot is held

		const stopped = new AbortController();
		const stoppedWait = gate.acquire(stopped.signal);
		let keptAdmitted = false;
		const keptWait = gate.acquire().then(() => {
			keptAdmitted = true;
		});

		stopped.abort();
		await expect(stoppedWait).rejects.toBeInstanceOf(SubagentSlotWaitAbortedError);

		// The aborted waiter neither consumed nor skipped the slot: releasing the held
		// slot admits the remaining waiter, and the gate is full again afterwards.
		gate.release();
		await keptWait;
		expect(keptAdmitted).toBe(true);

		let extraAdmitted = false;
		const extra = gate.acquire().then(() => {
			extraAdmitted = true;
		});
		await Promise.resolve();
		expect(extraAdmitted).toBe(false);
		gate.release();
		await extra;
		expect(extraAdmitted).toBe(true);
	});

	it("rejects an already-aborted signal without taking a free slot", async () => {
		const gate = createSubagentConcurrencyGate(1);
		const controller = new AbortController();
		controller.abort();

		await expect(gate.acquire(controller.signal)).rejects.toBeInstanceOf(SubagentSlotWaitAbortedError);

		// The free slot is still available to the next caller.
		let admitted = false;
		await gate.acquire().then(() => {
			admitted = true;
		});
		expect(admitted).toBe(true);
	});

	it("an abort after the slot was granted has no effect on accounting", async () => {
		const gate = createSubagentConcurrencyGate(1);
		const controller = new AbortController();
		await gate.acquire(controller.signal);
		controller.abort(); // the holder must still release explicitly

		let waiterAdmitted = false;
		const waiter = gate.acquire().then(() => {
			waiterAdmitted = true;
		});
		await Promise.resolve();
		expect(waiterAdmitted).toBe(false);
		gate.release();
		await waiter;
		expect(waiterAdmitted).toBe(true);
	});
});
