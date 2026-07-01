import { type SessionInfo, SessionManager } from "@dreb/coding-agent/session-manager";

export type DashboardSessionInfo = Omit<SessionInfo, "created" | "modified"> & {
	created: string;
	modified: string;
};

export interface SessionLister {
	listAll(): Promise<SessionInfo[]>;
	listProject(cwd: string): Promise<SessionInfo[]>;
}

export class CodingAgentSessionLister implements SessionLister {
	async listAll(): Promise<SessionInfo[]> {
		return SessionManager.listAll();
	}

	async listProject(cwd: string): Promise<SessionInfo[]> {
		return SessionManager.list(cwd);
	}
}

export class SessionApi {
	constructor(private readonly lister: SessionLister = new CodingAgentSessionLister()) {}

	async listAll(): Promise<DashboardSessionInfo[]> {
		return (await this.lister.listAll()).map(serializeSession);
	}

	async listProject(cwd: string): Promise<DashboardSessionInfo[]> {
		return (await this.lister.listProject(cwd)).map(serializeSession);
	}
}

function serializeSession(session: SessionInfo): DashboardSessionInfo {
	return {
		...session,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
	};
}
