/**
 * Message handler — sends user messages directly to the agent.
 *
 * Two paths (matching TUI parity):
 * - **Steering**: agent is streaming → inject mid-run via steer()
 * - **Normal**: agent is idle → create display, fire prompt, return
 *
 * Architecture:
 * - Event chain processes events and pushes text to userState.outbox (never blocks on Telegram I/O)
 * - Delivery loop drains outbox to Telegram independently, with retries on failure
 * - Persistent event subscription per bridge handles DONE markers and session persistence
 */

import type { Api } from "grammy";
import type { AgentBridge } from "../agent-bridge.js";
import { setUserSession } from "../state.js";
import type { UserState } from "../types.js";
import { cleanupUploads } from "../util/files.js";
import { log, safeDelete, safeSend, sendLong } from "../util/telegram.js";
import { createEventDisplay, type EventDisplayState, handleAgentEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Delivery loop — drains userState.outbox to Telegram, retries on failure
// ---------------------------------------------------------------------------

const MAX_RETRIES = 5;
const RETRY_DELAY = 2_000;

/** Track which users have an active delivery loop */
const activeDeliveryLoops = new WeakSet<UserState>();

/**
 * Start draining the outbox. Runs independently of the event chain.
 * Self-terminates when the outbox is empty; restarts on next push.
 */
async function drainOutbox(api: Api, userState: UserState): Promise<void> {
	if (activeDeliveryLoops.has(userState)) return; // already draining
	activeDeliveryLoops.add(userState);

	try {
		while (userState.outbox.length > 0) {
			const item = userState.outbox[0];
			item.retries = (item.retries ?? 0) + 1;

			let success: boolean;
			if (item.long) {
				// sendLong returns remaining undelivered text (empty = all delivered).
				// On partial failure, update item.text to only the undelivered tail
				// so retries don't resend already-delivered chunks.
				const remaining = await sendLong(api, item.chatId, item.text);
				success = remaining === "";
				if (!success) item.text = remaining;
			} else {
				const msgId = await safeSend(api, item.chatId, item.text);
				success = msgId !== 0;
			}

			if (success) {
				userState.outbox.shift();
			} else if (item.retries >= MAX_RETRIES) {
				log(`[DELIVER] Giving up on message after ${MAX_RETRIES} retries: ${item.text.slice(0, 100)}`);
				userState.outbox.shift();
			} else {
				// Retry after delay
				await new Promise((r) => setTimeout(r, RETRY_DELAY));
			}
		}
	} catch (e) {
		log(`[DELIVER] Drain error: ${e}`);
	} finally {
		activeDeliveryLoops.delete(userState);
	}
}

/** Push a message to the outbox and kick the delivery loop */
function enqueueSend(api: Api, userState: UserState, chatId: number, text: string, long?: boolean): void {
	userState.outbox.push({ chatId, text, long });
	void drainOutbox(api, userState);
}

// ---------------------------------------------------------------------------
// Persistent event subscription
// ---------------------------------------------------------------------------

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
	let parentAgentDone = false; // true after agent_end fires (even if BG agents still running)

	/** Chain the completion sequence — session persist, cleanup, DONE marker */
	function chainCompletion(display: EventDisplayState) {
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

				// DONE marker — only when truly idle and not stopped.
				// Brief delay lets in-flight delivery (outbox drain) settle
				// before DONE appears in the chat.
				if (!bridge.isStreaming && !userState.stopRequested) {
					await new Promise((r) => setTimeout(r, 150));
					enqueueSend(api, userState, display.chatId, "🦀 _dreb DONE_");
				}
			})
			.catch((e) => log(`[EVENT] Completion error: ${e}`));
	}

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

		// Build a send callback that pushes to the outbox — captures chatId
		// at event arrival time (same snapshot as display).
		const send = (text: string, long?: boolean) => {
			enqueueSend(api, userState, display.chatId, text, long);
		};

		// Queue event processing — the chain never blocks on Telegram I/O.
		// handleAgentEvent pushes permanent messages to outbox via send(),
		// only ephemeral operations (status edits, file sends) go inline.
		eventChain = eventChain
			.then(() => handleAgentEvent(send, api, display, event))
			.catch((e) => log(`[EVENT] Error: ${e}`));

		// Handle turn completion — checks run INSIDE the eventChain so they
		// execute after handleAgentEvent has updated display state (e.g.
		// retryInProgress set by auto_retry_start that arrives right after agent_end).
		if (event.type === "agent_end") {
			parentAgentDone = true;
			eventChain = eventChain.then(() => {
				if (userState.backgroundAgents.size > 0 || display.retryInProgress) {
					return;
				}
				chainCompletion(display);
			});
		}

		// Re-trigger completion when the last BG agent finishes.
		// agent_end already fired but skipped completion because BG agents were running.
		// Now that the last one is done, finalize.
		if (event.type === "background_agent_end") {
			eventChain = eventChain.then(() => {
				if (parentAgentDone && userState.backgroundAgents.size === 0 && !bridge.isStreaming) {
					chainCompletion(display);
				}
			});
		}

		// Reset parentAgentDone when a new run starts (e.g. user sends another message)
		if (event.type === "agent_start") {
			parentAgentDone = false;
		}
	});
}

// ---------------------------------------------------------------------------
// sendPrompt — steering vs normal path
// ---------------------------------------------------------------------------

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
		userState.stopRequested = false;
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
