/**
 * Regenerate the dashboard screenshots used in the root README.
 *
 *   npm run screenshots -w @dreb/dashboard                  # all shots → docs/screenshots/
 *   npm run screenshots -w @dreb/dashboard -- --only fleet-desktop-dark
 *   npm run screenshots -w @dreb/dashboard -- --out /tmp/shots
 *
 * Needs no API keys, models, or dreb sessions: everything rendered comes from
 * the fictional scenario in `scenario.ts`. Network access is used only for the
 * Google-hosted default typeface. See the "README screenshots" section of
 * packages/dashboard/README.md.
 *
 * This module is only ever the CLI entry point, so it always runs. Detecting the
 * entry point from `process.argv` breaks when the script is reached via a symlink,
 * so the argument parser lives in `capture-args.ts` for tests to import instead.
 */

import { parseCaptureArgs, usage } from "./capture-args.js";
import { runScreenshotHarness } from "./harness.js";
import { selectShots } from "./shots.js";

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

void main();
