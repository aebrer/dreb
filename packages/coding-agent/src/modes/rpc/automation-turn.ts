import type { AgentSession } from "../../core/agent-session.js";
import type { RpcAutomationResult } from "./rpc-types.js";

type AutomationSession = Pick<
	AgentSession,
	"agent" | "isStreaming" | "prompt" | "sendCustomMessage" | "waitForAutomationSettled"
>;

export async function runAutomationTurn(
	session: AutomationSession,
	message: string,
	guardFeedback: boolean,
): Promise<RpcAutomationResult> {
	if (session.isStreaming) throw new Error("Automation session is already working");
	let started = false;
	const dispose = session.agent.subscribe((event) => {
		if (event.type === "agent_start") started = true;
	});
	try {
		if (guardFeedback) {
			await session.sendCustomMessage(
				{ customType: "automation-guard-feedback", content: `Task guard feedback:\n${message}`, display: true },
				{ triggerTurn: true },
			);
		} else {
			await session.prompt(message, { expandPromptTemplates: false, literalAutomationInput: true, source: "rpc" });
		}
		if (!started) throw new Error("The automation prompt did not start a turn");
		await session.waitForAutomationSettled();
		const messages = session.agent.state.messages;
		const last = messages.findLast((entry) => entry.role === "assistant");
		if (!last || last.role !== "assistant") throw new Error("Automation produced no assistant response");
		if (last.stopReason !== "stop") {
			throw new Error(last.errorMessage || `Automation response ended with ${last.stopReason}`);
		}
		const text = last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		const evidence = messages.slice(-24).flatMap((entry) => {
			if (entry.role !== "assistant" && entry.role !== "toolResult") return [];
			const excerpt = entry.content
				.flatMap((part) => {
					if (part.type === "text") return [part.text.slice(0, 3000)];
					if (part.type === "toolCall")
						return [`Tool: ${part.name} ${JSON.stringify(part.arguments).slice(0, 1000)}`];
					return [];
				})
				.join("\n")
				.slice(0, 3000);
			return excerpt
				? [{ role: entry.role === "toolResult" ? `tool:${entry.toolName}` : entry.role, text: excerpt }]
				: [];
		});
		return { text, evidence };
	} finally {
		dispose();
	}
}
