import { describe, expect, it } from "vitest";
import { createWaitToolDefinition, type WaitToolDetails, waitToolDefinition } from "../../src/core/tools/wait.js";

describe("wait tool", () => {
	// Cast execute to skip the ctx parameter (not used by this tool)
	const execute = waitToolDefinition.execute.bind(waitToolDefinition) as (
		toolCallId: string,
		params: { reason?: string },
		signal?: AbortSignal,
		onUpdate?: any,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details?: WaitToolDetails }>;

	it("returns confirmation text with no reason", async () => {
		const result = await execute("call-1", {});

		expect(result.content[0]).toEqual({ type: "text", text: "Waiting…" });
		expect(result.details).toEqual({ reason: undefined });
	});

	it("returns confirmation text with a reason", async () => {
		const result = await execute("call-2", { reason: "background subagent still running" });

		expect(result.content[0]).toEqual({ type: "text", text: "Waiting: background subagent still running" });
		expect(result.details).toEqual({ reason: "background subagent still running" });
	});

	it("trims whitespace-only reason to undefined", async () => {
		const result = await execute("call-3", { reason: "   " });

		expect(result.content[0]).toEqual({ type: "text", text: "Waiting…" });
		expect(result.details).toEqual({ reason: undefined });
	});

	it("trims reason string", async () => {
		const result = await execute("call-4", { reason: "  waiting for agent  " });

		expect(result.content[0]).toEqual({ type: "text", text: "Waiting: waiting for agent" });
		expect(result.details).toEqual({ reason: "waiting for agent" });
	});

	it("returns immediately (is synchronous aside from Promise wrapper)", async () => {
		const start = Date.now();
		await execute("call-5", { reason: "test" });
		const elapsed = Date.now() - start;

		// Should complete in well under 50ms — it's a pure no-op
		expect(elapsed).toBeLessThan(50);
	});

	it("has correct tool metadata", () => {
		expect(waitToolDefinition.name).toBe("wait");
		expect(waitToolDefinition.label).toBe("wait");
		expect(waitToolDefinition.promptSnippet).toBeTruthy();
		expect(waitToolDefinition.promptGuidelines).toBeTruthy();
		expect(waitToolDefinition.promptGuidelines!.length).toBeGreaterThanOrEqual(2);
	});

	it("description mentions ending the turn", () => {
		expect(waitToolDefinition.description).toContain("end your turn");
	});

	it("prompt guidelines scope usage narrowly", () => {
		const guidelines = waitToolDefinition.promptGuidelines!.join(" ");
		expect(guidelines).toContain("explicitly told to wait");
		expect(guidelines).toContain("background subagents");
	});

	describe("createWaitToolDefinition factory", () => {
		it("returns the same shape as the singleton", () => {
			const created = createWaitToolDefinition();
			expect(created.name).toBe("wait");
			expect(created.label).toBe("wait");
			expect(created.description).toBe(waitToolDefinition.description);
		});
	});
});
