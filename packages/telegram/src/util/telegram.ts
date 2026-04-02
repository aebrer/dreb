/**
 * Telegram message utilities — splitting, markdown fallback, rate-limit debounce.
 */

import type { Api } from "grammy";

const SAFE_LENGTH = 4000; // Leave room for markdown overhead (Telegram max is 4096)

/**
 * Wrap a promise with a timeout. Rejects with an error if the promise
 * doesn't settle within `ms` milliseconds. Used to prevent Telegram API
 * calls from hanging the event chain indefinitely.
 *
 * The timer is cleared when the promise settles to avoid accumulating
 * stale timers in the Node.js timer heap during heavy message runs.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Telegram API timeout after ${ms}ms`)), ms);
	});
	// Prevent unhandled rejection from the slow promise if the timeout wins.
	// Without this, a late rejection after timeout becomes an unhandled rejection
	// which crashes the process in Node.js >= 15.
	promise.catch(() => {});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

const API_TIMEOUT = 15_000; // 15s per Telegram API call

/**
 * Send a message, falling back to plain text if Markdown fails.
 */
export async function safeSend(api: Api, chatId: number, text: string, replyToId?: number): Promise<number> {
	// Truncate to Telegram's limit — callers sending long content should use sendLong instead
	if (text.length > SAFE_LENGTH) text = truncate(text, SAFE_LENGTH);
	try {
		const msg = await withTimeout(
			api.sendMessage(chatId, text, {
				parse_mode: "Markdown",
				...(replyToId ? { reply_parameters: { message_id: replyToId } } : {}),
			}),
			API_TIMEOUT,
		);
		return msg.message_id;
	} catch (e) {
		// Only retry as plain text for Markdown parse errors (Telegram 400).
		// For timeouts/network errors, the original request may still be in-flight —
		// retrying would risk delivering duplicate messages. Return 0 and let
		// the outbox retry loop handle it.
		if (!isTelegramParseError(e)) {
			log(`[WARN] Failed to send message: ${e}`);
			return 0;
		}
		try {
			const msg = await withTimeout(
				api.sendMessage(chatId, text, {
					...(replyToId ? { reply_parameters: { message_id: replyToId } } : {}),
				}),
				API_TIMEOUT,
			);
			return msg.message_id;
		} catch (e2) {
			log(`[WARN] Failed to send message (plain text fallback): ${e2}`);
			return 0;
		}
	}
}

/**
 * Check if an error is a Telegram API parse error (HTTP 400 for bad Markdown).
 * These are safe to retry as plain text because the original request definitively
 * failed — Telegram won't deliver it. Timeouts and network errors are NOT safe
 * to retry immediately because the in-flight request may still succeed.
 */
function isTelegramParseError(e: unknown): boolean {
	if (!e || typeof e !== "object") return false;
	// grammy HttpError has error_code
	const code = (e as any).error_code ?? (e as any).status ?? (e as any).statusCode;
	if (code === 400) return true;
	// Fallback: check message for common Telegram parse error text
	const msg = (e as any).message ?? String(e);
	return typeof msg === "string" && msg.includes("can't parse entities");
}

/**
 * Send a long message, splitting at newline boundaries.
 * Stops on first chunk failure to avoid resending already-delivered chunks
 * on retry. Returns the remaining (undelivered) text, or empty string if
 * everything was delivered.
 */
export async function sendLong(api: Api, chatId: number, text: string, replyToId?: number): Promise<string> {
	while (text) {
		if (text.length <= SAFE_LENGTH) {
			const msgId = await safeSend(api, chatId, text, replyToId);
			return msgId === 0 ? text : "";
		}
		let splitAt = text.lastIndexOf("\n", SAFE_LENGTH);
		if (splitAt < 2000) splitAt = SAFE_LENGTH;
		const msgId = await safeSend(api, chatId, text.slice(0, splitAt), replyToId);
		if (msgId === 0) return text; // Stop — return full remaining text including this failed chunk
		text = text.slice(splitAt).replace(/^\n+/, "");
		replyToId = undefined; // Only reply to the first chunk
	}
	return "";
}

/**
 * Edit a message safely, falling back to plain text.
 */
export async function safeEdit(api: Api, chatId: number, messageId: number, text: string): Promise<boolean> {
	text = truncate(text, SAFE_LENGTH);
	try {
		await withTimeout(api.editMessageText(chatId, messageId, text, { parse_mode: "Markdown" }), API_TIMEOUT);
		return true;
	} catch {
		try {
			await withTimeout(api.editMessageText(chatId, messageId, text), API_TIMEOUT);
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * Delete a message, ignoring errors.
 */
export async function safeDelete(api: Api, chatId: number, messageId: number): Promise<void> {
	try {
		await withTimeout(api.deleteMessage(chatId, messageId), API_TIMEOUT);
	} catch {
		// Ignore — message may already be deleted or too old
	}
}

/**
 * Truncate text to fit Telegram's limit.
 */
export function truncate(text: string, maxLen = SAFE_LENGTH): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen - 20)}\n\n_(truncated)_`;
}

/**
 * Rate-limited message editor — debounces rapid edits to avoid Telegram 429s.
 * Minimum 2 seconds between edits to the same message.
 */
export class DebouncedEditor {
	private pending: Map<string, { text: string; timer: ReturnType<typeof setTimeout> }> = new Map();
	private lastEdit: Map<string, number> = new Map();
	private readonly minInterval = 2000; // 2s between edits

	constructor(private api: Api) {}

	/**
	 * Schedule an edit. If another edit comes in before the debounce fires,
	 * the previous one is replaced.
	 */
	edit(chatId: number, messageId: number, text: string): void {
		const key = `${chatId}:${messageId}`;
		const existing = this.pending.get(key);
		if (existing) clearTimeout(existing.timer);

		const lastTime = this.lastEdit.get(key) || 0;
		const elapsed = Date.now() - lastTime;
		const delay = Math.max(0, this.minInterval - elapsed);

		const timer = setTimeout(() => {
			this.pending.delete(key);
			this.lastEdit.set(key, Date.now());
			void safeEdit(this.api, chatId, messageId, text);
		}, delay);

		this.pending.set(key, { text, timer });
	}

	/**
	 * Force flush a pending edit immediately (e.g., before deleting the message).
	 */
	async flush(chatId: number, messageId: number): Promise<void> {
		const key = `${chatId}:${messageId}`;
		const existing = this.pending.get(key);
		if (existing) {
			clearTimeout(existing.timer);
			this.pending.delete(key);
			this.lastEdit.set(key, Date.now());
			await safeEdit(this.api, chatId, messageId, existing.text);
		}
	}

	/** Cancel all pending edits. */
	clear(): void {
		for (const { timer } of this.pending.values()) clearTimeout(timer);
		this.pending.clear();
	}
}

export function log(msg: string): void {
	console.error(msg);
}
