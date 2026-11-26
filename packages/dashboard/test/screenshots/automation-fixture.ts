import type { RpcEvent } from "@dreb/coding-agent/rpc";
import type { AutomationRun } from "../../src/shared/automation.js";
import { FIXTURE_PROJECTS, type LiveRuntimeScenario, NOW_MS } from "./scenario.js";
import type { AssistantMessage } from "./session-builder.js";

/** Persist finished runs only: no running orchestrator, discovery or host session files. */
export function automationHistory(setupFile: string): Array<AutomationRun & { owner: "local" }> {
	const model = { provider: "fixture", model: "offline", tools: [] };
	return [
		{
			owner: "local",
			id: "station-cache-review",
			draft: {
				cwd: FIXTURE_PROJECTS.tidewatch,
				instructions: "Verify the station cache offline",
				orchestrator: model,
				guard: model,
			},
			status: "stopped",
			startedAt: NOW_MS - 720_000,
			endedAt: NOW_MS - 120_000,
			compactions: 1,
			decisions: [{ at: NOW_MS - 120_000, action: "stop", report: "All offline cache checks passed." }],
			setupFile,
			guardFiles: [],
			report: "Station data is available without a network connection.",
		},
	];
}

/** The browser test releases each SSE update only after observing the preceding frame. */
export class SetupTurns {
	private reply?: AssistantMessage;
	private text = "";
	private configured = false;

	constructor(
		private readonly runtime: LiveRuntimeScenario,
		private readonly emit: (event: RpcEvent) => void,
	) {}

	configure(config: { role: string }): void {
		if (this.configured || config.role !== "setup" || Object.keys(config).length !== 1)
			throw new Error("Expected one configureAutomation({ role: 'setup' })");
		this.configured = true;
	}

	get streaming(): boolean {
		return !!this.reply;
	}

	prompt(text: string): void {
		if (!this.configured || this.reply) throw new Error("Expected ordinary prompt on idle, configured setup session");
		const { model, session } = this.runtime;
		const user = { role: "user" as const, content: text, timestamp: NOW_MS + session.messages.length };
		this.text = "";
		this.reply = {
			role: "assistant",
			provider: model.provider,
			model: model.id,
			api: model.api,
			content: [],
			timestamp: user.timestamp + 1,
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				totalTokens: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		session.messages.push(user);
		this.emit({ type: "agent_start", model: { provider: model.provider, id: model.id } });
		this.emit({ type: "message_start", message: user });
		this.emit({ type: "message_end", message: user });
	}

	delta(delta: string): void {
		if (!this.reply) throw new Error("No pending fixture reply");
		if (!this.text) {
			this.emit({ type: "message_start", message: this.reply });
			this.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
		}
		this.text += delta;
		this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
	}

	finish(reason: "stop" | "error" | "aborted", errorMessage?: string): void {
		if (!this.reply) throw new Error("No pending fixture reply");
		if (!this.text) this.emit({ type: "message_start", message: this.reply });
		else
			this.emit({
				type: "message_update",
				assistantMessageEvent: { type: "text_end", contentIndex: 0, content: this.text },
			});
		const message: AssistantMessage = {
			...this.reply,
			content: this.text ? [{ type: "text", text: this.text }] : [],
			stopReason: reason,
			errorMessage,
		};
		this.reply = undefined;
		this.runtime.session.messages.push(message);
		this.emit({ type: "message_end", message });
		this.emit({ type: "agent_end", messages: [message] });
	}
}
