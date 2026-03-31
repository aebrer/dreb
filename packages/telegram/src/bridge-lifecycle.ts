/**
 * Bridge lifecycle helpers — extracted to avoid circular imports between bot.ts and commands.
 */

import { AgentBridge } from "./agent-bridge.js";
import type { Config } from "./config.js";
import type { UserState } from "./types.js";

/**
 * Ensure the user has an active agent bridge, starting one if needed.
 * Does NOT handle session selection — that's up to the caller.
 */
export async function ensureBridge(config: Config, userState: UserState): Promise<AgentBridge> {
	if (!userState.bridge || !userState.bridge.isAlive) {
		const bridge = new AgentBridge(config);
		await bridge.start();
		userState.bridge = bridge;

		// Wire up background agent tracking
		bridge.onEvent((event: any) => {
			if (event.type === "background_agent_start") {
				userState.backgroundAgents.set(event.agentId, {
					agentId: event.agentId,
					agentType: event.agentType,
					taskSummary: event.taskSummary,
					startTime: Date.now(),
				});
			} else if (event.type === "background_agent_end") {
				userState.backgroundAgents.delete(event.agentId);
			}
		});
	}

	return userState.bridge;
}
