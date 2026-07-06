import { afterEach, describe, expect, it, vi } from "vitest";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { getTreeForRpc, navigateTreeForRpc, toRpcTreeNodes } from "../src/modes/rpc/rpc-mode.js";
import type { RpcTreeNode } from "../src/modes/rpc/rpc-types.js";
import { createHarnessWithExtensions } from "./test-harness.js";
import { assistantMsg, buildTestTree, createTestSession, userMsg } from "./utilities.js";

const sessionContexts: Array<{ cleanup: () => void }> = [];

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
};

function createDeferred<T = void>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (reason?: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function trackSessionContext<T extends { cleanup: () => void }>(context: T): T {
	sessionContexts.push(context);
	return context;
}

function findNode(nodes: RpcTreeNode[], id: string): RpcTreeNode | undefined {
	const stack = [...nodes];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.id === id) return node;
		stack.push(...node.children);
	}
	return undefined;
}

function buildBranchedTree(sessionManager: SessionManager): Map<string, string> {
	return buildTestTree(sessionManager, {
		messages: [
			{ role: "user", text: "u1 text" },
			{ role: "assistant", text: "a1 text" },
			{ role: "user", text: "u2 text" },
			{ role: "assistant", text: "a2 text" },
			{ role: "user", text: "u3 text", branchFrom: "a1 text" },
			{ role: "assistant", text: "a3 text" },
		],
	});
}

function previewFor(sessionManager: SessionManager, id: string): string {
	return findNode(toRpcTreeNodes(sessionManager.getTree()), id)!.preview;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const context of sessionContexts.splice(0, sessionContexts.length).reverse()) {
		context.cleanup();
	}
});

describe("toRpcTreeNodes and getTreeForRpc", () => {
	it("maps roots, children, branch ordering, and id/parent wiring", () => {
		const sessionManager = SessionManager.inMemory();
		const ids = buildBranchedTree(sessionManager);

		const roots = toRpcTreeNodes(sessionManager.getTree());

		expect(roots).toHaveLength(1);
		const u1 = roots[0]!;
		expect(u1.id).toBe(ids.get("u1 text"));
		expect(u1.parentId).toBeNull();
		expect(u1.children).toHaveLength(1);

		const a1 = u1.children[0]!;
		expect(a1.id).toBe(ids.get("a1 text"));
		expect(a1.parentId).toBe(u1.id);
		expect(a1.children.map((child) => child.id)).toEqual([ids.get("u2 text"), ids.get("u3 text")]);

		const u2 = a1.children[0]!;
		const u3 = a1.children[1]!;
		expect(u2.parentId).toBe(a1.id);
		expect(u2.children[0]!.id).toBe(ids.get("a2 text"));
		expect(u2.children[0]!.parentId).toBe(u2.id);
		expect(u3.parentId).toBe(a1.id);
		expect(u3.children[0]!.id).toBe(ids.get("a3 text"));
		expect(u3.children[0]!.parentId).toBe(u3.id);
	});

	it("sets role only for message entries", () => {
		const sessionManager = SessionManager.inMemory();
		const userId = sessionManager.appendMessage(userMsg("hello"));
		const thinkingId = sessionManager.appendThinkingLevelChange("high");

		const roots = toRpcTreeNodes(sessionManager.getTree());
		const userNode = findNode(roots, userId)!;
		const thinkingNode = findNode(roots, thinkingId)!;

		expect(userNode.role).toBe("user");
		expect(thinkingNode.role).toBeUndefined();
		expect(thinkingNode.preview).toBe("[thinking: high]");
	});

	it("extracts user previews, collapses whitespace, and truncates to 200 characters", () => {
		const simple = SessionManager.inMemory();
		const simpleId = simple.appendMessage(userMsg("hello world"));
		expect(findNode(toRpcTreeNodes(simple.getTree()), simpleId)!.preview).toBe("hello world");

		const whitespace = SessionManager.inMemory();
		const whitespaceId = whitespace.appendMessage(userMsg("hello\n\tthere   friend"));
		expect(findNode(toRpcTreeNodes(whitespace.getTree()), whitespaceId)!.preview).toBe("hello there friend");

		const long = SessionManager.inMemory();
		const longText = "x".repeat(250);
		const longId = long.appendMessage(userMsg(longText));
		const preview = findNode(toRpcTreeNodes(long.getTree()), longId)!.preview;
		expect(preview).toHaveLength(200);
		expect(preview).toBe("x".repeat(200));
	});

	it("renders assistant previews for text, aborted, errors, and empty content", () => {
		const sessionManager = SessionManager.inMemory();
		const textId = sessionManager.appendMessage(assistantMsg("assistant\ntext"));
		const abortedId = sessionManager.appendMessage({ ...assistantMsg(""), content: [], stopReason: "aborted" });
		const errorId = sessionManager.appendMessage({
			...assistantMsg(""),
			content: [],
			stopReason: "error",
			errorMessage: "  provider\nfailed  ",
		});
		const emptyId = sessionManager.appendMessage({ ...assistantMsg(""), content: [] });

		expect(previewFor(sessionManager, textId)).toBe("assistant text");
		expect(previewFor(sessionManager, abortedId)).toBe("(aborted)");
		expect(previewFor(sessionManager, errorId)).toBe("provider failed");
		expect(previewFor(sessionManager, emptyId)).toBe("(no content)");
	});

	it("renders tool, bash, and unknown-role message previews", () => {
		const sessionManager = SessionManager.inMemory();
		const toolId = sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "read",
			content: [{ type: "text", text: "contents" }],
			isError: false,
			timestamp: Date.now(),
		});
		const fallbackToolId = sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "tc2",
			content: [{ type: "text", text: "contents" }],
			isError: false,
			timestamp: Date.now(),
		} as Parameters<SessionManager["appendMessage"]>[0]);
		const bashId = sessionManager.appendMessage({
			role: "bashExecution",
			command: "npm test",
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		});
		const unknownRoleId = sessionManager.appendMessage({
			role: "futureRole",
			content: "future",
			timestamp: Date.now(),
			// Targeted cast: exercises the unknown-role fallback for forward-compat session data.
		} as unknown as Parameters<SessionManager["appendMessage"]>[0]);

		expect(previewFor(sessionManager, toolId)).toBe("[read]");
		expect(previewFor(sessionManager, fallbackToolId)).toBe("[tool]");
		expect(previewFor(sessionManager, bashId)).toBe("[bash]: npm test");
		expect(previewFor(sessionManager, unknownRoleId)).toBe("[futureRole]");
	});

	it("renders custom, compaction, model, and session metadata previews", () => {
		const sessionManager = SessionManager.inMemory();
		const rootId = sessionManager.appendMessage(userMsg("root"));
		const customMessageId = sessionManager.appendCustomMessageEntry("note", "hello\nthere", true);
		const compactionId = sessionManager.appendCompaction("summary", rootId, 50000);
		const modelId = sessionManager.appendModelChange("anthropic", "claude-3-5-sonnet");
		const customId = sessionManager.appendCustomEntry("artifact", { id: 1 });
		const sessionInfoId = sessionManager.appendSessionInfo("Project Name");
		const emptyTitleId = sessionManager.appendSessionInfo("  ");

		expect(previewFor(sessionManager, customMessageId)).toBe("[note]: hello there");
		expect(previewFor(sessionManager, compactionId)).toBe("[compaction: 50k tokens]");
		expect(previewFor(sessionManager, modelId)).toBe("[model: claude-3-5-sonnet]");
		expect(previewFor(sessionManager, customId)).toBe("[custom: artifact]");
		expect(previewFor(sessionManager, sessionInfoId)).toBe("[title: Project Name]");
		// Empty titles (reachable via extension setSessionName("")) match the TUI's "[title: empty]"
		expect(previewFor(sessionManager, emptyTitleId)).toBe("[title: empty]");
	});

	it("renders a placeholder for unknown entry types from future or corrupt session files", () => {
		// Targeted cast: session files are JSON-parsed, so runtime data can contain
		// forward-compatible or corrupt entry types outside the current SessionEntry union.
		const futureEntry = {
			type: "future_type",
			id: "future-1",
			parentId: null,
			timestamp: "2024-01-01T00:00:00.000Z",
		} as unknown as SessionEntry;

		const roots = toRpcTreeNodes([{ entry: futureEntry, children: [] }]);

		expect(roots[0]!.preview).toBe("[future_type]");
	});

	it("resolves labels and renders label entries", () => {
		const sessionManager = SessionManager.inMemory();
		const targetId = sessionManager.appendMessage(userMsg("labeled message"));
		const labelEntryId = sessionManager.appendLabelChange(targetId, "important");

		const roots = toRpcTreeNodes(sessionManager.getTree());
		const targetNode = findNode(roots, targetId)!;
		const labelNode = findNode(roots, labelEntryId)!;

		expect(targetNode.label).toBe("important");
		expect(labelNode.label).toBeUndefined();
		expect(labelNode.role).toBeUndefined();
		expect(labelNode.preview).toBe("[label: important]");
	});

	it("renders non-message previews", () => {
		const sessionManager = SessionManager.inMemory();
		const userId = sessionManager.appendMessage(userMsg("root"));
		const thinkingId = sessionManager.appendThinkingLevelChange("medium");
		const summaryId = sessionManager.branchWithSummary(userId, "old branch summary");

		const roots = toRpcTreeNodes(sessionManager.getTree());

		expect(findNode(roots, thinkingId)!.preview).toBe("[thinking: medium]");
		expect(findNode(roots, summaryId)!.preview).toBe("[branch summary]: old branch summary");
	});

	it("does not leak raw entry or message payloads", () => {
		const sessionManager = SessionManager.inMemory();
		const id = sessionManager.appendMessage(userMsg("hello"));

		const node = findNode(toRpcTreeNodes(sessionManager.getTree()), id)!;

		expect(Object.keys(node)).toEqual(["id", "parentId", "type", "role", "preview", "timestamp", "children"]);
		expect(JSON.stringify(node)).not.toContain('"entry":');
		expect(JSON.stringify(node)).not.toContain('"message":');
	});

	it("returns the current leaf id and handles an empty tree", () => {
		const sessionManager = SessionManager.inMemory();
		buildBranchedTree(sessionManager);

		expect(getTreeForRpc(sessionManager)).toEqual({
			roots: toRpcTreeNodes(sessionManager.getTree()),
			leafId: sessionManager.getLeafId(),
		});

		const fresh = SessionManager.inMemory();
		expect(getTreeForRpc(fresh)).toEqual({ roots: [], leafId: null });
	});

	it("maps deep linear trees without recursion", () => {
		const sessionManager = SessionManager.inMemory();
		let lastId = "";
		for (let i = 0; i < 5000; i++) {
			lastId = sessionManager.appendMessage(userMsg(`message ${i}`));
		}

		const roots = toRpcTreeNodes(sessionManager.getTree());

		expect(roots).toHaveLength(1);
		expect(findNode(roots, lastId)?.preview).toBe("message 4999");
	});
});

describe("navigateTreeForRpc", () => {
	it("forwards options verbatim", async () => {
		const options = {
			summarize: true,
			customInstructions: "summarize this",
			replaceInstructions: true,
			label: "kept",
		};
		const session = {
			navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
		};

		await navigateTreeForRpc(session, "target-id", options);

		expect(session.navigateTree).toHaveBeenCalledWith("target-id", options);
	});

	it("returns only cancelled and editorText fields", async () => {
		const session = {
			navigateTree: vi.fn().mockResolvedValue({
				cancelled: false,
				editorText: "edit me",
				aborted: true,
				summaryEntry: { id: "summary" },
			}),
		};

		await expect(navigateTreeForRpc(session, "target-id")).resolves.toEqual({
			cancelled: false,
			editorText: "edit me",
		});
	});

	it("propagates thrown errors", async () => {
		const session = {
			navigateTree: vi.fn().mockRejectedValue(new Error("navigation failed")),
		};

		await expect(navigateTreeForRpc(session, "target-id")).rejects.toThrow("navigation failed");
	});
});

describe("navigateTreeForRpc real-session integration", () => {
	it("navigates to a root user message, returns editor text, and updates session state", async () => {
		const { session, sessionManager } = trackSessionContext(createTestSession({ inMemory: true }));
		const ids = buildBranchedTree(sessionManager);

		await expect(navigateTreeForRpc(session, ids.get("u1 text")!)).resolves.toEqual({
			cancelled: false,
			editorText: "u1 text",
		});

		expect(sessionManager.getLeafId()).toBeNull();
		expect(session.messages).toEqual([]);
	});

	it("navigates to an assistant entry without editor text", async () => {
		const { session, sessionManager } = trackSessionContext(createTestSession({ inMemory: true }));
		const ids = buildBranchedTree(sessionManager);
		const assistantId = ids.get("a1 text")!;

		await expect(navigateTreeForRpc(session, assistantId)).resolves.toEqual({ cancelled: false });

		expect(sessionManager.getLeafId()).toBe(assistantId);
		expect(
			session.messages.map((message) => ({
				role: message.role,
				content: "content" in message ? message.content : undefined,
			})),
		).toEqual([
			{ role: "user", content: "u1 text" },
			{ role: "assistant", content: [{ type: "text", text: "a1 text" }] },
		]);
	});

	it("rejects unknown target ids with the core error", async () => {
		const { session } = trackSessionContext(createTestSession({ inMemory: true }));

		await expect(navigateTreeForRpc(session, "missing-entry")).rejects.toThrow("Entry missing-entry not found");
	});

	it("rejects navigation while streaming", async () => {
		const { session, sessionManager } = trackSessionContext(createTestSession({ inMemory: true }));
		const targetId = sessionManager.appendMessage(userMsg("blocked"));
		vi.spyOn(session, "isStreaming", "get").mockReturnValue(true);

		await expect(navigateTreeForRpc(session, targetId)).rejects.toThrow(
			"Cannot navigate the session tree while the agent is streaming",
		);
	});

	it("rejects if streaming starts during async tree preparation without mutating session state", async () => {
		const { session, sessionManager } = trackSessionContext(
			await createHarnessWithExtensions({
				extensionFactories: [
					(dreb) => {
						dreb.on("session_before_tree", async () => {
							await Promise.resolve();
						});
					},
				],
			}),
		);
		const ids = buildBranchedTree(sessionManager);
		const targetId = ids.get("u1 text")!;
		const originalLeafId = sessionManager.getLeafId();
		const originalEntries = sessionManager.getEntries();
		let isStreamingCalls = 0;
		vi.spyOn(session, "isStreaming", "get").mockImplementation(() => isStreamingCalls++ > 0);

		await expect(navigateTreeForRpc(session, targetId)).rejects.toThrow(
			"Cannot navigate the session tree while the agent is streaming. Abort or wait for idle first.",
		);

		expect(sessionManager.getLeafId()).toBe(originalLeafId);
		expect(sessionManager.getEntries()).toEqual(originalEntries);
		// The abort controller must be cleared on the throw path, or isCompacting wedges true
		// (queuing all interactive input and misreporting get_state) until the next navigation.
		expect(session.isCompacting).toBe(false);
	});

	it("rejects concurrent navigation while the first navigation is preparing the tree", async () => {
		const firstParked = createDeferred();
		const releaseFirst = createDeferred();
		let beforeTreeCalls = 0;
		const { session, sessionManager } = trackSessionContext(
			await createHarnessWithExtensions({
				extensionFactories: [
					(dreb) => {
						dreb.on("session_before_tree", async () => {
							beforeTreeCalls++;
							if (beforeTreeCalls === 1) {
								firstParked.resolve();
								await releaseFirst.promise;
							}
						});
					},
				],
			}),
		);
		const ids = buildBranchedTree(sessionManager);
		const firstTargetId = ids.get("u1 text")!;
		const secondTargetId = ids.get("u2 text")!;

		const firstNavigation = navigateTreeForRpc(session, firstTargetId);
		await firstParked.promise;

		await expect(navigateTreeForRpc(session, secondTargetId)).rejects.toThrow(
			"Cannot navigate the session tree while summarization or compaction is in progress. Wait for idle first.",
		);

		releaseFirst.resolve();
		await expect(firstNavigation).resolves.toEqual({ cancelled: false, editorText: "u1 text" });
		expect(beforeTreeCalls).toBe(1);
		expect(session.isCompacting).toBe(false);
	});

	it("clears compaction state when an extension cancels tree navigation", async () => {
		const { session, sessionManager } = trackSessionContext(
			await createHarnessWithExtensions({
				extensionFactories: [
					(dreb) => {
						dreb.on("session_before_tree", () => ({ cancel: true }));
					},
				],
			}),
		);
		const ids = buildBranchedTree(sessionManager);
		const targetId = ids.get("u1 text")!;
		const originalLeafId = sessionManager.getLeafId();
		const originalEntries = sessionManager.getEntries();

		await expect(navigateTreeForRpc(session, targetId)).resolves.toEqual({ cancelled: true });

		expect(sessionManager.getLeafId()).toBe(originalLeafId);
		expect(sessionManager.getEntries()).toEqual(originalEntries);
		expect(session.isCompacting).toBe(false);
	});

	it("rejects summarize when no model is available", async () => {
		const { session, sessionManager } = trackSessionContext(createTestSession({ inMemory: true }));
		const ids = buildBranchedTree(sessionManager);
		vi.spyOn(session, "model", "get").mockReturnValue(undefined);

		await expect(navigateTreeForRpc(session, ids.get("u1 text")!, { summarize: true })).rejects.toThrow(
			"No model available for summarization",
		);
	});
});

describe("RpcClient tree commands", () => {
	it("getTree sends the get_tree command and unwraps tree data", async () => {
		const client = new RpcClient() as any;
		const data: { roots: RpcTreeNode[]; leafId: string | null } = {
			roots: [
				{
					id: "u1",
					parentId: null,
					type: "message",
					role: "user",
					preview: "hello",
					timestamp: "2024-01-01T00:00:00.000Z",
					children: [],
				},
			],
			leafId: "u1",
		};
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "get_tree",
			success: true,
			data,
		});

		await expect(client.getTree()).resolves.toEqual(data);
		expect(client.send).toHaveBeenCalledWith({ type: "get_tree" });
		expect(client.send.mock.calls[0]).toHaveLength(1);
	});

	it("navigateTree uses the five-minute default timeout when no options are provided", async () => {
		const client = new RpcClient() as any;
		const data = { cancelled: false };
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "navigate_tree",
			success: true,
			data,
		});

		await expect(client.navigateTree("u1")).resolves.toEqual(data);
		expect(client.send).toHaveBeenCalledWith({ type: "navigate_tree", targetId: "u1" }, 300000);
	});

	it("navigateTree sends options without timeoutMs and unwraps navigation data", async () => {
		const client = new RpcClient() as any;
		const data = { cancelled: false, editorText: "edit" };
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "navigate_tree",
			success: true,
			data,
		});

		await expect(
			client.navigateTree("u1", {
				summarize: true,
				customInstructions: "custom",
				replaceInstructions: true,
				label: "label",
				timeoutMs: 123,
			}),
		).resolves.toEqual(data);
		expect(client.send).toHaveBeenCalledWith(
			{
				type: "navigate_tree",
				targetId: "u1",
				summarize: true,
				customInstructions: "custom",
				replaceInstructions: true,
				label: "label",
			},
			123,
		);
	});

	it("navigateTree rejects with the RPC error message on failure", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "navigate_tree",
			success: false,
			error: "Entry missing not found",
		});

		await expect(client.navigateTree("missing")).rejects.toThrow("Entry missing not found");
	});
});
