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
	/** Covers the race window between prompt() call and agent_start event */
	promptInFlight: boolean;
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
	/** Messages waiting to be delivered to Telegram — drained by a delivery loop */
	outbox: Array<{ chatId: number; text: string; long?: boolean; retries?: number }>;
	/** Buddy controller — any to avoid import of @dreb/coding-agent/buddy */
	buddyController: any;
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
