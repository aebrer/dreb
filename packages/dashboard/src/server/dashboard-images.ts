import { createHash } from "node:crypto";
import type { DashboardImageReferenceDto } from "../shared/protocol.js";
import {
	type GeneratedImagePreview,
	type ImagePreviewGenerator,
	MAX_PREVIEW_BYTES,
	MAX_PREVIEW_HEIGHT,
	MAX_PREVIEW_WIDTH,
} from "./image-preview.js";

export const DASHBOARD_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
export const DASHBOARD_IMAGE_CACHE_RECORDS = 2000;
export const DASHBOARD_IMAGE_ID_PATTERN = /^[0-9a-f]{64}$/;
export const DASHBOARD_IMAGE_MIME_TYPES = new Set<DashboardImageReferenceDto["mimeType"]>([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

export interface DashboardImageScope {
	runtimeKey: string;
	agentId?: string;
}

export interface DashboardImageBinary {
	bytes: Uint8Array;
	mimeType: DashboardImageReferenceDto["mimeType"];
}

export interface DashboardImageRepositoryOptions {
	maxBytes?: number;
	maxRecords?: number;
}

interface CachedVariant extends DashboardImageBinary {
	lastUsed: number;
}

interface CachedImage {
	id: string;
	mimeType: DashboardImageReferenceDto["mimeType"];
	size: number;
	scopes: Set<string>;
	original?: CachedVariant;
	preview?: CachedVariant;
}

const DROP = Symbol("drop-dashboard-image");
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

function scopeKey(scope: DashboardImageScope): string {
	return `${scope.runtimeKey}\0${scope.agentId ?? ""}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasRasterSignature(mimeType: DashboardImageReferenceDto["mimeType"], bytes: Uint8Array): boolean {
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
			// auxiliary gain-map, motion-photo, or vendor metadata after the primary
			// image. Browsers and Photon decode the JPEG through EOI and preserve the
			// trailing bytes when the exact original is requested.
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
}

/** Strict standard base64 decode: whitespace, data URLs, and non-canonical padding are rejected. */
export function decodeDashboardImage(value: unknown, mimeType: unknown): DashboardImageBinary | undefined {
	if (typeof value !== "string" || typeof mimeType !== "string") return undefined;
	if (!DASHBOARD_IMAGE_MIME_TYPES.has(mimeType as DashboardImageReferenceDto["mimeType"])) return undefined;
	if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value) return undefined;
	const exactMimeType = mimeType as DashboardImageReferenceDto["mimeType"];
	if (!hasRasterSignature(exactMimeType, bytes)) return undefined;
	return { bytes, mimeType: exactMimeType };
}

export function dashboardImageId(mimeType: string, bytes: Uint8Array): string {
	return createHash("sha256").update(mimeType).update(Uint8Array.of(0)).update(bytes).digest("hex");
}

export function isDashboardImageReference(value: unknown): value is DashboardImageReferenceDto {
	if (!isRecord(value)) return false;
	return (
		value.type === "image_reference" &&
		typeof value.id === "string" &&
		DASHBOARD_IMAGE_ID_PATTERN.test(value.id) &&
		typeof value.mimeType === "string" &&
		DASHBOARD_IMAGE_MIME_TYPES.has(value.mimeType as DashboardImageReferenceDto["mimeType"]) &&
		typeof value.size === "number" &&
		Number.isSafeInteger(value.size) &&
		value.size > 0
	);
}

export class DashboardImageNotFoundError extends Error {}
export class DashboardImagePreviewError extends Error {}

/** Synchronous projection + bounded original/preview repository. */
export class DashboardImageService {
	private readonly images = new Map<string, CachedImage>();
	private readonly originalFlights = new Map<string, Promise<DashboardImageBinary>>();
	private readonly previewFlights = new Map<string, Promise<DashboardImageBinary>>();
	private readonly maxBytes: number;
	private readonly maxRecords: number;
	private usedBytes = 0;
	private usedRecords = 0;
	private clock = 0;

	constructor(
		private readonly previews: ImagePreviewGenerator,
		options: DashboardImageRepositoryOptions = {},
	) {
		this.maxBytes = options.maxBytes ?? DASHBOARD_IMAGE_CACHE_BYTES;
		this.maxRecords = options.maxRecords ?? DASHBOARD_IMAGE_CACHE_RECORDS;
	}

	get byteSize(): number {
		return this.usedBytes;
	}

	get recordCount(): number {
		return this.usedRecords;
	}

	/** Project a browser-facing event without mutating the authoritative source. */
	projectEvent(event: Record<string, unknown>, scope: DashboardImageScope): Record<string, unknown> {
		return this.projectNode(event, scope) as Record<string, unknown>;
	}

	/** Project messages/snapshots before JSON serialization. */
	project<T>(value: T, scope: DashboardImageScope): T {
		const projected = this.projectNode(value, scope);
		return (projected === DROP ? undefined : projected) as T;
	}

	async original(
		scope: DashboardImageScope,
		id: string,
		loadAuthoritative: () => Promise<unknown>,
	): Promise<DashboardImageBinary> {
		const cached = this.cachedVariant(scope, id, "original");
		if (cached) return cached;
		// Single-flight authoritative recovery per scope+id. In originals display
		// mode the browser auto-fetches every tool-result image, so N concurrent
		// cache misses for distinct ids would each trigger a full authoritative
		// (getMessages) re-fetch over the same RPC pipe. Coalescing the concurrent
		// misses for one id collapses them into a single load. The key is
		// scope-bound so requesters from another runtime/agent never piggyback.
		const key = `${scopeKey(scope)}\0${id}`;
		const flight = this.originalFlights.get(key);
		if (flight) return flight;
		const promise = this.recoverOriginal(scope, id, loadAuthoritative);
		this.originalFlights.set(key, promise);
		try {
			return await promise;
		} finally {
			this.originalFlights.delete(key);
		}
	}

	async preview(
		scope: DashboardImageScope,
		id: string,
		loadAuthoritative: () => Promise<unknown>,
	): Promise<DashboardImageBinary> {
		const cached = this.cachedVariant(scope, id, "preview");
		if (cached) return cached;
		// Authorize/recover this scope before joining a content-global flight. A
		// guessed ID from another runtime must not piggyback its in-flight preview.
		const original = await this.original(scope, id, loadAuthoritative);
		const recoveredPreview = this.cachedVariant(scope, id, "preview");
		if (recoveredPreview) return recoveredPreview;
		const flight = this.previewFlights.get(id);
		if (flight) return flight;
		const promise = (async () => {
			let generated: GeneratedImagePreview;
			try {
				generated = await this.previews.generate(original.bytes, original.mimeType);
			} catch (error) {
				throw new DashboardImagePreviewError(
					`Preview generation failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (
				generated.bytes.byteLength > MAX_PREVIEW_BYTES ||
				generated.width < 1 ||
				generated.height < 1 ||
				generated.width > MAX_PREVIEW_WIDTH ||
				generated.height > MAX_PREVIEW_HEIGHT ||
				(generated.mimeType !== "image/png" && generated.mimeType !== "image/jpeg")
			) {
				throw new DashboardImagePreviewError("Preview worker returned an invalid or over-budget image");
			}
			const binary: DashboardImageBinary = { bytes: generated.bytes, mimeType: generated.mimeType };
			this.putVariant(id, scope, "preview", binary);
			return binary;
		})();
		this.previewFlights.set(id, promise);
		try {
			return await promise;
		} finally {
			this.previewFlights.delete(id);
		}
	}

	removeRuntime(runtimeKey: string): void {
		for (const image of [...this.images.values()]) {
			for (const key of image.scopes) {
				if (key === runtimeKey || key.startsWith(`${runtimeKey}\0`)) image.scopes.delete(key);
			}
			if (image.scopes.size === 0) this.deleteImage(image);
		}
	}

	close(): Promise<void> {
		return this.previews.close();
	}

	private projectNode(value: unknown, scope: DashboardImageScope): unknown | typeof DROP {
		if (Array.isArray(value)) {
			const projected: unknown[] = [];
			for (const item of value) {
				const next = this.projectNode(item, scope);
				if (next !== DROP) projected.push(next);
			}
			return projected;
		}
		if (!isRecord(value)) return value;
		if (value.type === "image") {
			const image = decodeDashboardImage(value.data, value.mimeType);
			if (!image) return DROP;
			return this.insertOriginal(scope, image);
		}
		if (value.type === "image_reference") return isDashboardImageReference(value) ? { ...value } : DROP;
		const childScope =
			value.type === "background_agent_event" && typeof value.agentId === "string"
				? { runtimeKey: scope.runtimeKey, agentId: value.agentId }
				: scope;
		const copy: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			const next = this.projectNode(item, key === "event" ? childScope : scope);
			if (next !== DROP) copy[key] = next;
		}
		return copy;
	}

	private insertOriginal(scope: DashboardImageScope, binary: DashboardImageBinary): DashboardImageReferenceDto {
		const id = dashboardImageId(binary.mimeType, binary.bytes);
		let image = this.images.get(id);
		if (!image) {
			image = { id, mimeType: binary.mimeType, size: binary.bytes.byteLength, scopes: new Set() };
			this.images.set(id, image);
		}
		image.scopes.add(scopeKey(scope));
		if (!image.original) this.putVariant(id, scope, "original", binary);
		else image.original.lastUsed = ++this.clock;
		return { type: "image_reference", id, mimeType: binary.mimeType, size: binary.bytes.byteLength };
	}

	private cachedVariant(
		scope: DashboardImageScope,
		id: string,
		variant: "original" | "preview",
	): DashboardImageBinary | undefined {
		const image = this.images.get(id);
		if (!image || !image.scopes.has(scopeKey(scope))) return undefined;
		const cached = image[variant];
		if (!cached) return undefined;
		cached.lastUsed = ++this.clock;
		return { bytes: cached.bytes, mimeType: cached.mimeType };
	}

	private async recoverOriginal(
		scope: DashboardImageScope,
		id: string,
		loadAuthoritative: () => Promise<unknown>,
	): Promise<DashboardImageBinary> {
		const source = await loadAuthoritative();
		let recovered: DashboardImageBinary | undefined;
		const visit = (value: unknown): void => {
			if (recovered) return;
			if (Array.isArray(value)) {
				for (const item of value) visit(item);
				return;
			}
			if (!isRecord(value)) return;
			if (value.type === "image") {
				const image = decodeDashboardImage(value.data, value.mimeType);
				if (image && dashboardImageId(image.mimeType, image.bytes) === id) recovered = image;
				return;
			}
			for (const item of Object.values(value)) visit(item);
		};
		visit(source);
		if (!recovered) throw new DashboardImageNotFoundError("Image is no longer available from this transcript");
		this.insertOriginal(scope, recovered);
		return recovered;
	}

	private putVariant(
		id: string,
		scope: DashboardImageScope,
		variant: "original" | "preview",
		binary: DashboardImageBinary,
	): void {
		let image = this.images.get(id);
		if (!image) {
			image = { id, mimeType: binary.mimeType, size: binary.bytes.byteLength, scopes: new Set() };
			this.images.set(id, image);
		}
		image.scopes.add(scopeKey(scope));
		const previous = image[variant];
		if (previous) {
			this.usedBytes -= previous.bytes.byteLength;
		} else {
			this.usedRecords += 1;
		}
		image[variant] = { bytes: binary.bytes, mimeType: binary.mimeType, lastUsed: ++this.clock };
		this.usedBytes += binary.bytes.byteLength;
		this.evict();
	}

	private evict(): void {
		while (this.usedBytes > this.maxBytes || this.usedRecords > this.maxRecords) {
			let oldest: { image: CachedImage; variant: "original" | "preview"; lastUsed: number } | undefined;
			for (const image of this.images.values()) {
				for (const variant of ["original", "preview"] as const) {
					const candidate = image[variant];
					if (candidate && (!oldest || candidate.lastUsed < oldest.lastUsed)) {
						oldest = { image, variant, lastUsed: candidate.lastUsed };
					}
				}
			}
			if (!oldest) break;
			const removed = oldest.image[oldest.variant]!;
			this.usedBytes -= removed.bytes.byteLength;
			this.usedRecords -= 1;
			delete oldest.image[oldest.variant];
			if (!oldest.image.original && !oldest.image.preview) this.images.delete(oldest.image.id);
		}
	}

	private deleteImage(image: CachedImage): void {
		for (const variant of [image.original, image.preview]) {
			if (!variant) continue;
			this.usedBytes -= variant.bytes.byteLength;
			this.usedRecords -= 1;
		}
		this.images.delete(image.id);
	}
}
