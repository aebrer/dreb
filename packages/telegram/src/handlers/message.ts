/**
 * Message handler — sends user messages directly to the agent.
 *
 * Two paths (matching TUI parity):
 * - **Steering**: agent is streaming → inject mid-run via steer()
 * - **Normal**: agent is idle → create display, fire prompt, return
 *
 * A single persistent event subscription per bridge handles all event
 * delivery, DONE markers, and session persistence. sendPrompt just swaps
 * the display target and fires the prompt — no per-prompt subscription
 * lifecycle, no background cycles, no turnResolver. Same as the TUI.
 */

import type { Api } from "grammy";
import type { AgentBridge } from "../agent-bridge.js";
import { setUserSession } from "../state.js";
import type { UserState } from "../types.js";
import { cleanupUploads } from "../util/files.js";
import { log, safeDelete, safeSend } from "../util/telegram.js";
import { createEventDisplay, type EventDisplayState, handleAgentEvent } from "./events.js";

/** Track which bridges have a persistent event subscription */
const subscribedBridges = new WeakSet<AgentBridge>();

/** Current display state per user — swapped on each new prompt */
const displays = new Map<UserState, EventDisplayState>();

/** Track userId for session persistence (set by sendPrompt, used by completion handler) */
const userIds = new Map<UserState, number>();

/**
 * Ensure a persistent event subscription exists for this bridge.
 * Called once per bridge lifetime — handles all event delivery,
 * DONE markers, session persistence, and cleanup.
 */
function ensureSubscribed(api: Api, userState: UserState, bridge: AgentBridge): void {
	if (subscribedBridges.has(bridge)) return;
	subscribedBridges.add(bridge);

	// New bridge — clear stale state from any previous bridge
	userState.promptInFlight = false;
	displays.delete(userState);

	let eventChain = Promise.resolve();

	bridge.onEvent((event) => {
		// Capture display at event arrival time — even if a new prompt
		// replaces the display later, this event uses the correct one.
		const display = displays.get(userState);
		if (!display) return;

		// Clear promptInFlight on first event after a prompt
		if (userState.promptInFlight) {
			userState.promptInFlight = false;
		}

		// Queue event processing (serialized to prevent concurrent state mutations)
		eventChain = eventChain
			.then(() => handleAgentEvent(api, display, event))
			.catch((e) => log(`[EVENT] Error: ${e}`));

		// Handle turn completion
		if (event.type === "agent_end") {
			// Don't finalize if BG agents or auto-retry still active.
			// Check userState.backgroundAgents (persistent, tracked by bridge-lifecycle)
			// NOT display.backgroundAgents (per-display, lost on display swap).
			if (userState.backgroundAgents.size > 0 || display.retryInProgress) {
				return;
			}

			// Chain completion after the event is processed
			eventChain = eventChain
				.then(async () => {
					// Only clean up if this display is still active
					// (a new prompt may have already replaced it)
					if (displays.get(userState) === display) {
						displays.delete(userState);
					}

					// Persist session
					if (bridge.isAlive) {
						try {
							await bridge.refreshSessionInfo();
							const userId = userIds.get(userState);
							if (bridge.sessionFile && userId) {
								setUserSession(userId, bridge.sessionFile);
							}
						} catch (e) {
							log(`[EVENT] Session refresh error: ${e}`);
						}
					}

					cleanupUploads();

					// DONE marker — only when truly idle and not stopped
					if (!bridge.isStreaming && !userState.stopRequested) {
						await safeSend(api, display.chatId, "🦀 _dreb DONE_");
					}
				})
				.catch((e) => log(`[EVENT] Completion error: ${e}`));
		}
	});
}

/**
 * Send a prompt to the agent. If the agent is streaming, steers instead.
 *
 * Returns immediately — the persistent subscription handles event delivery.
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

	// Ensure persistent subscription exists for this bridge
	ensureSubscribed(api, userState, bridge);

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

	// Normal path — create new display, fire prompt, return immediately
	userState.promptInFlight = true;
	userState.stopRequested = false;
	if (opts.userId) userIds.set(userState, opts.userId);

	const display = createEventDisplay(api, opts.chatId, opts.replyToId, opts.statusMessageId);
	displays.set(userState, display);

	bridge.prompt(opts.prompt, opts.images).catch((e) => {
		const msg = e instanceof Error ? e.message : String(e);
		if (!userState.stopRequested) {
			void safeSend(api, opts.chatId, `❌ Error: ${msg.slice(0, 200)}`);
		}
		userState.promptInFlight = false;
		displays.delete(userState);
		cleanupUploads();
	});
}
