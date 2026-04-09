import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanProject } from "../../src/core/search/scanner.js";

describe("scanner .dreb/ visibility", () => {
	let fixtureDir: string;

	beforeAll(() => {
		fixtureDir = mkdtempSync(path.join(tmpdir(), "scanner-dreb-"));

		// Create .gitignore that ignores .dreb/
		writeFileSync(path.join(fixtureDir, ".gitignore"), "**/.dreb/\n", "utf-8");

		// Regular project file
		mkdirSync(path.join(fixtureDir, "src"), { recursive: true });
		writeFileSync(path.join(fixtureDir, "src", "main.ts"), "export const main = true;", "utf-8");

		// Tool-visible .dreb/ content
		mkdirSync(path.join(fixtureDir, ".dreb", "memory"), { recursive: true });
		writeFileSync(
			path.join(fixtureDir, ".dreb", "memory", "knowledge.md"),
			"# Project Knowledge\nImportant context here.",
			"utf-8",
		);

		mkdirSync(path.join(fixtureDir, ".dreb", "agents"), { recursive: true });
		writeFileSync(
			path.join(fixtureDir, ".dreb", "agents", "custom-agent.md"),
			"# Custom Agent\nDoes custom things.",
			"utf-8",
		);

		mkdirSync(path.join(fixtureDir, ".dreb", "extensions"), { recursive: true });
		writeFileSync(
			path.join(fixtureDir, ".dreb", "extensions", "my-ext.ts"),
			"export function myExtension() {}",
			"utf-8",
		);

		// Tool-hidden .dreb/ content
		mkdirSync(path.join(fixtureDir, ".dreb", "index"), { recursive: true });
		writeFileSync(path.join(fixtureDir, ".dreb", "index", "search.db"), "fake-binary-data", "utf-8");

		mkdirSync(path.join(fixtureDir, ".dreb", "agent", "sessions"), { recursive: true });
		writeFileSync(path.join(fixtureDir, ".dreb", "agent", "sessions", "log.jsonl"), '{"event":"test"}', "utf-8");

		mkdirSync(path.join(fixtureDir, ".dreb", "secrets"), { recursive: true });
		writeFileSync(path.join(fixtureDir, ".dreb", "secrets", "keys.json"), '{"key":"secret"}', "utf-8");
	});

	afterAll(() => {
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	it("includes regular project files", async () => {
		const files = await scanProject(fixtureDir);
		const paths = files.map((f) => f.filePath);

		expect(paths).toContain("src/main.ts");
	});

	it("includes .dreb/memory/ files despite gitignore", async () => {
		const files = await scanProject(fixtureDir);
		const paths = files.map((f) => f.filePath);

		expect(paths.some((p) => p.includes(".dreb/memory/knowledge.md"))).toBe(true);
	});

	it("includes .dreb/agents/ files despite gitignore", async () => {
		const files = await scanProject(fixtureDir);
		const paths = files.map((f) => f.filePath);

		expect(paths.some((p) => p.includes(".dreb/agents/custom-agent.md"))).toBe(true);
	});

	it("includes .dreb/extensions/ files despite gitignore", async () => {
		const files = await scanProject(fixtureDir);
		const paths = files.map((f) => f.filePath);

		expect(paths.some((p) => p.includes(".dreb/extensions/my-ext.ts"))).toBe(true);
	});

	it("does NOT include .dreb/index/ content", async () => {
		const files = await scanProject(fixtureDir);
		const paths = files.map((f) => f.filePath);

		expect(paths.some((p) => p.includes(".dreb/index/"))).toBe(false);
	});

	it("does NOT include .dreb/agent/ content", async () => {
		const files = await scanProject(fixtureDir);
		const paths = files.map((f) => f.filePath);

		expect(paths.some((p) => p.includes(".dreb/agent/"))).toBe(false);
	});

	it("does NOT include .dreb/secrets/ content", async () => {
		const files = await scanProject(fixtureDir);
		const paths = files.map((f) => f.filePath);

		expect(paths.some((p) => p.includes(".dreb/secrets/"))).toBe(false);
	});
});
