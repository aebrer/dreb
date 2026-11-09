import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Minimatch } from "minimatch";

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

interface FdResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

/**
 * fd turns globs into regexes that assume `/`, then tests native Windows paths
 * without normalizing their separators. Rewriting separators inside the glob
 * breaks recursive globstars and single-star boundaries. Let fd enumerate with
 * its normal ignore rules and match normalized paths instead. Stream candidates
 * so nonmatches do not fill a buffer or consume the result limit.
 */
export async function findWindowsPathGlob(
	fdPath: string,
	args: string[],
	pattern: string,
	limit: number,
	signal?: AbortSignal,
): Promise<FdResult> {
	if (signal?.aborted) throw new Error("Operation aborted");
	if (!Number.isInteger(limit) || limit < 0) throw new Error("Find limit must be a non-negative integer");
	const matcher = new Minimatch(pattern, {
		dot: true,
		nonegate: true,
		nocomment: true,
		noext: true,
		// Preserve fd's smart-case rule, including case-sensitive literal parts.
		nocase: pattern === pattern.toLowerCase(),
		windowsNoMagicRoot: false,
		platform: "win32",
		optimizationLevel: 0,
	});

	return new Promise((resolve, reject) => {
		const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
		const matches: string[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let stderr = "";
		let limitReached = false;
		let failure: Error | undefined;

		const stop = () => {
			if (!child.killed) child.kill();
		};
		const onAbort = () => {
			failure = new Error("Operation aborted");
			stop();
		};
		const cleanup = () => {
			lines.close();
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		lines.on("line", (line) => {
			if (failure || limitReached || !line) return;
			// Directory output has a trailing separator, but fd matches without it.
			const candidate = line.replaceAll("\\", "/").replace(/\/$/, "");
			if (!matcher.match(candidate)) return;
			stdoutBytes += Buffer.byteLength(line) + 1;
			if (stdoutBytes > MAX_BUFFER_BYTES) {
				failure = new Error("fd matched output exceeded the 10 MiB buffer limit");
				stop();
				return;
			}
			matches.push(line);
			if (limit > 0 && matches.length >= limit) {
				limitReached = true;
				stop();
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (failure || limitReached) return;
			stderrBytes += Buffer.byteLength(chunk);
			if (stderrBytes > MAX_BUFFER_BYTES) {
				failure = new Error("fd stderr exceeded the 10 MiB buffer limit");
				stop();
			} else {
				stderr += chunk;
			}
		});
		child.on("error", (error) => {
			cleanup();
			reject(new Error(`Failed to run fd: ${error.message}`));
		});
		child.on("close", (status) => {
			cleanup();
			if (failure) reject(failure);
			else resolve({ status: limitReached ? 0 : status, stdout: matches.join("\n"), stderr });
		});
		if (signal?.aborted) onAbort();
	});
}
