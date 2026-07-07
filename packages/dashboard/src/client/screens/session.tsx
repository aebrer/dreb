/**
 * Session view — full-parity chat drill-in. Transcript, dock (tasks, subagent
 * strip, status line, composer with steer/follow-up modes + abort),
 * session bar with model/thinking switchers, extension-UI modals.
 */

import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { ModelInfoDto } from "../../shared/protocol.js";
import { api } from "../api.js";
import { Modal } from "../components/common.js";
import { Transcript } from "../components/transcript.js";
import type { ExtensionUiRequest, SessionViewState } from "../state/reducer.js";
import type { AppStore } from "../state/store.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

function ExtensionUiModal(props: {
	request: ExtensionUiRequest;
	onRespond: (response: Record<string, unknown>) => void;
}): JSX.Element {
	const [text, setText] = createSignal(props.request.prefill ?? "");
	const respond = (body: Record<string, unknown>) =>
		props.onRespond({ type: "extension_ui_response", id: props.request.id, ...body });

	return (
		<Modal
			title={props.request.title}
			onDismiss={() => respond({ cancelled: true })}
			actions={
				<Show when={props.request.method !== "select"}>
					<button type="button" class="btn btn-small" onClick={() => respond({ cancelled: true })}>
						cancel
					</button>
					<Show when={props.request.method === "confirm"}>
						<button type="button" class="btn btn-small btn-primary" onClick={() => respond({ confirmed: true })}>
							confirm
						</button>
					</Show>
					<Show when={props.request.method === "input" || props.request.method === "editor"}>
						<button type="button" class="btn btn-small btn-primary" onClick={() => respond({ value: text() })}>
							submit
						</button>
					</Show>
				</Show>
			}
		>
			<Show when={props.request.message}>
				<p style={{ "margin-bottom": "12px" }}>{props.request.message}</p>
			</Show>
			<Show when={props.request.method === "select"}>
				<div class="recent-projects">
					<For each={props.request.options ?? []}>
						{(option) => (
							<button type="button" onClick={() => respond({ value: option })}>
								{option}
							</button>
						)}
					</For>
				</div>
			</Show>
			<Show when={props.request.method === "input"}>
				<div class="field">
					<input
						type="text"
						value={text()}
						placeholder={props.request.placeholder}
						onInput={(e) => setText(e.currentTarget.value)}
					/>
				</div>
			</Show>
			<Show when={props.request.method === "editor"}>
				<div class="field">
					<textarea rows="8" value={text()} onInput={(e) => setText(e.currentTarget.value)} />
				</div>
			</Show>
		</Modal>
	);
}

function ModelSelectorModal(props: { sessionKey: string; onClose: () => void; onSelected: () => void }): JSX.Element {
	const [models, setModels] = createSignal<ModelInfoDto[]>([]);
	const [filter, setFilter] = createSignal("");
	const [error, setError] = createSignal<string>();

	onMount(async () => {
		try {
			const { models } = await api.models(props.sessionKey);
			setModels(models);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	});

	const filtered = createMemo(() => {
		const q = filter().toLowerCase();
		return models().filter((m) => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q));
	});

	return (
		<Modal title="select model" onDismiss={props.onClose}>
			<div class="field" style={{ "margin-bottom": "8px" }}>
				<input
					type="text"
					placeholder="search models…"
					value={filter()}
					onInput={(e) => setFilter(e.currentTarget.value)}
				/>
			</div>
			<Show when={error()}>
				<p class="pair-error">{error()}</p>
			</Show>
			<div class="recent-projects" style={{ "max-height": "300px" }}>
				<For each={filtered().slice(0, 50)}>
					{(model) => (
						<button
							type="button"
							onClick={async () => {
								try {
									await api.setModel(props.sessionKey, model.provider, model.id);
									props.onSelected();
									props.onClose();
								} catch (err) {
									setError(err instanceof Error ? err.message : String(err));
								}
							}}
						>
							{model.provider}/{model.id}
							{model.reasoning ? " ·think" : ""}
						</button>
					)}
				</For>
			</div>
		</Modal>
	);
}

export function SessionScreen(props: { store: AppStore; sessionKey: string }): JSX.Element {
	const session = (): SessionViewState | undefined => props.store.sessions[props.sessionKey];
	const runtime = createMemo(() => props.store.fleet().runtimes.find((r) => r.key === props.sessionKey));

	const [composerText, setComposerText] = createSignal("");
	const [sendMode, setSendMode] = createSignal<"steer" | "follow_up">("steer");
	const [showModelSelector, setShowModelSelector] = createSignal(false);
	const [showOverflow, setShowOverflow] = createSignal(false);
	const [showCompactModal, setShowCompactModal] = createSignal(false);
	const [showRenameModal, setShowRenameModal] = createSignal(false);
	const [fallbackDismissed, setFallbackDismissed] = createSignal(false);
	const [actionError, setActionError] = createSignal<string>();
	const [elapsed, setElapsed] = createSignal(0);

	let chatRef: HTMLDivElement | undefined;
	let autoScroll = true;

	onMount(() => {
		props.store.hydrateSession(props.sessionKey).catch((err) => {
			setActionError(err instanceof Error ? err.message : String(err));
		});
	});

	// Elapsed timer for the status line.
	const timer = setInterval(() => {
		const since = session()?.workingSince;
		setElapsed(since ? Math.floor((Date.now() - since) / 1000) : 0);
	}, 1000);
	onCleanup(() => clearInterval(timer));

	// Composer prefill from set_editor_text / fork.
	createEffect(() => {
		const prefill = session()?.composerPrefill;
		if (prefill) setComposerText(prefill);
	});

	// Auto-scroll on new entries unless the user scrolled up.
	createEffect(() => {
		session()?.entries.length;
		if (autoScroll && chatRef) chatRef.scrollTop = chatRef.scrollHeight;
	});

	const streaming = () => session()?.streaming ?? false;

	async function send() {
		const text = composerText().trim();
		if (!text) return;
		setActionError(undefined);
		try {
			if (streaming()) {
				await api.prompt(props.sessionKey, text, sendMode());
			} else {
				await api.prompt(props.sessionKey, text);
			}
			setComposerText("");
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		}
	}

	async function abort() {
		try {
			await api.abort(props.sessionKey);
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		}
	}

	const liveAgents = () => Object.values(session()?.backgroundAgents ?? {}).filter((a) => a.status === "running");
	const doneAgents = () => Object.values(session()?.backgroundAgents ?? {}).filter((a) => a.status !== "running");
	const tasks = () => session()?.tasks ?? [];
	const tasksDone = () => tasks().filter((t) => t.status === "completed").length;
	const ctx = () => runtime()?.state.contextUsage;
	const isMobile = () => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 700px)").matches;

	return (
		<div class="session-screen">
			<header class="session-bar">
				<div class="session-bar-inner">
					<a class="back" href="#/">
						← fleet
					</a>
					<span class="title">{runtime()?.state.sessionName ?? session()?.title ?? props.sessionKey}</span>
					<span class="project">{runtime()?.cwd}</span>
					<span class="right">
						<button type="button" class="switcher optional" onClick={() => setShowModelSelector(true)}>
							<span class="label">model</span> {runtime()?.state.model?.id ?? "—"}
						</button>
						<button
							type="button"
							class="switcher optional"
							onClick={async () => {
								const current = runtime()?.state.thinkingLevel ?? "off";
								const next = THINKING_LEVELS[(THINKING_LEVELS.indexOf(current) + 1) % THINKING_LEVELS.length];
								try {
									await api.setThinking(props.sessionKey, next);
									await props.store.refreshFleet();
								} catch (err) {
									setActionError(err instanceof Error ? err.message : String(err));
								}
							}}
						>
							<span class="label">think</span> {runtime()?.state.thinkingLevel ?? "—"}
						</button>
						<Show when={ctx()}>
							<output class="switcher">
								<span class="label">ctx</span>{" "}
								{ctx()!.percent === null ? "?" : `${ctx()!.percent!.toFixed(0)}%`}
							</output>
						</Show>
						<button type="button" class="switcher" onClick={() => setShowOverflow(!showOverflow())}>
							⋯
						</button>
					</span>
				</div>
				<Show when={showOverflow()}>
					<div class="session-bar-inner" style={{ "justify-content": "flex-end", gap: "8px" }}>
						<a class="btn btn-small" href={api.exportHtmlUrl(props.sessionKey)}>
							export HTML
						</a>
						<button type="button" class="btn btn-small" onClick={() => setShowCompactModal(true)}>
							compact now
						</button>
						<button type="button" class="btn btn-small" onClick={() => setShowRenameModal(true)}>
							rename
						</button>
						<Show when={isMobile()}>
							<button type="button" class="btn btn-small" onClick={() => setShowModelSelector(true)}>
								model
							</button>
						</Show>
					</div>
				</Show>
			</header>

			<Show when={runtime()?.state.modelFallbackMessage && !fallbackDismissed()}>
				<div class="container" style={{ "padding-top": "8px" }}>
					<div class="fallback-banner">
						<span>◆ {runtime()!.state.modelFallbackMessage}</span>
						<button type="button" class="btn btn-small dismiss" onClick={() => setFallbackDismissed(true)}>
							dismiss
						</button>
					</div>
				</div>
			</Show>

			<main
				class="chat"
				ref={chatRef}
				onScroll={() => {
					if (!chatRef) return;
					autoScroll = chatRef.scrollTop + chatRef.clientHeight >= chatRef.scrollHeight - 40;
				}}
			>
				<div class="chat-inner">
					<Show when={session()} fallback={<p class="muted">loading transcript…</p>}>
						<For each={session()!.widgets.above}>{(line) => <div class="widget-block">{line}</div>}</For>
						<Transcript entries={session()!.entries} />
						<For each={session()!.widgets.below}>{(line) => <div class="widget-block">{line}</div>}</For>
					</Show>
				</div>
			</main>

			<footer class="dock">
				<div class="dock-inner">
					<Show when={tasks().length > 0}>
						<details class="tasks" open={!isMobile()}>
							<summary>
								tasks — {tasksDone()} of {tasks().length} done
							</summary>
							<ul>
								<For each={tasks()}>
									{(task) => (
										<li
											classList={{
												done: task.status === "completed",
												active: task.status === "in_progress",
											}}
										>
											{task.status === "completed" ? "☑" : task.status === "in_progress" ? "⧖" : "☐"}{" "}
											{task.title}
										</li>
									)}
								</For>
							</ul>
						</details>
					</Show>

					<Show when={liveAgents().length + doneAgents().length > 0}>
						<div class="subagent-strip">
							<span class="count">
								⚡ {liveAgents().length} running · {doneAgents().length} done
							</span>
							<For each={[...liveAgents(), ...doneAgents()].slice(0, 4)}>
								{(agent) => (
									<button
										type="button"
										class="agent-chip"
										title="view this subagent's session"
										onClick={() =>
											props.store.navigate({
												screen: "subagent",
												key: props.sessionKey,
												agentId: agent.agentId,
											})
										}
									>
										<span class={agent.status === "running" ? "live" : "done"}>
											{agent.status === "running" ? "●" : agent.status === "completed" ? "✓" : "✕"}
										</span>
										<span class="task">
											{agent.agentType} — {agent.taskSummary}
										</span>
									</button>
								)}
							</For>
						</div>
					</Show>

					<Show when={streaming() || (session()?.statusEntries.length ?? 0) > 0 || actionError()}>
						<div class="status-line">
							<Show when={streaming()}>
								<span class="working">
									● working{session()?.workingText ? ` — ${session()!.workingText}` : ""}
									{elapsed() > 2 ? ` (${elapsed()}s)` : ""}
								</span>
							</Show>
							<For each={session()?.statusEntries ?? []}>
								{(status) => <span class={status.tone === "info" ? "queued" : status.tone}>{status.text}</span>}
							</For>
							<Show when={actionError()}>
								<span class="error">{actionError()}</span>
							</Show>
							<Show when={streaming()}>
								<button type="button" class="btn btn-small btn-danger" onClick={abort}>
									■ stop
								</button>
							</Show>
						</div>
					</Show>

					<div class="composer">
						<textarea
							placeholder={streaming() ? "Message dreb — sends as steer while it works…" : "Message dreb…"}
							value={composerText()}
							onInput={(e) => setComposerText(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									send();
								}
							}}
						/>
						<div class="composer-row">
							<Show when={streaming()}>
								<span class="mode-toggle" role="radiogroup" aria-label="send mode">
									<button
										type="button"
										classList={{ selected: sendMode() === "steer" }}
										title="Deliver now — injected into the running turn"
										onClick={() => setSendMode("steer")}
									>
										steer
									</button>
									<button
										type="button"
										classList={{ selected: sendMode() === "follow_up" }}
										title="Queue — delivered after the agent finishes"
										onClick={() => setSendMode("follow_up")}
									>
										follow-up
									</button>
								</span>
							</Show>
							<Show when={session()?.suggestedCommand}>
								<button
									type="button"
									class="ghost-suggest"
									onClick={() => setComposerText(session()!.suggestedCommand!)}
								>
									suggested: <code>{session()!.suggestedCommand}</code> <span class="key">tap</span>
								</button>
							</Show>
							<button type="button" class="btn btn-primary btn-small send" onClick={send}>
								send ↵
							</button>
						</div>
					</div>
				</div>
			</footer>

			<Show when={session()?.uiRequests[0]}>
				{(request) => (
					<ExtensionUiModal
						request={request()}
						onRespond={async (response) => {
							try {
								await api.extensionUiResponse(props.sessionKey, response);
							} catch (err) {
								setActionError(err instanceof Error ? err.message : String(err));
							}
						}}
					/>
				)}
			</Show>

			<Show when={showModelSelector()}>
				<ModelSelectorModal
					sessionKey={props.sessionKey}
					onClose={() => setShowModelSelector(false)}
					onSelected={() => props.store.refreshFleet()}
				/>
			</Show>

			<Show when={showCompactModal()}>
				<Modal
					title="compact context"
					onDismiss={() => setShowCompactModal(false)}
					actions={
						<>
							<button type="button" class="btn btn-small" onClick={() => setShowCompactModal(false)}>
								cancel
							</button>
							<button
								type="button"
								class="btn btn-small btn-primary"
								onClick={async () => {
									setShowCompactModal(false);
									try {
										await api.compact(props.sessionKey);
									} catch (err) {
										setActionError(err instanceof Error ? err.message : String(err));
									}
								}}
							>
								compact
							</button>
						</>
					}
				>
					<p>Summarize older context to free window space. The transcript keeps a summary card.</p>
				</Modal>
			</Show>

			<Show when={showRenameModal()}>
				<RenameModal
					current={runtime()?.state.sessionName ?? ""}
					onClose={() => setShowRenameModal(false)}
					onRename={async (name) => {
						try {
							await api.rename(props.sessionKey, name);
							await props.store.refreshFleet();
							setShowRenameModal(false);
						} catch (err) {
							setActionError(err instanceof Error ? err.message : String(err));
						}
					}}
				/>
			</Show>
		</div>
	);
}

function RenameModal(props: { current: string; onClose: () => void; onRename: (name: string) => void }): JSX.Element {
	const [name, setName] = createSignal(props.current);
	return (
		<Modal
			title="rename session"
			onDismiss={props.onClose}
			actions={
				<>
					<button type="button" class="btn btn-small" onClick={props.onClose}>
						cancel
					</button>
					<button
						type="button"
						class="btn btn-small btn-primary"
						disabled={!name().trim()}
						onClick={() => props.onRename(name().trim())}
					>
						rename
					</button>
				</>
			}
		>
			<div class="field">
				<input type="text" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
			</div>
		</Modal>
	);
}
