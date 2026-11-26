import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readSessionTranscript } from "@dreb/coding-agent";
import type { RpcClient } from "@dreb/coding-agent/rpc";
import type {
	AutomationDecision,
	AutomationLaunch,
	AutomationModel,
	AutomationRunDetail,
	AutomationSetupMessage,
	AutomationSetupReply,
} from "../shared/automation.js";
import { type AutomationRecord, type AutomationStore, runSummary } from "./automation-store.js";

type Client = Pick<RpcClient, "start" | "stop" | "abort" | "getState" | "automationTurn">;
export type AutomationSpawn = (cwd: string, role: "setup" | "worker" | "guard", model: AutomationModel) => Client;

interface Lease {
	client: Client;
	starting: Promise<void>;
	closing?: Promise<void>;
}

interface ActiveRun {
	record: AutomationRecord;
	leases: Set<Lease>;
	cancelled: boolean;
	done?: Promise<void>;
}

function replyObject(text: string): Record<string, unknown> {
	const trimmed = text.trim();
	const block = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
	let parsed: unknown;
	try {
		parsed = JSON.parse(block?.[1] ?? trimmed);
	} catch {
		throw new Error("The agent did not return a valid automation response.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid automation response.");
	return parsed as Record<string, unknown>;
}

function nonempty(text: unknown): text is string {
	return typeof text === "string" && text.trim().length > 0;
}

export class AutomationRunner {
	private readonly active = new Map<string, ActiveRun>();
	private readonly setupClients = new Set<Lease>();
	private closing = false;
	private closePromise?: Promise<void>;

	constructor(
		readonly store: AutomationStore,
		private readonly spawn: AutomationSpawn,
		private readonly changed: (id: string) => void,
		private readonly now: () => Date = () => new Date(),
		private readonly logError: (message: string) => void = console.error,
	) {}

	async setup(cwd: string, model: AutomationModel, messages: AutomationSetupMessage[]): Promise<AutomationSetupReply> {
		if (this.closing) throw new Error("Dashboard is shutting down");
		const lease = this.open(this.setupClients, cwd, "setup", model);
		try {
			await lease.starting;
			if (this.closing) throw new Error("Dashboard is shutting down");
			const { text } = await lease.client.automationTurn(
				`Continue this setup conversation in the project directory. Reply to the final user message.\n${JSON.stringify(messages)}`,
			);
			const result = replyObject(text);
			if (!nonempty(result.message) || (result.instructions !== null && !nonempty(result.instructions))) {
				throw new Error("The setup agent did not return a chat reply and an optional draft.");
			}
			return { message: result.message, instructions: result.instructions };
		} finally {
			await this.end(lease);
			this.setupClients.delete(lease);
		}
	}

	launch(input: AutomationLaunch): string {
		if (this.closing) throw new Error("Dashboard is shutting down");
		const run: ActiveRun = {
			record: { ...input, id: randomUUID(), status: "starting", createdAt: this.now().toISOString(), decisions: [] },
			leases: new Set(),
			cancelled: false,
		};
		this.record(run, {});
		this.active.set(run.record.id, run);
		run.done = this.execute(run);
		return run.record.id;
	}

	detail(id: string): AutomationRunDetail | undefined {
		const run = this.store.get(id);
		if (!run) return undefined;
		return {
			...runSummary(run),
			instructions: run.instructions,
			workerModel: run.workerModel,
			guardModel: run.guardModel,
			decisions: run.decisions,
			finalReport: run.finalReport,
			hasSession: Boolean(run.sessionFile && existsSync(run.sessionFile)),
		};
	}

	transcript(id: string): unknown[] | undefined {
		const record = this.store.get(id);
		if (!record?.sessionFile || !record.sessionId || !existsSync(record.sessionFile)) return undefined;
		const result = readSessionTranscript(record.sessionFile);
		if (result.header.id !== record.sessionId)
			throw new Error("The saved session no longer matches this automation run.");
		return result.messages;
	}

	stop(id: string): boolean {
		const run = this.active.get(id);
		if (!run || run.cancelled || run.record.status === "stopped" || run.record.status === "failed") return false;
		this.cancel(run, false);
		return true;
	}

	close(): Promise<void> {
		this.closePromise ??= this.closeAll();
		return this.closePromise;
	}

	private async closeAll(): Promise<void> {
		this.closing = true;
		const runs = [...this.active.values()];
		for (const run of runs) {
			if (!run.cancelled && run.record.status !== "stopped" && run.record.status !== "failed")
				this.cancel(run, true);
		}
		await Promise.allSettled([...runs.map((r) => r.done), ...[...this.setupClients].map((lease) => this.end(lease))]);
	}

	private cancel(run: ActiveRun, shutdown: boolean): void {
		run.cancelled = true;
		const outcome = shutdown ? "Dashboard shut down before the run ended." : "Stopped by the user.";
		try {
			this.record(run, {
				status: shutdown ? "interrupted" : "stopped",
				outcome,
				finalReport: this.fallbackReport(run, outcome),
			});
		} finally {
			for (const lease of run.leases) void this.end(lease);
		}
	}

	private open(leases: Set<Lease>, cwd: string, role: Parameters<AutomationSpawn>[1], model: AutomationModel): Lease {
		const client = this.spawn(cwd, role, model);
		const lease = { client, starting: client.start() };
		leases.add(lease);
		return lease;
	}

	private end(lease: Lease): Promise<void> {
		lease.closing ??= (async () => {
			try {
				await lease.starting;
				await lease.client.abort();
			} catch (err) {
				this.logError(`Automation child did not accept abort: ${String(err)}`);
			} finally {
				try {
					await lease.client.stop();
				} catch (err) {
					this.logError(`Automation child stop failed: ${String(err)}`);
				}
			}
		})();
		return lease.closing;
	}

	private record(run: ActiveRun, update: Partial<AutomationRecord>): void {
		const record = { ...run.record, ...update };
		this.store.save(record);
		run.record = record;
		this.changed(record.id);
	}

	private fallbackReport(run: ActiveRun, reason: string): string {
		const last = run.record.decisions.at(-1);
		return last ? `${reason}\n\nLast guard findings:\n${last.report}` : `${reason}\n\nNo guard review was completed.`;
	}

	private async execute(run: ActiveRun): Promise<void> {
		try {
			const { cwd, workerModel, guardModel, instructions } = run.record;
			const worker = this.open(run.leases, cwd, "worker", workerModel);
			await worker.starting;
			if (run.cancelled) return;
			const state = await worker.client.getState();
			if (run.cancelled) return;
			if (!state.sessionFile) throw new Error("The work session cannot be saved.");
			this.record(run, { sessionId: state.sessionId, sessionFile: state.sessionFile, status: "working" });
			let feedback: string | undefined;
			while (!run.cancelled) {
				const work = await worker.client.automationTurn(feedback ?? instructions, feedback !== undefined);
				if (run.cancelled) return;
				this.record(run, { status: "reviewing" });
				const guard = this.open(run.leases, cwd, "guard", guardModel);
				let decision: AutomationDecision;
				try {
					await guard.starting;
					if (run.cancelled) return;
					const reviewTime = this.now();
					const result = await guard.client.automationTurn(
						JSON.stringify({
							agreedInstructions: instructions,
							reviewTime: reviewTime.toISOString(),
							hostLocalTime: reviewTime.toString(),
							hostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
							workerReport: work.text,
							workerEvidence: work.evidence,
							previousDecisions: run.record.decisions.slice(-3),
						}),
					);
					if (run.cancelled) return;
					const { action, reason, report } = replyObject(result.text);
					if ((action !== "continue" && action !== "stop") || !nonempty(reason) || !nonempty(report)) {
						throw new Error("The guard did not return a valid stop or continue decision.");
					}
					decision = { at: reviewTime.toISOString(), action, reason, report };
				} finally {
					await this.end(guard);
					run.leases.delete(guard);
				}
				if (run.cancelled) return;
				const decisions = [...run.record.decisions, decision];
				if (decision.action === "stop") {
					this.record(run, {
						decisions,
						status: "stopped",
						outcome: decision.reason,
						finalReport: decision.report,
					});
					return;
				}
				this.record(run, { decisions, status: "working" });
				feedback = `${decision.reason}\n\n${decision.report}`;
			}
		} catch (error) {
			if (!run.cancelled) {
				const outcome = error instanceof Error ? error.message : String(error);
				try {
					this.record(run, { status: "failed", outcome, finalReport: this.fallbackReport(run, outcome) });
				} catch (saveError) {
					this.logError(`Failed to save automation outcome: ${String(saveError)}`);
				}
			}
		} finally {
			await Promise.all([...run.leases].map((lease) => this.end(lease)));
			this.active.delete(run.record.id);
		}
	}
}
