/**
 * SSE event hub — fans runtime events out to connected browsers with a bounded
 * ring buffer per hub for Last-Event-ID catch-up after reconnects.
 */

import type { EventEnvelope } from "../shared/protocol.js";

export interface SseClient {
	write(chunk: string): void;
}

const DEFAULT_BUFFER_SIZE = 2000;

export class EventHub {
	private seq = 0;
	private readonly buffer: EventEnvelope[] = [];
	private readonly clients = new Set<SseClient>();

	constructor(private readonly bufferSize = DEFAULT_BUFFER_SIZE) {}

	/** Publish an event from a runtime; assigns a sequence number and fans out. */
	publish(key: string, event: Record<string, unknown>): EventEnvelope {
		this.seq += 1;
		const envelope: EventEnvelope = { seq: this.seq, key, event };
		this.buffer.push(envelope);
		if (this.buffer.length > this.bufferSize) {
			this.buffer.splice(0, this.buffer.length - this.bufferSize);
		}
		const frame = formatSseFrame(envelope);
		for (const client of this.clients) {
			try {
				client.write(frame);
			} catch {
				// Dead connections are removed via their close handlers; a write
				// failure here must not break the loop for other clients.
			}
		}
		return envelope;
	}

	/**
	 * Attach a client. When `lastEventId` is provided, buffered events after it
	 * are replayed first. Returns a detach function.
	 *
	 * When the requested id has already been evicted from the buffer, or belongs
	 * to an older server instance whose sequence is no longer present, a
	 * `dashboard_resync` event is sent first — the client must refetch state
	 * because the gap cannot be replayed.
	 */
	attach(client: SseClient, lastEventId?: number): () => void {
		if (lastEventId !== undefined) {
			const oldest = this.buffer[0]?.seq;
			const newest = this.buffer[this.buffer.length - 1]?.seq;
			if (oldest === undefined || newest === undefined || lastEventId < oldest - 1 || lastEventId > newest) {
				this.seq += 1;
				client.write(
					formatSseFrame({
						seq: this.seq,
						key: "",
						event: { type: "dashboard_resync", reason: oldest === undefined ? "empty_buffer" : "buffer_gap" },
					}),
				);
			}
			for (const envelope of this.buffer) {
				if (envelope.seq > lastEventId) client.write(formatSseFrame(envelope));
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
}

/** Format an envelope as an SSE frame with the sequence number as event id. */
export function formatSseFrame(envelope: EventEnvelope): string {
	return `id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`;
}
