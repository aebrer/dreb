import { describe, expect, it } from "vitest";
import { ImagePreviewWorker } from "../src/server/image-preview.js";

describe("ImagePreviewWorker", () => {
	it("rejects every pending request when the worker exits non-zero", async () => {
		const worker = new ImagePreviewWorker(new URL("data:text/javascript,process.exit(7)"));
		const first = worker.generate(Uint8Array.of(1), "image/png");
		const second = worker.generate(Uint8Array.of(2), "image/jpeg");

		await Promise.all([
			expect(first).rejects.toThrow("Image preview worker exited with code 7"),
			expect(second).rejects.toThrow("Image preview worker exited with code 7"),
		]);
		await worker.close();
	});
});
