/**
 * Tests for AgentSession.fork() — forking at any transcript position.
 *
 * The fork point may be any user or assistant message. Role determines semantics:
 *   - assistant → branch *includes* the selected response (continue from that answer),
 *     with no editor pre-fill. Forking at the last assistant keeps the whole state.
 *   - user → rewind to *before* the selected question (drop it and everything after)
 *     and offer its text as editor pre-fill.
 *
 * These run offline (no live API): the conversation is constructed by appending
 * messages directly to the in-memory SessionManager, then fork() reloads the branch
 * via buildSessionContext + replaceMessages.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createHarnessWithExtensions, type Harness } from "./test-harness.js";
import { assistantMsg, userMsg } from "./utilities.js";

describe("AgentSession.fork — any message", () => {
	let harness: Harness;

	afterEach(() => {
		harness?.cleanup();
	});

	it("forking at the last assistant message keeps the full state (incl. last response)", async () => {
		harness = await createHarnessWithExtensions();
		const { session, sessionManager } = harness;

		// q1 -> a1 -> q2 -> a2 (a2 is the last model response)
		sessionManager.appendMessage(userMsg("q1"));
		sessionManager.appendMessage(assistantMsg("a1"));
		sessionManager.appendMessage(userMsg("q2"));
		const lastAssistantId = sessionManager.appendMessage(assistantMsg("a2"));
		expect(sessionManager.getLeafId()).toBe(lastAssistantId);

		const result = await session.fork(lastAssistantId);
		expect(result.cancelled).toBe(false);
		// No re-ask pre-fill when forking at an assistant message.
		expect(result.selectedText).toBe("");

		// The full conversation survives and the tail is the last assistant response.
		expect(session.messages).toHaveLength(4);
		const tail = session.messages.at(-1)!;
		expect(tail.role).toBe("assistant");
		expect(JSON.stringify(tail)).toContain("a2");
		expect(sessionManager.getLeafId()).not.toBeNull();
	});

	it("forking at an earlier assistant message includes up to and including it", async () => {
		harness = await createHarnessWithExtensions();
		const { session, sessionManager } = harness;

		sessionManager.appendMessage(userMsg("q1"));
		const a1Id = sessionManager.appendMessage(assistantMsg("a1"));
		sessionManager.appendMessage(userMsg("q2"));
		sessionManager.appendMessage(assistantMsg("a2"));

		const result = await session.fork(a1Id);
		expect(result.cancelled).toBe(false);
		expect(result.selectedText).toBe("");

		// Branch is q1 -> a1; q2/a2 are dropped and the tail is a1.
		expect(session.messages).toHaveLength(2);
		const tail = session.messages.at(-1)!;
		expect(tail.role).toBe("assistant");
		expect(JSON.stringify(tail)).toContain("a1");
	});

	it("forking at a user message rewinds to before it and offers its text as pre-fill", async () => {
		harness = await createHarnessWithExtensions();
		const { session, sessionManager } = harness;

		sessionManager.appendMessage(userMsg("q1"));
		sessionManager.appendMessage(assistantMsg("a1"));
		const q2Id = sessionManager.appendMessage(userMsg("q2"));
		sessionManager.appendMessage(assistantMsg("a2"));

		const result = await session.fork(q2Id);
		expect(result.cancelled).toBe(false);
		// The selected question is offered for editing/re-asking.
		expect(result.selectedText).toBe("q2");

		// Branch is q1 -> a1 (before q2); q2 and everything after are dropped.
		expect(session.messages).toHaveLength(2);
		const tail = session.messages.at(-1)!;
		expect(tail.role).toBe("assistant");
		expect(JSON.stringify(tail)).toContain("a1");
	});

	it("throws for a non-message / invalid entry id", async () => {
		harness = await createHarnessWithExtensions();
		const { session, sessionManager } = harness;
		sessionManager.appendMessage(userMsg("q1"));

		await expect(session.fork("does-not-exist")).rejects.toThrow(/Invalid entry ID/);
	});

	it("can be cancelled by a session_before_fork extension handler", async () => {
		harness = await createHarnessWithExtensions({
			extensionFactories: [
				(dreb) => {
					dreb.on("session_before_fork", async () => ({ cancel: true }));
				},
			],
		});
		const { session, sessionManager } = harness;

		sessionManager.appendMessage(userMsg("q1"));
		const a1Id = sessionManager.appendMessage(assistantMsg("a1"));
		const leafBefore = sessionManager.getLeafId();
		const entriesBefore = sessionManager.getEntries();

		const result = await session.fork(a1Id);
		expect(result.cancelled).toBe(true);

		// Cancellation must not branch or mutate the session.
		expect(sessionManager.getLeafId()).toBe(leafBefore);
		expect(sessionManager.getEntries()).toEqual(entriesBefore);
	});

	it("skips the conversation restore when a session_before_fork handler requests it", async () => {
		harness = await createHarnessWithExtensions({
			extensionFactories: [
				(dreb) => {
					dreb.on("session_before_fork", async () => ({ skipConversationRestore: true }));
				},
			],
		});
		const { session, sessionManager } = harness;

		sessionManager.appendMessage(userMsg("q1"));
		const a1Id = sessionManager.appendMessage(assistantMsg("a1"));

		const result = await session.fork(a1Id);
		expect(result.cancelled).toBe(false);

		// The branch was created (new leaf tracked)...
		expect(sessionManager.getLeafId()).not.toBeNull();
		// ...but agent.replaceMessages was skipped, so the in-memory conversation is
		// NOT reloaded from the branch (stays empty here, since nothing was streamed).
		expect(session.messages).toHaveLength(0);
	});

	it("emits session_fork exactly once after the branch is created", async () => {
		const forkEvents: Array<{ type: string }> = [];
		harness = await createHarnessWithExtensions({
			extensionFactories: [
				(dreb) => {
					dreb.on("session_fork", async (event) => {
						forkEvents.push(event);
					});
				},
			],
		});
		const { session, sessionManager } = harness;

		sessionManager.appendMessage(userMsg("q1"));
		const a1Id = sessionManager.appendMessage(assistantMsg("a1"));

		const result = await session.fork(a1Id);
		expect(result.cancelled).toBe(false);
		expect(forkEvents).toHaveLength(1);
		expect(forkEvents[0].type).toBe("session_fork");
	});

	it("does not emit session_fork when a session_before_fork handler cancels", async () => {
		const forkEvents: Array<{ type: string }> = [];
		harness = await createHarnessWithExtensions({
			extensionFactories: [
				(dreb) => {
					dreb.on("session_before_fork", async () => ({ cancel: true }));
					dreb.on("session_fork", async (event) => {
						forkEvents.push(event);
					});
				},
			],
		});
		const { session, sessionManager } = harness;

		sessionManager.appendMessage(userMsg("q1"));
		const a1Id = sessionManager.appendMessage(assistantMsg("a1"));

		const result = await session.fork(a1Id);
		expect(result.cancelled).toBe(true);
		expect(forkEvents).toHaveLength(0);
	});
});
