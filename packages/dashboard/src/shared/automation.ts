import type { AutomationDraft } from "@dreb/coding-agent/rpc";
export type { AutomationDraft };

export interface AutomationRun {
	id: string;
	name?: string;
	draft: AutomationDraft;
	status: "working" | "reviewing" | "stopped" | "failed" | "interrupted";
	startedAt: number;
	endedAt?: number;
	compactions: number;
	decisions: { action: "continue" | "stop"; report: string; at: number }[];
	report?: string;
	setupFile: string;
	/** Identity and working directory recorded at launch. Older runs have only setupFile. */
	setupSession?: { id: string; cwd: string };
	workFile?: string;
	guardFiles: string[];
}
