/**
 * Tests for warnInSession() behavior, warnResourceDiagnostics(), AgentSession.reload()
 * diagnostic surfacing, onWarning → informational mapping, configValueWarnings drain,
 * and event queue error recovery.
 *
 * Covers: PR 155 findings 1, 3, 5, 6, 10, 11
 */

import { Agent } from "@dreb/agent-core";
import { findModel } from "@dreb/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ResourceDiagnostic } from "../src/core/diagnostics.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { clearConfigValueCache, configValueWarnings } from "../src/core/resolve-config-value.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createHarness, type Harness } from "./test-harness.js";
import { createTestResourceLoader } from "./utilities.js";

const model = findModel("anthropic", "sonnet")!;

function createMinimalSession(resourceLoader?: ReturnType<typeof createTestResourceLoader>) {
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test.",
			tools: [],
		},
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: new ModelRegistry(authStorage, undefined),
		resourceLoader: resourceLoader ?? createTestResourceLoader(),
	});

	session.subscribe(() => {});

	return { session, agent };
}

// ============================================================================
// Finding 3: warnInSession() streaming vs queuing branches
// ============================================================================

describe("warnInSession", () => {
	it("queues message to _pendingNextTurnMessages when not streaming", () => {
		const { session } = createMinimalSession();
		try {
			expect(session.isStreaming).toBe(false);

			session.warnInSession("disk is full");

			const pending = (session as any)._pendingNextTurnMessages;
			expect(pending).toHaveLength(1);
			expect(pending[0].role).toBe("custom");
			expect(pending[0].customType).toBe("system_warning");
			expect(pending[0].content).toContain("[System Warning] disk is full");
			expect(pending[0].content).toContain("Inform the user about this issue");
			expect(pending[0].display).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("calls agent.steer() when streaming", () => {
		const { session, agent } = createMinimalSession();
		try {
			// Mock isStreaming to return true
			vi.spyOn(agent.state, "isStreaming", "get").mockReturnValue(true);
			const steerSpy = vi.spyOn(agent, "steer");

			session.warnInSession("connection lost");

			expect(steerSpy).toHaveBeenCalledTimes(1);
			const steerArg = steerSpy.mock.calls[0][0] as any;
			expect(steerArg.role).toBe("custom");
			expect(steerArg.customType).toBe("system_warning");
			expect(steerArg.content).toContain("[System Warning] connection lost");

			// Should NOT be in pending queue
			const pending = (session as any)._pendingNextTurnMessages;
			expect(pending).toHaveLength(0);

			steerSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("appends actionable suffix by default", () => {
		const { session } = createMinimalSession();
		try {
			session.warnInSession("something broke");

			const pending = (session as any)._pendingNextTurnMessages;
			expect(pending[0].content).toContain(
				"Inform the user about this issue and ask how they would like to proceed.",
			);
			expect(pending[0].content).not.toContain("Note this for context");
		} finally {
			session.dispose();
		}
	});

	it("appends informational suffix when informational option is true", () => {
		const { session } = createMinimalSession();
		try {
			session.warnInSession("config changed", { informational: true });

			const pending = (session as any)._pendingNextTurnMessages;
			expect(pending[0].content).toContain(
				"Note this for context but do not interrupt the current task to discuss it.",
			);
			expect(pending[0].content).not.toContain("Inform the user about this issue");
		} finally {
			session.dispose();
		}
	});

	it("queues multiple warnings in order", () => {
		const { session } = createMinimalSession();
		try {
			session.warnInSession("first warning");
			session.warnInSession("second warning", { informational: true });
			session.warnInSession("third warning");

			const pending = (session as any)._pendingNextTurnMessages;
			expect(pending).toHaveLength(3);
			expect(pending[0].content).toContain("first warning");
			expect(pending[1].content).toContain("second warning");
			expect(pending[2].content).toContain("third warning");
		} finally {
			session.dispose();
		}
	});
});

// ============================================================================
// Finding 10: AgentSession.reload() diagnostic surfacing
// ============================================================================

describe("AgentSession.reload() diagnostic surfacing", () => {
	it("calls warnInSession with formatted diagnostics after reload", async () => {
		const diagnostics: ResourceDiagnostic[] = [
			{ type: "warning", message: "Skill file has no frontmatter", path: "/skills/bad.md" },
			{ type: "error", message: "Could not parse theme", path: "/themes/broken.json" },
		];

		const resourceLoader = createTestResourceLoader();
		// Inject diagnostics into skills return value
		const originalGetSkills = resourceLoader.getSkills;
		resourceLoader.getSkills = () => ({
			...originalGetSkills(),
			diagnostics,
		});

		const { session } = createMinimalSession(resourceLoader);
		try {
			const warnSpy = vi.spyOn(session, "warnInSession");

			await session.reload();

			expect(warnSpy).toHaveBeenCalledTimes(1);
			const message = warnSpy.mock.calls[0][0];
			expect(message).toContain("Resource loading issues:");
			expect(message).toContain("[warning] Skill file has no frontmatter (/skills/bad.md)");
			expect(message).toContain("[error] Could not parse theme (/themes/broken.json)");

			warnSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("includes extension errors in reload diagnostics", async () => {
		const resourceLoader = createTestResourceLoader();
		const originalGetExtensions = resourceLoader.getExtensions;
		resourceLoader.getExtensions = () => ({
			...originalGetExtensions(),
			errors: [{ path: "/ext/broken.ts", error: "SyntaxError: unexpected token" }],
		});

		const { session } = createMinimalSession(resourceLoader);
		try {
			const warnSpy = vi.spyOn(session, "warnInSession");

			await session.reload();

			expect(warnSpy).toHaveBeenCalledTimes(1);
			const message = warnSpy.mock.calls[0][0];
			expect(message).toContain("Resource loading issues:");
			expect(message).toContain("[error] Extension: /ext/broken.ts: SyntaxError: unexpected token");

			warnSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("does not call warnInSession when reload has no diagnostics", async () => {
		const resourceLoader = createTestResourceLoader();

		const { session } = createMinimalSession(resourceLoader);
		try {
			const warnSpy = vi.spyOn(session, "warnInSession");

			await session.reload();

			expect(warnSpy).not.toHaveBeenCalled();

			warnSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("includes context diagnostics in reload warning", async () => {
		const resourceLoader = createTestResourceLoader();
		resourceLoader.getContextDiagnostics = () => [
			{ type: "error", message: "Could not read AGENTS.md", path: "/project/AGENTS.md" },
		];

		const { session } = createMinimalSession(resourceLoader);
		try {
			const warnSpy = vi.spyOn(session, "warnInSession");

			await session.reload();

			expect(warnSpy).toHaveBeenCalledTimes(1);
			const message = warnSpy.mock.calls[0][0];
			expect(message).toContain("[error] Could not read AGENTS.md (/project/AGENTS.md)");

			warnSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});
});

// ============================================================================
// Finding 1: warnResourceDiagnostics() — shared helper for startup + reload
// ============================================================================

describe("warnResourceDiagnostics", () => {
	it("formats skill, prompt, theme, context diagnostics and extension errors into a single warning", () => {
		const resourceLoader = createTestResourceLoader();
		resourceLoader.getSkills = () => ({
			skills: [],
			diagnostics: [{ type: "warning", message: "Bad frontmatter", path: "/skills/bad.md" }],
		});
		resourceLoader.getPrompts = () => ({
			prompts: [],
			diagnostics: [{ type: "error", message: "Prompt parse failed", path: "/prompts/x.md" }],
		});
		resourceLoader.getContextDiagnostics = () => [
			{ type: "error", message: "Could not read AGENTS.md", path: "/project/AGENTS.md" },
		];

		const { session } = createMinimalSession(resourceLoader);
		try {
			const warnSpy = vi.spyOn(session, "warnInSession");

			session.warnResourceDiagnostics(resourceLoader);

			expect(warnSpy).toHaveBeenCalledTimes(1);
			const message = warnSpy.mock.calls[0][0];
			expect(message).toContain("Resource loading issues:");
			expect(message).toContain("[warning] Bad frontmatter (/skills/bad.md)");
			expect(message).toContain("[error] Prompt parse failed (/prompts/x.md)");
			expect(message).toContain("[error] Could not read AGENTS.md (/project/AGENTS.md)");

			warnSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("includes extension errors", () => {
		const resourceLoader = createTestResourceLoader();
		const originalGetExtensions = resourceLoader.getExtensions;
		resourceLoader.getExtensions = () => ({
			...originalGetExtensions(),
			errors: [{ path: "/ext/broken.ts", error: "SyntaxError" }],
		});

		const { session } = createMinimalSession(resourceLoader);
		try {
			const warnSpy = vi.spyOn(session, "warnInSession");

			session.warnResourceDiagnostics(resourceLoader);

			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0][0]).toContain("[error] Extension: /ext/broken.ts: SyntaxError");

			warnSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("does not call warnInSession when there are no diagnostics or errors", () => {
		const resourceLoader = createTestResourceLoader();

		const { session } = createMinimalSession(resourceLoader);
		try {
			const warnSpy = vi.spyOn(session, "warnInSession");

			session.warnResourceDiagnostics(resourceLoader);

			expect(warnSpy).not.toHaveBeenCalled();

			warnSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});
});

// ============================================================================
// Finding 5: onWarning code → informational mapping
// ============================================================================

describe("onWarning informational mapping", () => {
	it("routes sse_parse_error as informational", () => {
		const { session } = createMinimalSession();
		try {
			const warnSpy = vi.spyOn(session, "warnInSession");

			// Simulate the mapping from sdk.ts onWarning callback
			const code: string = "sse_parse_error";
			const informational =
				code === "sse_parse_error" || code === "ws_parse_error" || code === "json_parse_total_failure";
			session.warnInSession("3 malformed SSE events dropped", { informational });

			expect(warnSpy).toHaveBeenCalledWith("3 malformed SSE events dropped", { informational: true });

			const pending = (session as any)._pendingNextTurnMessages;
			expect(pending[0].content).toContain("Note this for context");
			expect(pending[0].content).not.toContain("Inform the user");

			warnSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("routes ws_parse_error as informational", () => {
		const { session } = createMinimalSession();
		try {
			const code: string = "ws_parse_error";
			const informational =
				code === "sse_parse_error" || code === "ws_parse_error" || code === "json_parse_total_failure";
			session.warnInSession("Malformed WS message", { informational });

			const pending = (session as any)._pendingNextTurnMessages;
			expect(pending[0].content).toContain("Note this for context");
		} finally {
			session.dispose();
		}
	});

	it("routes json_parse_total_failure as informational", () => {
		const { session } = createMinimalSession();
		try {
			const code: string = "json_parse_total_failure";
			const informational =
				code === "sse_parse_error" || code === "ws_parse_error" || code === "json_parse_total_failure";
			session.warnInSession("Both parsers failed", { informational });

			const pending = (session as any)._pendingNextTurnMessages;
			expect(pending[0].content).toContain("Note this for context");
		} finally {
			session.dispose();
		}
	});

	it("routes unknown warning codes as actionable (not informational)", () => {
		const { session } = createMinimalSession();
		try {
			const code: string = "some_other_error";
			const informational =
				code === "sse_parse_error" || code === "ws_parse_error" || code === "json_parse_total_failure";
			session.warnInSession("Something broke", { informational });

			const pending = (session as any)._pendingNextTurnMessages;
			expect(pending[0].content).toContain("Inform the user about this issue");
			expect(pending[0].content).not.toContain("Note this for context");
		} finally {
			session.dispose();
		}
	});
});

// ============================================================================
// Finding 6: configValueWarnings → warnInSession forwarding
// ============================================================================

describe("configValueWarnings forwarding", () => {
	afterEach(() => {
		clearConfigValueCache();
	});

	it("drains configValueWarnings and forwards each to warnInSession", () => {
		const { session } = createMinimalSession();
		try {
			const warnSpy = vi.spyOn(session, "warnInSession");

			// Simulate warnings accumulated during resolveConfigValue
			configValueWarnings.push('Config command "!get-key" exited with status 1');
			configValueWarnings.push('Config command "!other-cmd" failed: ENOENT');

			// Simulate the drain logic from sdk.ts getApiKey callback
			const warnings = configValueWarnings.splice(0);
			for (const w of warnings) {
				session.warnInSession(w);
			}

			expect(warnSpy).toHaveBeenCalledTimes(2);
			expect(warnSpy).toHaveBeenCalledWith('Config command "!get-key" exited with status 1');
			expect(warnSpy).toHaveBeenCalledWith('Config command "!other-cmd" failed: ENOENT');

			// Array should be drained
			expect(configValueWarnings).toHaveLength(0);

			warnSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("splice(0) on empty array produces no warnings", () => {
		const { session } = createMinimalSession();
		try {
			const warnSpy = vi.spyOn(session, "warnInSession");

			// Drain empty array — same pattern as sdk.ts
			const warnings = configValueWarnings.splice(0);
			for (const w of warnings) {
				session.warnInSession(w);
			}

			expect(warnSpy).not.toHaveBeenCalled();

			warnSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});
});

// ============================================================================
// Finding 11: Event queue error recovery
// ============================================================================

describe("event queue error recovery", () => {
	let harness: Harness;

	afterEach(() => {
		harness?.cleanup();
	});

	it("recovers from event processing errors and processes subsequent events", async () => {
		harness = createHarness({ responses: ["first", "second"] });
		const session = harness.session;

		// Make _processAgentEvent throw on the first call, succeed on subsequent calls
		let callCount = 0;
		const originalProcessEvent = (session as any)._processAgentEvent.bind(session);
		const processEventSpy = vi.fn(async (event: any) => {
			callCount++;
			if (callCount === 1) {
				throw new Error("simulated processing failure");
			}
			return originalProcessEvent(event);
		});
		(session as any)._processAgentEvent = processEventSpy;

		const warnSpy = vi.spyOn(session, "warnInSession");

		// First prompt triggers an event that will fail in processing
		await session.prompt("hello").catch(() => {
			// prompt may reject if the event queue error propagates
		});

		// The .catch() on the queue should have called warnInSession
		// Wait a tick for the catch handler to fire
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Event queue error: simulated processing failure"));

		// Restore _processAgentEvent so the second prompt can succeed
		(session as any)._processAgentEvent = originalProcessEvent;

		// Second prompt should still work — the queue recovered
		await session.prompt("world");

		const assistantMessages = session.messages.filter((m) => m.role === "assistant");
		expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

		warnSpy.mockRestore();
	});
});
