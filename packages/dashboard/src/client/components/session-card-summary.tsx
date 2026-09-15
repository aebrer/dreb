/** Display-only live-session summary shared by fleet cards and sidebar buttons. */
import { For, type JSX, Show } from "solid-js";
import type { RuntimeInfoDto } from "../../shared/protocol.js";
import { pendingQuestionsReason } from "../state/reducer.js";
import type { AppStore } from "../state/store.js";
import { relativeTime, runtimeStatus, StatusChip } from "./common.js";

export function sessionCardStatus(store: AppStore, runtime: RuntimeInfoDto): ReturnType<typeof runtimeStatus> {
	return store.sessions[runtime.key]?.lastError ? "error" : runtimeStatus(runtime);
}

export function latestAssistantPreview(store: AppStore, runtime: RuntimeInfoDto): string | undefined {
	const entries = store.sessions[runtime.key]?.entries ?? [];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.kind !== "assistant") continue;
		const text = entry.blocks
			.filter((block) => block.kind === "text")
			.map((block) => block.text)
			.join("")
			.trim();
		if (text) return text.slice(0, 200);
	}
	return runtime.lastAssistantText?.slice(0, 200);
}

export function SessionCardSummary(props: { store: AppStore; runtime: RuntimeInfoDto }): JSX.Element {
	const session = () => props.store.sessions[props.runtime.key];
	const status = () => sessionCardStatus(props.store, props.runtime);
	const liveAgents = () => props.runtime.backgroundAgents.filter((a) => a.status === "running");
	const doneAgents = () => props.runtime.backgroundAgents.filter((a) => a.status !== "running");
	const tasks = () => session()?.tasks ?? props.runtime.state.tasks ?? [];
	const tasksDone = () => tasks().filter((t) => t.status === "completed").length;
	const ctx = () => props.runtime.state.contextUsage;
	const model = () => props.runtime.state.model;
	const historicalSession = () =>
		props.store.fleet().diskSessions.find((candidate) => candidate.path === props.runtime.state.sessionFile);
	const historicalCwd = () => {
		const historical = historicalSession();
		if (!historical || historical.cwd === props.runtime.cwd) return undefined;
		return historical.cwd;
	};
	const activity = () => {
		const s = session();
		if (s?.workingText) return `▸ ${s.workingText}`;
		if (s?.suggestedCommand) return `suggested next: ${s.suggestedCommand}`;
		return latestAssistantPreview(props.store, props.runtime);
	};

	// Phrasing content only: this summary is also used inside a native button.
	return (
		<>
			<span class="session-title">
				<span class="name">
					{session()?.sessionName ?? props.runtime.state.sessionName ?? props.runtime.state.sessionId.slice(0, 8)}
				</span>
				<StatusChip status={status()} />
			</span>
			<span class="session-project" title={props.runtime.cwd}>
				{props.runtime.cwd.replace(/^\/home\/[^/]+/, "~")}
			</span>
			<Show when={historicalCwd()}>
				<span class="historical-cwd" title={historicalCwd()}>
					originally {historicalCwd()!.replace(/^\/home\/[^/]+/, "~")}
				</span>
			</Show>
			<Show when={runtimeStatus(props.runtime) === "attention"}>
				<span class="attention-reason">
					{pendingQuestionsReason(session()?.uiRequests ?? []) ?? "needs attention"}
				</span>
			</Show>
			<Show when={props.runtime.error ?? session()?.lastError}>
				<span class="error-reason">{props.runtime.error ?? session()?.lastError}</span>
			</Show>
			<Show when={activity()}>
				<span class="activity">{activity()}</span>
			</Show>
			<Show when={props.runtime.backgroundAgents.length > 0}>
				<span class="subagents">
					<span>
						⚡ {liveAgents().length} running · {doneAgents().length} done
					</span>
					<For each={liveAgents().slice(0, 3)}>
						{(agent) => (
							<span class="agent-line">
								<span class="live">●</span> {agent.agentType} — {agent.taskSummary}
							</span>
						)}
					</For>
				</span>
			</Show>
			<span class="session-meta">
				<Show when={tasks().length > 0}>
					<span>
						tasks {tasksDone()}/{tasks().length}
					</span>
					<span>·</span>
				</Show>
				<Show when={model()}>
					<span>
						{model()!.provider}/{model()!.id}
					</span>
					<span>·</span>
				</Show>
				<Show when={ctx() && ctx()!.percent !== null}>
					<span>ctx {ctx()!.percent!.toFixed(0)}%</span>
					<span>·</span>
				</Show>
				<Show when={props.runtime.stats}>
					<span>${props.runtime.stats!.cost.toFixed(2)}</span>
					<span>·</span>
				</Show>
				<span>{props.runtime.state.messageCount} msgs</span>
				<span>·</span>
				<span>{relativeTime(props.runtime.lastActivity)}</span>
			</span>
		</>
	);
}
