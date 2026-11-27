import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { setImmediate as nextTick } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as outputGuard from "../src/core/output-guard.js";
import * as subagents from "../src/core/tools/subagent.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.js";
import { createHarness, createHarnessWithExtensions, type Harness } from "./test-harness.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { resolve, promise };
}

describe("settled automation turns", () => {
	let harness: Harness;
	afterEach(() => {
		vi.restoreAllMocks();
		harness?.cleanup();
	});

	it("waits past agent_end and idle through a delayed retry, including for feedback", async () => {
		harness = createHarness({
			responses: [{ error: "529 overloaded" }, "recovered"],
			settings: { retry: { enabled: true, baseDelayMs: 1, maxRetries: 1 } },
		});
		const { session, agent } = harness;
		const retryStarted = deferred();
		const releaseRetry = deferred();
		const resume = agent.continue.bind(agent);
		vi.spyOn(agent, "continue").mockImplementationOnce(async () => {
			retryStarted.resolve();
			await releaseRetry.promise;
			await resume();
		});
		let finished = false;
		const turn = session.automationTurn("Please revise", true).finally(() => {
			finished = true;
		});
		await retryStarted.promise;
		await nextTick();
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(session.isStreaming).toBe(false);
		expect(finished).toBe(false);
		await expect(session.automationTurn("concurrent")).rejects.toThrow(/in progress/);
		releaseRetry.resolve();
		await expect(turn).resolves.toBe("recovered");
		expect(harness.eventsOfType("agent_end")).toHaveLength(2);
		expect(session.messages[0]).toMatchObject({
			role: "custom",
			customType: "automation-guard-feedback",
			content: "Please revise",
			display: true,
		});
	});

	it("waits for the queued continuation scheduled by successful threshold compaction", async () => {
		harness = await createHarnessWithExtensions({
			responses: [{ text: "first answer", usage: { input: 127000 } }, "after compaction"],
			extensionFactories: [
				(api) => {
					api.on("session_before_compact", ({ preparation }) => ({
						compaction: {
							summary: "test summary",
							firstKeptEntryId: preparation.firstKeptEntryId,
							tokensBefore: preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harness.session.subscribe((event) => {
			if (event.type === "auto_compaction_start") {
				harness.agent.followUp({ role: "user", content: "finish", timestamp: Date.now() });
			}
		});
		await expect(harness.session.automationTurn("start")).resolves.toBe("after compaction");
		expect(harness.eventsOfType("agent_end")).toHaveLength(2);
	});

	it("does not acknowledge the answer while its queued compaction is pending or if compaction fails", async () => {
		harness = createHarness({ responses: [{ text: "premature", usage: { input: 127000 } }] });
		const { session } = harness;
		const compacting = deferred();
		const release = deferred();
		vi.spyOn(session.modelRegistry, "getApiKey").mockImplementation(async () => {
			compacting.resolve();
			await release.promise;
			throw new Error("compactor failed");
		});
		let finished = false;
		const turn = session.automationTurn("feedback", true).finally(() => {
			finished = true;
		});
		await compacting.promise;
		await nextTick();
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(finished).toBe(false);
		release.resolve();
		await expect(turn).rejects.toThrow(/compactor failed/);
	});

	it("rejects an agent_end-only exception even when its diagnostic looks retryable", async () => {
		harness = createHarness({ settings: { retry: { enabled: true } } });
		harness.agent.getApiKey = async () => {
			throw new Error("connection refused resolving credentials");
		};
		await expect(harness.session.automationTurn("start")).rejects.toThrow(/connection refused/);
		expect(harness.session.isRetrying).toBe(false);
	});

	it.each(["error", "aborted"] as const)(
		"rejects a terminal %s instead of stale or partial text",
		async (stopReason) => {
			harness = createHarness({
				responses: ["old answer", { text: "partial", stopReason, error: "operation stopped" }],
			});
			const { session } = harness;
			const prompt = vi.spyOn(session, "prompt");
			await expect(session.automationTurn("/example")).resolves.toBe("old answer");
			expect(prompt).toHaveBeenCalledWith("/example", { source: "rpc", expandPromptTemplates: false });
			await expect(session.automationTurn("again")).rejects.toThrow("operation stopped");
			prompt.mockResolvedValueOnce(undefined);
			await expect(session.automationTurn("handled without starting")).rejects.toThrow(/no final assistant text/);
		},
	);

	it("returns only the settled RPC response, without a 30s timeout, and rejects on child exit", async () => {
		harness = createHarness();
		// Connect the real client and server JSONL readers through in-memory pipes.
		const child = Object.assign(new ChildProcess(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		vi.mocked(spawn).mockReturnValueOnce(child);
		vi.spyOn(process, "stdin", "get").mockReturnValue(child.stdin as unknown as typeof process.stdin);
		vi.spyOn(outputGuard, "takeOverStdout").mockImplementation(() => {});
		vi.spyOn(outputGuard, "writeRawStdout").mockImplementation((line) => {
			child.stdout.write(line);
		});
		void runRpcMode(harness.session);
		const client = new RpcClient();
		await client.start();
		await expect(client.automationTurn("ordinary session")).rejects.toThrow(/requires an orchestrator or guard/);
		let role = "orchestrator";
		Object.defineProperty(harness.session, "automationRole", { get: () => role });
		const gate = deferred();
		const run = vi.spyOn(harness.session, "automationTurn").mockImplementation(async () => {
			await gate.promise;
			return "final answer";
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const answer = client.automationTurn("revise", true);
			await vi.advanceTimersByTimeAsync(31000);
			expect(run).toHaveBeenCalledWith("revise", true);
			gate.resolve();
			await expect(answer).resolves.toBe("final answer");

			role = "guard";
			const pending = client.automationTurn("review");
			expect(run).toHaveBeenCalledWith("review", undefined);
			child.emit("exit", 7, null);
			await expect(pending).rejects.toThrow(/exited with code 7/);
		} finally {
			gate.resolve();
			vi.useRealTimers();
		}
	});

	it("rejects outstanding background work at settlement", async () => {
		harness = createHarness();
		harness.session.subscribe((event) => {
			if (event.type === "agent_end")
				vi.spyOn(subagents, "getRunningBackgroundAgents").mockReturnValue([
					{ agentId: "child", agentType: "Explore", taskSummary: "pending", startedAt: 0, status: "running" },
				]);
		});
		await expect(harness.session.automationTurn("start")).rejects.toThrow(/outstanding background work/);
	});

	it("invalidates a pending setup draft from every command the Dashboard can send, and only those", async () => {
		harness = createHarness();
		const { session } = harness;
		await session.configureAutomation({ role: "setup" }, () => {});
		const invalidate = vi.spyOn(session, "invalidateAutomationDraft");

		// Drive the real RPC command surface: the hook under test lives in runRpcMode's dispatcher,
		// which is the only path the Dashboard uses. Without this test, deleting the hook or typoing
		// a command name still leaves a user able to approve a draft they replaced by typing.
		const child = Object.assign(new ChildProcess(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		vi.mocked(spawn).mockReturnValueOnce(child);
		vi.spyOn(process, "stdin", "get").mockReturnValue(child.stdin as unknown as typeof process.stdin);
		vi.spyOn(outputGuard, "takeOverStdout").mockImplementation(() => {});
		vi.spyOn(outputGuard, "writeRawStdout").mockImplementation((line) => {
			child.stdout.write(line);
		});
		void runRpcMode(session);
		const client = new RpcClient();
		await client.start();
		try {
			expect(session.automationRole).toBe("setup");
			// Command outcomes (accepted or rejected) are not the point: each of these is a user
			// action that makes a draft on screen stale, so each must discard it. (abort invalidates
			// twice: once from this hook and once from AgentSession.abort() itself.)
			for (const [name, send] of [
				["prompt", () => client.prompt("change of plan")] as const,
				["steer", () => client.steer("change of plan")] as const,
				["follow_up", () => client.followUp("change of plan")] as const,
				["abort", () => client.abort()] as const,
				["reload", () => client.reload()] as const,
				["new_session", () => client.newSession()] as const,
				["switch_session", () => client.switchSession("/nonexistent.jsonl")] as const,
			]) {
				invalidate.mockClear();
				await send().catch(() => {});
				expect(invalidate, name).toHaveBeenCalled();
			}
			// A read must not throw away the draft the user is looking at.
			invalidate.mockClear();
			await client.getState();
			expect(invalidate).not.toHaveBeenCalled();
		} finally {
			await client.stop();
		}
	});
});
