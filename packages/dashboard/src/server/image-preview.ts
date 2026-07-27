import { Worker } from "node:worker_threads";

export const MAX_PREVIEW_WIDTH = 1024;
export const MAX_PREVIEW_HEIGHT = 1024;
export const MAX_PREVIEW_BYTES = 256 * 1024;

export interface GeneratedImagePreview {
	bytes: Uint8Array;
	mimeType: "image/png" | "image/jpeg";
	width: number;
	height: number;
}

export interface ImagePreviewGenerator {
	generate(bytes: Uint8Array, mimeType: string): Promise<GeneratedImagePreview>;
	close(): Promise<void>;
}

interface WorkerSuccess {
	id: number;
	ok: true;
	bytes: ArrayBuffer;
	mimeType: "image/png" | "image/jpeg";
	width: number;
	height: number;
}

interface WorkerFailure {
	id: number;
	ok: false;
	error: string;
}

type WorkerReply = WorkerSuccess | WorkerFailure;

/** One worker keeps Photon decode/resize work off the ordered SSE path. */
export class ImagePreviewWorker implements ImagePreviewGenerator {
	private worker: Worker | undefined;
	private nextId = 1;
	private closed = false;
	private readonly pending = new Map<
		number,
		{ resolve: (preview: GeneratedImagePreview) => void; reject: (error: Error) => void }
	>();

	constructor(
		/** Injectable worker URL keeps abnormal-exit handling deterministic in tests. */
		private readonly workerUrl = new URL("./image-preview-worker.js", import.meta.url),
	) {}

	async generate(bytes: Uint8Array, mimeType: string): Promise<GeneratedImagePreview> {
		if (this.closed) throw new Error("Image preview worker is closed");
		const worker = this.getWorker();
		const id = this.nextId++;
		// Do not detach repository-owned storage when transferring to the worker.
		const copy = Uint8Array.from(bytes);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			worker.postMessage({ id, bytes: copy.buffer, mimeType }, [copy.buffer]);
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) pending.reject(new Error("Image preview worker closed"));
		this.pending.clear();
		const worker = this.worker;
		this.worker = undefined;
		if (worker) await worker.terminate();
	}

	private getWorker(): Worker {
		if (this.worker) return this.worker;
		const worker = new Worker(this.workerUrl);
		worker.on("message", (reply: WorkerReply) => {
			const pending = this.pending.get(reply.id);
			if (!pending) return;
			this.pending.delete(reply.id);
			if (!reply.ok) {
				pending.reject(new Error(reply.error));
				return;
			}
			pending.resolve({
				bytes: new Uint8Array(reply.bytes),
				mimeType: reply.mimeType,
				width: reply.width,
				height: reply.height,
			});
		});
		const fail = (error: Error) => {
			for (const pending of this.pending.values()) pending.reject(error);
			this.pending.clear();
			this.worker = undefined;
		};
		worker.on("error", fail);
		worker.on("exit", (code) => {
			if (!this.closed && code !== 0) fail(new Error(`Image preview worker exited with code ${code}`));
		});
		this.worker = worker;
		return worker;
	}
}
