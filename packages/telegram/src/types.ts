/**
 * Bot-specific types for the Telegram frontend.
 */

import type { AgentBridge } from "./agent-bridge.js";

/** Tracked background agent */
export interface TrackedAgent {
	agentId: string;
	agentType: string;
	taskSummary: string;
	startTime: number;
}

/** Per-user state managed by the bot */
export interface UserState {
	/** Active agent bridge (RPC process) */
	bridge: AgentBridge | null;
	/** Whether a prompt cycle is running (prompt sent, waiting for completion) */
	processing: boolean;
	/** Flag to start a fresh session on next message */
	newSessionFlag: boolean;
	/** Optional working directory override for the next new session */
	newSessionCwd: string | null;
	/** The actual working directory of the current bridge (may differ from config default) */
	effectiveCwd: string | null;
	/** Currently running background agents */
	backgroundAgents: Map<string, TrackedAgent>;
	/** Whether /stop was used (suppress DONE marker) */
	stopRequested: boolean;
	/** Abort controller for the current prompt cycle — signaled by /stop to break the wait */
	currentAbort: AbortController | null;
}

/** Session info for persistence across bot restarts */
export interface SavedSessions {
	[userId: string]: Array<{
		sessionPath: string;
		sessionId: string;
		timestamp: number;
		preview: string;
	}>;
}
