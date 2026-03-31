/**
 * File handling utilities — temp dir management, telegram:send pattern.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "./telegram.js";

const UPLOAD_DIR = join(tmpdir(), "dreb-telegram-uploads");

/** Pattern for file send requests embedded in assistant text */
export const SEND_FILE_PATTERN = /\[\[telegram:send:([^\]]+)\]\]/g;

/**
 * Ensure the upload directory exists.
 */
export function ensureUploadDir(): string {
	if (!existsSync(UPLOAD_DIR)) {
		mkdirSync(UPLOAD_DIR, { recursive: true });
	}
	return UPLOAD_DIR;
}

/**
 * Save a buffer to the upload directory.
 */
export function saveUpload(filename: string, data: Buffer): string {
	const dir = ensureUploadDir();
	const path = join(dir, `${Date.now()}_${filename}`);
	writeFileSync(path, data);
	return path;
}

/**
 * Extract [[telegram:send:path]] markers from text.
 * Returns [cleanedText, filePaths].
 */
export function extractSendFiles(text: string): [string, string[]] {
	const paths: string[] = [];
	const cleaned = text.replace(SEND_FILE_PATTERN, (_match, path) => {
		paths.push(path.trim());
		return "";
	});
	return [cleaned.trim(), paths];
}

/**
 * Clean up the upload directory.
 */
export function cleanupUploads(): void {
	try {
		if (existsSync(UPLOAD_DIR)) {
			rmSync(UPLOAD_DIR, { recursive: true, force: true });
			log("[FILES] Cleaned up upload directory");
		}
	} catch (e) {
		log(`[FILES] Cleanup failed: ${e}`);
	}
}
