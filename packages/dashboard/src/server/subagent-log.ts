/**
 * Subagent session-log reader — turns a background agent's on-disk session
 * JSONL into the message list the client's transcript reducer consumes.
 *
 * Why disk: `background_agent_event` relays are ephemeral (they exist only on
 * SSE clients connected while the agent streams). After a browser reload the
 * reducer state is gone, so the session log is the only source of truth for
 * a subagent transcript. The child process appends entries as it works, so
 * reading the file mid-run yields the transcript up to the last completed
 * message.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SubagentLogSource {
	/** Path to the agent's session JSONL (known after the child exits). */
	sessionFile?: string;
	/** Directory the child writes its session into (known at spawn time). */
	sessionDir?: string;
}

/**
 * Find the most recently modified .jsonl in a session directory. Parity with
 * discoverSessionFile in @dreb/coding-agent's subagent tool (not exported
 * there); each subagent gets a dedicated directory, so "newest .jsonl" is
 * unambiguous in practice.
 */
export function discoverSubagentSessionFile(sessionDir: string): string | undefined {
	if (!existsSync(sessionDir)) return undefined;
	let best: { path: string; mtime: number } | undefined;
	for (const name of readdirSync(sessionDir)) {
		if (!name.endsWith(".jsonl")) continue;
		try {
			const path = join(sessionDir, name);
			const mtime = statSync(path).mtime.getTime();
			if (!best || mtime > best.mtime) best = { path, mtime };
		} catch {
			// File disappeared between readdir and stat — skip it.
		}
	}
	return best?.path;
}

/**
 * Read the message payloads from a subagent session log.
 *
 * Subagent sessions are single-shot and linear (no branching/compaction), so
 * a straight scan of `type: "message"` entries reconstructs the transcript.
 * Malformed lines are skipped (the tail line can be mid-write).
 *
 * @throws when no session file can be located — callers surface this loudly.
 */
export function readSubagentMessages(source: SubagentLogSource): unknown[] {
	const file = source.sessionFile ?? (source.sessionDir ? discoverSubagentSessionFile(source.sessionDir) : undefined);
	if (!file || !existsSync(file)) {
		throw new Error("No session log found for this agent — it may not have produced output yet");
	}
	const messages: unknown[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; message?: unknown };
			if (entry.type === "message" && entry.message) messages.push(entry.message);
		} catch {
			// Skip malformed/partial lines (the child may be mid-append).
		}
	}
	return messages;
}
