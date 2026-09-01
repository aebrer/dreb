/**
 * Cross-boundary round trip for the issue 495 image dedupe.
 *
 * The RPC child (dashboard mode) sends each unique image's base64 across stdout
 * exactly once per process lifetime; later occurrences are sent as
 * `image_reference` frames whose id is `sha256(mimeType + 0x00 + decodedBytes)`.
 * The dashboard server then projects those events into its own content-global
 * references. This test proves the composed pipeline keeps every reference
 * resolvable: a child-emitted reference always has its binary in the dashboard
 * image cache (cached from the earlier first-occurrence event), so the UI never
 * needs the slow authoritative reload path for in-flight images.
 *
 * The child-side projector is imported from coding-agent source (not the built
 * dist) so this test exercises the actual dedupe logic without depending on
 * build order.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDashboardRpcEventProjector } from "../../coding-agent/src/modes/rpc/rpc-event-projection.js";
import { DashboardImageService, dashboardImageId } from "../src/server/dashboard-images.js";
import type { GeneratedImagePreview, ImagePreviewGenerator } from "../src/server/image-preview.js";

class NoopPreviewGenerator implements ImagePreviewGenerator {
	async generate(): Promise<GeneratedImagePreview> {
		return { bytes: new Uint8Array([1]), mimeType: "image/png", width: 1, height: 1 };
	}
	async close(): Promise<void> {}
}

const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);
const GIF_BYTES = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

function imageBlock(bytes: Uint8Array, mimeType = "image/png") {
	return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType };
}

const scope = { runtimeKey: "rt" };

function childId(mimeType: string, bytes: Uint8Array): string {
	return createHash("sha256").update(mimeType).update(Uint8Array.of(0)).update(bytes).digest("hex");
}

type Ref = { type: "image_reference"; id: string; mimeType: string; size: number };

function refOf(value: unknown): Ref {
	if (Array.isArray(value)) throw new Error("expected a single reference");
	return value as Ref;
}

describe("issue 495 cross-boundary image dedupe round trip", () => {
	it("child-side references resolve from the dashboard cache without an authoritative load", async () => {
		const service = new DashboardImageService(new NoopPreviewGenerator());
		const projector = createDashboardRpcEventProjector();
		const pngId = childId("image/png", PNG_BYTES);
		const gifId = childId("image/gif", GIF_BYTES);

		// First occurrence: the child sends both images inline; the dashboard
		// caches both binaries.
		const first = projector({
			type: "message_end",
			message: { role: "user", content: [imageBlock(PNG_BYTES), imageBlock(GIF_BYTES, "image/gif")] },
		}) as { message: { content: unknown[] } };
		expect(first.message.content.map((b) => (b as { type: string }).type)).toEqual(["image", "image"]);
		service.projectEvent(first, scope);
		expect(service.byteSize).toBe(PNG_BYTES.length + GIF_BYTES.length);

		// Re-occurrence: the child sends references (ids derived from the image
		// bytes), and the dashboard passes them through untouched — its cache
		// already holds both binaries.
		const second = projector({
			type: "agent_end",
			messages: [{ role: "user", content: [imageBlock(PNG_BYTES), imageBlock(GIF_BYTES, "image/gif")] }],
		}) as { messages: Array<{ content: unknown[] }> };
		expect(second.messages[0]!.content).toEqual([
			{ type: "image_reference", id: pngId, mimeType: "image/png", size: PNG_BYTES.length },
			{ type: "image_reference", id: gifId, mimeType: "image/gif", size: GIF_BYTES.length },
		]);
		const projectedSecond = service.projectEvent(second, scope) as {
			messages: Array<{ content: unknown[] }>;
		};
		expect(refOf(projectedSecond.messages[0]!.content[0]!)).toEqual({
			type: "image_reference",
			id: pngId,
			mimeType: "image/png",
			size: PNG_BYTES.length,
		});
		expect(refOf(projectedSecond.messages[0]!.content[1]!)).toEqual({
			type: "image_reference",
			id: gifId,
			mimeType: "image/gif",
			size: GIF_BYTES.length,
		});
		// Still exactly one binary per unique image.
		expect(service.byteSize).toBe(PNG_BYTES.length + GIF_BYTES.length);

		// original() resolves straight from the cache — no transcript reload.
		const mustNotLoad = (): Promise<unknown> => {
			throw new Error("must not load the authoritative transcript");
		};
		const [png, gif] = await Promise.all([
			service.original(scope, pngId, mustNotLoad),
			service.original(scope, gifId, mustNotLoad),
		]);
		expect(png.bytes).toEqual(PNG_BYTES);
		expect(gif.bytes).toEqual(GIF_BYTES);
	});

	it("produces the same references as a fully inline stream", () => {
		const inlineService = new DashboardImageService(new NoopPreviewGenerator());
		const inline = inlineService.projectEvent(
			{ type: "message_end", message: { content: [imageBlock(PNG_BYTES), imageBlock(GIF_BYTES, "image/gif")] } },
			scope,
		) as { message: { content: unknown[] } };
		const inlineIds = inline.message.content.map((ref) => (ref as Ref).id);

		const projector = createDashboardRpcEventProjector();
		const dedupeService = new DashboardImageService(new NoopPreviewGenerator());
		const first = projector({
			type: "message_end",
			message: { content: [imageBlock(PNG_BYTES), imageBlock(GIF_BYTES, "image/gif")] },
		});
		const second = projector({ type: "agent_end", messages: [{ content: [imageBlock(PNG_BYTES)] }] });
		const dedupedFirst = dedupeService.projectEvent(first, scope) as { message: { content: unknown[] } };
		const dedupedSecond = dedupeService.projectEvent(second, scope) as {
			messages: Array<{ content: unknown[] }>;
		};

		const dedupedFirstIds = dedupedFirst.message.content.map((ref) => (ref as Ref).id);
		const dedupedSecondIds = dedupedSecond.messages[0]!.content.map((ref) => (ref as Ref).id);

		// Same ids as the inline path, in the same order — so any id the child
		// emitted is exactly the id the dashboard would have assigned.
		expect(dedupedFirstIds).toEqual(inlineIds);
		expect(dedupedSecondIds).toEqual([inlineIds[0]]);
	});

	it("never dangles: blocks the dashboard strict-decode rejects stay inline at every occurrence", () => {
		const service = new DashboardImageService(new NoopPreviewGenerator());
		const projector = createDashboardRpcEventProjector();
		// JPEG bytes labeled as PNG: the dashboard's strict decode rejects the
		// block (no PNG signature), so the child must not claim it either —
		// every occurrence stays inline and the dashboard drops each, exactly
		// as before the dedupe existed (no unresolvable reference, no 404).
		const jpegAsPng = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 0xff, 0xd9]);
		const block = imageBlock(jpegAsPng, "image/png");
		const first = projector({ type: "message_end", message: { content: [block] } }) as {
			message: { content: unknown[] };
		};
		expect(first.message.content[0]).toEqual(block); // inline, not a reference
		service.projectEvent(first, scope);
		expect(service.byteSize).toBe(0); // dashboard rejected it — nothing cached
		const second = projector({ type: "agent_end", messages: [{ content: [block] }] }) as {
			messages: Array<{ content: unknown[] }>;
		};
		expect(second.messages[0]!.content).toEqual([block]); // still inline — no dangling reference
		const projectedSecond = service.projectEvent(second, scope) as { messages: Array<{ content: unknown[] }> };
		expect(projectedSecond.messages[0]!.content).toEqual([]); // dropped, as pre-PR
	});

	it("child ids match the dashboard id formula (cross-process parity)", () => {
		// The child emits image_reference ids computed from the image bytes, and
		// the dashboard caches by dashboardImageId. For references to resolve
		// across the process boundary, both formulas must agree — pin the real
		// child projector's output against the dashboard's id function.
		const projector = createDashboardRpcEventProjector();
		projector({ type: "message_end", message: { content: [imageBlock(PNG_BYTES)] } });
		const second = projector({ type: "agent_end", messages: [{ content: [imageBlock(PNG_BYTES)] }] }) as {
			messages: Array<{ content: unknown[] }>;
		};
		expect(refOf(second.messages[0]!.content[0]!)).toEqual({
			type: "image_reference",
			id: dashboardImageId("image/png", PNG_BYTES),
			mimeType: "image/png",
			size: PNG_BYTES.length,
		});
	});
});
