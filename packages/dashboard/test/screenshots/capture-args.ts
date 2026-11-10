/**
 * Command-line arguments of the screenshot capture CLI (`capture.ts`).
 *
 * Kept apart from the entry point so tests can import the parser without running
 * a capture.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_OUT_DIR = fileURLToPath(new URL("../../docs/screenshots/", import.meta.url));

export interface CaptureArgs {
	outDir: string;
	only: string[];
	help: boolean;
}

export function usage(): string {
	return [
		"Usage: npm run screenshots -w @dreb/dashboard -- [--out <dir>] [--only <name> ...]",
		"",
		"  --out <dir>    write PNGs here instead of packages/dashboard/docs/screenshots/",
		"  --only <name>  capture only the named shot(s); repeatable",
	].join("\n");
}

export function parseCaptureArgs(argv: readonly string[]): CaptureArgs {
	const args: CaptureArgs = { outDir: DEFAULT_OUT_DIR, only: [], help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			args.help = true;
		} else if (arg === "--out") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) throw new Error("--out requires a directory");
			args.outDir = resolve(value);
		} else if (arg === "--only") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) throw new Error("--only requires a shot name");
			args.only.push(value);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return args;
}
