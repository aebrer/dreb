interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

// ---------------------------------------------------------------------------
// Backpressure-aware bounded write queue
//
// stream.write() returns false when the stream's internal buffer is full
// (backpressure). Ignoring that signal during high-rate event streaming lets
// output queue up unboundedly inside the process, which is what produced the
// multi-thousand-event end-of-response bursts in issue 448. While the stream
// is backpressured we queue subsequent writes and flush them in order on
// "drain". The queue is byte-capped: a consumer that stalls beyond the cap
// means this process's primary output channel is dead or hopelessly behind,
// so we fail loudly instead of growing memory without bound.
// ---------------------------------------------------------------------------

/** Maximum bytes allowed to queue behind a backpressured stdout before aborting. */
export const MAX_QUEUED_STDOUT_BYTES = 16 * 1024 * 1024; // 16 MiB

const FATAL_DIAGNOSTIC_FLUSH_TIMEOUT_MS = 1_000;

const stdoutQueue: string[] = [];
let stdoutQueuedBytes = 0;
let stdoutBackpressured = false;
let stdoutDrainListening = false;
let stdoutDrainWaiters: Array<() => void> = [];

function writeToStdout(text: string): boolean {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite(text);
	}
	return process.stdout.write(text);
}

function requestDrainFlush(): void {
	if (stdoutDrainListening) return;
	stdoutDrainListening = true;
	process.stdout.once("drain", () => {
		stdoutDrainListening = false;
		flushStdoutQueue();
	});
}

function flushStdoutQueue(): void {
	stdoutBackpressured = false;
	while (stdoutQueue.length > 0) {
		const next = stdoutQueue.shift() as string;
		stdoutQueuedBytes -= Buffer.byteLength(next);
		// A false return means the stream accepted the chunk but its buffer is
		// full again — stop writing and wait for the next drain.
		if (!writeToStdout(next)) {
			stdoutBackpressured = true;
			requestDrainFlush();
			return;
		}
	}
	if (stdoutDrainWaiters.length > 0) {
		const waiters = stdoutDrainWaiters;
		stdoutDrainWaiters = [];
		for (const resolve of waiters) resolve();
	}
}

function enqueueStdout(text: string): void {
	const bytes = Buffer.byteLength(text);
	if (stdoutQueuedBytes + bytes > MAX_QUEUED_STDOUT_BYTES) {
		const diagnostic =
			`Fatal: stdout write queue exceeded ${MAX_QUEUED_STDOUT_BYTES} bytes while the stream was ` +
			"backpressured. The consumer of this process's stdout is not reading; refusing " +
			"unbounded memory growth. Aborting.\n";
		let exiting = false;
		const exit = (): void => {
			if (exiting) return;
			exiting = true;
			clearTimeout(forceExit);
			process.exit(1);
		};
		const forceExit = setTimeout(exit, FATAL_DIAGNOSTIC_FLUSH_TIMEOUT_MS);
		forceExit.unref();
		process.stderr.write(diagnostic, exit);
		return;
	}
	stdoutQueue.push(text);
	stdoutQueuedBytes += bytes;
}

export function writeRawStdout(text: string): void {
	// Queue behind any backpressured/queued writes to preserve ordering.
	if (stdoutBackpressured || stdoutQueue.length > 0) {
		enqueueStdout(text);
		return;
	}
	if (!writeToStdout(text)) {
		stdoutBackpressured = true;
		requestDrainFlush();
	}
}

export async function flushRawStdout(): Promise<void> {
	// Wait for any queued output to drain so flushes observe true end-of-stream.
	if (stdoutBackpressured || stdoutQueue.length > 0) {
		await new Promise<void>((resolve) => {
			stdoutDrainWaiters.push(resolve);
		});
	}

	if (stdoutTakeoverState) {
		await new Promise<void>((resolve, reject) => {
			stdoutTakeoverState?.rawStdoutWrite("", (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
		return;
	}

	await new Promise<void>((resolve, reject) => {
		process.stdout.write("", (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}
