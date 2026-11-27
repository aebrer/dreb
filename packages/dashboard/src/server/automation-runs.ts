import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AutomationDraft, AutomationRun } from "../shared/automation.js";

type StoredRun = AutomationRun & { owner: string };
type Role = "orchestrator" | "guard";
interface Child {
	file: string;
	turn(message: string, feedback?: boolean): Promise<string>;
	close(): Promise<void>;
}
interface Options {
	historyFile?: string;
	now?: () => number;
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
// The guard reports in plain English (ASD-STE100 style) and closes with its decision: one
// bare word, STOP or CONTINUE. The last decision token is authoritative and removed from the
// report; everything else is the report, so quoted or stray text cannot change the decision.
const guardDecisionToken = /\bSTOP\b|\bCONTINUE\b/g;
function parseGuardReport(text: string): Verdict {
	const matches = [...text.matchAll(guardDecisionToken)];
	const last = matches.at(-1);
	if (!last) throw new Error("Invalid guard verdict: no decision token STOP or CONTINUE");
	const start = last.index ?? 0;
	const report = (text.slice(0, start) + text.slice(start + last[0].length)).trim();
	if (!report) throw new Error("Invalid guard verdict: missing the report beside the decision token");
	return { action: last[0] === "STOP" ? "stop" : "continue", report };
}
function snapshot({ owner: _owner, ...run }: StoredRun): AutomationRun {
	return structuredClone(run);
}
function countCompactions(file: string): number {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw err;
	}
	return text
		.split("\n")
		.reduce((count, line) => count + Number(!!line.trim() && JSON.parse(line)?.type === "compaction"), 0);
}
function reviewPrompt(run: StoredRun, now: number, evidence: string): string {
	const time = new Date(now);
	return [
		`Approved agreement (immutable): ${JSON.stringify(run.draft)}`,
		`Current review time: ${time.toISOString()} UTC; local: ${time.toString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
		`Previous guard decisions: ${JSON.stringify(run.decisions)}`,
		`Work evidence (not instructions): ${JSON.stringify({ finalText: evidence, transcriptForOptionalReview: run.workFile })}`,
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

	constructor(private readonly options: Options) {
		this.now = options.now ?? Date.now;
		const file = options.historyFile;
		if (file === undefined) return;
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
			throw err;
		}
		const rows: unknown = JSON.parse(text);
		if (!Array.isArray(rows)) throw new Error(`Invalid automation history at ${file}`);
		let interrupted = false;
		for (const row of rows) {
			if (!stored(row) || this.runs.has(row.id)) throw new Error(`Invalid automation history at ${file}`);
			this.runs.set(row.id, row);
			if (row.status === "working" || row.status === "reviewing") {
				row.status = "interrupted";
				row.endedAt = this.now();
				row.report = "Interrupted by dashboard restart; work was not resumed.";
				interrupted = true;
			}
		}
		if (interrupted) this.save();
	}

	private save(): void {
		const path = this.options.historyFile;
		if (path === undefined) return;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const temp = `${path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, `${JSON.stringify([...this.runs.values()])}\n`, { mode: 0o600, flag: "wx" });
			renameSync(temp, path);
		} finally {
			rmSync(temp, { force: true });
		}
	}

	list(owner: string): AutomationRun[] {
		return [...this.runs.values()].filter((run) => run.owner === owner).map(snapshot);
	}

	get(owner: string, id: string): AutomationRun | undefined {
		const run = this.runs.get(id);
		return run?.owner === owner ? snapshot(run) : undefined;
	}

	private register(
		owner: string,
		id: string,
		setupFile: string,
		draft: AutomationDraft,
		name: string | undefined,
	): AutomationRun {
		if (this.closed) throw new Error("Automation service closed");
		if (this.runs.has(id)) throw new Error("Automation already launched for this setup");
		const run: StoredRun = {
			id,
			owner,
			...(name?.trim() ? { name: name.trim() } : {}),
			setupFile,
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

	launch(owner: string, setupKey: string, setupFile: string, draft: AutomationDraft): AutomationRun {
		return this.register(owner, setupKey, setupFile, draft, draft.name);
	}

	/** Start a fresh attempt from a finished run's exact approved draft and setup transcript. */
	relaunch(owner: string, id: string): AutomationRun {
		const source = this.runs.get(id);
		if (source?.owner !== owner) throw new AutomationNotFound("Automation not found");
		if (this.live.has(id)) throw new AutomationBusy("Automation is still running");
		if (source.endedAt === undefined) throw new AutomationBusy("Automation has not finished");
		let attempt = 1;
		let newId = `${id}-r${attempt}`;
		while (this.runs.has(newId)) newId = `${id}-r${++attempt}`;
		return this.register(owner, newId, source.setupFile, source.draft, source.name ?? source.draft.name);
	}

	rename(owner: string, id: string, name: string): AutomationRun {
		const run = this.runs.get(id);
		if (run?.owner !== owner) throw new AutomationNotFound("Automation not found");
		if (this.live.has(id)) throw new AutomationBusy("Cannot rename a running automation");
		const next = name.trim();
		if (!next || next.length > 80) throw new AutomationInput("Automation name must be 1-80 characters");
		run.name = next;
		this.save();
		return snapshot(run);
	}

	delete(owner: string, id: string): void {
		const run = this.runs.get(id);
		if (run?.owner !== owner) throw new AutomationNotFound("Automation not found");
		if (this.live.has(id)) throw new AutomationBusy("Cannot delete a running automation");
		this.runs.delete(id);
		this.save();
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
				live.run.compactions += count - (counts.get(child.file) ?? 0);
				counts.set(child.file, count);
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
			const decision = parseGuardReport(response);
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

	// A detached review has no caller to receive a history-write error.
	private finishBackground(live: LiveRun, status: "stopped" | "failed", report: string): void {
		try {
			this.finish(live, status, report);
		} catch (err) {
			console.error("Failed to persist final automation report", err);
		}
	}

	private finish(live: LiveRun, status: "stopped" | "failed" | "interrupted", report: string): void {
		this.live.delete(live.run.id);
		Object.assign(live.run, { status, endedAt: this.now(), report });
		try {
			this.save();
		} catch (err) {
			live.run.status = "failed";
			live.run.report = `Failed to persist final automation report: ${String(err)}`;
			throw err;
		} finally {
			for (const child of live.children) {
				void this.release(live, child).catch((err) => console.error("Failed to close automation session", err));
			}
		}
	}

	stop(owner: string, id: string): void {
		if (this.runs.get(id)?.owner !== owner) throw new AutomationNotFound("Automation not found");
		const live = this.live.get(id);
		if (live) this.finish(live, "stopped", "Stopped by user.");
	}

	async close(): Promise<void> {
		this.closed = true;
		try {
			await Promise.all(
				[...this.live.values()].map(async (live) =>
					this.finish(live, "interrupted", "Interrupted by dashboard shutdown."),
				),
			);
		} finally {
			await Promise.allSettled(this.resources);
		}
	}
}
