/**
 * Subagent drill-in — read-only live view of a background agent's transcript
 * via the event relay. No composer (SPEC §5a): a fixed note explains the
 * parent controls this agent.
 */

import { createMemo, type JSX, Show } from "solid-js";
import { StatusChip } from "../components/common.js";
import { Transcript } from "../components/transcript.js";
import type { AppStore } from "../state/store.js";

export function SubagentScreen(props: { store: AppStore; sessionKey: string; agentId: string }): JSX.Element {
	const parent = () => props.store.sessions[props.sessionKey];
	const agent = createMemo(() => parent()?.backgroundAgents[props.agentId]);
	const sub = () => parent()?.subagents[props.agentId];
	const runtime = createMemo(() => props.store.fleet().runtimes.find((r) => r.key === props.sessionKey));
	const parentName = () => runtime()?.state.sessionName ?? props.sessionKey;

	return (
		<div class="session-screen">
			<header class="session-bar">
				<div class="session-bar-inner">
					<a class="back" href={`#/session/${props.sessionKey}`}>
						← {parentName()}
					</a>
					<span class="agent-type">subagent · {agent()?.agentType ?? "unknown"}</span>
					<span class="title">{agent()?.taskSummary ?? props.agentId}</span>
					<span class="right">
						<Show
							when={agent()?.status === "running"}
							fallback={
								<StatusChip status={agent()?.status === "failed" ? "error" : "idle"} label={agent()?.status} />
							}
						>
							<StatusChip status="running" />
						</Show>
					</span>
				</div>
			</header>

			<main class="chat">
				<div class="chat-inner">
					<Show
						when={sub() && sub()!.entries.length > 0}
						fallback={
							<p class="muted">
								{agent()
									? "waiting for relayed events from this agent…"
									: "no live data for this agent — it may have finished before this view opened. Its session log is on disk."}
							</p>
						}
					>
						<Transcript
							entries={sub()!.entries}
							who={agent()?.agentType ?? "agent"}
							userLabel="task from parent"
						/>
					</Show>
				</div>
			</main>

			<footer class="dock">
				<div class="dock-inner">
					<Show when={sub()?.streaming}>
						<div class="status-line">
							<span class="working">● working</span>
						</div>
					</Show>
					<div class="readonly-note">
						viewing live — subagents can't be steered yet; the parent session controls this agent.
					</div>
				</div>
			</footer>
		</div>
	);
}
