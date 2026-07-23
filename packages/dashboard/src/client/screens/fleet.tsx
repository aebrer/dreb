/**
 * Fleet overview — home screen. Live-first: one grid of all live session
 * cards (attention-first, project path on each card), then compact past
 * sessions grouped by project (3 rows + expand). "+ new session" modal.
 */

import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { RuntimeInfoDto, SessionInfoDto } from "../../shared/protocol.js";
import { api } from "../api.js";
import { Modal, relativeTime, StatusChip, Topbar } from "../components/common.js";
import type { AppStore } from "../state/store.js";

function runtimeStatus(runtime: RuntimeInfoDto): "running" | "attention" | "idle" | "error" {
	if (runtime.error) return "error";
	if (runtime.needsAttention) return "attention";
	if (runtime.state.isStreaming || runtime.state.isCompacting) return "running";
	return "idle";
}

// Display-only normalization: /tmp children are grouped together in the fleet UI.
// Resume still uses each session's own real cwd and session log path unchanged.
export function fleetGroupKey(cwd: string): string {
	return cwd === "/tmp" || cwd.startsWith("/tmp/") ? "/tmp" : cwd;
}

function shortenPath(path: string): string {
	return path.replace(/^\/home\/[^/]+/, "~");
}

function runtimeModelLabel(runtime: RuntimeInfoDto): string | undefined {
	const model = runtime.state.model;
	return model ? `${model.provider}/${model.id}` : undefined;
}

function runtimeCostLabel(runtime: RuntimeInfoDto): string | undefined {
	return runtime.stats ? `$${runtime.stats.cost.toFixed(2)}` : undefined;
}

const ACTIVITY_PREVIEW_LIMIT = 200;

function latestAssistantPreview(store: AppStore, runtime: RuntimeInfoDto): string | undefined {
	const entries = store.sessions[runtime.key]?.entries ?? [];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.kind !== "assistant") continue;
		const text = entry.blocks
			.filter((block) => block.kind === "text")
			.map((block) => block.text)
			.join("")
			.trim();
		if (text) return text.slice(0, ACTIVITY_PREVIEW_LIMIT);
	}
	return runtime.lastAssistantText;
}

function SessionCard(props: { store: AppStore; runtime: RuntimeInfoDto }): JSX.Element {
	const status = () => runtimeStatus(props.runtime);
	const session = () => props.store.sessions[props.runtime.key];
	const liveAgents = () => props.runtime.backgroundAgents.filter((a) => a.status === "running");
	const doneAgents = () => props.runtime.backgroundAgents.filter((a) => a.status !== "running");
	const tasks = () => session()?.tasks ?? props.runtime.state.tasks ?? [];
	const tasksDone = () => tasks().filter((t) => t.status === "completed").length;
	const ctx = () => props.runtime.state.contextUsage;
	const activity = () => {
		const s = session();
		if (s?.workingText) return `▸ ${s.workingText}`;
		if (s?.suggestedCommand) return `suggested next: ${s.suggestedCommand}`;
		return latestAssistantPreview(props.store, props.runtime);
	};

	return (
		<article
			class="session-card"
			classList={{ attention: status() === "attention", error: status() === "error" || !!session()?.lastError }}
		>
			<div class="session-title">
				<span class="name">
					{session()?.sessionName ?? props.runtime.state.sessionName ?? props.runtime.state.sessionId.slice(0, 8)}
				</span>
				<Show when={session()?.lastError} fallback={<StatusChip status={status()} />}>
					<StatusChip status="error" />
				</Show>
			</div>
			<p class="session-project" title={props.runtime.cwd}>
				{shortenPath(props.runtime.cwd)}
			</p>
			<Show when={status() === "attention"}>
				<p class="attention-reason">
					{session()?.uiRequests[0] ? `waiting for input — ${session()!.uiRequests[0].title}` : "needs attention"}
				</p>
			</Show>
			<Show when={props.runtime.error ?? session()?.lastError}>
				<p class="error-reason">{props.runtime.error ?? session()!.lastError}</p>
			</Show>
			<Show when={activity()}>
				<p class="activity">{activity()}</p>
			</Show>
			<Show when={props.runtime.backgroundAgents.length > 0}>
				<div class="subagents">
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
				</div>
			</Show>
			<div class="session-meta">
				<Show when={tasks().length > 0}>
					<span>
						tasks {tasksDone()}/{tasks().length}
					</span>
					<span>·</span>
				</Show>
				<Show when={runtimeModelLabel(props.runtime)}>
					<span>{runtimeModelLabel(props.runtime)}</span>
					<span>·</span>
				</Show>
				<Show when={ctx() && ctx()!.percent !== null}>
					<span>ctx {ctx()!.percent!.toFixed(0)}%</span>
					<span>·</span>
				</Show>
				<Show when={runtimeCostLabel(props.runtime)}>
					<span>{runtimeCostLabel(props.runtime)}</span>
					<span>·</span>
				</Show>
				<span>{props.runtime.state.messageCount} msgs</span>
				<span>·</span>
				<span>{relativeTime(props.runtime.lastActivity)}</span>
			</div>
			<div class="session-actions">
				<button
					type="button"
					class="btn btn-small btn-primary"
					onClick={() => props.store.navigate({ screen: "session", key: props.runtime.key })}
				>
					open
				</button>
				<button
					type="button"
					class="btn btn-small btn-danger"
					onClick={async () => {
						await api.stopRuntime(props.runtime.key);
						await props.store.removeRuntime(props.runtime.key);
					}}
				>
					stop runtime
				</button>
			</div>
		</article>
	);
}

function NewSessionModal(props: {
	store: AppStore;
	initialCwd?: string;
	recentProjects: string[];
	onClose: () => void;
}): JSX.Element {
	const [cwd, setCwd] = createSignal(props.initialCwd ?? "");
	const [firstPrompt, setFirstPrompt] = createSignal("");
	const [error, setError] = createSignal<string>();
	const [busy, setBusy] = createSignal(false);

	async function create() {
		setBusy(true);
		setError(undefined);
		try {
			const runtime = await api.createRuntime(cwd(), {
				firstPrompt: firstPrompt() || undefined,
			});
			props.store.upsertRuntime(runtime);
			await props.store.refreshDiskSessions();
			props.onClose();
			props.store.navigate({ screen: "session", key: runtime.key });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal
			title="new session"
			onDismiss={props.onClose}
			actions={
				<>
					<button type="button" class="btn btn-small" onClick={props.onClose}>
						cancel
					</button>
					<button type="button" class="btn btn-small btn-primary" disabled={busy() || !cwd()} onClick={create}>
						{busy() ? "starting…" : "start session"}
					</button>
				</>
			}
		>
			<div class="field">
				<label for="new-session-cwd">project path</label>
				<input
					id="new-session-cwd"
					type="text"
					value={cwd()}
					placeholder="/path/to/project"
					onInput={(e) => setCwd(e.currentTarget.value)}
				/>
			</div>
			<Show when={props.recentProjects.length > 0}>
				<div class="field">
					<label for="recent-projects-list">recent projects</label>
					<div class="recent-projects" id="recent-projects-list">
						<For each={props.recentProjects}>
							{(project) => (
								<button type="button" onClick={() => setCwd(project)}>
									{shortenPath(project)}
								</button>
							)}
						</For>
					</div>
				</div>
			</Show>
			<div class="field">
				<label for="new-session-prompt">first prompt (optional)</label>
				<textarea
					id="new-session-prompt"
					rows="3"
					value={firstPrompt()}
					onInput={(e) => setFirstPrompt(e.currentTarget.value)}
				/>
			</div>
			<Show when={error()}>
				<p class="pair-error">{error()}</p>
			</Show>
		</Modal>
	);
}

export function FleetScreen(props: { store: AppStore }): JSX.Element {
	const [newSessionCwd, setNewSessionCwd] = createSignal<string | undefined>();
	const [showNewSession, setShowNewSession] = createSignal(false);
	const [confirmDelete, setConfirmDelete] = createSignal<SessionInfoDto>();
	const [expandedGroups, setExpandedGroups] = createSignal<Record<string, boolean>>({});
	const [resumeError, setResumeError] = createSignal<string>();

	// Live sessions: one flat grid, deterministically ordered — alphabetical by
	// project path, then session start time as tiebreak. Stable ordering beats
	// dynamic reordering for UX: cards never jump around as activity ticks.
	const liveRuntimes = createMemo(() => {
		const runtimes = [...props.store.fleet().runtimes];
		runtimes.sort((a, b) => {
			const byPath = a.cwd.localeCompare(b.cwd);
			if (byPath !== 0) return byPath;
			return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
		});
		return runtimes;
	});

	// Past sessions: grouped by project, compact rows, newest group first.
	const diskGroups = createMemo(() => {
		const fleet = props.store.fleet();
		const liveSessionFiles = new Set(fleet.runtimes.map((r) => r.state.sessionFile).filter(Boolean));
		const byProject = new Map<string, SessionInfoDto[]>();
		for (const session of fleet.diskSessions) {
			if (liveSessionFiles.has(session.path)) continue; // already live
			const key = fleetGroupKey(session.cwd);
			const group = byProject.get(key) ?? [];
			group.push(session);
			byProject.set(key, group);
		}
		const entries = [...byProject.entries()];
		entries.sort(([, a], [, b]) => new Date(b[0]?.modified ?? 0).getTime() - new Date(a[0]?.modified ?? 0).getTime());
		return entries;
	});

	const counts = createMemo(() => {
		const fleet = props.store.fleet();
		return {
			live: fleet.runtimes.length,
			attention: fleet.runtimes.filter((r) => r.needsAttention).length,
			disk: fleet.diskSessions.length,
		};
	});

	const recentProjects = createMemo(() => {
		const paths = new Set<string>();
		for (const runtime of props.store.fleet().runtimes) paths.add(runtime.cwd);
		for (const session of props.store.fleet().diskSessions) paths.add(session.cwd);
		return [...paths].slice(0, 8);
	});

	onMount(() => {
		const timer = setInterval(() => void props.store.refreshFleetStats(), 30_000);
		onCleanup(() => clearInterval(timer));
	});

	async function resume(session: SessionInfoDto) {
		setResumeError(undefined);
		try {
			const runtime = await api.createRuntime(session.cwd, { sessionPath: session.path });
			props.store.upsertRuntime(runtime);
			await props.store.refreshDiskSessions();
			props.store.navigate({ screen: "session", key: runtime.key });
		} catch (err) {
			setResumeError(`Failed to resume session: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return (
		<div class="screen-fill">
			<Topbar store={props.store} active="fleet" />
			<main class="container">
				<div class="fleet-head">
					<div>
						<h1>fleet</h1>
						<p class="muted small">
							{counts().live} live · {counts().attention} needs attention · {counts().disk} on disk
						</p>
					</div>
					<button
						type="button"
						class="btn btn-primary"
						onClick={() => {
							setNewSessionCwd(undefined);
							setShowNewSession(true);
						}}
					>
						+ new session
					</button>
				</div>

				<Show when={props.store.fleetError()}>
					<div class="settings-error" role="alert">
						Fleet could not be loaded: {props.store.fleetError()}
					</div>
				</Show>
				<Show when={props.store.fleetStatsError()}>
					<div class="settings-error" role="alert">
						Fleet stats could not be refreshed: {props.store.fleetStatsError()}
					</div>
				</Show>

				<Show
					when={liveRuntimes().length > 0 || diskGroups().length > 0 || props.store.fleetError()}
					fallback={
						<div class="empty-state">
							<p>No sessions yet.</p>
							<p style={{ "margin-top": "8px" }}>
								<button type="button" class="btn btn-primary" onClick={() => setShowNewSession(true)}>
									+ create your first session
								</button>
							</p>
						</div>
					}
				>
					<Show when={liveRuntimes().length > 0}>
						<section class="live-sessions">
							<div class="session-grid">
								<For each={liveRuntimes()}>
									{(runtime) => <SessionCard store={props.store} runtime={runtime} />}
								</For>
							</div>
						</section>
					</Show>

					<Show when={diskGroups().length > 0}>
						<section class="past-sessions">
							<h2 class="past-sessions-head">past sessions</h2>
							<Show when={resumeError()}>
								<p class="pair-error">{resumeError()}</p>
							</Show>
							<For each={diskGroups()}>
								{([project, sessions]) => {
									const expanded = () => expandedGroups()[project] ?? false;
									const visible = () => (expanded() ? sessions : sessions.slice(0, 3));
									return (
										<section class="project-group">
											<div class="group-head">
												<h3>{shortenPath(project)}</h3>
												<span class="muted small">{sessions.length} on disk</span>
												<button
													type="button"
													class="btn btn-small"
													onClick={() => {
														setNewSessionCwd(project);
														setShowNewSession(true);
													}}
												>
													+ new
												</button>
											</div>
											<For each={visible()}>
												{(session) => (
													<div class="disk-row">
														<span class="name" classList={{ muted: !session.name }}>
															{session.name ?? `“${session.firstMessage.slice(0, 60)}…”`}
														</span>
														<span class="meta">
															{session.messageCount} msgs · {relativeTime(session.modified)}
														</span>
														<span class="actions">
															<button
																type="button"
																class="btn btn-small"
																onClick={() => resume(session)}
															>
																resume
															</button>
															<button
																type="button"
																class="btn btn-small btn-danger"
																onClick={() => setConfirmDelete(session)}
															>
																delete
															</button>
														</span>
													</div>
												)}
											</For>
											<Show when={sessions.length > 3}>
												<button
													type="button"
													class="disk-more"
													onClick={() =>
														setExpandedGroups((current) => ({ ...current, [project]: !expanded() }))
													}
												>
													{expanded() ? "show fewer ←" : `all ${sessions.length} on disk →`}
												</button>
											</Show>
										</section>
									);
								}}
							</For>
						</section>
					</Show>
				</Show>
			</main>

			<Show when={showNewSession()}>
				<NewSessionModal
					store={props.store}
					initialCwd={newSessionCwd()}
					recentProjects={recentProjects()}
					onClose={() => setShowNewSession(false)}
				/>
			</Show>

			<Show when={confirmDelete()}>
				{(session) => (
					<Modal
						title="delete session?"
						onDismiss={() => setConfirmDelete(undefined)}
						actions={
							<>
								<button type="button" class="btn btn-small" onClick={() => setConfirmDelete(undefined)}>
									cancel
								</button>
								<button
									type="button"
									class="btn btn-small btn-danger"
									onClick={async () => {
										await api.deleteSession(session().path);
										setConfirmDelete(undefined);
										await props.store.refreshDiskSessions();
									}}
								>
									delete
								</button>
							</>
						}
					>
						<p>
							{session().name ?? session().firstMessage.slice(0, 80)} — {session().messageCount} messages. The
							session file is moved to trash where supported.
						</p>
					</Modal>
				)}
			</Show>
		</div>
	);
}
