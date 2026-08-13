/**
 * Subagent drill-in — live transcript with direct steering while the child is
 * running, hydrated from its on-disk session log so reloads preserve history.
 */

import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { PendingMessagesDto, SubagentArbitrationDto } from "../../shared/protocol.js";
import { api } from "../api.js";
import { StatusChip } from "../components/common.js";
import { Transcript } from "../components/transcript.js";
import { isAbortError } from "../errors.js";
import { bindStickToBottom, createStickToBottom } from "../scrolling.js";
import type { AppStore } from "../state/store.js";
import { autoGrowTextarea } from "./session.js";

function arbitrationLabel(record: SubagentArbitrationDto): string {
	const step = record.step !== undefined ? `step ${record.step}: ` : "";
	if (record.status === "failure")
		return `${step}failed — ${record.errorMessage ?? record.errorCode ?? "unknown error"}`;
	if (!record.final || record.changed.length === 0) {
		return `${step}kept ${record.proposed.agent} · ${record.proposed.model} · ${record.proposed.thinking}`;
	}
	return `${step}${record.changed.join(", ")} changed → ${record.final.agent} · ${record.final.model} · ${record.final.thinking}`;
}

export function SubagentScreen(props: { store: AppStore; sessionKey: string; agentId: string }): JSX.Element {
	const parent = () => props.store.sessions[props.sessionKey];
	const agent = createMemo(() => parent()?.backgroundAgents[props.agentId]);
	const sub = () => parent()?.subagents[props.agentId];
	const runtime = createMemo(() => props.store.fleet().runtimes.find((r) => r.key === props.sessionKey));
	const parentName = () => runtime()?.state.sessionName ?? props.sessionKey;
	const [hydrateError, setHydrateError] = createSignal<string>();
	const [composerText, setComposerText] = createSignal("");
	const [sending, setSending] = createSignal(false);
	const [steerError, setSteerError] = createSignal<string>();
	const [steeringMode, setSteeringMode] = createSignal<"all" | "one-at-a-time">();
	const [pending, setPending] = createSignal<PendingMessagesDto>({ steering: [], followUp: [] });
	const isRunning = () => agent()?.status === "running";
	const isMobile = () => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 700px)").matches;

	let chatRef: HTMLDivElement | undefined;
	let composerRef: HTMLTextAreaElement | undefined;
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
		if (chatRef) onCleanup(bindStickToBottom(stickToBottom, chatRef, { keyboard: "window" }));
	});
	onCleanup(() => stickToBottom.dispose());

	async function refreshPending(): Promise<void> {
		if (!isRunning()) return;
		try {
			const result = await api.subagentPending(props.sessionKey, props.agentId);
			setSteeringMode(result.steeringMode);
			setPending(result.pending);
			setSteerError(undefined);
		} catch (err) {
			setSteerError(err instanceof Error ? err.message : String(err));
		}
	}

	onMount(() => {
		void refreshPending();
		const timer = window.setInterval(() => {
			if (isRunning()) void refreshPending();
		}, 1000);
		onCleanup(() => window.clearInterval(timer));
	});

	createEffect(() => {
		composerText();
		if (composerRef) queueMicrotask(() => composerRef && autoGrowTextarea(composerRef));
	});

	async function sendSteer(): Promise<void> {
		const message = composerText();
		if (!message.trim() || sending() || !isRunning()) return;
		setSending(true);
		setSteerError(undefined);
		try {
			await api.steerSubagent(props.sessionKey, props.agentId, message);
			setComposerText("");
			await refreshPending();
		} catch (err) {
			setSteerError(err instanceof Error ? err.message : String(err));
		} finally {
			setSending(false);
		}
	}

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

			<main class="chat" ref={chatRef}>
				<div class="chat-inner" ref={chatInnerRef}>
					<Show when={(agent()?.arbitrations?.length ?? 0) > 0}>
						<div class="status-line arbitration-history">
							<For each={agent()?.arbitrations ?? []}>
								{(record) => (
									<span class={record.status === "failure" ? "error-reason" : "muted"}>
										arbiter: {arbitrationLabel(record)}
									</span>
								)}
							</For>
						</div>
					</Show>
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
							imageScope={{ runtimeKey: props.sessionKey, agentId: props.agentId }}
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
					<Show
						when={isRunning()}
						fallback={
							<div class="readonly-note">This subagent is no longer running; its transcript is read-only.</div>
						}
					>
						<Show when={steerError()}>
							<p class="pair-error">{steerError()}</p>
						</Show>
						<Show when={pending().steering.length > 0}>
							<output class="pending-chips" aria-label="pending subagent steering messages">
								<For each={pending().steering}>
									{(message) => <span class="pending-chip">steer: {message}</span>}
								</For>
							</output>
						</Show>
						<div class="composer">
							<textarea
								ref={composerRef}
								placeholder="Steer this subagent…"
								value={composerText()}
								disabled={sending()}
								onInput={(event) => {
									setComposerText(event.currentTarget.value);
									autoGrowTextarea(event.currentTarget);
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey && !isMobile()) {
										event.preventDefault();
										void sendSteer();
									}
								}}
							/>
							<div class="composer-row">
								<span class="muted">steering delivery: {steeringMode() ?? "loading…"}</span>
								<button
									type="button"
									class="btn btn-primary btn-small send"
									disabled={sending() || composerText().trim().length === 0}
									onClick={() => void sendSteer()}
								>
									{sending() ? "sending…" : "steer ↵"}
								</button>
							</div>
						</div>
					</Show>
				</div>
			</footer>
		</div>
	);
}
