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

interface SessionFileCandidate {
	path: string;
	mtime: number;
}

const STEP_SESSION_DIR_RE = /^step-(\d+)$/;

function isExpectedFilesystemError(err: unknown): boolean {
	return typeof (err as NodeJS.ErrnoException | undefined)?.code === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function findNewestJsonlFileInDir(dir: string): SessionFileCandidate | undefined {
	let best: SessionFileCandidate | undefined;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.name.endsWith(".jsonl")) continue;
		if (entry.isDirectory()) continue;
		const path = join(dir, entry.name);
		try {
			const mtime = statSync(path).mtime.getTime();
			if (!best || mtime > best.mtime) best = { path, mtime };
		} catch (err) {
			if (isExpectedFilesystemError(err)) continue;
			throw err;
		}
	}
	return best;
}

function discoverStepSessionFileCandidates(sessionDir: string): SessionFileCandidate[] {
	const steps: Array<{ name: string; index: number }> = [];
	for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const match = STEP_SESSION_DIR_RE.exec(entry.name);
		if (!match) continue;
		steps.push({ name: entry.name, index: Number(match[1]) });
	}
	steps.sort((a, b) => a.index - b.index || a.name.localeCompare(b.name));

	const files: SessionFileCandidate[] = [];
	for (const step of steps) {
		try {
			const candidate = findNewestJsonlFileInDir(join(sessionDir, step.name));
			if (candidate) files.push(candidate);
		} catch (err) {
			if (isExpectedFilesystemError(err)) continue;
			throw err;
		}
	}
	return files;
}

/**
 * Find chain step session JSONLs under step-N/ directories, ordered by numeric
 * step index. Returns an empty list for missing/non-chain directories.
 */
export function discoverSubagentStepSessionFiles(sessionDir: string): string[] {
	try {
		if (!existsSync(sessionDir)) return [];
		return discoverStepSessionFileCandidates(sessionDir).map((file) => file.path);
	} catch (err) {
		if (isExpectedFilesystemError(err)) return [];
		throw err;
	}
}

/**
 * Find the most recently modified .jsonl in a session directory. Parity with
 * discoverSessionFile in @dreb/coding-agent's subagent tool. Normal subagents
 * write directly under sessionDir; chain-mode subagents register the chain root
 * but write per-step logs under step-N/ subdirectories.
 */
export function discoverSubagentSessionFile(sessionDir: string): string | undefined {
	try {
		if (!existsSync(sessionDir)) return undefined;
		const flatFile = findNewestJsonlFileInDir(sessionDir);
		if (flatFile) return flatFile.path;

		let best: SessionFileCandidate | undefined;
		for (const file of discoverStepSessionFileCandidates(sessionDir)) {
			if (!best || file.mtime > best.mtime) best = file;
		}
		return best?.path;
	} catch (err) {
		if (isExpectedFilesystemError(err)) return undefined;
		throw err;
	}
}

function readMessagesFromFile(file: string): unknown[] {
	const messages: unknown[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (isRecord(entry) && entry.type === "message" && entry.message) messages.push(entry.message);
		} catch (err) {
			if (err instanceof SyntaxError) continue;
			throw err;
		}
	}
	return messages;
}

function discoverMessageFiles(source: SubagentLogSource): string[] {
	const stepFiles = source.sessionDir ? discoverSubagentStepSessionFiles(source.sessionDir) : [];
	if (stepFiles.length > 0) return stepFiles;
	if (source.sessionFile) return existsSync(source.sessionFile) ? [source.sessionFile] : [];
	const file = source.sessionDir ? discoverSubagentSessionFile(source.sessionDir) : undefined;
	return file ? [file] : [];
}

/**
 * Read the message payloads from a subagent session log.
 *
 * Subagent sessions are single-shot and linear (no branching/compaction), so
 * a straight scan of `type: "message"` entries reconstructs the transcript.
 * Chain-mode subagents write one linear log per step; those step logs are
 * concatenated in numeric step order. Malformed lines are skipped (the tail
 * line can be mid-write).
 *
 * @throws when no session file can be located — callers surface this loudly.
 */
export function readSubagentMessages(source: SubagentLogSource): unknown[] {
	const files = discoverMessageFiles(source);
	if (files.length === 0) {
		throw new Error("No session log found for this agent — it may not have produced output yet");
	}
	return files.flatMap((file) => readMessagesFromFile(file));
}
