import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@dreb/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import { getGitBranch } from "../src/core/git-branch.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { getPendingMessagesForRpc, getResourcesForRpc, getStateForRpc } from "../src/modes/rpc/rpc-mode.js";
import type { RpcPendingMessages, RpcResources } from "../src/modes/rpc/rpc-types.js";
import { createTestResourceLoader, createTestSession } from "./utilities.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-rpc-dashboard-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function model(provider: string, id: string, name = id): Model<any> {
	return {
		provider,
		id,
		name,
		api: "anthropic-messages",
		input: ["text"],
		reasoning: true,
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200_000,
		maxTokens: 8192,
	} as Model<any>;
}

describe("RPC dashboard state/resources DTOs", () => {
	it("includes scoped models in get_state data", () => {
		const scoped = model("anthropic", "claude-scoped", "Claude Scoped");
		const { session, cleanup } = createTestSession({ inMemory: true });
		session.setScopedModels([{ model: scoped, thinkingLevel: "high" }]);

		try {
			const state = getStateForRpc(session);

			expect(state.scopedModels).toEqual([
				{
					provider: "anthropic",
					id: "claude-scoped",
					name: "Claude Scoped",
					reasoning: true,
					thinkingLevel: "high",
				},
			]);
		} finally {
			cleanup();
		}
	});

	it("includes OAuth subscription usage in get_state data", () => {
		const { session, cleanup } = createTestSession({ inMemory: true });
		const isUsingOAuth = vi.spyOn(session.modelRegistry, "isUsingOAuth").mockReturnValue(true);

		try {
			const state = getStateForRpc(session);

			expect(isUsingOAuth).toHaveBeenCalledWith(session.model);
			expect(state.usingSubscription).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("returns queued message metadata without clearing queues", () => {
		const pending = getPendingMessagesForRpc({
			getSteeringMessages: () => ["steer one", "steer two"],
			getFollowUpMessages: () => ["follow one"],
		} as never);

		expect(pending).toEqual({ steering: ["steer one", "steer two"], followUp: ["follow one"] });
	});

	it("returns lean loaded resource metadata without file contents", () => {
		const sourceInfo = createSyntheticSourceInfo("/tmp/resource", { source: "test-source" });
		const skill = {
			name: "review-code",
			description: "Review code",
			filePath: "/tmp/skills/review-code/SKILL.md",
			baseDir: "/tmp/skills/review-code",
			sourceInfo,
			disableModelInvocation: false,
			userInvocable: true,
		};
		const prompt = {
			name: "plan",
			description: "Make a plan",
			content: "hidden prompt body",
			filePath: "/tmp/prompts/plan.md",
			sourceInfo,
		};
		const resourceLoader = createTestResourceLoader({
			agentsFiles: [{ path: "/tmp/AGENTS.md", content: "huge hidden context" }],
			skills: [skill],
			prompts: [prompt],
			systemPrompt: "hidden system prompt",
			extensionsResult: {
				extensions: [
					{
						path: "/tmp/extensions/example.ts",
						sourceInfo,
						handlers: new Map(),
						tools: new Map(),
						messageRenderers: new Map(),
						commands: new Map(),
						flags: new Map(),
						shortcuts: new Map(),
					} as never,
				],
				errors: [],
				runtime: createExtensionRuntime(),
			},
		});

		const resources = getResourcesForRpc({
			resourceLoader,
			getFilteredSkills: () => [skill],
			promptTemplates: [prompt],
		} as never);

		expect(resources).toEqual({
			contextFiles: [{ path: "/tmp/AGENTS.md" }],
			skills: [{ name: "review-code", description: "Review code" }],
			extensions: [{ name: "test-source", path: "/tmp/extensions/example.ts" }],
			promptTemplates: [{ name: "plan", description: "Make a plan" }],
			systemPromptPresent: true,
		});
		expect(JSON.stringify(resources)).not.toContain("huge hidden context");
		expect(JSON.stringify(resources)).not.toContain("hidden prompt body");
		expect(JSON.stringify(resources)).not.toContain("hidden system prompt");
	});
});

describe("git branch helper used by RPC", () => {
	it("resolves a branch from the supplied cwd", async () => {
		const dir = await createTempDir();
		mkdirSync(join(dir, ".git"));
		writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feature/dashboard\n");

		expect(getGitBranch(dir)).toBe("feature/dashboard");
	});
});

describe("RpcClient dashboard command methods", () => {
	it("getResources sends get_resources and unwraps resources", async () => {
		const client = new RpcClient() as any;
		const data: RpcResources = {
			contextFiles: [],
			skills: [],
			extensions: [],
			promptTemplates: [],
			systemPromptPresent: false,
		};
		client.send = vi.fn().mockResolvedValue({ type: "response", command: "get_resources", success: true, data });

		await expect(client.getResources()).resolves.toBe(data);
		expect(client.send).toHaveBeenCalledWith({ type: "get_resources" });
	});

	it("getGitBranch sends get_git_branch and unwraps the branch", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "get_git_branch",
			success: true,
			data: { branch: "main" },
		});

		await expect(client.getGitBranch()).resolves.toBe("main");
		expect(client.send).toHaveBeenCalledWith({ type: "get_git_branch" });
	});

	it("getDailyCost sends get_daily_cost and unwraps the cost", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "get_daily_cost",
			success: true,
			data: { cost: 1.23 },
		});

		await expect(client.getDailyCost()).resolves.toBe(1.23);
		expect(client.send).toHaveBeenCalledWith({ type: "get_daily_cost" });
	});

	it("getPendingMessages sends get_pending_messages and unwraps queues", async () => {
		const client = new RpcClient() as any;
		const data: RpcPendingMessages = { steering: ["steer"], followUp: ["follow"] };
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "get_pending_messages",
			success: true,
			data,
		});

		await expect(client.getPendingMessages()).resolves.toEqual(data);
		expect(client.send).toHaveBeenCalledWith({ type: "get_pending_messages" });
	});

	it("clearPendingMessages sends clear_pending_messages and unwraps cleared queues", async () => {
		const client = new RpcClient() as any;
		const data: RpcPendingMessages = { steering: ["old steer"], followUp: ["old follow"] };
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "clear_pending_messages",
			success: true,
			data,
		});

		await expect(client.clearPendingMessages()).resolves.toEqual(data);
		expect(client.send).toHaveBeenCalledWith({ type: "clear_pending_messages" });
	});

	it("abortCompaction sends abort_compaction", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({ type: "response", command: "abort_compaction", success: true });

		await expect(client.abortCompaction()).resolves.toBeUndefined();
		expect(client.send).toHaveBeenCalledWith({ type: "abort_compaction" });
	});

	it("abortRetry sends abort_retry", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({ type: "response", command: "abort_retry", success: true });

		await expect(client.abortRetry()).resolves.toBeUndefined();
		expect(client.send).toHaveBeenCalledWith({ type: "abort_retry" });
	});
});
