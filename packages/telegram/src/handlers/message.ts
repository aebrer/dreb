/**
 * Message handler — queues user messages and processes them sequentially.
 * Only one agent prompt runs at a time per user.
 */

import type { Api } from "grammy";
import { setUserSession } from "../state.js";
import type { QueueItem, UserState } from "../types.js";
import { cleanupUploads } from "../util/files.js";
import { log, safeDelete, safeSend } from "../util/telegram.js";
import { createEventDisplay, type EventDisplayState, handleAgentEvent } from "./events.js";

/**
 * Enqueue a prompt for processing. Starts the queue processor if not running.
 */
export function enqueuePrompt(api: Api, userState: UserState, item: QueueItem): void {
	userState.queue.push(item);

	if (!userState.processing) {
		userState.processing = true;
		void processQueue(api, userState);
	}
}

/**
 * Process the queue sequentially — one prompt at a time.
 */
async function processQueue(api: Api, userState: UserState): Promise<void> {
	try {
		while (userState.queue.length > 0) {
			const item = userState.queue.shift()!;
			userState.stopRequested = false;

			if (item.wasQueued && item.message) {
				await safeSend(api, item.message.chat.id, `📨 _Processing queued message:_ ${item.prompt.slice(0, 200)}`);
			}

			await processItem(api, userState, item);
		}
	} catch (e) {
		log(`[QUEUE] Processor error: ${e}`);
	} finally {
		userState.processing = false;

		// Clean up upload files after queue is fully drained
		cleanupUploads();
	}
}

/**
 * Process a single queue item — send prompt, wait for completion.
 */
async function processItem(api: Api, userState: UserState, item: QueueItem): Promise<void> {
	const bridge = userState.bridge;
	if (!bridge) {
		log("[QUEUE] No bridge available");
		if (item.statusMessage) {
			await safeDelete(api, item.statusMessage.chat_id, item.statusMessage.message_id);
		}
		if (item.message) {
			await safeSend(api, item.message.chat.id, "❌ No agent connection. Try sending your message again.");
		}
		return;
	}

	const chatId = item.message!.chat.id;
	const replyToId = item.message!.message_id;

	// Create event display state
	const display = createEventDisplay(api, chatId, replyToId, item.statusMessage?.message_id ?? null);

	// Subscribe to events — serialize processing to prevent concurrent state mutations
	let eventChain = Promise.resolve();
	const unsubscribe = bridge.onEvent((event) => {
		eventChain = eventChain
			.then(() => handleAgentEvent(api, display, event))
			.catch((e) => log(`[EVENT] Error: ${e}`));
	});

	// Create an abort controller for this item — /stop can signal it
	const abort = new AbortController();
	userState.currentAbort = abort;

	try {
		// Send the prompt
		await bridge.prompt(item.prompt, item.images);

		// Wait for completion — resolved by agent_end, bridge death, or /stop signal
		await waitForCompletion(display, bridge, abort.signal);

		// Update session info after completion and persist for reconnect
		if (bridge.isAlive) {
			await bridge.refreshSessionInfo();
			if (bridge.sessionFile) {
				const userId = item.message?.from?.id;
				if (userId) setUserSession(userId, bridge.sessionFile);
			}
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (!userState.stopRequested) {
			await safeSend(api, chatId, `❌ Error: ${msg.slice(0, 200)}`);
		}
	} finally {
		unsubscribe();
		userState.currentAbort = null;
	}

	// Send DONE for this item (if queue is empty and not stopped)
	if (userState.queue.length === 0 && !userState.stopRequested) {
		await safeSend(api, chatId, "🦀 _dreb DONE_");
	}
}

/**
 * Wait for the agent to finish. Resolves when any of these occur:
 * - `display.done` is set (agent_end event processed)
 * - The bridge dies (RPC process crashed)
 * - The abort signal fires (/stop command)
 *
 * No timeouts — matches TUI parity. The user can always /stop to interrupt.
 */
function waitForCompletion(
	display: EventDisplayState,
	bridge: { isAlive: boolean },
	signal: AbortSignal,
): Promise<void> {
	if (display.done) return Promise.resolve();
	if (signal.aborted) return Promise.resolve();

	return new Promise((resolve) => {
		const timer = setInterval(() => {
			if (display.done || signal.aborted || !bridge.isAlive) {
				clearInterval(timer);
				signal.removeEventListener("abort", onAbort);
				resolve();
			}
		}, 500);

		function onAbort() {
			clearInterval(timer);
			resolve();
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
