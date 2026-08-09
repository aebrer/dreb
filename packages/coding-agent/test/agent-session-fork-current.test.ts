/**
 * Tests for AgentSession.forkFromCurrent().
 *
 * Unlike fork(), which rewinds to *before* a selected user message, forkFromCurrent()
 * branches from the current leaf — so the new branch includes the last model response.
 *
 * These run offline (no live API): the conversation is constructed by appending
 * messages directly to the in-memory SessionManager, then forkFromCurrent() reloads
 * the branch via buildSessionContext + replaceMessages.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createHarnessWithExtensions, type Harness } from "./test-harness.js";
import { assistantMsg, userMsg } from "./utilities.js";

describe("AgentSession.forkFromCurrent", () => {
	let harness: Harness;

	afterEach(() => {
		harness?.cleanup();
	});

	it("includes the last model response in the forked branch", async () => {
		harness = await createHarnessWithExtensions();
		const { session, sessionManager } = harness;

		// Conversation: q1 -> a1 -> q2 -> a2 (a2 is the last model response)
		sessionManager.appendMessage(userMsg("q1"));
		sessionManager.appendMessage(assistantMsg("a1"));
		sessionManager.appendMessage(userMsg("q2"));
		const lastAssistantId = sessionManager.appendMessage(assistantMsg("a2"));
		expect(sessionManager.getLeafId()).toBe(lastAssistantId);

		const result = await session.forkFromCurrent();
		expect(result.cancelled).toBe(false);

		// The full conversation survives and the tail is the last assistant response.
		expect(session.messages).toHaveLength(4);
		const tail = session.messages.at(-1)!;
		expect(tail.role).toBe("assistant");
		expect(JSON.stringify(tail)).toContain("a2");

		// A new session was branched (fresh id), still tracking the conversation.
		expect(sessionManager.getLeafId()).not.toBeNull();
	});

	it("is a no-op that returns cancelled for an empty session", async () => {
		harness = await createHarnessWithExtensions();
		const { session, sessionManager } = harness;

		expect(sessionManager.getLeafId()).toBeNull();

		const result = await session.forkFromCurrent();
		expect(result.cancelled).toBe(true);
		expect(session.messages).toHaveLength(0);
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
		sessionManager.appendMessage(assistantMsg("a1"));
		const leafBefore = sessionManager.getLeafId();
		const entriesBefore = sessionManager.getEntries();

		const result = await session.forkFromCurrent();
		expect(result.cancelled).toBe(true);

		// Cancellation must not branch or mutate the session.
		expect(sessionManager.getLeafId()).toBe(leafBefore);
		expect(sessionManager.getEntries()).toEqual(entriesBefore);
	});
});
