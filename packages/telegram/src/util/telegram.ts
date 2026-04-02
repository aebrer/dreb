/**
 * Telegram message utilities — splitting, markdown fallback, rate-limit debounce.
 */

import type { Api } from "grammy";

const SAFE_LENGTH = 4000; // Leave room for markdown overhead (Telegram max is 4096)

/**
 * Wrap a promise with a timeout. Rejects with an error if the promise
 * doesn't settle within `ms` milliseconds. Used to prevent Telegram API
 * calls from hanging the event chain indefinitely.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Telegram API timeout after ${ms}ms`)), ms)),
	]);
}

const API_TIMEOUT = 15_000; // 15s per Telegram API call

/**
 * Send a message, falling back to plain text if Markdown fails.
 */
export async function safeSend(api: Api, chatId: number, text: string, replyToId?: number): Promise<number> {
	text = truncate(text, SAFE_LENGTH);
	try {
		const msg = await withTimeout(
			api.sendMessage(chatId, text, {
				parse_mode: "Markdown",
				...(replyToId ? { reply_parameters: { message_id: replyToId } } : {}),
			}),
			API_TIMEOUT,
		);
		return msg.message_id;
	} catch {
		try {
			const msg = await withTimeout(
				api.sendMessage(chatId, text, {
					...(replyToId ? { reply_parameters: { message_id: replyToId } } : {}),
				}),
				API_TIMEOUT,
			);
			return msg.message_id;
		} catch (e) {
			log(`[WARN] Failed to send message (possibly timed out): ${e}`);
			return 0;
		}
	}
}

/**
 * Send a long message, splitting at newline boundaries.
 */
export async function sendLong(api: Api, chatId: number, text: string, replyToId?: number): Promise<void> {
	while (text) {
		if (text.length <= SAFE_LENGTH) {
			await safeSend(api, chatId, text, replyToId);
			break;
		}
		let splitAt = text.lastIndexOf("\n", SAFE_LENGTH);
		if (splitAt < 2000) splitAt = SAFE_LENGTH;
		await safeSend(api, chatId, text.slice(0, splitAt), replyToId);
		text = text.slice(splitAt).replace(/^\n+/, "");
		replyToId = undefined; // Only reply to the first chunk
	}
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
