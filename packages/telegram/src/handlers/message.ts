/**
 * Message handler — queues user messages and processes them sequentially.
 * Only one agent prompt runs at a time per user.
 */

import type { Api } from "grammy";
import type { QueueItem, UserState } from "../types.js";
import { log, safeSend } from "../util/telegram.js";
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

		// Send DONE unless /stop was used
		if (!userState.stopRequested && userState.queue.length === 0) {
			// Find the last item's chat to send DONE to
			// The bridge tracks the chat from the last processed item
		}
	}
}

/**
 * Process a single queue item — send prompt, wait for completion.
 */
async function processItem(api: Api, userState: UserState, item: QueueItem): Promise<void> {
	const bridge = userState.bridge;
	if (!bridge) {
		log("[QUEUE] No bridge available");
		return;
	}

	const chatId = item.message!.chat.id;
	const replyToId = item.message!.message_id;

	// Create event display state
	const display = createEventDisplay(api, chatId, replyToId, item.statusMessage?.message_id ?? null);

	// Subscribe to events for this run
	const unsubscribe = bridge.onEvent((event) => {
		void handleAgentEvent(api, display, event);
	});

	try {
		// Send the prompt
		await bridge.prompt(item.prompt, item.images);

		// Wait for agent_end
		await waitForDone(display, 600_000); // 10 minute timeout

		// Update session info after completion
		await bridge.refreshSessionInfo();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (!userState.stopRequested) {
			await safeSend(api, chatId, `❌ Error: ${msg.slice(0, 200)}`);
		}
	} finally {
		unsubscribe();
	}

	// Send DONE for this item (if queue is empty and not stopped)
	if (userState.queue.length === 0 && !userState.stopRequested) {
		await safeSend(api, chatId, "🦀 _dreb DONE_");
	}
}

function waitForDone(display: EventDisplayState, timeout: number): Promise<void> {
	if (display.done) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("Timeout waiting for agent completion"));
		}, timeout);

		const check = setInterval(() => {
			if (display.done) {
				clearTimeout(timer);
				clearInterval(check);
				resolve();
			}
		}, 100);
	});
}
