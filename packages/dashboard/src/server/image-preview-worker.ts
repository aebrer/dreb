import { parentPort } from "node:worker_threads";
import * as photon from "@silvia-odwyer/photon-node";
import { MAX_PREVIEW_BYTES, MAX_PREVIEW_HEIGHT, MAX_PREVIEW_WIDTH } from "./image-preview.js";

type PhotonImage = ReturnType<typeof photon.PhotonImage.new_from_byteslice>;

interface PreviewRequest {
	id: number;
	bytes: ArrayBuffer;
	mimeType: string;
}

function readExifOrientation(bytes: Uint8Array): number {
	let tiff = -1;
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
			const marker = bytes[offset + 1];
			const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
			if (marker === 0xe1 && offset + 10 <= bytes.length) {
				const start = offset + 4;
				if (String.fromCharCode(...bytes.slice(start, start + 6)) === "Exif\0\0") tiff = start + 6;
				break;
			}
			if (length < 2) break;
			offset += 2 + length;
		}
	} else if (
		bytes.length >= 12 &&
		String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
		String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
	) {
		let offset = 12;
		while (offset + 8 <= bytes.length) {
			const chunk = String.fromCharCode(...bytes.slice(offset, offset + 4));
			const size =
				bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
			const start = offset + 8;
			if (chunk === "EXIF") {
				tiff = String.fromCharCode(...bytes.slice(start, start + 6)) === "Exif\0\0" ? start + 6 : start;
				break;
			}
			offset = start + size + (size % 2);
		}
	}
	if (tiff < 0 || tiff + 8 > bytes.length) return 1;
	const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
	const read16 = (at: number) => (little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]);
	const read32 = (at: number) =>
		little
			? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
			: ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
	const ifd = tiff + read32(tiff + 4);
	if (ifd + 2 > bytes.length) return 1;
	const count = read16(ifd);
	for (let index = 0; index < count; index++) {
		const entry = ifd + 2 + index * 12;
		if (entry + 12 > bytes.length) break;
		if (read16(entry) === 0x0112) {
			const value = read16(entry + 8);
			return value >= 1 && value <= 8 ? value : 1;
		}
	}
	return 1;
}

function rotate(image: PhotonImage, clockwise: boolean): PhotonImage {
	const width = image.get_width();
	const height = image.get_height();
	const source = image.get_raw_pixels();
	const target = new Uint8Array(source.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const sourceIndex = (y * width + x) * 4;
			const destinationPixel = clockwise ? x * height + (height - 1 - y) : (width - 1 - x) * height + y;
			target.set(source.slice(sourceIndex, sourceIndex + 4), destinationPixel * 4);
		}
	}
	return new photon.PhotonImage(target, height, width);
}

function orient(image: PhotonImage, bytes: Uint8Array): PhotonImage {
	const orientation = readExifOrientation(bytes);
	if (orientation === 2) photon.fliph(image);
	else if (orientation === 3) {
		photon.fliph(image);
		photon.flipv(image);
	} else if (orientation === 4) photon.flipv(image);
	else if (orientation >= 5) {
		const rotated = rotate(image, orientation === 5 || orientation === 6);
		image.free();
		image = rotated;
		if (orientation === 5 || orientation === 7) photon.fliph(image);
	}
	return image;
}

export function generateImagePreview(bytes: Uint8Array): {
	bytes: Uint8Array;
	mimeType: "image/png" | "image/jpeg";
	width: number;
	height: number;
} {
	let image = photon.PhotonImage.new_from_byteslice(bytes);
	try {
		image = orient(image, bytes);
		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		if (originalWidth < 1 || originalHeight < 1) throw new Error("Image has invalid dimensions");
		const scale = Math.min(1, MAX_PREVIEW_WIDTH / originalWidth, MAX_PREVIEW_HEIGHT / originalHeight);
		let width = Math.max(1, Math.round(originalWidth * scale));
		let height = Math.max(1, Math.round(originalHeight * scale));
		while (true) {
			const resized = photon.resize(image, width, height, photon.SamplingFilter.Lanczos3);
			try {
				const candidates: Array<{ bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" }> = [
					{ bytes: resized.get_bytes(), mimeType: "image/png" },
					...([85, 70, 55, 40] as const).map((quality) => ({
						bytes: resized.get_bytes_jpeg(quality),
						mimeType: "image/jpeg" as const,
					})),
				];
				const acceptable = candidates.filter((candidate) => candidate.bytes.byteLength <= MAX_PREVIEW_BYTES);
				if (acceptable.length > 0) {
					acceptable.sort((left, right) => left.bytes.byteLength - right.bytes.byteLength);
					return { ...acceptable[0]!, width, height };
				}
			} finally {
				resized.free();
			}
			if (width === 1 && height === 1) break;
			width = Math.max(1, Math.floor(width * 0.75));
			height = Math.max(1, Math.floor(height * 0.75));
		}
		throw new Error("Could not encode image within the 256 KiB preview limit");
	} finally {
		image.free();
	}
}

const port = parentPort;
if (port) {
	port.on("message", (request: PreviewRequest) => {
		try {
			const preview = generateImagePreview(new Uint8Array(request.bytes));
			const transferable = Uint8Array.from(preview.bytes);
			port.postMessage({ id: request.id, ok: true, ...preview, bytes: transferable.buffer }, [transferable.buffer]);
		} catch (error) {
			port.postMessage({
				id: request.id,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}
