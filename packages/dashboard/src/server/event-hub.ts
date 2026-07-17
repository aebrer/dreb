/**
 * SSE event hub — projects runtime events for the dashboard, keeps a
 * byte-bounded replay history, and fans serialized frames out to browsers.
 */

import type { EventEnvelope } from "../shared/protocol.js";

export type SseWriteKind = "live" | "replay" | "resync";

/** Metadata deliberately excludes the serialized event payload. */
export interface SseWriteMetadata {
	kind: SseWriteKind;
	seq: number;
	type: string;
	frameBytes: number;
	/** Safe synthesized-barrier classification, never runtime payload data. */
	reason?: string;
}

export interface ReplayDiagnostic {
	kind: "replay" | "resync";
	count: number;
	bytes: number;
	fromSeq?: number;
	toSeq?: number;
	reason?: string;
}

/** Return false when this connection can no longer accept frames. */
export interface SseClient {
	write(chunk: string, metadata?: SseWriteMetadata): boolean | undefined;
}

export interface EventHubOptions {
	/** Maximum number of retained frames. */
	bufferSize?: number;
	/** Maximum encoded bytes retained for reconnect replay. */
	bufferBytes?: number;
	/** Maximum encoded bytes written during a single replay. */
	replayBytes?: number;
	/** Largest projected event frame that may be delivered directly. */
	eventBytes?: number;
}

export const DEFAULT_BUFFER_SIZE = 2000;
export const DEFAULT_BUFFER_BYTES = 8 * 1024 * 1024;
/** Kept below the response destruction ceiling in server.ts. */
export const DEFAULT_REPLAY_BYTES = 3 * 1024 * 1024;
export const DEFAULT_EVENT_BYTES = 1024 * 1024;

interface SerializedEnvelope {
	envelope: EventEnvelope;
	frame: string;
	bytes: number;
	/** Present only for barriers synthesized by this hub, never runtime data. */
	resyncReason?: string;
}

function omit<T extends Record<string, unknown>>(event: T, ...keys: string[]): Record<string, unknown> {
	const copy = { ...event };
	for (const key of keys) delete copy[key];
	return copy;
}

/**
 * Dashboard-only transport projection. Each removed field is cumulative data
 * that the dashboard reducer does not read. Unknown event types are returned
 * exactly as received so extensions and future runtimes remain forward-safe.
 */
export function projectDashboardEvent(event: Record<string, unknown>): Record<string, unknown> {
	switch (event.type) {
		case "agent_end":
			return omit(event, "messages");
		case "turn_end":
			return omit(event, "message", "toolResults");
		case "message_update":
			return omit(event, "message");
		case "tool_execution_update":
			return omit(event, "args");
		case "stream_retry":
			return omit(event, "discardedPartial");
		case "length_retry":
			return omit(event, "discardedPartial");
		case "background_agent_event": {
			const child = event.event;
			return child && typeof child === "object" && !Array.isArray(child)
				? { ...event, event: projectDashboardEvent(child as Record<string, unknown>) }
				: event;
		}
		default:
			return event;
	}
}

export class EventHub {
	private seq = 0;
	private bufferedBytes = 0;
	private readonly buffer: SerializedEnvelope[] = [];
	private readonly clients = new Set<SseClient>();
	private readonly options: Required<EventHubOptions>;

	constructor(options: number | EventHubOptions = {}) {
		this.options = {
			bufferSize: typeof options === "number" ? options : (options.bufferSize ?? DEFAULT_BUFFER_SIZE),
			bufferBytes:
				typeof options === "number" ? DEFAULT_BUFFER_BYTES : (options.bufferBytes ?? DEFAULT_BUFFER_BYTES),
			replayBytes:
				typeof options === "number" ? DEFAULT_REPLAY_BYTES : (options.replayBytes ?? DEFAULT_REPLAY_BYTES),
			eventBytes: typeof options === "number" ? DEFAULT_EVENT_BYTES : (options.eventBytes ?? DEFAULT_EVENT_BYTES),
		};
	}

	/** Publish an event from a runtime; assigns a sequence number and fans out. */
	publish(key: string, rawEvent: Record<string, unknown>): EventEnvelope {
		const event = projectDashboardEvent(rawEvent);
		const serialized = this.serialize(this.seq + 1, key, event);
		if (serialized.bytes > this.options.eventBytes) {
			return this.publishResync("oversized_event").envelope;
		}
		this.seq += 1;
		this.retain(serialized);
		this.fanout(serialized, "live");
		return serialized.envelope;
	}

	/**
	 * Attach a client. Replays only a complete, bounded range. A gap or replay
	 * over budget receives a recovery frame only on this connection; it never
	 * consumes a global sequence or disturbs healthy clients' ordered stream.
	 */
	attach(client: SseClient, lastEventId?: number, onReplay?: (diagnostic: ReplayDiagnostic) => void): () => void {
		if (lastEventId !== undefined) {
			const replay = this.replayAfter(lastEventId);
			if (!replay) {
				const reason = this.resyncReason(lastEventId);
				const barrier = this.targetedResync(reason);
				onReplay?.({ kind: "resync", count: 1, bytes: barrier.bytes, toSeq: barrier.envelope.seq, reason });
				if (!this.write(client, barrier, "resync")) return () => {};
			} else {
				const bytes = replay.reduce((total, item) => total + item.bytes, 0);
				onReplay?.({
					kind: "replay",
					count: replay.length,
					bytes,
					fromSeq: replay[0]?.envelope.seq,
					toSeq: replay[replay.length - 1]?.envelope.seq,
				});
				for (const serialized of replay) {
					if (!this.write(client, serialized, "replay")) return () => {};
				}
			}
		}
		this.clients.add(client);
		return () => {
			this.clients.delete(client);
		};
	}

	get clientCount(): number {
		return this.clients.size;
	}

	get historyBytes(): number {
		return this.bufferedBytes;
	}

	get historyCount(): number {
		return this.buffer.length;
	}

	/** Current sequence, captured without emitting, retaining, or fanning out. */
	get currentSequence(): number {
		return this.seq;
	}

	private serialize(seq: number, key: string, event: Record<string, unknown>): SerializedEnvelope {
		const envelope: EventEnvelope = { seq, key, event };
		const frame = formatSseFrame(envelope);
		return { envelope, frame, bytes: Buffer.byteLength(frame) };
	}

	private retain(serialized: SerializedEnvelope): void {
		this.buffer.push(serialized);
		this.bufferedBytes += serialized.bytes;
		while (this.buffer.length > this.options.bufferSize || this.bufferedBytes > this.options.bufferBytes) {
			const evicted = this.buffer.shift();
			if (!evicted) break;
			this.bufferedBytes -= evicted.bytes;
		}
	}

	private replayAfter(lastEventId: number): SerializedEnvelope[] | undefined {
		const oldest = this.buffer[0]?.envelope.seq;
		const newest = this.buffer[this.buffer.length - 1]?.envelope.seq;
		if (oldest === undefined || newest === undefined || lastEventId < oldest - 1 || lastEventId > newest)
			return undefined;
		const replay = this.buffer.filter((item) => item.envelope.seq > lastEventId);
		return replay.reduce((bytes, item) => bytes + item.bytes, 0) <= this.options.replayBytes ? replay : undefined;
	}

	private resyncReason(lastEventId: number): string {
		const oldest = this.buffer[0]?.envelope.seq;
		const newest = this.buffer[this.buffer.length - 1]?.envelope.seq;
		if (oldest === undefined) return "empty_buffer";
		if (lastEventId < oldest - 1 || lastEventId > newest!) return "buffer_gap";
		return "replay_over_budget";
	}

	/** Explicit oversized events are globally unrecoverable, so retain and fan out their barrier. */
	private publishResync(reason: string): SerializedEnvelope {
		this.seq += 1;
		const barrier = this.serialize(this.seq, "", { type: "dashboard_resync", reason });
		barrier.resyncReason = reason;
		this.retain(barrier);
		this.fanout(barrier, "resync");
		return barrier;
	}

	/**
	 * A stale reconnect needs the current ordering cursor, not a new global
	 * event. With no events yet, establish sequence 1 so it has a usable cursor.
	 */
	private targetedResync(reason: string): SerializedEnvelope {
		if (this.seq === 0) this.seq = 1;
		const barrier = this.serialize(this.seq, "", { type: "dashboard_resync", reason });
		barrier.resyncReason = reason;
		return barrier;
	}

	private fanout(serialized: SerializedEnvelope, kind: SseWriteKind): void {
		for (const client of this.clients) {
			if (!this.write(client, serialized, kind)) this.clients.delete(client);
		}
	}

	private write(client: SseClient, serialized: SerializedEnvelope, kind: SseWriteKind): boolean {
		try {
			return (
				client.write(serialized.frame, {
					kind,
					seq: serialized.envelope.seq,
					type: String(serialized.envelope.event.type ?? "unknown"),
					frameBytes: serialized.bytes,
					...(serialized.resyncReason ? { reason: serialized.resyncReason } : {}),
				}) !== false
			);
		} catch {
			return false;
		}
	}
}

/** Format an envelope as an SSE frame with the sequence number as event id. */
export function formatSseFrame(envelope: EventEnvelope): string {
	return `id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/** Observable liveness signal; intentionally unnumbered and never buffered. */
export function formatHeartbeatFrame(): string {
	return "event: heartbeat\ndata: {}\n\n";
}
