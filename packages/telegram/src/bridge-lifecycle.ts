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
		// Use effectiveCwd if set — preserves custom cwd across bridge crashes
		const effectiveConfig =
			userState.effectiveCwd && userState.effectiveCwd !== config.workingDir
				? { ...config, workingDir: userState.effectiveCwd }
				: config;
		const bridge = new AgentBridge(effectiveConfig);
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

/**
 * Ensure bridge is alive AND a session is selected.
 * Used by message/file handlers and skill commands before prompting.
 */
export async function ensureBridgeWithSession(config: Config, userState: UserState): Promise<AgentBridge> {
	// Handle new session — always kill and recreate the bridge for clean state.
	// For /new <path>: uses the user-specified directory.
	// For /new (bare): preserves the current effectiveCwd.
	if (userState.newSessionFlag) {
		const cwd = userState.newSessionCwd ?? userState.effectiveCwd ?? config.workingDir;
		userState.newSessionFlag = false;
		userState.newSessionCwd = null;

		// Kill existing bridge and start a new one with the resolved cwd
		if (userState.bridge?.isAlive) {
			await userState.bridge.stop();
		}
		userState.bridge = null;

		const customConfig = { ...config, workingDir: cwd };
		// Set effectiveCwd BEFORE ensureBridge so the stale-cwd override
		// in ensureBridge doesn't clobber the resolved directory
		userState.effectiveCwd = cwd;
		const bridge = await ensureBridge(customConfig, userState);
		await bridge.newSession();
		return bridge;
	}

	const hadBridge = !!userState.bridge?.isAlive;
	const bridge = await ensureBridge(config, userState);
	const freshBridge = !hadBridge;

	// Track effective cwd (default from config on first bridge creation)
	if (!userState.effectiveCwd) {
		userState.effectiveCwd = config.workingDir;
	}

	// No session yet — try to resume latest
	if (!bridge.sessionId) {
		await bridge.resumeLatest();
	}

	// Check for model fallback warning on fresh bridge (e.g. after crash)
	if (freshBridge) {
		try {
			const state = await bridge.getState();
			if (state?.modelFallbackMessage) {
				userState.pendingModelFallbackWarning = state.modelFallbackMessage;
			}
		} catch {
			// Non-critical — the warning is best-effort
		}
	}

	return bridge;
}
