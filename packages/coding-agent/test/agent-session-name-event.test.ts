import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { createTestSession } from "./utilities.js";

describe("AgentSession session name events", () => {
	it("emits session_name_changed after persisting the new name", () => {
		const { session, cleanup } = createTestSession({ inMemory: true });
		const events: AgentSessionEvent[] = [];
		const unsubscribe = session.subscribe((event) => events.push(event));

		try {
			session.setSessionName("Dashboard Session");

			expect(session.sessionName).toBe("Dashboard Session");
			expect(events).toContainEqual({ type: "session_name_changed", name: "Dashboard Session" });
		} finally {
			unsubscribe();
			cleanup();
		}
	});
});
