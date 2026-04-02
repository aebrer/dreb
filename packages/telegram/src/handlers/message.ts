/**
 * Message handler — sends user messages directly to the agent.
 *
 * Two paths:
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

	// Steering path — agent is already streaming, inject mid-run
	if (bridge.isStreaming) {
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
	userState.stopRequested = false;

	const display = createEventDisplay(api, opts.chatId, opts.replyToId, opts.statusMessageId);

	// Subscribe to events
	let eventChain = Promise.resolve();
	const unsubscribe = bridge.onEvent((event) => {
		eventChain = eventChain
			.then(() => handleAgentEvent(api, display, event))
			.catch((e) => log(`[EVENT] Error: ${e}`));
	});

	// Abort controller for /stop
	const abort = new AbortController();
	userState.currentAbort = abort;

	// Fire the prompt cycle in the background
	runPromptCycle(api, userState, bridge, opts, display, unsubscribe, abort).catch((e) => {
		log(`[PROMPT] Cycle error: ${e}`);
	});
}

/**
 * Run the full prompt cycle: send prompt → wait for completion → cleanup.
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
	display: ReturnType<typeof createEventDisplay>,
	unsubscribe: () => void,
	abort: AbortController,
): Promise<void> {
	try {
		await bridge.prompt(opts.prompt, opts.images);
		await waitForCompletion(display, bridge, abort.signal);

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
		userState.processing = false;
		cleanupUploads();
	}

	// Send DONE when agent is truly done
	if (!bridge.isStreaming && !userState.stopRequested) {
		await safeSend(api, opts.chatId, "🦀 _dreb DONE_");
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
