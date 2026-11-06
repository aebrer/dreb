/**
 * Tests for image processing utilities using Photon.
 */

import { describe, expect, it, vi } from "vitest";
import { convertToPng } from "../src/utils/image-convert.js";
import { formatDimensionNote, resizeImage } from "../src/utils/image-resize.js";
import { loadPhoton, type PhotonImageType } from "../src/utils/photon.js";

type Photon = NonNullable<Awaited<ReturnType<typeof loadPhoton>>>;

async function getPhoton(): Promise<Photon> {
	const photon = await loadPhoton();
	if (!photon) throw new Error("Photon is required for image resize tests");
	return photon;
}

interface SyntheticImage {
	width: number;
	height: number;
	/**
	 * "photographic": smooth gradients with light noise, like a photo or rendered slide.
	 * "flat": a few solid color bands, like a diagram or screenshot.
	 */
	content: "photographic" | "flat";
	/** Make the left quarter fully transparent, stored as transparent black like most encoders do. */
	transparentRegion?: boolean;
	/** Make the left quarter half transparent (alpha 128), keeping its color, like a shadow or overlay. */
	translucentRegion?: boolean;
}

/** RGBA pixels from a seeded generator, so every run encodes identical fixtures. */
function synthesizePixels({
	width,
	height,
	content,
	transparentRegion,
	translucentRegion,
}: SyntheticImage): Uint8Array {
	const pixels = new Uint8Array(width * height * 4);
	let seed = 12345;
	const noise = () => {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		return (seed / 4294967296 - 0.5) * 2;
	};
	const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			if (transparentRegion && x < width / 4) continue; // stays (0, 0, 0, 0)
			if (content === "photographic") {
				const n = noise();
				pixels[i] = clamp(128 + 100 * Math.sin(x / 97) + n);
				pixels[i + 1] = clamp(128 + 100 * Math.cos(y / 71) + n);
				pixels[i + 2] = clamp(128 + 60 * Math.sin((x + y) / 53) + n);
			} else {
				const band = ((x >> 6) + (y >> 5)) % 3;
				pixels[i] = band === 0 ? 255 : 30;
				pixels[i + 1] = band === 1 ? 255 : 30;
				pixels[i + 2] = band === 2 ? 200 : 30;
			}
			pixels[i + 3] = translucentRegion && x < width / 4 ? 128 : 255;
		}
	}
	return pixels;
}

/** Base64 of a synthetic image encoded as PNG or as JPEG at quality 80. */
async function encodeSynthetic(spec: SyntheticImage, format: "png" | "jpeg"): Promise<string> {
	const photon = await getPhoton();
	const image = new photon.PhotonImage(synthesizePixels(spec), spec.width, spec.height);
	try {
		return Buffer.from(format === "png" ? image.get_bytes() : image.get_bytes_jpeg(80)).toString("base64");
	} finally {
		image.free();
	}
}

/** Base64 sizes of the encodings resizeImage compares, produced the same way it resizes. */
async function encodedSizesAt(
	data: string,
	width: number,
	height: number,
): Promise<{ png: number; jpeg: (quality: number) => number; dispose: () => void }> {
	const photon = await getPhoton();
	const source = photon.PhotonImage.new_from_byteslice(new Uint8Array(Buffer.from(data, "base64")));
	const resized = photon.resize(source, width, height, photon.SamplingFilter.Lanczos3);
	source.free();
	const base64Size = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").length;
	return {
		png: base64Size(resized.get_bytes()),
		jpeg: (quality) => base64Size(resized.get_bytes_jpeg(quality)),
		dispose: () => resized.free(),
	};
}

/** RGBA of one pixel of a base64-encoded image. */
async function pixelAt(data: string, x: number, y: number): Promise<number[]> {
	const photon = await getPhoton();
	const image = photon.PhotonImage.new_from_byteslice(new Uint8Array(Buffer.from(data, "base64")));
	try {
		const i = (y * image.get_width() + x) * 4;
		return Array.from(image.get_raw_pixels().slice(i, i + 4));
	} finally {
		image.free();
	}
}

const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

// Small 2x2 red PNG image (base64) - generated with ImageMagick
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

// Small 2x2 blue JPEG image (base64) - generated with ImageMagick
const TINY_JPEG =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VTB3/2Q==";

// 100x100 gray PNG
const MEDIUM_PNG_100x100 =
	"iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAAAAABVicqIAAAAAmJLR0QA/4ePzL8AAAAHdElNRQfqAQ4AMzkN2iH/AAAAP0lEQVRo3u3NQQEAAAQEMASXXYrz2gqst/Lm4ZBIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiSTsAP1cAUZeKtreAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAw6crMeAAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMJiXdMQAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDDPglUbAAAAAElFTkSuQmCC";

// 200x200 colored PNG
const LARGE_PNG_200x200 =
	"iVBORw0KGgoAAAANSUhEUgAAAMgAAADIEAIAAAByquWKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRP///////wlY99wAAAAHdElNRQfqAQ4AMzqU03BFAAAEEElEQVR42u3dvWqUURSF4XXMRAyIhSAWQvwnWtjaWusFx9bW1kKD/wELESxEiBjDjJdwysOC57mCXW32+zGcGbtdACpsdi+T8Xz1GABzm91xMl6sHgNgblzcT/Y+rh4DYG6cv0/2H64eA2BOEgI1fHQHaoyzbXIwVo8BMCcJgRqSEKgxft9Lrn5aPQbA3Ph1klw7Wj0GwJwkBGpYWECN8fMiub63egyAORcWUMPCAmqMH3eTG59XjwEwN76/S24+Wj0GwJwkBGpYWECN8e1fcmuzegyAORcWUMPCAmqM09vJ4dfVYwDMjS9vkzuPV48BMCcJgRqeSAZqjA/nyYP91WMAzElCoIYkBGqMk8Pk6HT1GABzm+3L5JIkBApIQqCGj+5AjfHmb/Lk8uoxAOYkIVBDEgI1LCygxmZ7nFyShEABFxZQw8ICaozXf5KnV1aPATDnwgJqWFhADQsLqOFnDUANFxZQw8ICaoxXZ8mzg9VjAMy5sIAaFhZQw3tYQA1/QgHUkIRADUkI1JCEQA1JCNSQhEANFxZQwzcsoIYkBGpIQqCGJARqSEKghiQEalhYQA1/QgHUcGEBNSwsoIYkBGq4sIAaFhZQw8ICaviGBdRwYQE1LCyghiQEariwgBoWFlDDe1hADS+OAjUkIVBDEgI1JCFQQxICNSQhUMOFBdTwDQuoIQmBGpIQqCEJgRqSEKghCYEaFhZQw4ujQA0XFlDDwgJqSEKghgsLqGFhATUsLKCGb1hADRcWUMPCAmpIQqCGCwuoYWEBNbyHBdTw4ihQQxICNSQhUEMSAjUkIVBDEgI1XFhADd+wgBqSEKghCYEakhCoIQmBGpIQqGFhATW8OArUcGEBNSwsoIYkBGq4sIAaFhZQw8ICaviGBdRwYQE1LCyghiQEariwgBoWFlDDe1hADS+OAjUkIVBDEgI1JCFQQxICNSQhUMOFBdTwDQuoIQmBGpIQqCEJgRqSEKghCYEa49lB8ups9RgAc14cBWpIQqCGhQXUkIRADRcWUMPCAmqMp1eS139WjwEw5xsWUEMSAjUsLKCGJARquLCAGhYWUGM8uZy8+bt6DIA5L44CNSQhUMMTyUCNcXSanByuHgNgThICNSQhUGM82E8+nK8eA2DOzxqAGpIQqDHuPE6+vF09BsDcOPyanN5ePQbAnCQEavgdFlBj3Nok3/6tHgNgzoujQA1JCNQYNx8l39+tHgNgbtz4nPy4u3oMgDlJCNSwsIAa4/pe8vNi9RgAc37WANSQhECNce0o+XWyegyAuXH1U/L73uoxAOYkIVDDwgJqjIORnG1XjwEw508ogBqSEKgx9h8m5+9XjwEwN/Y+Jhf3V48BMCcJgRpjPE+2x6vHAJgbSbLbrR4DYO4/GqiSgXN+ksgAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDDpysx4AAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwmJd0xAAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMM+CVRsAAAAASUVORK5CYII=";

describe("convertToPng", () => {
	it("should return original data for PNG input", async () => {
		const result = await convertToPng(TINY_PNG, "image/png");
		expect(result).not.toBeNull();
		expect(result!.data).toBe(TINY_PNG);
		expect(result!.mimeType).toBe("image/png");
	});

	it("should convert JPEG to PNG", async () => {
		const result = await convertToPng(TINY_JPEG, "image/jpeg");
		expect(result).not.toBeNull();
		expect(result!.mimeType).toBe("image/png");
		// Result should be valid base64
		expect(() => Buffer.from(result!.data, "base64")).not.toThrow();
		// PNG magic bytes
		const buffer = Buffer.from(result!.data, "base64");
		expect(buffer[0]).toBe(0x89);
		expect(buffer[1]).toBe(0x50); // 'P'
		expect(buffer[2]).toBe(0x4e); // 'N'
		expect(buffer[3]).toBe(0x47); // 'G'
	});
});

describe("resizeImage", () => {
	it("should return original image if within limits", async () => {
		const result = await resizeImage(
			{ type: "image", data: TINY_PNG, mimeType: "image/png" },
			{ maxWidth: 100, maxHeight: 100, maxBytes: 1024 * 1024 },
		);

		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(false);
		expect(result!.data).toBe(TINY_PNG);
		expect(result!.originalWidth).toBe(2);
		expect(result!.originalHeight).toBe(2);
		expect(result!.width).toBe(2);
		expect(result!.height).toBe(2);
	});

	it("should resize image exceeding dimension limits", async () => {
		const result = await resizeImage(
			{ type: "image", data: MEDIUM_PNG_100x100, mimeType: "image/png" },
			{ maxWidth: 50, maxHeight: 50, maxBytes: 1024 * 1024 },
		);

		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(true);
		expect(result!.originalWidth).toBe(100);
		expect(result!.originalHeight).toBe(100);
		expect(result!.width).toBeLessThanOrEqual(50);
		expect(result!.height).toBeLessThanOrEqual(50);
	});

	it("should resize image exceeding byte limit", async () => {
		const originalBuffer = Buffer.from(LARGE_PNG_200x200, "base64");
		const originalSize = originalBuffer.length;

		// Set maxBytes to less than the original encoded image size
		const result = await resizeImage(
			{ type: "image", data: LARGE_PNG_200x200, mimeType: "image/png" },
			{ maxWidth: 2000, maxHeight: 2000, maxBytes: Math.floor(LARGE_PNG_200x200.length * 0.9) },
		);

		// Should have tried to reduce size
		expect(result).not.toBeNull();
		const resultBuffer = Buffer.from(result!.data, "base64");
		expect(resultBuffer.length).toBeLessThan(originalSize);
		expect(result!.data.length).toBeLessThan(LARGE_PNG_200x200.length);
	});

	it("should return null when image cannot be resized below maxBytes", async () => {
		const result = await resizeImage(
			{ type: "image", data: LARGE_PNG_200x200, mimeType: "image/png" },
			{ maxWidth: 2000, maxHeight: 2000, maxBytes: 1 },
		);

		expect(result).toBeNull();
	});

	it("should handle JPEG input", async () => {
		const result = await resizeImage(
			{ type: "image", data: TINY_JPEG, mimeType: "image/jpeg" },
			{ maxWidth: 100, maxHeight: 100, maxBytes: 1024 * 1024 },
		);

		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(false);
		expect(result!.originalWidth).toBe(2);
		expect(result!.originalHeight).toBe(2);
	});

	describe("output format", () => {
		it("returns a photographic JPEG just over the default size limit as a JPEG of about its original size", async () => {
			// A 2001x1125 render: one pixel over the 2000 px default, so it must be resized.
			const input = await encodeSynthetic({ width: 2001, height: 1125, content: "photographic" }, "jpeg");
			const sizes = await encodedSizesAt(input, 2000, 1124);
			const pngSize = sizes.png;
			sizes.dispose();
			// The PNG fits under the limit, so returning the first fitting encoding picks it.
			expect(pngSize).toBeLessThan(DEFAULT_MAX_BYTES);

			const result = await resizeImage({ type: "image", data: input, mimeType: "image/jpeg" });

			expect(result).not.toBeNull();
			expect(result!.mimeType).toBe("image/jpeg");
			expect(result!.wasResized).toBe(true);
			expect([result!.width, result!.height]).toEqual([2000, 1124]);
			expect(result!.data.length).toBeLessThan(input.length * 1.25);
			expect(result!.data.length * 4).toBeLessThan(pngSize);
		});

		it("keeps PNG for a flat graphic where PNG is smaller", async () => {
			const input = await encodeSynthetic({ width: 801, height: 450, content: "flat" }, "png");
			const sizes = await encodedSizesAt(input, 800, 449);
			const [pngSize, jpegSize] = [sizes.png, sizes.jpeg(80)];
			sizes.dispose();
			expect(pngSize).toBeLessThan(jpegSize);

			const result = await resizeImage(
				{ type: "image", data: input, mimeType: "image/png" },
				{ maxWidth: 800, maxHeight: 800 },
			);

			expect(result).not.toBeNull();
			expect(result!.mimeType).toBe("image/png");
			expect([result!.width, result!.height]).toEqual([800, 449]);
			expect(result!.data.length).toBe(pngSize);
		});

		it("keeps PNG for a transparent image whose JPEG would be smaller, preserving the transparency", async () => {
			const input = await encodeSynthetic(
				{ width: 801, height: 450, content: "photographic", transparentRegion: true },
				"png",
			);
			const sizes = await encodedSizesAt(input, 800, 449);
			const [pngSize, jpegSize] = [sizes.png, sizes.jpeg(80)];
			sizes.dispose();
			expect(jpegSize).toBeLessThan(pngSize);

			const result = await resizeImage(
				{ type: "image", data: input, mimeType: "image/png" },
				{ maxWidth: 800, maxHeight: 800 },
			);

			expect(result).not.toBeNull();
			expect(result!.mimeType).toBe("image/png");
			expect((await pixelAt(result!.data, 10, 200))[3]).toBe(0);
		});

		it("keeps PNG for a partly transparent image whose JPEG would be smaller", async () => {
			const input = await encodeSynthetic(
				{ width: 801, height: 450, content: "photographic", translucentRegion: true },
				"png",
			);
			const sizes = await encodedSizesAt(input, 800, 449);
			const [pngSize, jpegSize] = [sizes.png, sizes.jpeg(80)];
			sizes.dispose();
			expect(jpegSize).toBeLessThan(pngSize);

			const result = await resizeImage(
				{ type: "image", data: input, mimeType: "image/png" },
				{ maxWidth: 800, maxHeight: 800 },
			);

			expect(result).not.toBeNull();
			expect(result!.mimeType).toBe("image/png");
			const alpha = (await pixelAt(result!.data, 10, 200))[3];
			expect(alpha).toBeGreaterThan(0);
			expect(alpha).toBeLessThan(255);
		});

		it("checks transparency on the resized pixels, never copying the full-size source", async () => {
			// Copying the source raster out of WASM costs memory proportional to the input, which
			// is unbounded; the resized raster is bounded by maxWidth x maxHeight.
			const input = await encodeSynthetic({ width: 1601, height: 900, content: "flat" }, "png");
			const photon = await getPhoton();
			const getRawPixels = photon.PhotonImage.prototype.get_raw_pixels;
			const scanned: string[] = [];
			const spy = vi.spyOn(photon.PhotonImage.prototype, "get_raw_pixels").mockImplementation(function (
				this: PhotonImageType,
			) {
				scanned.push(`${this.get_width()}x${this.get_height()}`);
				return getRawPixels.call(this);
			});
			try {
				const result = await resizeImage(
					{ type: "image", data: input, mimeType: "image/png" },
					{ maxWidth: 800, maxHeight: 800 },
				);

				expect(result).not.toBeNull();
				expect([result!.width, result!.height]).toEqual([800, 450]);
			} finally {
				spy.mockRestore();
			}
			expect(scanned).toEqual(["800x450"]);
		});

		it("still falls back to JPEG for a transparent image whose PNG does not fit", async () => {
			const input = await encodeSynthetic(
				{ width: 801, height: 450, content: "photographic", transparentRegion: true },
				"png",
			);
			const sizes = await encodedSizesAt(input, 800, 449);
			const [pngSize, jpegSize] = [sizes.png, sizes.jpeg(80)];
			sizes.dispose();
			const maxBytes = Math.floor((pngSize + jpegSize) / 2);

			const result = await resizeImage(
				{ type: "image", data: input, mimeType: "image/png" },
				{ maxWidth: 800, maxHeight: 800, maxBytes },
			);

			expect(result).not.toBeNull();
			expect(result!.mimeType).toBe("image/jpeg");
			expect([result!.width, result!.height]).toEqual([800, 449]);
			expect(result!.data.length).toBe(jpegSize);
		});

		it("lowers JPEG quality before dimensions when neither PNG nor JPEG at the configured quality fits", async () => {
			const input = await encodeSynthetic({ width: 400, height: 300, content: "photographic" }, "png");
			const sizes = await encodedSizesAt(input, 400, 300);
			const [pngSize, configuredJpegSize, lowestJpegSize] = [sizes.png, sizes.jpeg(80), sizes.jpeg(40)];
			sizes.dispose();
			const maxBytes = Math.floor((configuredJpegSize + lowestJpegSize) / 2);
			expect(maxBytes).toBeLessThan(Math.min(pngSize, configuredJpegSize));

			const result = await resizeImage({ type: "image", data: input, mimeType: "image/png" }, { maxBytes });

			expect(result).not.toBeNull();
			expect(result!.mimeType).toBe("image/jpeg");
			expect([result!.width, result!.height]).toEqual([400, 300]);
			expect(result!.data.length).toBeLessThan(maxBytes);
		});
	});
});

describe("formatDimensionNote", () => {
	it("should return undefined for non-resized images", () => {
		const note = formatDimensionNote({
			data: "",
			mimeType: "image/png",
			originalWidth: 100,
			originalHeight: 100,
			width: 100,
			height: 100,
			wasResized: false,
		});
		expect(note).toBeUndefined();
	});

	it("should return formatted note for resized images", () => {
		const note = formatDimensionNote({
			data: "",
			mimeType: "image/png",
			originalWidth: 2000,
			originalHeight: 1000,
			width: 1000,
			height: 500,
			wasResized: true,
		});
		expect(note).toContain("original 2000x1000");
		expect(note).toContain("displayed at 1000x500");
		expect(note).toContain("2.00"); // scale factor
	});
});
