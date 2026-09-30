import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isExpensiveLiveApiEnabled, isLiveApiEnabled } from "./live-api.js";

const repoRoot = resolve(__dirname, "../../..");
const TEST_DIRS = ["packages/ai/test", "packages/agent/test", "packages/coding-agent/test"].map((d) =>
	join(repoRoot, d),
);

/** Provider credential references that imply a live, billed request. */
const CREDENTIAL = /_API_KEY|_OAUTH_TOKEN|HF_TOKEN|Token\b|hasAuthForProvider|Credentials\(\)/;
/** Accepted opt-in guards. */
const OPT_IN = /isLiveApiEnabled\(|isExpensiveLiveApiEnabled\(|shouldRunBedrockExtensiveTests\(/;

function listTestSources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "fixtures") continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) out.push(...listTestSources(path));
		else if (entry.endsWith(".ts")) out.push(path);
	}
	return out;
}

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Extract the argument text of each `.skipIf(...)` / `.runIf(...)` call, balancing parentheses. */
function gateConditions(source: string): string[] {
	const conditions: string[] = [];
	const re = /\.(skipIf|runIf)\(/g;
	for (let m = re.exec(source); m; m = re.exec(source)) {
		let depth = 1;
		let i = re.lastIndex;
		for (; i < source.length && depth > 0; i++) {
			if (source[i] === "(") depth++;
			else if (source[i] === ")") depth--;
		}
		conditions.push(source.slice(re.lastIndex, i - 1));
	}
	return conditions;
}

describe("live provider API opt-in", () => {
	it("is disabled unless DREB_LIVE_API=1", () => {
		expect(isLiveApiEnabled({})).toBe(false);
		expect(isLiveApiEnabled({ DREB_LIVE_API: "0" })).toBe(false);
		expect(isLiveApiEnabled({ DREB_LIVE_API: "true" })).toBe(false);
		expect(isLiveApiEnabled({ DREB_LIVE_API: "1" })).toBe(true);
	});

	it("requires both flags for expensive live tests", () => {
		expect(isExpensiveLiveApiEnabled({ DREB_LIVE_API_EXPENSIVE: "1" })).toBe(false);
		expect(isExpensiveLiveApiEnabled({ DREB_LIVE_API: "1" })).toBe(false);
		expect(isExpensiveLiveApiEnabled({ DREB_LIVE_API: "1", DREB_LIVE_API_EXPENSIVE: "1" })).toBe(true);
	});

	it("every credential-gated test block goes through the opt-in helper", () => {
		const offenders: string[] = [];
		for (const dir of TEST_DIRS) {
			for (const file of listTestSources(dir)) {
				const source = stripComments(readFileSync(file, "utf8"));
				for (const condition of gateConditions(source)) {
					if (CREDENTIAL.test(condition) && !OPT_IN.test(condition)) {
						offenders.push(`${relative(repoRoot, file)}: skipIf/runIf(${condition.trim().replace(/\s+/g, " ")})`);
					}
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("no test references the removed skip-style live API flag", () => {
		// Built from parts so this file does not match itself.
		const removedFlag = ["DREB", "SKIP", "LIVE", "API"].join("_");
		const offenders = TEST_DIRS.flatMap((dir) =>
			listTestSources(dir).filter((file) => readFileSync(file, "utf8").includes(removedFlag)),
		);
		expect(offenders.map((f) => relative(repoRoot, f))).toEqual([]);
	});
});
