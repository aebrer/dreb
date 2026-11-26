export interface AutomationModel {
	provider: string;
	id: string;
}

export interface AutomationSetupMessage {
	role: "user" | "assistant";
	text: string;
}

export interface AutomationSetupReply {
	message: string;
	instructions: string | null;
}

export type AutomationRunStatus = "starting" | "working" | "reviewing" | "stopped" | "failed" | "interrupted";

export interface AutomationDecision {
	at: string;
	action: "continue" | "stop";
	reason: string;
	report: string;
}

export interface AutomationRunSummary {
	id: string;
	cwd: string;
	createdAt: string;
	status: AutomationRunStatus;
	taskPreview: string;
	latestDecision?: Pick<AutomationDecision, "at" | "action" | "reason">;
	outcome?: string;
}

export interface AutomationRunDetail extends AutomationRunSummary {
	instructions: string;
	workerModel: AutomationModel;
	guardModel: AutomationModel;
	decisions: AutomationDecision[];
	finalReport?: string;
	hasSession: boolean;
}

export interface AutomationLaunch {
	cwd: string;
	instructions: string;
	workerModel: AutomationModel;
	guardModel: AutomationModel;
}

export function isAutomationActive(status: AutomationRunStatus): boolean {
	return status === "starting" || status === "working" || status === "reviewing";
}
