/**
 * Persistent state — survives bot restarts.
 * Stores per-user session paths so the bot can eagerly reconnect on startup.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "./util/telegram.js";

const STATE_FILE = join(homedir(), ".dreb", "telegram", "state.json");

interface PersistedState {
	/** userId → last active session file path */
	sessions: Record<string, string>;
}

let state: PersistedState = { sessions: {} };

/** Load persisted state from disk. Safe to call multiple times. */
export function loadState(): void {
	try {
		if (existsSync(STATE_FILE)) {
			const raw = readFileSync(STATE_FILE, "utf-8");
			state = JSON.parse(raw);
			log(`[STATE] Loaded state: ${Object.keys(state.sessions).length} user(s)`);
		}
	} catch (e) {
		log(`[STATE] Failed to load state: ${e}`);
		state = { sessions: {} };
	}
}

/** Save current state to disk. */
function saveState(): void {
	try {
		const dir = dirname(STATE_FILE);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
	} catch (e) {
		log(`[STATE] Failed to save state: ${e}`);
	}
}

/** Record the active session for a user. Persists immediately. */
export function setUserSession(userId: number, sessionPath: string): void {
	state.sessions[String(userId)] = sessionPath;
	saveState();
}

/** Get the last known session path for a user, or undefined. */
export function getUserSession(userId: number): string | undefined {
	return state.sessions[String(userId)];
}
