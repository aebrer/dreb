/**
 * Regenerate the dashboard README screenshots.
 *
 *   npm run screenshots -w @dreb/dashboard                  # all shots → docs/screenshots/
 *   npm run screenshots -w @dreb/dashboard -- --only fleet-desktop-dark
 *   npm run screenshots -w @dreb/dashboard -- --out /tmp/shots
 *
 * Needs no API keys, models, or dreb sessions: everything rendered comes from
 * the fictional scenario in `scenario.ts`. Network access is used only for the
 * Google-hosted default typeface. See the "README screenshots" section of
 * packages/dashboard/README.md.
 */

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runScreenshotHarness } from "./harness.js";
import { selectShots } from "./shots.js";

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

async function main(): Promise<void> {
	try {
		const args = parseCaptureArgs(process.argv.slice(2));
		if (args.help) {
			console.log(usage());
			return;
		}
		const shots = selectShots(args.only);
		await runScreenshotHarness({
			outDir: args.outDir,
			shots,
			fonts: "network",
			log: (line) => console.log(line),
		});
		console.log(`wrote ${shots.length} screenshot(s) to ${args.outDir}`);
	} catch (error) {
		console.error(`screenshots: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
