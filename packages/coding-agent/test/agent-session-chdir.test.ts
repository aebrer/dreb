import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findModel } from "@dreb/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

// Remove GIT_* env vars that leak from git hooks
const { GIT_DIR: _, GIT_INDEX_FILE: __, GIT_WORK_TREE: ___, ...cleanEnv } = process.env;

function git(cwd: string, args: string): void {
	execSync(`git ${args}`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: cleanEnv });
}

describe("AgentSession chdir integration", () => {
	let tempDir: string;
	let agentDir: string;
	let repoDir: string;
	let subDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `dreb-chdir-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		repoDir = join(tempDir, "repo");
		subDir = join(repoDir, "subdir");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(subDir, { recursive: true });

		// Initialize a git repo
		git(repoDir, "init -q");
		git(repoDir, "config user.email test@test.com");
		git(repoDir, "config user.name Test");
		git(repoDir, "config commit.gpgsign false");
		writeFileSync(join(repoDir, "README.md"), "hello\n");
		git(repoDir, "add README.md");
		git(repoDir, "commit -q -m init");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("chdir tool is active in default session", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: repoDir,
			agentDir,
			settingsManager,
			extensionFactories: [],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: repoDir,
			agentDir,
			model: findModel("anthropic", "sonnet")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		expect(session.getActiveToolNames()).toContain("chdir");
	});

	it("_changeCwd updates session cwd and rebuilds tools", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: repoDir,
			agentDir,
			settingsManager,
			extensionFactories: [],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: repoDir,
			agentDir,
			model: findModel("anthropic", "sonnet")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		// Verify initial cwd
		expect((session as any)._cwd).toBe(repoDir);

		// Invoke the chdir tool directly via its definition
		const chdirDef = session.getToolDefinition("chdir");
		expect(chdirDef).toBeDefined();

		const result = await chdirDef!.execute("test-call-id", { path: subDir }, undefined, undefined, undefined as any);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Changed working directory"),
		});

		// Verify cwd was updated
		expect((session as any)._cwd).toBe(subDir);

		// Verify system prompt reflects new cwd
		expect(session.systemPrompt).toContain(subDir);
	});

	it("_changeCwd rolls back on _buildRuntime failure", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: repoDir,
			agentDir,
			settingsManager,
			extensionFactories: [],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: repoDir,
			agentDir,
			model: findModel("anthropic", "sonnet")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		// Sabotage _buildRuntime to throw
		const _originalBuildRuntime = (session as any)._buildRuntime.bind(session);
		let buildCalled = false;
		(session as any)._buildRuntime = () => {
			buildCalled = true;
			throw new Error("simulated _buildRuntime failure");
		};

		// Attempt to change cwd — should throw and rollback
		expect(() => (session as any)._changeCwd(subDir)).toThrow("simulated _buildRuntime failure");
		expect(buildCalled).toBe(true);

		// Verify cwd was rolled back
		expect((session as any)._cwd).toBe(repoDir);
	});
});
