import { expect, it, vi } from "vitest";
import { allowsAutomationTool } from "../src/core/automation.js";
import { runAutomationTurn } from "../src/modes/rpc/automation-turn.js";

type Session = Parameters<typeof runAutomationTurn>[0];

function stub(stopReason = "stop", emitStart = true) {
	let started: ((event: { type: string }) => void) | undefined;
	const dispose = vi.fn();
	const session = {
		isStreaming: false,
		prompt: vi.fn(async () => {
			if (emitStart) started?.({ type: "agent_start" });
		}),
		sendCustomMessage: vi.fn(async () => started?.({ type: "agent_start" })),
		waitForAutomationSettled: vi.fn(async () => {}),
		agent: {
			subscribe: vi.fn((listener) => {
				started = listener;
				return dispose;
			}),
			state: {
				messages: [
					{
						role: "assistant",
						stopReason,
						errorMessage: stopReason === "error" ? "model unavailable" : undefined,
						content: [
							{ type: "thinking", thinking: "not evidence" },
							{ type: "text", text: "Final work report" },
						],
					},
				],
			},
		},
	};
	return { session, input: session as unknown as Session, dispose };
}

it("uses literal startup input and returns only once session work has settled", async () => {
	const { session, input, dispose } = stub();
	let release!: () => void;
	session.waitForAutomationSettled.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const finished = vi.fn();
	const awaiting = runAutomationTurn(input, "/this is task text", false).then(finished);
	await vi.waitFor(() => expect(session.waitForAutomationSettled).toHaveBeenCalledOnce());
	expect(finished).not.toHaveBeenCalled();
	expect(session.prompt).toHaveBeenCalledWith(
		"/this is task text",
		expect.objectContaining({ expandPromptTemplates: false, literalAutomationInput: true }),
	);
	release();
	await awaiting;
	expect(finished).toHaveBeenCalledWith({
		text: "Final work report",
		evidence: [{ role: "assistant", text: "Final work report" }],
	});
	expect(dispose).toHaveBeenCalledOnce();
});

it("delivers findings as guard feedback, not a new user-authored prompt", async () => {
	const { session, input } = stub();
	await runAutomationTurn(input, "Check the public API", true);
	expect(session.prompt).not.toHaveBeenCalled();
	expect(session.sendCustomMessage).toHaveBeenCalledWith(
		{ customType: "automation-guard-feedback", content: "Task guard feedback:\nCheck the public API", display: true },
		{ triggerTurn: true },
	);
});

it("rejects provider failures, aborted turns, and requests that did not start", async () => {
	await expect(runAutomationTurn(stub("error").input, "Work", false)).rejects.toThrow("model unavailable");
	await expect(runAutomationTurn(stub("aborted").input, "Work", false)).rejects.toThrow("aborted");
	await expect(runAutomationTurn(stub("stop", false).input, "Work", false)).rejects.toThrow("did not start");
});

it("keeps work tools but excludes ask_user, and limits setup and guard to inspection", () => {
	expect(allowsAutomationTool(undefined, "ask_user")).toBe(true);
	expect(allowsAutomationTool("worker", "ask_user")).toBe(false);
	expect(allowsAutomationTool("worker", "edit")).toBe(true);
	expect(allowsAutomationTool("guard", "edit")).toBe(false);
	expect(allowsAutomationTool("guard", "read")).toBe(true);
	expect(allowsAutomationTool("setup", "write")).toBe(false);
});
