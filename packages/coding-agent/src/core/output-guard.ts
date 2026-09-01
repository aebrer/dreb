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
// "drain". The queue is byte-capped: legitimate multi-MiB bursts (for example
// dashboard turns with several inline images, issue 495) can push the backlog
// past the cap while the consumer is merely slow, so the cap is a grace
// trigger, not an immediate kill — we only abort when the consumer makes no
// drain progress for the grace window, which means the output channel is dead
// or hopelessly behind. That keeps us from growing memory without bound.
// ---------------------------------------------------------------------------

/** Maximum aggregate bytes allowed for ordinary queued writes before the no-drain window starts. */
export const MAX_QUEUED_STDOUT_BYTES = 16 * 1024 * 1024; // 16 MiB

/** Abort if the queue stays above the cap with no drain progress for this long. */
export const MAX_NO_DRAIN_GRACE_MS = 30_000;

const FATAL_DIAGNOSTIC_FLUSH_TIMEOUT_MS = 1_000;

const stdoutQueue: string[] = [];
let stdoutQueuedBytes = 0;
let stdoutBackpressured = false;
let stdoutDrainListening = false;
let stdoutDrainWaiters: Array<() => void> = [];
let noDrainAbortTimer: ReturnType<typeof setTimeout> | undefined;

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
		// Any drain is forward progress by the consumer: reset the no-drain
		// abort window. If the backlog is still above the cap after this flush,
		// the next queued write starts a fresh window.
		disarmNoDrainAbort();
		flushStdoutQueue();
	});
}

/** Start (or keep) the no-drain abort window for an over-cap backlog. */
function armNoDrainAbort(): void {
	if (noDrainAbortTimer) return;
	const timer = setTimeout(() => {
		noDrainAbortTimer = undefined;
		abortForStalledConsumer();
	}, MAX_NO_DRAIN_GRACE_MS);
	timer.unref();
	noDrainAbortTimer = timer;
}

function disarmNoDrainAbort(): void {
	if (!noDrainAbortTimer) return;
	clearTimeout(noDrainAbortTimer);
	noDrainAbortTimer = undefined;
}

/**
 * The consumer exceeded the queue cap and then made no drain progress for the
 * full grace window — treat the output channel as dead and abort loudly
 * instead of holding payloads in memory forever.
 */
function abortForStalledConsumer(): void {
	if (stdoutQueuedBytes <= MAX_QUEUED_STDOUT_BYTES) {
		// The backlog drained back under the cap before the window expired.
		return;
	}
	const diagnostic =
		`Fatal: stdout write queue exceeded ${MAX_QUEUED_STDOUT_BYTES} bytes with no drain progress ` +
		`for ${MAX_NO_DRAIN_GRACE_MS} ms. The consumer of this process's stdout is not reading; ` +
		"refusing unbounded memory growth. Aborting.\n";
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
	// Bound accumulated ordinary backlog, but allow one legitimate protocol frame
	// larger than the cap (for example, a complete dashboard snapshot). Once that
	// oversized frame is queued, any subsequent write still counts against the cap.
	const exceedsAggregateCap = stdoutQueuedBytes + bytes > MAX_QUEUED_STDOUT_BYTES;
	const isSingleOversizedFrame = bytes > MAX_QUEUED_STDOUT_BYTES && stdoutQueuedBytes <= MAX_QUEUED_STDOUT_BYTES;
	if (exceedsAggregateCap && !isSingleOversizedFrame) {
		// Over the cap: keep queuing (this process has no other output channel)
		// and start the no-drain abort window. A slow-but-alive consumer — for
		// example a dashboard synchronously decoding multi-MiB image lines —
		// makes drain progress before the window expires and is not killed
		// mid-turn (issue 495); a dead one is.
		armNoDrainAbort();
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

/**
 * Test-only: clear all queue state (backlog, byte count, backpressure flag,
 * drain waiters, and the no-drain abort timer) so tests start from a clean
 * process-global slate.
 */
export function resetOutputGuardForTests(): void {
	stdoutQueue.length = 0;
	stdoutQueuedBytes = 0;
	stdoutBackpressured = false;
	stdoutDrainWaiters.length = 0;
	disarmNoDrainAbort();
}
