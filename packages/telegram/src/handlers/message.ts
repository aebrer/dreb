/**
 * Message handler — sends user messages directly to the agent.
 *
 * Two paths (matching TUI parity):
 * - **Steering**: agent is streaming → inject mid-run via steer()
 * - **Normal**: agent is idle → fire prompt, return immediately
 *
 * The handler never blocks — grammy processes updates sequentially, so
 * we must return immediately to allow subsequent messages (steering, /stop)
 * to be processed. The prompt cycle runs in the background; events flow
 * via async subscriptions.
 */

import type { Api } from "grammy";
import type { AgentBridge } from "../agent-bridge.js";
import { setUserSession } from "../state.js";
import type { UserState } from "../types.js";
import { cleanupUploads } from "../util/files.js";
import { log, safeDelete, safeSend } from "../util/telegram.js";
import { createEventDisplay, handleAgentEvent } from "./events.js";

/**
 * Send a prompt to the agent. If the agent is streaming, steers instead.
 *
 * Returns immediately — the prompt cycle runs in the background.
 */
export function sendPrompt(
	api: Api,
	userState: UserState,
	opts: {
		chatId: number;
		replyToId: number;
		userId?: number;
		prompt: string;
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		statusMessageId: number | null;
	},
): void {
	const bridge = userState.bridge;
	if (!bridge) {
		log("[PROMPT] No bridge available");
		if (opts.statusMessageId) {
			void safeDelete(api, opts.chatId, opts.statusMessageId);
		}
		void safeSend(api, opts.chatId, "❌ No agent connection. Try sending your message again.");
		return;
	}

	// Steering path — agent is actively streaming (same check as TUI).
	// promptInFlight covers the race window between prompt() and agent_start.
	if (bridge.isStreaming || userState.promptInFlight) {
		if (opts.statusMessageId) {
			void safeDelete(api, opts.chatId, opts.statusMessageId);
		}
		bridge
			.steer(opts.prompt, opts.images)
			.then(() => safeSend(api, opts.chatId, `↩️ _Steering:_ ${opts.prompt.slice(0, 200)}`))
			.catch((e) => {
				const msg = e instanceof Error ? e.message : String(e);
				if (!userState.stopRequested) {
					void safeSend(api, opts.chatId, `❌ Steering error: ${msg.slice(0, 200)}`);
				}
			});
		return;
	}

	// Normal path — agent is idle, start a new run (fire and forget)
	userState.processing = true;
	userState.promptInFlight = true;
	userState.stopRequested = false;

	// Turn tracker — resolves when the agent finishes this turn (agent_end).
	// Not tied to background agents — they deliver results via the agent core.
	const turnDone = new Promise<void>((resolve) => {
		userState.turnResolver = resolve;
	});

	const display = createEventDisplay(api, opts.chatId, opts.replyToId, opts.statusMessageId);

	// Subscribe to events
	let eventChain = Promise.resolve();
	const unsubscribe = bridge.onEvent((event) => {
		// Clear promptInFlight on first event
		if (userState.promptInFlight) {
			userState.promptInFlight = false;
		}
		// Resolve turnDone on agent_end — the agent finished its response.
		// BG agents may still be running, but that's handled by the core.
		if (event.type === "agent_end" && userState.turnResolver) {
			userState.turnResolver();
			userState.turnResolver = null;
		}
		eventChain = eventChain
			.then(() => handleAgentEvent(api, display, event))
			.catch((e) => log(`[EVENT] Error: ${e}`));
	});

	// Abort controller for /stop
	const abort = new AbortController();
	userState.currentAbort = abort;

	// Fire the prompt cycle in the background
	runPromptCycle(api, userState, bridge, opts, display, unsubscribe, abort, turnDone).catch((e) => {
		log(`[PROMPT] Cycle error: ${e}`);
	});
}

/**
 * Run the full prompt cycle: send prompt → wait for turn end → cleanup.
 *
 * "Turn end" means the agent finished its current response (agent_end), NOT
 * that all background agents are done. BG agents deliver results via the
 * agent core's own steer()/prompt() mechanism — they trigger new agent_start/
 * agent_end cycles that the event subscription handles independently.
 *
 * Runs entirely in the background — never blocks the message handler.
 */
async function runPromptCycle(
	api: Api,
	userState: UserState,
	bridge: AgentBridge,
	opts: {
		chatId: number;
		replyToId: number;
		userId?: number;
		prompt: string;
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		statusMessageId: number | null;
	},
	_display: ReturnType<typeof createEventDisplay>,
	unsubscribe: () => void,
	abort: AbortController,
	turnDone: Promise<void>,
): Promise<void> {
	try {
		await bridge.prompt(opts.prompt, opts.images);

		// Wait for agent_end OR abort OR bridge death
		await Promise.race([
			turnDone,
			new Promise<void>((resolve) => {
				const signal = abort.signal;

				// Bridge death detection
				const deathCheck = setInterval(() => {
					if (!bridge.isAlive) {
						clearInterval(deathCheck);
						clearTimeout(abortTimeout);
						signal.removeEventListener("abort", onAbort);
						resolve();
					}
				}, 500);

				// Abort signal (/stop)
				const onAbort = () => {
					clearInterval(deathCheck);
					clearTimeout(abortTimeout);
					resolve();
				};
				signal.addEventListener("abort", onAbort, { once: true });

				// Safety: if turnDone never resolves (shouldn't happen), don't leak
				const abortTimeout = setTimeout(() => {
					clearInterval(deathCheck);
					signal.removeEventListener("abort", onAbort);
					resolve();
				}, 300000); // 5 min safety
			}),
		]);

		// Update session info and persist
		if (bridge.isAlive) {
			await bridge.refreshSessionInfo();
			if (bridge.sessionFile && opts.userId) {
				setUserSession(opts.userId, bridge.sessionFile);
			}
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (!userState.stopRequested) {
			await safeSend(api, opts.chatId, `❌ Error: ${msg.slice(0, 200)}`);
		}
	} finally {
		unsubscribe();
		userState.currentAbort = null;
		userState.promptInFlight = false;
		userState.processing = false;
		userState.turnResolver = null;
		cleanupUploads();
	}

	// Send DONE when agent is truly idle (not streaming, not stopped)
	if (!bridge.isStreaming && !userState.stopRequested) {
		await safeSend(api, opts.chatId, "🦀 _dreb DONE_");
	}
}
