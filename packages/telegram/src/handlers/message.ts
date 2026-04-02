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
import { log, safeDelete, safeSend, sendLong } from "../util/telegram.js";
import { createEventDisplay, type EventDisplayState, handleAgentEvent } from "./events.js";

/**
 * Reconcile displayed messages against the session's ground truth.
 *
 * The session is the source of truth — `getMessages()` returns every message
 * the agent has produced. If the event pipeline missed any assistant messages
 * (due to stuck eventChain, Telegram API timeouts, display swaps, etc.),
 * this function catches them up by diffing what was displayed against what
 * the session contains.
 *
 * Called on agent_end (before DONE marker) and on new prompts (recovery path).
 */
async function reconcileMessages(
	api: Api,
	chatId: number,
	bridge: AgentBridge,
	userState: UserState,
	display: EventDisplayState | undefined,
): Promise<void> {
	if (!bridge.isAlive) return;

	try {
		const state = await bridge.getState();
		if (!state) return;

		const sessionMsgCount = state.messageCount ?? 0;

		// Quick check — if counts match, nothing was missed
		if (sessionMsgCount <= userState.lastKnownMsgCount) {
			userState.lastKnownMsgCount = sessionMsgCount;
			return;
		}

		// Counts differ — fetch full messages and find what we missed
		const messages = await bridge.getMessages();
		if (!messages || messages.length === 0) return;

		// Count assistant messages with text content in the session
		const assistantMessages: Array<{ texts: string[] }> = [];
		for (const msg of messages) {
			if (msg.role !== "assistant") continue;
			if (!Array.isArray(msg.content)) continue;
			const texts: string[] = [];
			for (const block of msg.content) {
				if (block.type === "text" && block.text?.trim()) {
					texts.push(block.text.trim());
				}
			}
			if (texts.length > 0) {
				assistantMessages.push({ texts });
			}
		}

		// displayedMsgIndex tracks how many assistant messages were rendered
		// via the event pipeline. Skip those and send the rest.
		const displayedCount = display?.displayedMsgIndex ?? 0;
		const missed = assistantMessages.slice(displayedCount);

		if (missed.length > 0) {
			log(`[RECONCILE] Delivering ${missed.length} missed assistant message(s)`);
			for (const msg of missed) {
				for (const text of msg.texts) {
					await sendLong(api, chatId, text);
				}
			}
			// Mark these as displayed so we don't resend them next time
			if (display) {
				display.displayedMsgIndex = assistantMessages.length;
			}
		}

		// Update the persistent count
		userState.lastKnownMsgCount = sessionMsgCount;
	} catch (e) {
		log(`[RECONCILE] Error: ${e}`);
	}
}

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

	// eventChain health monitoring — detect and recover from stuck chains
	let lastEventProcessed = Date.now();
	let pendingCount = 0;
	const STUCK_THRESHOLD = 30_000; // 30s without progress = stuck

	// Periodic reconciliation — runs OUTSIDE the eventChain on its own timer.
	// If the event pipeline drops messages (stuck chain, Telegram API issues,
	// display swap races), this catches them without waiting for user action.
	const RECONCILE_INTERVAL = 5_000; // 5s
	const reconcileTimer = setInterval(() => {
		if (!bridge.isAlive) {
			clearInterval(reconcileTimer);
			return;
		}
		const display = displays.get(userState);
		if (!display) return;
		// Fire-and-forget — runs independently of the eventChain
		void reconcileMessages(api, display.chatId, bridge, userState, display);
	}, RECONCILE_INTERVAL);

	bridge.onEvent((event) => {
		// Capture display at event arrival time — even if a new prompt
		// replaces the display later, this event uses the correct one.
		const display = displays.get(userState);
		if (!display) {
			log(`[EVENT] No display for event: ${event.type} — dropped`);
			return;
		}

		// Clear promptInFlight on first event after a prompt
		if (userState.promptInFlight) {
			userState.promptInFlight = false;
		}

		// Stuck chain detection: if events have been pending for too long,
		// the chain is frozen (likely a hung Telegram API call). Reset it
		// so new events can flow. Missed messages are caught by reconciliation.
		if (pendingCount > 0 && Date.now() - lastEventProcessed > STUCK_THRESHOLD) {
			log(
				`[EVENT] Chain stuck for ${Math.round((Date.now() - lastEventProcessed) / 1000)}s with ${pendingCount} pending — resetting`,
			);
			eventChain = Promise.resolve();
			pendingCount = 0;
		}

		pendingCount++;

		// Queue event processing (serialized to prevent concurrent state mutations)
		eventChain = eventChain
			.then(() => handleAgentEvent(api, display, event))
			.then(() => {
				pendingCount--;
				lastEventProcessed = Date.now();
			})
			.catch((e) => {
				pendingCount--;
				lastEventProcessed = Date.now();
				log(`[EVENT] Error: ${e}`);
			});

		// Handle turn completion
		if (event.type === "agent_end") {
			// Don't finalize if BG agents or auto-retry still active.
			// Check userState.backgroundAgents (persistent, tracked by bridge-lifecycle)
			// NOT display.backgroundAgents (per-display, lost on display swap).
			if (userState.backgroundAgents.size > 0 || display.retryInProgress) {
				return;
			}

			// Chain completion after the event is processed.
			// Do NOT delete the display — it persists until replaced by a
			// new sendPrompt. This matches TUI behavior (display is never
			// destroyed) and prevents lost events from races or BG agents.
			eventChain = eventChain
				.then(async () => {
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

					// Reconciliation — deliver any messages the event pipeline missed.
					// Runs BEFORE the DONE marker so missed messages appear in order.
					await reconcileMessages(api, display.chatId, bridge, userState, display);

					// DONE marker — only when truly idle and not stopped.
					// Brief delay lets in-flight Telegram API calls (text edits,
					// status deletes) settle before DONE appears in the chat.
					if (!bridge.isStreaming && !userState.stopRequested) {
						await new Promise((r) => setTimeout(r, 150));
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

	// Recovery reconciliation — if the previous turn had missed messages
	// (stuck eventChain, /stop recovery, etc.), deliver them now before
	// starting the new turn. Fire-and-forget to avoid blocking the prompt.
	const prevDisplay = displays.get(userState);
	void reconcileMessages(api, opts.chatId, bridge, userState, prevDisplay);

	const display = createEventDisplay(api, opts.chatId, opts.replyToId, opts.statusMessageId);

	// Sync BG agent state — the display needs to know about running agents
	// so events.ts doesn't prematurely finalize on agent_end (flush editor,
	// delete status, set done). Without this, a new display created while
	// BG agents are running would have an empty backgroundAgents map,
	// causing events.ts to think the turn is over.
	for (const [id, agent] of userState.backgroundAgents) {
		display.backgroundAgents.set(id, agent);
	}

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
