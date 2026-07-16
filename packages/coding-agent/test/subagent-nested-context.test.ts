import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeNestedContextBlock, type NestedContextState } from "../src/core/nested-context.js";
import { SettingsManager } from "../src/core/settings-manager.js";

function realpath(path: string): string {
	return realpathSync.native(path);
}

describe("subagent nested context policy", () => {
	let tempDir: string;
	let agentDir: string;
	let childCwd: string;
	let trustedRepo: string;
	let similarlyPrefixedRepo: string;

	beforeEach(() => {
		tempDir = realpath(mkdtempSync(join(tmpdir(), "dreb-subagent-nested-context-")));
		agentDir = join(tempDir, "agent-settings");
		childCwd = join(tempDir, "child-repo");
		trustedRepo = join(tempDir, "shared-repo");
		similarlyPrefixedRepo = join(tempDir, "shared-repo-untrusted");

		mkdirSync(join(childCwd, ".dreb"), { recursive: true });
		mkdirSync(join(childCwd, ".git"), { recursive: true });
		mkdirSync(join(trustedRepo, ".git"), { recursive: true });
		mkdirSync(join(trustedRepo, "src"), { recursive: true });
		mkdirSync(join(similarlyPrefixedRepo, ".git"), { recursive: true });
		mkdirSync(join(similarlyPrefixedRepo, "src"), { recursive: true });
		writeFileSync(join(childCwd, ".dreb", "settings.json"), "{}\n");
		writeFileSync(join(trustedRepo, "CLAUDE.md"), "# Trusted cross-repo context\n");
		writeFileSync(join(trustedRepo, "src", "file.ts"), "export {};\n");
		writeFileSync(join(similarlyPrefixedRepo, "CLAUDE.md"), "# Untrusted prefix context\n");
		writeFileSync(join(similarlyPrefixedRepo, "src", "file.ts"), "export {};\n");

		childCwd = realpath(childCwd);
		trustedRepo = realpath(trustedRepo);
		similarlyPrefixedRepo = realpath(similarlyPrefixedRepo);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeGlobalSettings(context: Record<string, unknown>): void {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ context })}\n`);
	}

	function computeForFreshChild(targetFile: string): string | null {
		// A spawned child creates its own file-backed manager from its own cwd and the shared
		// global agent directory; it must not inherit its parent's already-loaded settings.
		const settingsManager = SettingsManager.create(childCwd, agentDir);
		const state: NestedContextState = {
			policy: settingsManager.getGlobalContextTrustPolicy(),
			cwd: childCwd,
			loaded: new Set(),
			scannedDirs: new Set(),
		};
		return computeNestedContextBlock("read", { path: targetFile }, state);
	}

	// This deliberately covers only lazy tool-triggered loading. The startup upward scan is
	// separate behavior and is intentionally not exercised by this subagent parity test.
	it("uses only global policy for a freshly created child settings manager", () => {
		writeFileSync(
			join(childCwd, ".dreb", "settings.json"),
			JSON.stringify({ context: { autoLoadNested: true, trustedFolders: [trustedRepo] } }),
		);
		writeGlobalSettings({});

		const locallySelfGranted = computeForFreshChild(join(trustedRepo, "src", "file.ts"));
		expect(locallySelfGranted).toBeNull();

		writeGlobalSettings({ trustedFolders: [trustedRepo] });
		const globallyTrusted = computeForFreshChild(join(trustedRepo, "src", "file.ts"));
		expect(globallyTrusted).toContain("# Trusted cross-repo context");

		const prefixSibling = computeForFreshChild(join(similarlyPrefixedRepo, "src", "file.ts"));
		expect(prefixSibling).toBeNull();

		writeGlobalSettings({ autoLoadNested: true });
		const globallyUnrestricted = computeForFreshChild(join(similarlyPrefixedRepo, "src", "file.ts"));
		expect(globallyUnrestricted).toContain("# Untrusted prefix context");
	});
});
