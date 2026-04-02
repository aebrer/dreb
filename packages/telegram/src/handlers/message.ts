/**
 * Message handler — sends user messages directly to the agent.
 *
 * Two paths:
 * - **Steering**: agent is streaming → inject mid-run via steer()
 * - **Normal**: agent is idle → prompt + wait for completion
 *
 * No queue — matches TUI parity. The agent core handles batching of
 * multiple steering messages internally.
 */

import type { Api } from "grammy";
import { setUserSession } from "../state.js";
import type { UserState } from "../types.js";
import { cleanupUploads } from "../util/files.js";
import { log, safeDelete, safeSend } from "../util/telegram.js";
import { createEventDisplay, handleAgentEvent } from "./events.js";

/**
 * Send a prompt to the agent. If the agent is streaming, steers instead.
 *
 * @returns true if the message was handled (steered or prompted)
 */
export async function sendPrompt(
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
): Promise<boolean> {
	const bridge = userState.bridge;
	if (!bridge) {
		log("[PROMPT] No bridge available");
		if (opts.statusMessageId) {
			await safeDelete(api, opts.chatId, opts.statusMessageId);
		}
		await safeSend(api, opts.chatId, "❌ No agent connection. Try sending your message again.");
		return false;
	}

	// Steering path — agent is already streaming, inject mid-run
	if (bridge.isStreaming) {
		if (opts.statusMessageId) {
			await safeDelete(api, opts.chatId, opts.statusMessageId);
		}
		try {
			await bridge.steer(opts.prompt, opts.images);
			await safeSend(api, opts.chatId, `↩️ _Steering:_ ${opts.prompt.slice(0, 200)}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!userState.stopRequested) {
				await safeSend(api, opts.chatId, `❌ Steering error: ${msg.slice(0, 200)}`);
			}
		}
		return true;
	}

	// Normal path — agent is idle, start a new run
	userState.processing = true;
	userState.stopRequested = false;

	const display = createEventDisplay(api, opts.chatId, opts.replyToId, opts.statusMessageId);

	// Subscribe to events — serialize processing to prevent concurrent state mutations
	let eventChain = Promise.resolve();
	const unsubscribe = bridge.onEvent((event) => {
		eventChain = eventChain
			.then(() => handleAgentEvent(api, display, event))
			.catch((e) => log(`[EVENT] Error: ${e}`));
	});

	// Create an abort controller — /stop can signal it
	const abort = new AbortController();
	userState.currentAbort = abort;

	try {
		await bridge.prompt(opts.prompt, opts.images);
		await waitForCompletion(display, bridge, abort.signal);

		// Update session info after completion and persist for reconnect
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
		userState.processing = false;
		cleanupUploads();
	}

	// Send DONE when agent is truly done
	if (!bridge.isStreaming && !userState.stopRequested) {
		await safeSend(api, opts.chatId, "🦀 _dreb DONE_");
	}

	return true;
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
	display: { done: boolean },
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
