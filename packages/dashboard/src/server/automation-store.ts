import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AutomationRunDetail, type AutomationRunSummary, isAutomationActive } from "../shared/automation.js";

export interface AutomationRecord extends Omit<AutomationRunDetail, "hasSession" | "latestDecision" | "taskPreview"> {
	sessionFile?: string;
	sessionId?: string;
}

export function runSummary(record: AutomationRecord): AutomationRunSummary {
	const decision = record.decisions.at(-1);
	return {
		id: record.id,
		cwd: record.cwd,
		createdAt: record.createdAt,
		status: record.status,
		taskPreview: [...record.instructions].slice(0, 256).join(""),
		latestDecision: decision
			? { at: decision.at, action: decision.action, reason: decision.reason.slice(0, 500) }
			: undefined,
		outcome: record.outcome,
	};
}

export class AutomationStore {
	private readonly records = new Map<string, AutomationRecord>();

	constructor(private readonly dir?: string) {
		if (!dir) return;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		for (const file of readdirSync(dir)) {
			if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
			const { version, record } = JSON.parse(readFileSync(join(dir, file), "utf8"));
			if (version !== 1 || record?.id !== file.slice(0, -5) || !Array.isArray(record.decisions)) {
				throw new Error(`Invalid automation run record: ${file}`);
			}
			if (isAutomationActive(record.status)) {
				this.save({ ...record, status: "interrupted", outcome: "Dashboard restarted before the run ended." });
			} else {
				this.records.set(record.id, record);
			}
		}
	}

	get sessionDirectory(): string | undefined {
		return this.dir ? join(this.dir, "sessions") : undefined;
	}

	get(id: string): AutomationRecord | undefined {
		return this.records.get(id);
	}

	list(): AutomationRunSummary[] {
		return [...this.records.values()]
			.sort(
				(a, b) => a.cwd.localeCompare(b.cwd) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
			)
			.map(runSummary);
	}

	save(record: AutomationRecord): void {
		if (this.dir) {
			if (!/^[0-9a-f-]{36}$/.test(record.id)) throw new Error("Invalid automation run ID");
			const temp = join(this.dir, `.${randomUUID()}.tmp`);
			try {
				writeFileSync(temp, JSON.stringify({ version: 1, record }), { flag: "wx", mode: 0o600 });
				renameSync(temp, join(this.dir, `${record.id}.json`));
			} finally {
				rmSync(temp, { force: true });
			}
		}
		this.records.set(record.id, record);
	}
}
