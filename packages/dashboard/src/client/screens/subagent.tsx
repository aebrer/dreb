/**
 * Subagent drill-in — read-only live view of a background agent's transcript
 * via the event relay, hydrated from the agent's on-disk session log so the
 * view survives browser reloads. No composer: a fixed note explains
 * the parent controls this agent.
 */

import { createEffect, createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { StatusChip } from "../components/common.js";
import { Transcript } from "../components/transcript.js";
import { isAbortError } from "../errors.js";
import { createStickToBottom } from "../scrolling.js";
import type { AppStore } from "../state/store.js";

export function SubagentScreen(props: { store: AppStore; sessionKey: string; agentId: string }): JSX.Element {
	const parent = () => props.store.sessions[props.sessionKey];
	const agent = createMemo(() => parent()?.backgroundAgents[props.agentId]);
	const sub = () => parent()?.subagents[props.agentId];
	const runtime = createMemo(() => props.store.fleet().runtimes.find((r) => r.key === props.sessionKey));
	const parentName = () => runtime()?.state.sessionName ?? props.sessionKey;
	const [hydrateError, setHydrateError] = createSignal<string>();

	let chatRef: HTMLDivElement | undefined;
	let chatInnerRef: HTMLDivElement | undefined;
	const stickToBottom = createStickToBottom({ scroller: () => chatRef });

	onMount(() => {
		const hydration = new AbortController();
		// Hydrate from the on-disk session log: after a reload the live relay
		// state is gone, and even mid-run the log carries everything so far.
		props.store.hydrateSubagent(props.sessionKey, props.agentId, hydration.signal).catch((err) => {
			if (hydration.signal.aborted && isAbortError(err)) return;
			setHydrateError(err instanceof Error ? err.message : String(err));
		});
		onCleanup(() => hydration.abort());
	});

	// Stick-to-bottom autoscroll during streaming (revision bumps per envelope).
	createEffect(() => {
		props.store.revisions[props.sessionKey];
		stickToBottom.notifyContentChanged();
	});
	// Re-pin when content grows asynchronously (e.g. late syntax highlighting) and
	// when the scroll viewport resizes (surrounding chrome changing clientHeight
	// with no content change and no scroll event).
	onMount(() => {
		stickToBottom.observeContent(chatInnerRef);
		stickToBottom.observeViewport(chatRef);
	});
	onCleanup(() => stickToBottom.dispose());

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

			<main
				class="chat"
				ref={chatRef}
				onTouchStart={() => stickToBottom.handleTouchStart()}
				onTouchEnd={() => stickToBottom.handleTouchEnd()}
				onTouchCancel={() => stickToBottom.handleTouchCancel()}
				onScroll={() => stickToBottom.handleScroll()}
			>
				<div class="chat-inner" ref={chatInnerRef}>
					<Show when={hydrateError()}>
						<p class="pair-error">{hydrateError()}</p>
					</Show>
					<Show
						when={sub() && sub()!.entries.length > 0}
						fallback={
							<p class="muted">
								{agent()
									? "waiting for output from this agent…"
									: "no data for this agent — it may not have started writing its session log yet."}
							</p>
						}
					>
						<Transcript
							entries={sub()!.entries}
							who={agent()?.agentType ?? "agent"}
							userLabel="task from parent"
							resetKey={`${props.sessionKey}:${props.agentId}`}
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
