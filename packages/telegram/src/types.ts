/**
 * Bot-specific types for the Telegram frontend.
 */

import type { Context } from "grammy";
import type { AgentBridge } from "./agent-bridge.js";

/** Extended context with user-specific agent bridge */
export interface BotContext extends Context {
	agentBridge?: AgentBridge;
}

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
	/** Message queue — one prompt at a time */
	queue: QueueItem[];
	/** Whether the queue processor is running */
	processing: boolean;
	/** Flag to start a fresh session on next message */
	newSessionFlag: boolean;
	/** Session ID to resume on next message */
	resumeSessionPath: string | null;
	/** Currently running background agents */
	backgroundAgents: Map<string, TrackedAgent>;
	/** Whether /stop was used (suppress DONE marker) */
	stopRequested: boolean;
}

export interface QueueItem {
	/** The Telegram message object */
	message: Context["message"];
	/** Text or file prompt to send to dreb */
	prompt: string;
	/** Optional images (base64) for the RPC prompt */
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	/** The ephemeral status message to edit */
	statusMessage: { chat_id: number; message_id: number } | null;
	/** Whether this item was queued (vs immediate) */
	wasQueued: boolean;
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
