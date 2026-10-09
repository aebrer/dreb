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

// ---------------------------------------------------------------------------
// Stdout stream errors (issues 454, 535)
//
// A failed pipe write (EPIPE when the reader is gone, ENOBUFS when the kernel
// cannot buffer the write, ...) surfaces asynchronously as an 'error' event on
// process.stdout. Without a listener Node rethrows it as an unhandled 'error'
// event and the process dies with only a stack trace. Both the direct and the
// takeover/raw-writer routes write to the same process.stdout socket, so one
// listener covers both; per-write callbacks route the same failure through the
// same fatal path. There is no recovery: stdout is this process's only output
// channel, so a write failure ends the run loudly with a nonzero exit.
// ---------------------------------------------------------------------------

let stdoutErrorListener: ((error: Error) => void) | undefined;
let fatalExitStarted = false;

function ensureStdoutErrorListener(): void {
	if (stdoutErrorListener) return;
	stdoutErrorListener = (error: Error) => abortForStdoutError(error);
	process.stdout.on("error", stdoutErrorListener);
}

function onStdoutWriteResult(error?: Error | null): void {
	if (error) abortForStdoutError(error);
}

function abortForStdoutError(error: Error): void {
	const code = (error as NodeJS.ErrnoException).code ?? "unknown";
	const reason =
		code === "EPIPE"
			? "the consumer closed its end of the pipe"
			: code === "ENOBUFS"
				? "the OS ran out of pipe buffer space"
				: "the stream reported an error";
	fatalExit(
		`Fatal: stdout write failed (${code}: ${error.message}); ${reason}. ` +
			"Output from this process can no longer be delivered. Aborting.\n",
	);
}

/**
 * Write a diagnostic to stderr and exit 1. Idempotent: a write callback error
 * and the stream 'error' event can both fire for the same failure. The exit is
 * bounded by a timeout in case stderr is itself broken; stderr failures are
 * swallowed here (never routed back into the stdout guard) because the process
 * is already exiting nonzero.
 */
function fatalExit(diagnostic: string): void {
	if (fatalExitStarted) return;
	fatalExitStarted = true;
	// Record the failure immediately so any exit path that races the diagnostic
	// (natural loop drain, or a shutdown that consults isFatalExitPending())
	// still reports failure.
	process.exitCode = 1;
	let exiting = false;
	const exit = (): void => {
		if (exiting) return;
		exiting = true;
		clearTimeout(forceExit);
		process.exit(1);
	};
	const forceExit = setTimeout(exit, FATAL_DIAGNOSTIC_FLUSH_TIMEOUT_MS);
	forceExit.unref();
	try {
		process.stderr.write(diagnostic, () => exit());
	} catch {
		exit();
	}
}

/**
 * True once a fatal stdout failure has started exiting the process. Graceful
 * shutdown paths must not exit 0 (or exit at all) while this is set: the fatal
 * path owns the exit and will terminate with code 1 once its diagnostic flushes.
 */
export function isFatalExitPending(): boolean {
	return fatalExitStarted;
}

function writeToStdout(text: string): boolean {
	ensureStdoutErrorListener();
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite(text, onStdoutWriteResult);
	}
	return process.stdout.write(text, onStdoutWriteResult);
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
	fatalExit(diagnostic);
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
	ensureStdoutErrorListener();
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
	if (stdoutErrorListener) {
		process.stdout.off("error", stdoutErrorListener);
		stdoutErrorListener = undefined;
	}
	if (fatalExitStarted) process.exitCode = undefined;
	fatalExitStarted = false;
}
