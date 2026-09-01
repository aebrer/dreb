/**
 * Dashboard-mode RPC event projection.
 *
 * `message_update` events carry two cumulative copies of the growing assistant
 * message: the top-level `message` field and `assistantMessageEvent.partial`.
 * Serializing both for every token makes the child->parent JSONL pipe quadratic
 * in response length and floods the stdout queue (see issue 448).
 *
 * The dashboard never reads those fields: its browser reducer consumes only
 * the delta fields (`delta`, `content`, `toolCall`, `contentIndex`), and its
 * authoritative transcript comes from `message_end` plus `get_dashboard_snapshot`
 * RPC responses. The dashboard's own EventHub already strips the same fields at
 * the browser SSE boundary (projectDashboardEvent); this module applies the same
 * removal one boundary earlier, before JSONL serialization in runRpcMode.
 *
 * Only the quadratic `message_update` fields are removed here. Broader bounding
 * (agent_end messages, tool_execution_update args, retry discardedPartial,
 * images) remains the EventHub's browser-facing concern.
 */

import { createHash } from "node:crypto";

function omit(event: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
	const copy = { ...event };
	for (const key of keys) delete copy[key];
	return copy;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project a single agent session event for dashboard-mode RPC transport.
 *
 * Unknown event types are returned exactly as received (same reference) so
 * extensions and future event types remain forward-safe. Projected events are
 * shallow copies — the input event is never mutated, because other session
 * subscribers (and the session's own state) share the same object.
 */
export function projectDashboardRpcEvent(event: Record<string, unknown>): Record<string, unknown> {
	switch (event.type) {
		case "message_update": {
			const projected = omit(event, "message");
			const streamEvent = event.assistantMessageEvent;
			return isPlainObject(streamEvent)
				? { ...projected, assistantMessageEvent: omit(streamEvent, "partial") }
				: projected;
		}
		case "background_agent_event": {
			const child = event.event;
			return isPlainObject(child) ? { ...event, event: projectDashboardRpcEvent(child) } : event;
		}
		default:
			return event;
	}
}

// ---------------------------------------------------------------------------
// Image dedupe (dashboard mode)
//
// Inline image blocks cross the JSONL pipe multiple times per turn: prompt
// re-emission (message_start + message_end), each tool result
// (tool_execution_end + message_start + message_end), and the agent_end
// transcript. A turn with several multi-MiB images easily fills the child
// stdout queue while the dashboard is busy decoding, and the stdout guard
// kills the session (issue 495).
//
// The dashboard already treats images content-globally: its server projection
// replaces every inline image with an image_reference whose id is
// sha256(mimeType + 0x00 + decodedBytes), caches the binary on first sight,
// and serves later fetches from that cache (recovering from the authoritative
// transcript when evicted). This projector applies the same reduction one
// boundary earlier: each unique image crosses stdout at most once per process
// lifetime; every later occurrence becomes an image_reference the dashboard
// resolves from its cache. Live events only — command responses
// (get_messages, get_dashboard_snapshot) always keep full payloads, because
// they are the authoritative source the dashboard's image recovery reads.
// ---------------------------------------------------------------------------

const DASHBOARD_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const JPEG_EOI = Buffer.from([0xff, 0xd9]);

type ImageReference = { type: "image_reference"; id: string; mimeType: string; size: number };

/**
 * Raster-signature check mirroring the dashboard server's hasRasterSignature
 * (packages/dashboard/src/server/dashboard-images.ts). Keep in sync: the child
 * may only turn a block into a reference when the dashboard's strict decode
 * (decodeDashboardImage) will accept it, or the reference dangles (the cache
 * holds nothing and the authoritative recovery decodes the same bytes and
 * rejects them again).
 */
function hasRasterSignature(mimeType: string, bytes: Uint8Array): boolean {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	switch (mimeType) {
		case "image/png": {
			const signature =
				bytes.length >= 24 &&
				[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => bytes[i] === byte);
			return (
				signature &&
				buffer.subarray(12, 16).toString("ascii") === "IHDR" &&
				buffer.readUInt32BE(16) > 0 &&
				buffer.readUInt32BE(20) > 0 &&
				buffer.indexOf(Buffer.from("IEND"), 24) >= 0
			);
		}
		case "image/jpeg": {
			if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return false;
			// EOI does not have to be the final byte. Phone JPEGs commonly append
			// auxiliary gain-map, motion-photo, or vendor metadata after the
			// primary image. Browsers and Photon decode the JPEG through EOI and
			// preserve the trailing bytes when the exact original is requested.
			return buffer.lastIndexOf(JPEG_EOI) >= 2;
		}
		case "image/gif": {
			const header = buffer.subarray(0, 6).toString("ascii");
			return (
				bytes.length >= 14 &&
				(header === "GIF87a" || header === "GIF89a") &&
				buffer.readUInt16LE(6) > 0 &&
				buffer.readUInt16LE(8) > 0 &&
				bytes[bytes.length - 1] === 0x3b
			);
		}
		case "image/webp": {
			if (
				bytes.length < 20 ||
				buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
				buffer.subarray(8, 12).toString("ascii") !== "WEBP"
			) {
				return false;
			}
			const chunk = buffer.subarray(12, 16).toString("ascii");
			return (
				buffer.readUInt32LE(4) + 8 <= bytes.length && (chunk === "VP8 " || chunk === "VP8L" || chunk === "VP8X")
			);
		}
	}
	return false;
}

/**
 * Content identity of an inline image block, mirroring the dashboard server's
 * dashboardImageId (sha256 of mimeType + 0x00 + decoded bytes). The gate is as
 * strict as the dashboard's decodeDashboardImage — allowlisted mimeType,
 * canonical base64 (round trip), and a matching raster signature — so a block
 * the dashboard would reject never becomes a reference: it stays inline at
 * every occurrence and is dropped by the dashboard's strict decode, exactly as
 * before this projection existed (no dangling image_references).
 */
function imageBlockIdentity(mimeType: string, data: string): { id: string; size: number } | undefined {
	if (!DASHBOARD_IMAGE_MIME_TYPES.has(mimeType)) return undefined;
	if (data.length === 0 || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) return undefined;
	const bytes = Buffer.from(data, "base64");
	if (bytes.byteLength === 0) return undefined;
	if (bytes.toString("base64") !== data) return undefined; // non-canonical encoding the dashboard rejects
	if (!hasRasterSignature(mimeType, bytes)) return undefined; // signature mismatch the dashboard rejects
	const id = createHash("sha256").update(mimeType).update(Uint8Array.of(0)).update(bytes).digest("hex");
	return { id, size: bytes.byteLength };
}

/**
 * Replace occurrences of already-seen image blocks with their stable
 * reference, keeping the first occurrence of each unique image inline.
 * Returns the input by reference when nothing changed, so events without
 * images keep sharing objects with other session subscribers.
 */
function dedupeImages(node: unknown, seen: Map<string, ImageReference>): unknown {
	if (Array.isArray(node)) {
		let changed = false;
		const result: unknown[] = new Array(node.length);
		for (let i = 0; i < node.length; i++) {
			const original = node[i];
			const next = dedupeImages(original, seen);
			if (next !== original) changed = true;
			result[i] = next;
		}
		return changed ? result : node;
	}
	if (isPlainObject(node)) {
		if (node.type === "image" && typeof node.mimeType === "string" && typeof node.data === "string") {
			const identity = imageBlockIdentity(node.mimeType, node.data);
			if (identity) {
				const reference = seen.get(identity.id);
				if (reference) return reference;
				const created: ImageReference = {
					type: "image_reference",
					id: identity.id,
					mimeType: node.mimeType,
					size: identity.size,
				};
				seen.set(identity.id, created);
				return node;
			}
			return node;
		}
		let changed = false;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(node)) {
			const original = node[key];
			const next = dedupeImages(original, seen);
			if (next !== original) changed = true;
			result[key] = next;
		}
		return changed ? result : node;
	}
	return node;
}

/**
 * Create the dashboard-mode RPC event projector for one runRpcMode process.
 *
 * Composes the per-event field projection with process-lifetime image dedupe.
 * Dashboard-mode sessions only — generic RPC consumers keep the full protocol.
 */
export function createDashboardRpcEventProjector(): (event: Record<string, unknown>) => Record<string, unknown> {
	const seenImageIds = new Map<string, ImageReference>();
	return (event: Record<string, unknown>): Record<string, unknown> => {
		const projected = projectDashboardRpcEvent(event);
		return dedupeImages(projected, seenImageIds) as Record<string, unknown>;
	};
}
