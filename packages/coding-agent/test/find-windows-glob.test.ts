import { describe, expect, it } from "vitest";
import { findWindowsPathGlob } from "../src/core/tools/find-windows-glob.js";

const candidates = [
	String.raw`C:\repo\loose.txt`,
	String.raw`C:\repo\src\example.spec.ts`,
	String.raw`C:\repo\src\foo\bar\nested.spec.ts`,
	String.raw`C:\repo\some\parent\direct.txt`,
	String.raw`C:\repo\some\parent\child\deep.txt`,
];

// A real child emits native Windows candidate bytes on every test platform.
// The traversal is covered separately by the real-fd find-tool tests.
async function find(pattern: string, paths = candidates, limit = 1000) {
	const result = await findWindowsPathGlob(
		process.execPath,
		["-e", `process.stdout.write(${JSON.stringify(`${paths.join("\r\n")}\r\n`)})`],
		pattern,
		limit,
	);
	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	return result.stdout ? result.stdout.split("\n") : [];
}

describe("Windows find path-glob matching", () => {
	it("lets recursive globstars match zero directories or multiple directories", async () => {
		expect(await find("**/src/**/*.spec.ts")).toEqual([candidates[1], candidates[2]]);
	});

	it("does not let a single star consume a native directory separator", async () => {
		expect(await find("**/some/parent/*.txt")).toEqual([candidates[3]]);
	});

	it("matches root and nested files for a leading recursive globstar", async () => {
		expect(await find("**/*.txt")).toEqual([candidates[0], candidates[3], candidates[4]]);
	});

	it("preserves hidden paths, brace alternatives, and character classes", async () => {
		const paths = [
			String.raw`C:\repo\.dreb\a1.md`,
			String.raw`C:\repo\src\b2.md`,
			String.raw`C:\repo\src\nested\b2.md`,
		];
		expect(await find("**/{.dreb,src}/[ab]?.md", paths)).toEqual(paths.slice(0, 2));
	});

	it("preserves fd smart-case matching for literal and wildcard portions", async () => {
		const paths = [String.raw`C:\repo\SRC\Example.SPEC.TS`, String.raw`C:\repo\src\Example.spec.ts`];
		expect(await find("**/src/**/*.spec.ts", paths)).toEqual(paths);
		expect(await find("**/src/**/Example.spec.ts", paths)).toEqual([paths[1]]);
	});

	it("counts only matches toward the result limit", async () => {
		expect(await find("**/src/**/*.spec.ts", candidates, 1)).toEqual([candidates[1]]);
	});

	it("stops the enumerator once the matching result limit is reached", async () => {
		const result = await findWindowsPathGlob(
			process.execPath,
			["-e", `process.stdout.write(${JSON.stringify(`${candidates[1]}\n`)}); setInterval(() => {}, 1000)`],
			"**/src/**/*.spec.ts",
			1,
		);
		expect(result).toMatchObject({ status: 0, stdout: candidates[1] });
	});

	it("does not buffer nonmatches before a late matching candidate", async () => {
		const result = await findWindowsPathGlob(
			process.execPath,
			[
				"-e",
				`process.stdout.write(("a".repeat(1024) + ".js\\n").repeat(11000)); process.stdout.write(${JSON.stringify(`${candidates[1]}\n`)})`,
			],
			"**/src/**/*.spec.ts",
			1,
		);
		expect(result).toMatchObject({ status: 0, stdout: candidates[1] });
	});

	it("keeps zero as an unlimited result count", async () => {
		expect(await find("**/*.txt", candidates, 0)).toEqual([candidates[0], candidates[3], candidates[4]]);
	});

	it("preserves a directory's trailing separator in the output", async () => {
		const paths = ["C:\\repo\\src\\"];
		expect(await find("**/src", paths)).toEqual(paths);
	});

	it("rejects a failed spawn", async () => {
		await expect(findWindowsPathGlob("/nonexistent/fd", [], "**/*.txt", 10)).rejects.toThrow("Failed to run fd");
	});

	it("retains fd exit status and stderr for the caller's error handling", async () => {
		const result = await findWindowsPathGlob(
			process.execPath,
			["-e", 'process.stderr.write("fd failure"); process.exitCode = 2'],
			"**/*.txt",
			10,
		);
		expect(result).toMatchObject({ status: 2, stdout: "", stderr: "fd failure" });
	});

	it("aborts a running enumeration instead of leaving the child alive", async () => {
		const controller = new AbortController();
		const pending = findWindowsPathGlob(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			"**/*.txt",
			10,
			controller.signal,
		);
		controller.abort();
		await expect(pending).rejects.toThrow("Operation aborted");
	});

	it("rejects before spawning if already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(findWindowsPathGlob("/nonexistent/fd", [], "**/*.txt", 10, controller.signal)).rejects.toThrow(
			"Operation aborted",
		);
	});

	it("bounds retained matching output", async () => {
		await expect(
			findWindowsPathGlob(
				process.execPath,
				["-e", 'process.stdout.write(("C:\\\\repo\\\\" + "a".repeat(1024) + ".txt\\n").repeat(11000))'],
				"**/*.txt",
				0,
			),
		).rejects.toThrow("fd matched output exceeded the 10 MiB buffer limit");
	});

	it("bounds retained stderr", async () => {
		await expect(
			findWindowsPathGlob(
				process.execPath,
				["-e", 'process.stderr.write("x".repeat(11 * 1024 * 1024))'],
				"**/*.txt",
				10,
			),
		).rejects.toThrow("fd stderr exceeded the 10 MiB buffer limit");
	});

	it.each([-1, 1.5, Number.POSITIVE_INFINITY])("rejects an invalid result limit: %s", async (limit) => {
		await expect(findWindowsPathGlob("/nonexistent/fd", [], "**/*.txt", limit)).rejects.toThrow(
			"Find limit must be a non-negative integer",
		);
	});
});
