import { randomUUID } from "node:crypto";
import {
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RpcSessionState } from "@dreb/coding-agent/rpc";
import type { AutomationDraft, AutomationRun } from "../shared/automation.js";

type StoredRun = AutomationRun & { owner: string };
type Role = "orchestrator" | "guard";
interface Child {
	file: string;
	streamMessage?(): Promise<RpcSessionState["streamMessage"]>;
	turn(message: string, feedback?: boolean): Promise<string>;
	close(): Promise<void>;
}
interface Options {
	historyFile?: string;
	now?: () => number;
	/** Routes operator-visible warnings through the caller's logger; defaults to console.warn. */
	warn?(message: string): void;
	start(cwd: string, role: Role, spec: AutomationDraft["guard"]): Promise<Child>;
}
interface LiveRun {
	run: StoredRun;
	children: Set<Child>;
	/** Final assistant text of the latest completed work turn. */
	lastEvidence?: string;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): boolean {
	return Array.isArray(value) && value.every((s) => typeof s === "string");
}
function model(value: unknown): boolean {
	return (
		object(value) && typeof value.provider === "string" && typeof value.model === "string" && strings(value.tools)
	);
}
type Verdict = Pick<AutomationRun["decisions"][number], "action" | "report">;
/** History lookup failures (unknown id or wrong owner) map to 404 at the HTTP boundary. */
export class AutomationNotFound extends Error {}
/** The run exists but its current state forbids the operation (still live, already terminal). */
export class AutomationBusy extends Error {}
/** The caller supplied a rejected value; the request itself is malformed. */
export class AutomationInput extends Error {}
function decision(value: unknown): value is Verdict {
	return (
		object(value) &&
		(value.action === "stop" || value.action === "continue") &&
		typeof value.report === "string" &&
		!!value.report.trim()
	);
}
function stored(value: unknown): value is StoredRun {
	if (!object(value) || !object(value.draft)) return false;
	const { draft } = value;
	return (
		typeof value.owner === "string" &&
		typeof value.id === "string" &&
		(value.name === undefined || (typeof value.name === "string" && !!value.name.trim())) &&
		typeof value.setupFile === "string" &&
		(value.setupSession === undefined ||
			(object(value.setupSession) &&
				typeof value.setupSession.id === "string" &&
				typeof value.setupSession.cwd === "string")) &&
		typeof draft.name === "string" &&
		typeof draft.cwd === "string" &&
		typeof draft.instructions === "string" &&
		model(draft.guard) &&
		model(draft.orchestrator) &&
		typeof value.status === "string" &&
		["working", "reviewing", "failed", "interrupted", "stopped"].includes(value.status) &&
		Number.isFinite(value.startedAt) &&
		(value.endedAt === undefined || Number.isFinite(value.endedAt)) &&
		typeof value.compactions === "number" &&
		Number.isSafeInteger(value.compactions) &&
		value.compactions >= 0 &&
		(value.workFile === undefined || typeof value.workFile === "string") &&
		strings(value.guardFiles) &&
		(value.report === undefined || typeof value.report === "string") &&
		Array.isArray(value.decisions) &&
		value.decisions.every((d: unknown) => object(d) && Number.isFinite(d.at) && decision(d))
	);
}
// The guard reports in plain English (ASD-STE100 style) and closes with its decision: the word
// STOP or CONTINUE alone on the last line. Only that final line can be the decision — a report
// may legitimately contain the words "stop" or "continue" in prose, and treating such a mention
// as a verdict would end or extend a run by accident. A decision written as "Stop." or
// "**STOP**" is the same decision, so emphasis and sentence punctuation are tolerated. A reply
// whose last line is not a decision is unparseable, not a verdict: the loop asks once more and,
// if that fails too, records the guard's text and stops without scheduling more work.
function parseGuardReport(text: string): Verdict | undefined {
	const lines = text.trimEnd().split("\n");
	const final = (lines.at(-1) ?? "").trim();
	const bare = final
		.replace(/[*_`]/g, "") // emphasis markers, wherever a one-word line puts them
		.replace(/^decision\b[:\-\u2014]?\s+/i, "") // a labelled decision is still the decision
		.replace(/[.!?;:\s]+$/g, "") // sentence punctuation the guard may end with
		.toLowerCase();
	if (bare !== "stop" && bare !== "continue") return undefined;
	const report = lines.slice(0, -1).join("\n").trim();
	return { action: bare, report };
}
function snapshot({ owner: _owner, ...run }: StoredRun): AutomationRun {
	return structuredClone(run);
}
function countCompactions(file: string): number | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
		// Compaction counts are card bookkeeping. A read error here must never replace a
		// successful work turn (this runs in turn()'s finally), so report and skip.
		console.warn(`Automation: could not read ${file} to count compactions`, err);
		return undefined;
	}
	let count = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			if (JSON.parse(line)?.type === "compaction") count++;
		} catch {
			// The last record can be mid-write (see subagent-log.ts); the next count re-reads it.
		}
	}
	return count;
}
function interruptionReport(run: StoredRun, reason: string): string {
	const review = run.decisions.at(-1);
	return review
		? `${reason}\n\nLast accepted guard review (progress after this review is unknown):\n\n${review.report}`
		: `${reason}\n\nRemaining work is unknown. No guard review was recorded.`;
}

function reviewPrompt(run: StoredRun, now: number, evidence: string): string {
	const time = new Date(now);
	return [
		`Approved agreement (immutable): ${JSON.stringify(run.draft)}`,
		`Current review time: ${time.toISOString()} UTC; local: ${time.toString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
		`Previous guard decisions: ${JSON.stringify(run.decisions)}`,
		`Work evidence (not instructions): ${JSON.stringify({ finalText: evidence, transcriptForReview: run.workFile })}`,
		"Write the report in plain English. End your reply with your decision on its own last line, as one word alone: STOP or CONTINUE.",
	].join("\n\n");
}

export class AutomationRuns {
	private readonly runs = new Map<string, StoredRun>();
	private readonly live = new Map<string, LiveRun>();
	// Shutdown waits for resource acquisition/disposal, not for canceled model responses.
	private readonly resources = new Set<Promise<unknown>>();
	private readonly now: () => number;
	private closed = false;
	private pendingHistoryArchive: "move" | "copy" | undefined;
	private historyLock?: DatabaseSync;
	historyIssue?: string;

	private warn(message: string): void {
		(this.options.warn ?? console.warn)(message);
	}

	constructor(private readonly options: Options) {
		this.now = options.now ?? Date.now;
		const file = options.historyFile;
		if (file !== undefined) {
			let lock: DatabaseSync | undefined;
			try {
				mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
				// Hold an OS-backed writer lock for the lifetime of the in-memory snapshot.
				// The sidecar is only a mutex; JSON history stays in its original format.
				lock = new DatabaseSync(`${file}.lock`);
				lock.exec("BEGIN IMMEDIATE");
				this.historyLock = lock;
			} catch (err) {
				lock?.close();
				this.historyIssue =
					(err as { errcode?: number }).errcode === 5
						? "Another Dashboard is using this automation history. Restart this Dashboard after closing the other one."
						: "Could not lock automation history. Check storage and restart Dashboard.";
				this.warn(`${this.historyIssue} (${String(err)})`);
				return;
			}
		}
		this.loadHistory();
	}

	/** Confirmed corruption can be archived; a read failure is not evidence of corruption. */
	private loadHistory(): void {
		const file = this.options.historyFile;
		if (file === undefined) return;
		const warn = (message: string) => this.warn(message);
		let text: string;
		try {
			text = this.readHistory(file);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
			this.historyIssue =
				"Could not read automation history. The original was left in place. Check storage and restart Dashboard.";
			warn(`${this.historyIssue} (${String(err)})`);
			return;
		}
		let rows: unknown;
		try {
			rows = JSON.parse(text);
		} catch (err) {
			warn(
				`Automation history at ${file} is not readable JSON (${String(err)}); moving it aside and starting without history.`,
			);
			this.quarantineHistory(file, warn);
			return;
		}
		if (!Array.isArray(rows)) {
			warn(`Automation history at ${file} is not a list; moving it aside and starting without history.`);
			this.quarantineHistory(file, warn);
			return;
		}
		let interrupted = false;
		const rejected: string[] = [];
		rows.forEach((row, index) => {
			if (!stored(row) || this.runs.has(row.id)) {
				rejected.push(
					typeof (row as { id?: unknown })?.id === "string"
						? String((row as { id: string }).id)
						: `entry ${index}`,
				);
				return;
			}
			this.runs.set(row.id, row);
			if (row.status === "working" || row.status === "reviewing") {
				row.status = "interrupted";
				row.endedAt = this.now();
				row.report = interruptionReport(row, "Interrupted by dashboard restart; work was not resumed.");
				interrupted = true;
			}
		});
		if (rejected.length > 0) {
			warn(
				`Automation history at ${file} rejected ${rejected.length} record(s): ${rejected.join(", ")}. Keeping valid records and archiving the original before replacement.`,
			);
			// A mixed file is still recoverable. Keep it at the canonical path until the repaired
			// history can replace it atomically, even if this process stops before saving again.
			this.pendingHistoryArchive = "copy";
		}
		if (!(interrupted || rejected.length > 0)) return;
		try {
			this.save();
		} catch (err) {
			warn(
				`Could not save repaired automation history at ${file} (${String(err)}). Recovered runs are available in memory.`,
			);
		}
	}

	private readHistory(path: string): string {
		return readFileSync(path, "utf8");
	}

	/** Archive the original history with a sortable, filesystem-safe timestamp. */
	private archiveHistory(file: string, mode: "move" | "copy"): void {
		const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
		let target = `${file}.corrupt-${stamp}`;
		for (let attempt = 1; existsSync(target); attempt++) target = `${file}.corrupt-${stamp}-${attempt}`;
		if (mode === "copy") copyFileSync(file, target, constants.COPYFILE_EXCL);
		else renameSync(file, target);
		this.pendingHistoryArchive = undefined;
	}

	private quarantineHistory(file: string, warn: (message: string) => void): void {
		try {
			this.archiveHistory(file, "move");
		} catch (err) {
			this.pendingHistoryArchive = "move";
			warn(
				`Automation history at ${file} could not be moved aside (${String(err)}); leaving the original untouched.`,
			);
		}
	}

	private save(runs: Iterable<StoredRun> = this.runs.values()): void {
		const path = this.options.historyFile;
		if (path === undefined) return;
		if (this.historyIssue || !this.historyLock) throw new Error(this.historyIssue ?? "Automation history is closed.");
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const temp = `${path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, `${JSON.stringify([...runs])}\n`, { mode: 0o600, flag: "wx" });
			if (this.pendingHistoryArchive) this.archiveHistory(path, this.pendingHistoryArchive);
			renameSync(temp, path);
		} catch (error) {
			try {
				rmSync(temp, { force: true });
			} catch (cleanupError) {
				this.warn(`Could not remove temporary automation history ${temp}: ${String(cleanupError)}`);
			}
			throw error;
		}
	}

	list(owner: string): AutomationRun[] {
		return [...this.runs.values()].filter((run) => run.owner === owner).map(snapshot);
	}

	get(owner: string, id: string): AutomationRun | undefined {
		const run = this.runs.get(id);
		return run?.owner === owner ? snapshot(run) : undefined;
	}

	async streamMessage(owner: string, id: string, file: string): Promise<RpcSessionState["streamMessage"]> {
		const live = this.live.get(id);
		if (!live || live.run.owner !== owner) return undefined;
		const child = [...live.children].find((item) => item.file === file);
		if (!child?.streamMessage) return undefined;
		try {
			const message = await child.streamMessage();
			return this.current(live) && live.children.has(child) ? message : undefined;
		} catch (err) {
			// A review or a cancellation can close the child during the RPC.
			if (this.current(live) && live.children.has(child)) throw err;
			return undefined;
		}
	}

	private register(
		owner: string,
		id: string,
		setupFile: string,
		draft: AutomationDraft,
		name: string | undefined,
		setupSession: AutomationRun["setupSession"],
	): AutomationRun {
		if (this.closed) throw new Error("Automation service closed");
		if (this.runs.has(id)) throw new Error("Automation already launched for this setup");
		const run: StoredRun = {
			id,
			owner,
			...(name?.trim() ? { name: name.trim() } : {}),
			setupFile,
			...(setupSession ? { setupSession: { ...setupSession } } : {}),
			draft: structuredClone(draft),
			status: "working",
			startedAt: this.now(),
			compactions: 0,
			decisions: [],
			guardFiles: [],
		};
		this.runs.set(run.id, run);
		try {
			this.save();
		} catch (err) {
			this.runs.delete(run.id);
			throw err;
		}
		const live: LiveRun = { run, children: new Set() };
		this.live.set(run.id, live);
		void this.loop(live).catch((err) => {
			if (!this.current(live)) return;
			// The last work evidence is the only visible record of what the worker achieved
			// before the failure, so the final report must carry it, not just the error.
			const evidence = this.live.get(run.id) === live ? live.lastEvidence : undefined;
			const reason = `Automation failed: ${err instanceof Error ? err.message : String(err)}`;
			this.finishBackground(live, "failed", evidence ? `${reason}\n\nLast work evidence:\n${evidence}` : reason);
		});
		return snapshot(run);
	}

	launch(
		owner: string,
		setupKey: string,
		setupFile: string,
		draft: AutomationDraft,
		setupSession?: AutomationRun["setupSession"],
	): AutomationRun {
		return this.register(owner, setupKey, setupFile, draft, draft.name, setupSession);
	}

	/** Start a fresh attempt from a finished run's exact approved draft and setup transcript. */
	relaunch(owner: string, id: string): AutomationRun {
		const source = this.runs.get(id);
		if (source?.owner !== owner) throw new AutomationNotFound("Automation not found");
		if (this.live.has(id)) throw new AutomationBusy("Automation is still running");
		if (source.endedAt === undefined) throw new AutomationBusy("Automation has not finished");
		return this.register(
			owner,
			randomUUID(),
			source.setupFile,
			source.draft,
			source.name ?? source.draft.name,
			source.setupSession,
		);
	}

	rename(owner: string, id: string, name: string): AutomationRun {
		const run = this.runs.get(id);
		if (run?.owner !== owner) throw new AutomationNotFound("Automation not found");
		if (this.live.has(id)) throw new AutomationBusy("Cannot rename a running automation");
		const next = name.trim();
		if (!next || next.length > 80) throw new AutomationInput("Automation name must be 1-80 characters");
		const renamed = { ...run, name: next };
		this.save([...this.runs.values()].map((row) => (row === run ? renamed : row)));
		this.runs.set(id, renamed);
		return snapshot(renamed);
	}

	delete(owner: string, id: string): void {
		const run = this.runs.get(id);
		if (run?.owner !== owner) throw new AutomationNotFound("Automation not found");
		if (this.live.has(id)) throw new AutomationBusy("Cannot delete a running automation");
		this.save([...this.runs.values()].filter((row) => row !== run));
		this.runs.delete(id);
	}

	private current(live: LiveRun): boolean {
		return this.live.get(live.run.id) === live;
	}

	private track<T>(task: Promise<T>): Promise<T> {
		this.resources.add(task);
		return task.finally(() => this.resources.delete(task));
	}

	private acquire(live: LiveRun, role: Role): Promise<Child | undefined> {
		const { draft } = live.run;
		return this.track(
			this.options.start(draft.cwd, role, structuredClone(draft[role])).then(async (child) => {
				if (!this.current(live)) {
					await child.close();
					return undefined;
				}
				live.children.add(child);
				return child;
			}),
		);
	}

	private async release(live: LiveRun, child: Child): Promise<void> {
		live.children.delete(child);
		return this.track(child.close());
	}

	private async turn(
		live: LiveRun,
		counts: Map<string, number>,
		child: Child,
		message: string,
		feedback?: boolean,
	): Promise<string> {
		try {
			return await child.turn(message, feedback);
		} finally {
			if (this.current(live)) {
				const count = countCompactions(child.file);
				// An unreadable transcript skips the count; the next turn re-reads the whole file.
				if (count !== undefined) {
					live.run.compactions += count - (counts.get(child.file) ?? 0);
					counts.set(child.file, count);
				}
			}
		}
	}

	private async loop(live: LiveRun): Promise<void> {
		const { run } = live;
		const work = await this.acquire(live, "orchestrator");
		if (!this.current(live) || !work) return;
		run.workFile = work.file;
		this.save();
		let feedback: string | undefined;
		const counts = new Map<string, number>();
		while (this.current(live)) {
			const evidence = await this.turn(
				live,
				counts,
				work,
				feedback ?? run.draft.instructions,
				feedback !== undefined,
			);
			if (!this.current(live)) return;
			live.lastEvidence = evidence;
			run.status = "reviewing";
			this.save();
			const guard = await this.acquire(live, "guard");
			if (!this.current(live) || !guard) return;
			run.guardFiles.push(guard.file);
			this.save();
			const response = await guard.turn(reviewPrompt(run, this.now(), evidence));
			if (!this.current(live)) return;
			let decision = parseGuardReport(response);
			if (!decision?.report) {
				// Ask once in the same review. An explicit STOP cannot be reversed by this
				// formatting correction, even if the guard now says CONTINUE.
				const mustStop = decision?.action === "stop";
				let correction: string;
				let corrected: Verdict | undefined;
				try {
					correction = await guard.turn(
						mustStop
							? "You decided STOP without a report. Explain why you stopped and what remains. Write STOP again on the last line."
							: "Your reply did not contain both a report and a decision. State your findings and any decision you made for the user. For STOP, explain why you stopped and what remains. Write STOP or CONTINUE on the last line.",
					);
					corrected = parseGuardReport(correction);
				} catch (err) {
					correction = `The guard could not complete the correction: ${err instanceof Error ? err.message : String(err)}`;
				}
				if (!this.current(live)) return;
				const replies = `First guard reply:\n${response}\n\nCorrection:\n${correction}`;
				if (corrected?.report && (!mustStop || corrected.action === "stop")) {
					decision = corrected;
				} else if (mustStop || corrected?.action === "stop") {
					decision = {
						action: "stop",
						report: `The guard decided STOP but did not provide a usable stop report. No further work was started.\n\n${replies}`,
					};
				} else {
					this.finishBackground(
						live,
						"failed",
						`Automation stopped without a usable guard decision and report.\n\n${replies}`,
					);
					return;
				}
			}
			run.decisions.push({ at: this.now(), ...decision });
			if (decision.action === "stop") {
				this.finishBackground(live, "stopped", decision.report);
				return;
			}
			feedback = decision.report;
			run.status = "working";
			this.save();
			await this.release(live, guard);
			// The while condition rechecks identity after the asynchronous close.
		}
	}

	private finishBackground(live: LiveRun, status: "stopped" | "failed", report: string): void {
		this.finish(live, status, report);
	}

	private finish(live: LiveRun, status: "stopped" | "failed" | "interrupted", report: string): boolean {
		this.live.delete(live.run.id);
		Object.assign(live.run, { status, endedAt: this.now(), report });
		try {
			this.save();
			return true;
		} catch (err) {
			this.warn(`Could not save final report for automation ${live.run.id}: ${String(err)}`);
			return false;
		} finally {
			for (const child of live.children) {
				void this.release(live, child).catch((err) => console.error("Failed to close automation session", err));
			}
		}
	}

	stop(owner: string, id: string): { ok: true; warning?: string } {
		if (this.runs.get(id)?.owner !== owner) throw new AutomationNotFound("Automation not found");
		const live = this.live.get(id);
		if (live && !this.finish(live, "stopped", interruptionReport(live.run, "Stopped by user."))) {
			return {
				ok: true,
				warning:
					"Work stopped, but Dashboard could not save its final report. The history may be out of date after a restart.",
			};
		}
		return { ok: true };
	}

	async close(): Promise<void> {
		this.closed = true;
		try {
			for (const live of this.live.values()) {
				this.finish(live, "interrupted", interruptionReport(live.run, "Interrupted by dashboard shutdown."));
			}
		} finally {
			await Promise.allSettled(this.resources);
			const lock = this.historyLock;
			this.historyLock = undefined;
			lock?.close();
		}
	}
}
