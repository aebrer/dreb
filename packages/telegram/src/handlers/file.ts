/**
 * File upload handler — downloads files from Telegram, batches rapid uploads,
 * and sends them to the agent as file path references.
 */

import type { Api, Context } from "grammy";
import type { UserState } from "../types.js";
import { saveUpload } from "../util/files.js";
import { log, safeSend } from "../util/telegram.js";
import { enqueuePrompt } from "./message.js";

/** Pending file batch */
interface FileBatch {
	userId: number;
	chatId: number;
	replyToId: number;
	statusMessageId: number | null;
	files: Array<{ path: string; name: string }>;
	caption: string;
	timer: ReturnType<typeof setTimeout>;
}

const BATCH_DELAY = 3000; // 3 second debounce
const pendingBatches = new Map<string, FileBatch>();

/**
 * Handle an incoming file (document, photo, voice, audio, video).
 */
export async function handleFile(
	ctx: Context,
	api: Api,
	_userState: UserState,
	getUserState: (userId: number) => UserState,
): Promise<void> {
	const msg = ctx.message;
	if (!msg) return;

	const userId = msg.from?.id;
	if (!userId) return;

	const chatId = msg.chat.id;
	const caption = msg.caption || "I've uploaded a file. Please analyze it.";

	// Extract file info
	const fileInfo = getFileInfo(msg);
	if (!fileInfo) {
		await safeSend(api, chatId, "❓ Unsupported file type");
		return;
	}

	// Download the file
	let localPath: string;
	try {
		const file = await ctx.getFile();
		const buffer = await downloadFile(api, file.file_path!);
		localPath = saveUpload(fileInfo.name, buffer);
		log(`[FILE] Downloaded: ${localPath}`);
	} catch (e) {
		log(`[FILE] Download failed: ${e}`);
		await safeSend(api, chatId, `❌ Failed to download file: ${e}`);
		return;
	}

	// Buffer key: media_group_id for albums, user ID for sequential uploads
	const bufferKey = msg.media_group_id || `user_${userId}`;

	if (pendingBatches.has(bufferKey)) {
		// Add to existing batch
		const batch = pendingBatches.get(bufferKey)!;
		batch.files.push({ path: localPath, name: fileInfo.name });
		if (msg.caption) batch.caption = caption;

		// Reset debounce timer
		clearTimeout(batch.timer);
		batch.timer = setTimeout(() => flushBatch(bufferKey, api, getUserState), BATCH_DELAY);
	} else {
		// Start new batch
		let statusMessageId: number | null = null;
		try {
			const statusMsg = await api.sendMessage(chatId, "📥 Downloading files...");
			statusMessageId = statusMsg.message_id;
		} catch {
			// Non-critical
		}

		const batch: FileBatch = {
			userId,
			chatId,
			replyToId: msg.message_id,
			statusMessageId,
			files: [{ path: localPath, name: fileInfo.name }],
			caption,
			timer: setTimeout(() => flushBatch(bufferKey, api, getUserState), BATCH_DELAY),
		};
		pendingBatches.set(bufferKey, batch);
	}
}

/**
 * Flush a file batch — combine all files into a single prompt.
 */
async function flushBatch(key: string, api: Api, getUserState: (userId: number) => UserState): Promise<void> {
	const batch = pendingBatches.get(key);
	if (!batch) return;
	pendingBatches.delete(key);

	const userState = getUserState(batch.userId);
	const n = batch.files.length;
	const fileNames = batch.files.map((f) => f.name).join(", ");
	const filesText = batch.files.map((f) => `File path: ${f.path}`).join("\n");
	const prompt = `${batch.caption}\n\n${filesText}`;

	log(`[FILE] Flushing batch: ${n} file(s) for user ${batch.userId}`);

	// Update status
	if (batch.statusMessageId) {
		const isBusy = userState.processing;
		const indicator = isBusy ? "📋 _Queued..._" : "🧠 _Processing..._";
		const status =
			n === 1
				? `📥 Downloaded: \`${fileNames}\`\n${indicator}`
				: `📥 Downloaded ${n} files: ${fileNames}\n${indicator}`;
		try {
			await api.editMessageText(batch.chatId, batch.statusMessageId, status, { parse_mode: "Markdown" });
		} catch {
			// Non-critical
		}
	}

	enqueuePrompt(api, userState, {
		message: { chat: { id: batch.chatId }, message_id: batch.replyToId } as any,
		prompt,
		statusMessage: batch.statusMessageId ? { chat_id: batch.chatId, message_id: batch.statusMessageId } : null,
		wasQueued: userState.processing,
	});
}

function getFileInfo(msg: any): { name: string } | null {
	if (msg.document) return { name: msg.document.file_name || "document" };
	if (msg.photo) return { name: "photo.jpg" };
	if (msg.voice) return { name: "voice.ogg" };
	if (msg.audio) return { name: msg.audio.file_name || "audio" };
	if (msg.video) return { name: msg.video.file_name || "video.mp4" };
	return null;
}

async function downloadFile(api: Api, filePath: string): Promise<Buffer> {
	const url = `https://api.telegram.org/file/bot${api.token}/${filePath}`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}
