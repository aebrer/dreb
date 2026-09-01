import * as photon from "@silvia-odwyer/photon-node";
import { describe, expect, it } from "vitest";
import {
	DashboardImageNotFoundError,
	DashboardImagePreviewError,
	DashboardImageService,
	dashboardImageId,
	decodeDashboardImage,
} from "../src/server/dashboard-images.js";
import type { GeneratedImagePreview, ImagePreviewGenerator } from "../src/server/image-preview.js";
import { generateImagePreview } from "../src/server/image-preview-worker.js";

const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);
const GIF_BYTES = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

function jpegWithTrailingMetadata(): Buffer {
	const source = new photon.PhotonImage(Uint8Array.of(255, 0, 0, 255), 1, 1);
	try {
		return Buffer.concat([Buffer.from(source.get_bytes_jpeg(90)), Buffer.from("phone auxiliary metadata")]);
	} finally {
		source.free();
	}
}

const imageBlock = (bytes: Uint8Array = PNG_BYTES, mimeType = "image/png") => ({
	type: "image",
	data: Buffer.from(bytes).toString("base64"),
	mimeType,
});

class FakePreviewGenerator implements ImagePreviewGenerator {
	calls = 0;
	closed = false;
	constructor(private readonly implementation?: (bytes: Uint8Array) => Promise<GeneratedImagePreview>) {}
	async generate(bytes: Uint8Array): Promise<GeneratedImagePreview> {
		this.calls += 1;
		if (this.implementation) return this.implementation(bytes);
		return { bytes: Uint8Array.of(1, 2, 3), mimeType: "image/png", width: 1, height: 1 };
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

const scope = { runtimeKey: "runtime" };

describe("dashboard image projection and repository", () => {
	it("strictly validates base64, MIME allowlisting, and raster signatures", () => {
		expect(decodeDashboardImage(PNG_BYTES.toString("base64"), "image/png")?.bytes).toEqual(PNG_BYTES);
		expect(decodeDashboardImage(` ${PNG_BYTES.toString("base64")}`, "image/png")).toBeUndefined();
		expect(decodeDashboardImage(PNG_BYTES.toString("base64").replace(/=$/, ""), "image/png")).toBeUndefined();
		expect(decodeDashboardImage(PNG_BYTES.toString("base64"), "image/jpeg")).toBeUndefined();
		expect(decodeDashboardImage(PNG_BYTES.toString("base64"), "image/svg+xml")).toBeUndefined();
		expect(decodeDashboardImage("AAAA", "image/png")).toBeUndefined();
		expect(
			decodeDashboardImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2]).toString("base64"), "image/jpeg"),
		).toBeUndefined();
	});

	it("projects phone JPEG uploads that retain auxiliary bytes after EOI", async () => {
		const service = new DashboardImageService(new FakePreviewGenerator());
		const jpeg = jpegWithTrailingMetadata();
		const projected = service.projectEvent(
			{
				type: "message_start",
				message: {
					role: "user",
					content: [{ type: "text", text: "describe this" }, imageBlock(jpeg, "image/jpeg")],
				},
			},
			scope,
		) as {
			message: { content: Array<{ type: string; id?: string; mimeType?: string; size?: number }> };
		};
		const reference = projected.message.content[1];

		expect(reference).toMatchObject({ type: "image_reference", mimeType: "image/jpeg", size: jpeg.length });
		expect(reference?.id).toMatch(/^[0-9a-f]{64}$/);
		const original = await service.original(scope, reference!.id!, async () => []);
		expect(original.bytes).toEqual(jpeg);
		expect(generateImagePreview(jpeg)).toMatchObject({ width: 1, height: 1 });
	});

	it("uses exact MIME and decoded bytes for stable content IDs", () => {
		const id = dashboardImageId("image/png", PNG_BYTES);
		expect(id).toMatch(/^[0-9a-f]{64}$/);
		expect(dashboardImageId("image/png", PNG_BYTES)).toBe(id);
		expect(dashboardImageId("image/jpeg", PNG_BYTES)).not.toBe(id);
		expect(dashboardImageId("image/png", Buffer.concat([PNG_BYTES, Buffer.of(0)]))).not.toBe(id);
	});

	it("projects recursively without mutating authoritative events and deduplicates duplicate copies", () => {
		const previews = new FakePreviewGenerator();
		const service = new DashboardImageService(previews);
		const source = {
			type: "background_agent_event",
			agentId: "child",
			event: {
				type: "tool_execution_end",
				result: { content: [{ type: "text", text: "note" }, imageBlock(), imageBlock()] },
			},
		};
		const projected = service.projectEvent(source, scope);
		const serialized = JSON.stringify(projected);
		expect(serialized).toContain('"type":"image_reference"');
		expect(serialized).not.toContain(PNG_BYTES.toString("base64"));
		expect(source.event.result.content[1]).toHaveProperty("data");
		expect(service.recordCount).toBe(1);
		expect(service.byteSize).toBe(PNG_BYTES.byteLength);
	});

	it("drops malformed image blocks and malformed pre-existing references", () => {
		const service = new DashboardImageService(new FakePreviewGenerator());
		const projected = service.project(
			[
				{ type: "text", text: "kept" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "image_reference", id: "bad", mimeType: "image/png", size: 1 },
			],
			scope,
		);
		expect(projected).toEqual([{ type: "text", text: "kept" }]);
	});

	it("enforces byte and record LRU bounds", () => {
		const service = new DashboardImageService(new FakePreviewGenerator(), {
			maxBytes: PNG_BYTES.length,
			maxRecords: 1,
		});
		service.project([imageBlock()], scope);
		const second = Buffer.from(PNG_BYTES);
		second[second.length - 1] ^= 1;
		service.project([imageBlock(second)], scope);
		expect(service.byteSize).toBeLessThanOrEqual(PNG_BYTES.length);
		expect(service.recordCount).toBeLessThanOrEqual(1);
	});

	it("recovers an evicted or restart-empty original only from the requested authoritative scope", async () => {
		const service = new DashboardImageService(new FakePreviewGenerator(), { maxBytes: 0, maxRecords: 0 });
		const projected = service.project<unknown[]>([imageBlock()], scope) as Array<{ id: string }>;
		const id = projected[0]!.id;
		expect(service.recordCount).toBe(0);
		const recovered = await service.original(scope, id, async () => [imageBlock()]);
		expect(recovered.bytes).toEqual(PNG_BYTES);
		await expect(service.original({ runtimeKey: "other" }, id, async () => [])).rejects.toBeInstanceOf(
			DashboardImageNotFoundError,
		);
	});

	it("revokes runtime scopes and releases unshared entries", async () => {
		const service = new DashboardImageService(new FakePreviewGenerator());
		const projected = service.project<unknown[]>([imageBlock()], scope) as Array<{ id: string }>;
		const id = projected[0]!.id;
		service.removeRuntime(scope.runtimeKey);
		expect(service.recordCount).toBe(0);
		await expect(service.original(scope, id, async () => [])).rejects.toBeInstanceOf(DashboardImageNotFoundError);
	});

	it("single-flights concurrent original() recovery for the same scope and id (issue 495)", async () => {
		const service = new DashboardImageService(new FakePreviewGenerator());
		const id = dashboardImageId("image/png", PNG_BYTES);
		let loadCalls = 0;
		let release!: (source: unknown) => void;
		const loadAuthoritative = (): Promise<unknown> =>
			new Promise((resolve) => {
				loadCalls += 1;
				release = resolve;
			});

		const first = service.original(scope, id, loadAuthoritative);
		const second = service.original(scope, id, loadAuthoritative);
		expect(loadCalls).toBe(1);

		release([imageBlock()]);
		const [a, b] = await Promise.all([first, second]);
		expect(loadCalls).toBe(1);
		expect(a.bytes).toEqual(PNG_BYTES);
		expect(b.bytes).toEqual(PNG_BYTES);
	});

	it("does not share original() recovery across scopes", async () => {
		const service = new DashboardImageService(new FakePreviewGenerator());
		const id = dashboardImageId("image/png", PNG_BYTES);
		let loadCalls = 0;
		const loadAuthoritative = async (): Promise<unknown> => {
			loadCalls += 1;
			return [imageBlock()];
		};

		await Promise.all([
			service.original(scope, id, loadAuthoritative),
			service.original({ runtimeKey: "other" }, id, loadAuthoritative),
		]);
		expect(loadCalls).toBe(2);
	});

	it("clears the original flight on rejection so the next request reloads", async () => {
		const service = new DashboardImageService(new FakePreviewGenerator());
		const id = dashboardImageId("image/png", PNG_BYTES);
		let transcript: unknown[] = [];
		const loadAuthoritative = async (): Promise<unknown> => transcript;

		await expect(service.original(scope, id, loadAuthoritative)).rejects.toBeInstanceOf(DashboardImageNotFoundError);
		transcript = [imageBlock()];
		const recovered = await service.original(scope, id, loadAuthoritative);
		expect(recovered.bytes).toEqual(PNG_BYTES);
	});

	it("generates previews lazily, single-flights concurrent requests, and caches the bounded result", async () => {
		let resolve!: (preview: GeneratedImagePreview) => void;
		const delayed = new Promise<GeneratedImagePreview>((done) => {
			resolve = done;
		});
		const generator = new FakePreviewGenerator(async () => delayed);
		const service = new DashboardImageService(generator);
		const projected = service.project<unknown[]>([imageBlock(GIF_BYTES, "image/gif")], scope) as Array<{
			id: string;
		}>;
		const id = projected[0]!.id;
		expect(generator.calls).toBe(0);
		const first = service.preview(scope, id, async () => []);
		const second = service.preview(scope, id, async () => []);
		await Promise.resolve();
		expect(generator.calls).toBe(1);
		resolve({ bytes: Uint8Array.of(1, 2), mimeType: "image/png", width: 1, height: 1 });
		expect(await first).toEqual(await second);
		expect((await service.preview(scope, id, async () => [])).mimeType).toBe("image/png");
		expect(generator.calls).toBe(1);
	});

	it("does not let another scope piggyback a guessed ID onto an in-flight preview", async () => {
		let resolve!: (preview: GeneratedImagePreview) => void;
		const delayed = new Promise<GeneratedImagePreview>((done) => {
			resolve = done;
		});
		const service = new DashboardImageService(new FakePreviewGenerator(async () => delayed));
		const projected = service.project<unknown[]>([imageBlock()], scope) as Array<{ id: string }>;
		const authorized = service.preview(scope, projected[0]!.id, async () => []);
		await expect(service.preview({ runtimeKey: "other" }, projected[0]!.id, async () => [])).rejects.toBeInstanceOf(
			DashboardImageNotFoundError,
		);
		resolve({ bytes: Uint8Array.of(1), mimeType: "image/png", width: 1, height: 1 });
		await authorized;
	});

	it("surfaces worker failures explicitly and closes the injected worker", async () => {
		const generator = new FakePreviewGenerator(async () => {
			throw new Error("photon exploded");
		});
		const service = new DashboardImageService(generator);
		const projected = service.project<unknown[]>([imageBlock()], scope) as Array<{ id: string }>;
		const failure = service.preview(scope, projected[0]!.id, async () => []);
		await expect(failure).rejects.toBeInstanceOf(DashboardImagePreviewError);
		await expect(failure).rejects.toThrow("photon exploded");
		await service.close();
		expect(generator.closed).toBe(true);
	});

	it("preserves exact animated GIF originals while preview results are static PNG/JPEG resources", async () => {
		const service = new DashboardImageService(new FakePreviewGenerator());
		const projected = service.project<unknown[]>([imageBlock(GIF_BYTES, "image/gif")], scope) as Array<{
			id: string;
		}>;
		const original = await service.original(scope, projected[0]!.id, async () => []);
		const preview = await service.preview(scope, projected[0]!.id, async () => []);
		expect(original.mimeType).toBe("image/gif");
		expect(original.bytes).toEqual(GIF_BYTES);
		expect(["image/png", "image/jpeg"]).toContain(preview.mimeType);
		expect(preview.bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
	});

	it("Photon preview encoding enforces dimensions and binary byte ceilings", () => {
		const width = 1200;
		const height = 800;
		const pixels = new Uint8Array(width * height * 4);
		for (let index = 0; index < pixels.length; index += 4) {
			pixels[index] = (index * 17) % 251;
			pixels[index + 1] = (index * 31) % 253;
			pixels[index + 2] = (index * 47) % 255;
			pixels[index + 3] = 255;
		}
		const source = new photon.PhotonImage(pixels, width, height);
		const encoded = source.get_bytes();
		source.free();
		const preview = generateImagePreview(encoded);
		expect(preview.width).toBeLessThanOrEqual(1024);
		expect(preview.height).toBeLessThanOrEqual(1024);
		expect(preview.bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
		expect(["image/png", "image/jpeg"]).toContain(preview.mimeType);
	});

	it("Photon applies EXIF orientation before bounding the preview", () => {
		const source = new photon.PhotonImage(Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]), 2, 1);
		const jpeg = source.get_bytes_jpeg(90);
		source.free();
		const exifPayload = Buffer.from([
			0x45,
			0x78,
			0x69,
			0x66,
			0,
			0, // Exif header
			0x49,
			0x49,
			0x2a,
			0,
			8,
			0,
			0,
			0, // little-endian TIFF + IFD offset
			1,
			0, // one IFD entry
			0x12,
			0x01,
			3,
			0,
			1,
			0,
			0,
			0,
			6,
			0,
			0,
			0, // orientation = 6
			0,
			0,
			0,
			0, // no next IFD
		]);
		const marker = Buffer.alloc(4);
		marker[0] = 0xff;
		marker[1] = 0xe1;
		marker.writeUInt16BE(exifPayload.length + 2, 2);
		const oriented = Buffer.concat([
			Buffer.from(jpeg.subarray(0, 2)),
			marker,
			exifPayload,
			Buffer.from(jpeg.subarray(2)),
		]);
		const preview = generateImagePreview(oriented);
		expect({ width: preview.width, height: preview.height }).toEqual({ width: 1, height: 2 });
	});

	it("Photon turns GIF input into a static PNG/JPEG preview", () => {
		const preview = generateImagePreview(GIF_BYTES);
		expect(["image/png", "image/jpeg"]).toContain(preview.mimeType);
		expect(preview.bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
	});
});
