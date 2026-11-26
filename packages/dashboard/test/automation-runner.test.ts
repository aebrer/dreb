import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationRunner, type AutomationSpawn } from "../src/server/automation-runner.js";
import { AutomationStore } from "../src/server/automation-store.js";
import type { AutomationLaunch } from "../src/shared/automation.js";

type Client = ReturnType<AutomationSpawn>;
type Turn = Awaited<ReturnType<Client["automationTurn"]>>;
const goal: AutomationLaunch = {
	cwd: "/project",
	workerModel: { provider: "one", id: "work" },
	guardModel: { provider: "two", id: "review/one" },
	instructions: "Use your judgment unless the public API would change. Stop at 9am.",
};
const work = { text: "Tests are not yet green.", evidence: [{ role: "tool:bash", text: "tests exited 1" }] };
const verdict = (action: "continue" | "stop", reason: string, report: string): Turn => ({
	text: JSON.stringify({ action, reason, report }),
	evidence: [],
});

function fake(turn: (message: string, feedback: boolean) => Promise<Turn>) {
	return {
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		getState: vi.fn(
			async () =>
				({ sessionFile: "/not-yet-written.jsonl", sessionId: "session-1" }) as Awaited<
					ReturnType<Client["getState"]>
				>,
		),
		automationTurn: vi.fn(turn),
	};
}

const services: AutomationRunner[] = [];
afterEach(async () => {
	await Promise.all(services.splice(0).map((runner) => runner.close()));
});

function harness(...clients: Client[]) {
	const store = new AutomationStore();
	const spawn = vi.fn<AutomationSpawn>().mockImplementation(() => {
		const client = clients.shift();
		if (!client) throw new Error("Unexpected process start");
		return client;
	});
	const changed = vi.fn();
	const now = vi.fn(() => new Date("2026-11-26T09:04:00.000Z"));
	const runner = new AutomationRunner(store, spawn, changed, now);
	services.push(runner);
	return { runner, spawn, changed, now };
}

describe("AutomationRunner", () => {
	it("hands the same instructions to both roles, then continues the same work session", async () => {
		const worker = fake(async () => work);
		const first = fake(async () => verdict("continue", "Keep the public API", "A check is still failing."));
		const second = fake(async () => verdict("stop", "stop condition met", "A check still fails."));
		const { runner, spawn, now } = harness(worker, first, second);
		now.mockReturnValueOnce(new Date("2026-11-26T08:50:00Z")).mockReturnValueOnce(new Date("2026-11-26T08:59:00Z"));
		const id = runner.launch(goal);
		await vi.waitFor(() => expect(runner.detail(id)?.status).toBe("stopped"));
		expect(spawn.mock.calls).toEqual([
			[goal.cwd, "worker", goal.workerModel],
			[goal.cwd, "guard", goal.guardModel],
			[goal.cwd, "guard", goal.guardModel],
		]);
		expect(worker.automationTurn.mock.calls).toEqual([
			[goal.instructions, false],
			["Keep the public API\n\nA check is still failing.", true],
		]);
		const review = JSON.parse(second.automationTurn.mock.calls[0][0]);
		expect(review).toMatchObject({
			agreedInstructions: goal.instructions,
			reviewTime: "2026-11-26T09:04:00.000Z",
			workerReport: work.text,
			workerEvidence: work.evidence,
			previousDecisions: [{ action: "continue" }],
		});
		expect(runner.detail(id)).toMatchObject({
			outcome: "stop condition met",
			finalReport: "A check still fails.",
			hasSession: false,
		});
		expect(runner.detail(id)?.decisions.map(({ action }) => action)).toEqual(["continue", "stop"]);
	});

	it("keeps work in progress past a deadline until a settled review", async () => {
		let finish!: (value: Turn) => void;
		const worker = fake(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const guard = fake(async () => verdict("stop", "stop condition met", "One test remains."));
		const { runner, spawn, now } = harness(worker, guard);
		now.mockReturnValue(new Date("2026-11-26T08:59:00Z"));
		const id = runner.launch(goal);
		await vi.waitFor(() => expect(worker.automationTurn).toHaveBeenCalledOnce());
		now.mockReturnValue(new Date("2026-11-26T09:04:00Z"));
		expect(worker.abort).not.toHaveBeenCalled();
		expect(spawn).toHaveBeenCalledOnce();
		finish(work);
		await vi.waitFor(() => expect(runner.detail(id)?.outcome).toBe("stop condition met"));
		expect(worker.automationTurn).toHaveBeenCalledOnce();
	});

	it("does not continue after a late guard reply to a manually stopped run", async () => {
		const worker = fake(async () => work);
		let finish!: (value: Turn) => void;
		const guard = fake(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const { runner } = harness(worker, guard);
		const id = runner.launch(goal);
		await vi.waitFor(() => expect(guard.automationTurn).toHaveBeenCalledOnce());
		expect(runner.stop(id)).toBe(true);
		finish(verdict("continue", "Not done", "Do another turn"));
		await runner.close();
		expect(worker.automationTurn).toHaveBeenCalledOnce();
		expect(guard.stop).toHaveBeenCalledOnce();
		expect(runner.detail(id)).toMatchObject({ outcome: "Stopped by the user.", decisions: [] });
	});

	it("records a malformed guard reply or provider failure instead of continuing", async () => {
		const worker = fake(async () => work);
		const guard = fake(async () => ({ text: "keep it up", evidence: [] }));
		const { runner } = harness(worker, guard);
		const id = runner.launch(goal);
		await vi.waitFor(() => expect(runner.detail(id)?.status).toBe("failed"));
		expect(worker.automationTurn).toHaveBeenCalledOnce();
		const badWorker = fake(async () => {
			throw new Error("provider unavailable");
		});
		const other = harness(badWorker);
		const bad = other.runner.launch(goal);
		await vi.waitFor(() => expect(other.runner.detail(bad)?.outcome).toBe("provider unavailable"));
		expect(other.spawn).toHaveBeenCalledOnce();
	});

	it("carries setup chat through turns and never starts work from a proposed draft", async () => {
		const setup = fake(async () => ({
			text: '{"message":"I cannot verify that without evidence.","instructions":null}',
			evidence: [],
		}));
		const next = fake(async () => ({
			text: JSON.stringify({ message: "Yes, I can check that.", instructions: goal.instructions }),
			evidence: [],
		}));
		const { runner, spawn } = harness(setup, next);
		const message = { role: "user", text: "Can you verify a result you can't see?" } as const;
		const first = await runner.setup(goal.cwd, goal.workerModel, [message]);
		expect(first.instructions).toBeNull();
		await expect(
			runner.setup(goal.cwd, goal.workerModel, [
				message,
				{ role: "assistant", text: first.message },
				{ role: "user", text: "Use the test output instead." },
			]),
		).resolves.toMatchObject({ instructions: goal.instructions });
		expect(next.automationTurn.mock.calls[0][0]).toContain(first.message);
		expect(spawn.mock.calls.map((call) => call[1])).toEqual(["setup", "setup"]);
		expect(runner.store.list()).toEqual([]);
	});
});
