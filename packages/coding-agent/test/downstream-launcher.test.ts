import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Fake compiled entrypoints only: no real CLI, providers, settings or service startup.
describe("personal downstream source launcher", () => {
	let root: string;
	let launcher: string;
	let cli: string;
	let cwd: string;
	let home: string;
	let agentDir: string;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "dreb-downstream-launcher-")));
		const checkout = join(root, "checkout with spaces");
		launcher = join(checkout, "scripts", "dreb-cloud.mjs");
		cli = join(checkout, "packages", "coding-agent", "dist", "cli.js");
		cwd = join(root, "caller project ");
		home = join(root, "home");
		agentDir = join(root, "agent");
		for (const directory of [join(checkout, "scripts"), cwd, home, agentDir]) {
			mkdirSync(directory, { recursive: true });
		}
		copyFileSync(fileURLToPath(new URL("../../../scripts/dreb-cloud.mjs", import.meta.url)), launcher);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function run(args: string[] = []) {
		return spawnSync(process.execPath, [launcher, ...args], {
			cwd,
			encoding: "utf8",
			env: {
				HOME: home,
				USERPROFILE: home,
				DREB_CODING_AGENT_DIR: agentDir,
				DREB_LIVE_API: "0",
				DREB_LIVE_API_EXPENSIVE: "0",
				DREB_NO_LOCAL_LLM: "1",
				PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
			},
		});
	}

	function writeCli(source: string) {
		mkdirSync(dirname(cli), { recursive: true });
		writeFileSync(cli, source);
	}

	it("refuses an unbuilt checkout without installing, building or writing profile state", () => {
		const result = run(["--version"]);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("compiled CLI missing");
		expect(result.stderr).toContain("CLOUD-WORKSPACES-MAINTENANCE.md");
		expect(existsSync(cli)).toBe(false);
		expect(readdirSync(cwd)).toEqual([]);
		expect(readdirSync(home)).toEqual([]);
		expect(readdirSync(agentDir)).toEqual([]);
	});

	it("forwards exact arguments, caller cwd and profile while selecting the compiled descendant entrypoint", () => {
		writeCli(`process.stdout.write(JSON.stringify({
			argv: process.argv.slice(1), cwd: process.cwd(),
			home: process.env.HOME, userProfile: process.env.USERPROFILE,
			agentDir: process.env.DREB_CODING_AGENT_DIR
		}));`);
		const args = ["dashboard", "--port", "5344", "literal path ", "--unknown-test-flag"];
		const result = run(args);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({
			argv: [cli, ...args],
			cwd,
			home,
			userProfile: home,
			agentDir,
		});
		expect(readdirSync(cwd)).toEqual([]);
		expect(readdirSync(home)).toEqual([]);
		expect(readdirSync(agentDir)).toEqual([]);
	});

	it("preserves a failure exit from the compiled entrypoint", () => {
		writeCli('process.stderr.write("synthetic CLI failure\\n"); process.exitCode = 37;');
		const result = run();
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(37);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("synthetic CLI failure\n");
	});
});
