import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as settle } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationBusy, AutomationInput, AutomationNotFound, AutomationRuns } from "../src/server/automation-runs.js";
import type { AutomationDraft, AutomationRun } from "../src/shared/automation.js";

let dir: string;
let historyFile: string;
const id = "setup-key";
const owner = "alice";
type Start = ConstructorParameters<typeof AutomationRuns>[0]["start"];

function agreement(instructions: string): AutomationDraft {
	return {
		name: "Review job",
		cwd: dir,
		instructions,
		orchestrator: { provider: "a", model: "worker", tools: ["read", "write"] },
		guard: { provider: "b", model: "reviewer", tools: ["read"] },
	};
}
function child(name: string) {
	return {
		file: join(dir, `${name}.jsonl`),
		turn: vi.fn<(msg: string, feedback?: boolean) => Promise<string>>(),
		close: vi.fn(async () => {}),
	};
}
function history(): Array<AutomationRun & { owner: string }> {
	return JSON.parse(readFileSync(historyFile, "utf8"));
}
function launch(runs: AutomationRuns, draft = agreement("Check the project")) {
	return runs.launch(owner, id, join(dir, "setup.jsonl"), draft);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dashboard-review-"));
	historyFile = join(dir, "history.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("AutomationRuns", () => {
	it("reviews at 09:04 after work ran past 09:00, then stops without a wrap-up", async () => {
		const draft = agreement("  Process the queue.\nStop at 09:00 UTC.\n");
		const approved = structuredClone(draft);
		let now = Date.parse("2026-06-01T08:59:00Z");
		const work = child("work");
		const guard = child("guard");
		const workDone = Promise.withResolvers<string>();
		const start = vi.fn<Start>(async (_, role) => {
			if (role === "orchestrator")
				expect(history()[0]).toMatchObject({ owner, id, draft: approved, status: "working" });
			return role === "guard" ? guard : work;
		});
		work.turn.mockImplementation(() => {
			expect(history()[0].workFile).toBe(work.file);
			return workDone.promise;
		});
		const report = "Stop condition met: the deadline passed with two items outstanding.";
		guard.turn.mockImplementation(async () => {
			expect(history()[0]).toMatchObject({ status: "reviewing", guardFiles: [guard.file], compactions: 1 });
			return `${report}\nSTOP`;
		});
		const runs = new AutomationRuns({ start, historyFile, now: () => now });
		const initial = launch(runs, draft);
		draft.instructions = "Cancel deadline";
		initial.draft.guard.tools.length = 0;
		await settle();
		expect(work.turn.mock.calls[0][0]).toBe(approved.instructions);
		now = Date.parse("2026-06-01T09:00:00Z");
		await settle();
		expect(start).toHaveBeenCalledTimes(1);
		expect(runs.get(owner, id)?.status).toBe("working");
		now += 4 * 60_000;
		writeFileSync(work.file, '{"type":"message","note":"compaction"}\n{"type":"compaction"}\n');
		workDone.resolve("Two queue items remain.");
		await settle();
		expect(start.mock.calls).toEqual([
			[dir, "orchestrator", approved.orchestrator],
			[dir, "guard", approved.guard],
		]);
		const prompt = guard.turn.mock.calls[0][0];
		for (const evidence of [
			new Date(now).toISOString(),
			Intl.DateTimeFormat().resolvedOptions().timeZone,
			"Two queue items remain.",
			work.file,
			JSON.stringify(approved),
		])
			expect(prompt).toContain(evidence);
		expect(history()[0]).toMatchObject({
			status: "stopped",
			decisions: [{ at: now, action: "stop", report }],
			compactions: 1,
			endedAt: now,
			report,
		});
		expect(statSync(historyFile).mode & 0o777).toBe(0o600);
		expect(work.turn).toHaveBeenCalledTimes(1);
		expect(work.close).toHaveBeenCalledTimes(1);
		expect(guard.close).toHaveBeenCalledTimes(1);
		await runs.close();
	});

	it("persists the guard's delegated choice before feedback; a fresh guard reviews the non-time condition", async () => {
		const draft = agreement("You choose the sample. Stop when it contains a duplicate.");
		const choice = { action: "continue", report: "Use sample B; no duplicate found yet." };
		const final = { action: "stop", report: "B contains a duplicate: stop condition met." };
		const work = child("work"),
			first = child("first"),
			second = child("second");
		const start = vi
			.fn<Start>()
			.mockResolvedValueOnce(work)
			.mockResolvedValueOnce(first)
			.mockResolvedValueOnce(second);
		work.turn
			.mockImplementationOnce(async () => {
				writeFileSync(work.file, '{"type":"compaction"}\n');
				return "Sample A checked; which next?";
			})
			.mockImplementationOnce(async () => {
				expect(history()[0].decisions).toEqual([{ at: 42, ...choice }]);
				expect(first.close).toHaveBeenCalledTimes(1);
				appendFileSync(work.file, '{"type":"compaction"}\n');
				return "B has a duplicate.";
			});
		first.turn.mockResolvedValueOnce("CONTINUE").mockImplementationOnce(async () => {
			writeFileSync(first.file, '{"type":"compaction"}\n');
			return `${choice.report}\nCONTINUE`;
		});
		second.turn.mockResolvedValue(`${final.report}\nSTOP`);
		const runs = new AutomationRuns({ start, historyFile, now: () => 42 });
		launch(runs, draft);
		await settle();
		expect(work.turn.mock.calls).toEqual([
			[draft.instructions, false],
			[choice.report, true],
		]);
		expect(second.turn.mock.calls[0][0]).toContain(choice.report);
		expect(second.turn.mock.calls[0][0]).toContain("B has a duplicate.");
		expect(history()[0]).toMatchObject({
			status: "stopped",
			compactions: 2,
			guardFiles: [first.file, second.file],
			decisions: [
				{ at: 42, ...choice },
				{ at: 42, ...final },
			],
			report: final.report,
		});
		expect(start).toHaveBeenCalledTimes(3);
		await runs.close();
	});

	it.each(["null", "The work looks fine, so carry on with the plan.", '{"action":"stop","report":"done"}', "   \n\n"])(
		"fails closed on a guard reply that carries no decision: %s",
		async (response) => {
			const work = child("work"),
				guard = child("guard");
			work.turn.mockResolvedValue("Evidence");
			guard.turn.mockResolvedValue(response);
			const runs = new AutomationRuns({
				historyFile,
				start: vi.fn<Start>().mockResolvedValueOnce(work).mockResolvedValueOnce(guard),
			});
			launch(runs);
			await settle();
			const saved = history()[0];
			expect(saved).toMatchObject({
				status: "failed",
				decisions: [],
				report: expect.stringMatching(/without a usable guard decision and report/i),
				endedAt: expect.any(Number),
			});
			// The guard's own words survive in the report instead of a parser message.
			if (response.trim()) expect(saved.report).toContain(response.trim());
			// One corrective ask in the same review session, then a visible stop; never a second
			// unattended work turn on an unreadable verdict.
			expect(guard.turn).toHaveBeenCalledTimes(2);
			expect(work.turn).toHaveBeenCalledTimes(1);
			expect(guard.close).toHaveBeenCalledTimes(1);
			await runs.close();
		},
	);

	it.each(["startup", "response", "close"])("ignores late guard %s after stop", async (stage) => {
		const work = child("work"),
			guard = child("guard");
		const acquired = Promise.withResolvers<typeof guard>(),
			response = Promise.withResolvers<string>(),
			closed = Promise.withResolvers<void>();
		work.turn.mockResolvedValue("Evidence");
		guard.turn.mockReturnValue(response.promise);
		guard.close.mockReturnValue(closed.promise);
		const start = vi.fn<Start>().mockResolvedValueOnce(work).mockReturnValueOnce(acquired.promise);
		const runs = new AutomationRuns({ historyFile, start });
		launch(runs);
		await settle();
		expect(start).toHaveBeenCalledTimes(2);
		if (stage !== "startup") acquired.resolve(guard);
		if (stage === "close") response.resolve("keep going\nCONTINUE");
		await settle();
		expect(guard.turn).toHaveBeenCalledTimes(stage === "startup" ? 0 : 1);
		expect(guard.close).toHaveBeenCalledTimes(stage === "close" ? 1 : 0);
		runs.stop(owner, id);
		const stopped = history();
		expect(stopped[0]).toMatchObject({ status: "stopped", report: expect.stringMatching(/user/i) });
		acquired.resolve(guard);
		response.resolve("too late\nCONTINUE");
		closed.resolve();
		await settle();
		expect(history()).toEqual(stopped);
		expect(guard.close).toHaveBeenCalledTimes(1);
		expect(work.close).toHaveBeenCalledTimes(1);
		expect(guard.turn).toHaveBeenCalledTimes(stage === "startup" ? 0 : 1);
		expect(work.turn).toHaveBeenCalledTimes(1);
		expect(start).toHaveBeenCalledTimes(2);
		await runs.close();
	});

	it("scopes reads and stops by owner and rejects duplicate setup ids, including after stop", async () => {
		const work = child("work");
		const acquiring = Promise.withResolvers<typeof work>();
		const start = vi.fn<Start>().mockReturnValue(acquiring.promise);
		const runs = new AutomationRuns({ start });
		const launched = launch(runs);
		expect(launched).not.toHaveProperty("owner");
		expect(runs.list(owner)).toEqual([launched]);
		expect(runs.list("other")).toEqual([]);
		expect(runs.get("other", id)).toBeUndefined();
		expect(() => runs.stop("other", id)).toThrow(/not found/i);
		expect(runs.get(owner, id)).toEqual(launched);
		expect(() => launch(runs)).toThrow(/already/i);
		runs.stop(owner, id);
		expect(() => runs.launch("other", id, launched.setupFile, launched.draft)).toThrow(/already/i);
		const closing = runs.close();
		acquiring.resolve(work);
		await closing;
		expect(work.close).toHaveBeenCalledTimes(1);
		expect(work.turn).not.toHaveBeenCalled();
		expect(start).toHaveBeenCalledTimes(1);
	});

	it("stopping one worker ignores its late evidence without canceling another run", async () => {
		const a = child("a"),
			b = child("b"),
			reviewer = child("reviewer");
		const late = Promise.withResolvers<string>(),
			active = Promise.withResolvers<string>();
		a.turn.mockReturnValue(late.promise);
		b.turn.mockReturnValue(active.promise);
		reviewer.turn.mockResolvedValue("B completed\nSTOP");
		const start = vi.fn<Start>().mockResolvedValueOnce(a).mockResolvedValueOnce(b).mockResolvedValueOnce(reviewer);
		const runs = new AutomationRuns({ start });
		launch(runs);
		runs.launch("bob", "other-setup", "setup-b.jsonl", agreement("Check B"));
		await settle();
		runs.stop(owner, id);
		late.resolve("stale work");
		active.resolve("evidence from B");
		await settle();
		expect(start).toHaveBeenCalledTimes(3);
		expect(reviewer.turn.mock.calls[0][0]).toContain("evidence from B");
		expect(runs.get(owner, id)).toMatchObject({ status: "stopped", guardFiles: [], decisions: [] });
		expect(runs.get("bob", "other-setup")).toMatchObject({ status: "stopped", report: "B completed" });
		await runs.close();
	});

	it("marks unfinished history interrupted without replay, preserving final records across restarts", async () => {
		const work = child("work"),
			guard = child("guard");
		const outstanding = "The index still needs verification.";
		work.turn.mockResolvedValueOnce("The index was written.").mockReturnValue(new Promise(() => {}));
		guard.turn.mockResolvedValue(`${outstanding}\nCONTINUE`);
		const service = new AutomationRuns({
			historyFile,
			start: vi.fn<Start>().mockResolvedValueOnce(work).mockResolvedValueOnce(guard),
		});
		launch(service);
		await settle();
		const [unfinished] = history();
		expect(unfinished.decisions).toHaveLength(1);
		await service.close();
		const [terminal] = history();
		expect(terminal).toMatchObject({ status: "interrupted", report: expect.stringMatching(/shutdown/i) });
		expect(terminal.report).toContain(outstanding);
		expect(work.turn).toHaveBeenCalledTimes(2);
		writeFileSync(
			historyFile,
			JSON.stringify([
				unfinished,
				{ ...unfinished, id: "review", status: "reviewing" },
				{ ...terminal, id: "terminal" },
			]),
		);
		const start = vi.fn<Start>();
		for (const now of [123, 456]) {
			const restored = new AutomationRuns({ historyFile, now: () => now, start });
			for (const key of [id, "review"])
				expect(restored.get(owner, key)).toMatchObject({
					status: "interrupted",
					endedAt: 123,
					report: expect.stringMatching(/restart/i),
				});
			for (const key of [id, "review"]) expect(restored.get(owner, key)?.report).toContain(outstanding);
			expect(history()[2]).toEqual({ ...terminal, id: "terminal" });
			expect(() => launch(restored)).toThrow(/already/i);
			await restored.close();
		}
		expect(start).not.toHaveBeenCalled();
	});

	it.each(["{", "{}", "[{}]"])("moves unusable history %s aside and still starts", (raw) => {
		writeFileSync(historyFile, raw);
		const warnings: string[] = [];
		const runs = new AutomationRuns({ historyFile, warn: (m) => warnings.push(m), start: vi.fn<Start>() });
		expect(runs.list(owner)).toEqual([]);
		expect(warnings.join("\n")).toMatch(/aside|archiving/i);
		// The unusable bytes survive for inspection; the dashboard boots either way.
		const quarantined = readdirSync(dir).filter((name) => name.startsWith("history.json.corrupt-"));
		expect(quarantined.length).toBe(1);
		expect(readFileSync(join(dir, quarantined[0]), "utf8")).toBe(raw);
	});

	it("keeps valid rows when a history file contains an invalid one, preserving the original", () => {
		const good = {
			id: "kept",
			owner,
			setupFile: join(dir, "setup.jsonl"),
			draft: agreement("Keep me"),
			status: "stopped",
			startedAt: 5,
			endedAt: 9,
			compactions: 0,
			guardFiles: [],
			decisions: [],
		};
		writeFileSync(historyFile, JSON.stringify([good, { draft: {} }, good]));
		const warnings: string[] = [];
		const runs = new AutomationRuns({ historyFile, warn: (m) => warnings.push(m), start: vi.fn<Start>() });
		expect(warnings.join("\n")).toMatch(/rejected 2 record\(s\)/);
		expect(runs.list(owner)).toEqual([expect.objectContaining({ id: "kept", status: "stopped" })]);
		const quarantined = readdirSync(dir).filter((name) => name.startsWith("history.json.corrupt-"));
		expect(quarantined.length).toBe(1);
		expect(JSON.parse(readFileSync(join(dir, quarantined[0]), "utf8")).length).toBe(3);
		// The sanitized history replaces the canonical path so the same warning cannot recur.
		expect(history()).toEqual([expect.objectContaining({ id: "kept" })]);
	});

	it("keeps a successful turn when the transcript tail is mid-write, and counts what it can", async () => {
		const work = child("work"),
			guard = child("guard");
		const start = vi.fn<Start>().mockResolvedValueOnce(work).mockResolvedValueOnce(guard);
		work.turn.mockImplementation(async () => {
			// A torn last record is expected while the child appends (see subagent-log.ts).
			writeFileSync(work.file, '{"type":"compaction"}\n{"type":"comp');
			return "Work finished.";
		});
		guard.turn.mockResolvedValue("All finished.\nSTOP");
		const runs = new AutomationRuns({ start, historyFile });
		launch(runs);
		await settle();
		expect(runs.get(owner, id)).toMatchObject({ status: "stopped", report: "All finished.", compactions: 1 });
		await runs.close();
	});

	it("skips compaction bookkeeping instead of failing the run when the transcript is unreadable", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const work = child("work"),
			guard = child("guard");
		// A directory path makes every read throw EISDIR: an environmental read failure, not a
		// missing file. Bookkeeping must never replace the successful turn.
		work.file = dir;
		const start = vi.fn<Start>().mockResolvedValueOnce(work).mockResolvedValueOnce(guard);
		work.turn.mockResolvedValue("Work finished.");
		guard.turn.mockResolvedValue("All finished.\nSTOP");
		const runs = new AutomationRuns({ start, historyFile });
		launch(runs);
		await settle();
		expect(runs.get(owner, id)).toMatchObject({ status: "stopped", report: "All finished.", compactions: 0 });
		expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/count compactions/);
		warn.mockRestore();
		await runs.close();
	});

	describe("guard verdict parsing", () => {
		let caseIndex = 0;
		async function reviewWith(guardReplies: string[]) {
			const work = child(`work${caseIndex}`),
				guard = child(`guard${caseIndex}`);
			const start = vi.fn<Start>().mockResolvedValueOnce(work).mockResolvedValueOnce(guard);
			work.turn.mockResolvedValue("Evidence from the work turn.");
			for (const reply of guardReplies) guard.turn.mockResolvedValueOnce(reply);
			const runs = new AutomationRuns({ start, historyFile });
			const runId = `review-case-${caseIndex++}`;
			runs.launch(owner, runId, join(dir, "setup.jsonl"), agreement("Check the project"));
			await settle();
			return { runs, runId, work, guard };
		}

		it("reads a decision in any case or punctuation, and strips emphasis markers", async () => {
			for (const [reply, report] of [
				["Everything is finished.\nStop.", "Everything is finished."],
				["Everything is finished.\n**STOP**", "Everything is finished."],
				["Everything is finished.\nStop!?", "Everything is finished."],
			] as const) {
				const { runs, runId } = await reviewWith([reply]);
				expect(runs.get(owner, runId)).toMatchObject({ status: "stopped", report });
				await runs.close();
			}
		});

		it("asks for an explanation after a bare STOP and cannot reverse it", async () => {
			const { runs, runId, guard, work } = await reviewWith(["STOP", "Check another item.\nCONTINUE"]);
			expect(guard.turn).toHaveBeenCalledTimes(2);
			expect(work.turn).toHaveBeenCalledTimes(1);
			expect(runs.get(owner, runId)).toMatchObject({
				status: "stopped",
				report: expect.stringMatching(/did not provide a usable stop report/i),
				decisions: [{ action: "stop" }],
			});
			await runs.close();
		});

		it("never continues without findings, even when the correction says CONTINUE", async () => {
			const { runs, runId, guard, work } = await reviewWith(["The inventory is incomplete.", "CONTINUE"]);
			expect(guard.turn).toHaveBeenCalledTimes(2);
			expect(work.turn).toHaveBeenCalledTimes(1);
			expect(runs.get(owner, runId)).toMatchObject({
				status: "failed",
				report: expect.stringContaining("The inventory is incomplete."),
				decisions: [],
			});
			await runs.close();
		});

		it("asks once more when a reply carries no decision, then records the retry's verdict", async () => {
			const { runs, runId, guard, work } = await reviewWith([
				"I believe the work is complete.",
				"The work is complete.\nSTOP",
			]);
			expect(guard.turn).toHaveBeenCalledTimes(2);
			expect(guard.turn.mock.calls[1][0]).toMatch(/did not contain both a report and a decision/i);
			expect(runs.get(owner, runId)).toMatchObject({
				status: "stopped",
				report: "The work is complete.",
				decisions: [{ action: "stop", report: "The work is complete." }],
			});
			// The retry is a review question, not another work turn.
			expect(work.turn).toHaveBeenCalledTimes(1);
			await runs.close();
		});

		it("stops without a decision after the retry, preserving the guard's text in the report", async () => {
			const { runs, runId, guard, work } = await reviewWith(["I think it is fine.", "Still fine."]);
			expect(guard.turn).toHaveBeenCalledTimes(2);
			expect(work.turn).toHaveBeenCalledTimes(1);
			const run = runs.get(owner, runId);
			expect(run?.status).toBe("failed");
			expect(run?.report).toContain("Still fine.");
			expect(run?.report).toContain("I think it is fine.");
			expect(run?.report).toMatch(/without a usable guard decision and report/i);
			await runs.close();
		});
	});

	it("relaunches a finished run as a new attempt and refuses to mutate live or foreign runs", async () => {
		const first = child("first"),
			firstGuard = child("firstguard");
		const liveWork = { ...child("live"), turn: vi.fn<() => Promise<string>>(() => new Promise(() => {})) };
		const start = vi
			.fn<Start>()
			.mockResolvedValueOnce(first)
			.mockResolvedValueOnce(firstGuard)
			.mockResolvedValueOnce(liveWork);
		first.turn.mockResolvedValue("Evidence");
		firstGuard.turn.mockResolvedValue("All done\nSTOP");
		const runs = new AutomationRuns({ historyFile, start });
		const original = launch(runs);
		await settle();
		expect(runs.get(owner, id)).toMatchObject({ status: "stopped", report: "All done" });

		expect(() => runs.relaunch("mallory", id)).toThrow(AutomationNotFound);
		expect(() => runs.relaunch(owner, "missing")).toThrow(AutomationNotFound);

		const attempt = runs.relaunch(owner, id);
		expect(attempt.id).not.toBe(id);
		expect(attempt).toMatchObject({ name: original.draft.name, status: "working" });
		expect(attempt.setupFile).toBe(original.setupFile);
		expect(attempt.draft).toEqual(original.draft);

		// The live attempt cannot be renamed, deleted, or relaunched again.
		expect(() => runs.rename(owner, attempt.id, "Renamed")).toThrow(AutomationBusy);
		expect(() => runs.delete(owner, attempt.id)).toThrow(AutomationBusy);
		expect(() => runs.relaunch(owner, attempt.id)).toThrow(AutomationBusy);
		runs.stop(owner, attempt.id);
		liveWork.turn.mockResolvedValue("too late");

		expect(runs.rename(owner, attempt.id, "Renamed")).toMatchObject({ name: "Renamed" });
		expect(history().find((run) => run.id === attempt.id)?.name).toBe("Renamed");
		expect(() => runs.rename(owner, attempt.id, "  ")).toThrow(AutomationInput);
		expect(() => runs.rename(owner, attempt.id, "x".repeat(81))).toThrow(AutomationInput);
		expect(() => runs.rename("mallory", attempt.id, "x")).toThrow(AutomationNotFound);
		expect(() => runs.delete("mallory", attempt.id)).toThrow(AutomationNotFound);
		runs.delete(owner, attempt.id);
		expect(runs.get(owner, attempt.id)).toBeUndefined();
		expect(history().some((run) => run.id === attempt.id)).toBe(false);
		await runs.close();
		const reopened = new AutomationRuns({ historyFile, start: async () => liveWork });
		const replacement = reopened.relaunch(owner, id);
		expect(replacement.id).not.toBe(attempt.id);
		expect(reopened.get(owner, attempt.id)).toBeUndefined();
		await reopened.close();
	});

	it.each(["rename", "delete"] as const)("does not publish or later save a failed history %s", async (edit) => {
		const target = {
			id,
			owner,
			name: "Original name",
			setupFile: join(dir, "setup.jsonl"),
			draft: agreement("Check the project"),
			status: "stopped",
			startedAt: 1,
			endedAt: 2,
			compactions: 0,
			guardFiles: [],
			decisions: [{ at: 2, action: "stop", report: "All done" }],
			report: "All done",
		};
		const other = { ...target, id: "other" };
		writeFileSync(historyFile, JSON.stringify([target, other]));
		const options = { historyFile, start: vi.fn<Start>() };
		const runs = new AutomationRuns(options);
		const before = runs.get(owner, id);
		// A directory in place of the history file reliably fails atomic replacement, even as root.
		const backup = join(dir, "backup.json");
		renameSync(historyFile, backup);
		mkdirSync(historyFile);
		expect(() => (edit === "rename" ? runs.rename(owner, id, "Not saved") : runs.delete(owner, id))).toThrow();
		expect(runs.get(owner, id)).toEqual(before);
		rmSync(historyFile, { recursive: true });
		renameSync(backup, historyFile);
		runs.rename(owner, other.id, "Saved separately");
		await runs.close();
		const reopened = new AutomationRuns(options);
		expect(reopened.get(owner, id)).toEqual(before);
		expect(reopened.get(owner, other.id)?.name).toBe("Saved separately");
		await reopened.close();
	});

	it("does not start a guard when the worker cannot save its answer", async () => {
		const work = child("work");
		const start = vi.fn<Start>().mockResolvedValueOnce(work);
		work.turn.mockRejectedValue(new Error("Could not save the automation transcript: No space left"));
		const runs = new AutomationRuns({ start, historyFile });
		launch(runs);
		await settle();
		expect(start).toHaveBeenCalledOnce();
		expect(history()[0]).toMatchObject({ status: "failed", guardFiles: [], decisions: [] });
		expect(history()[0].report).toContain("Could not save the automation transcript");
		await runs.close();
	});

	it("records the last work evidence in the report when a turn fails", async () => {
		const work = child("work"),
			guard = child("guard");
		const runs = new AutomationRuns({
			historyFile,
			start: vi.fn<Start>().mockResolvedValueOnce(work).mockResolvedValueOnce(guard),
		});
		work.turn.mockResolvedValue("The worker found the answer is 42.");
		guard.turn.mockRejectedValue(new Error("provider rejected the request"));
		launch(runs);
		await settle();
		expect(history()[0]).toMatchObject({ status: "failed" });
		expect(history()[0].report).toContain("provider rejected the request");
		expect(history()[0].report).toContain("The worker found the answer is 42.");
		await runs.close();
	});

	it("does not spawn or reserve a run id when initial persistence fails", async () => {
		const start = vi.fn<Start>();
		const runs = new AutomationRuns({ historyFile, start });
		mkdirSync(historyFile);
		expect(() => launch(runs)).toThrow();
		expect(runs.list(owner)).toEqual([]);
		expect(start).not.toHaveBeenCalled();
		await runs.close();
	});
});
