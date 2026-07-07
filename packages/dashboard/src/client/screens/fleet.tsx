/**
 * Fleet overview — home screen. Live cards grouped by project (status chip,
 * activity, subagents, tasks, ctx%, model), on-disk inventory with
 * resume/delete, "+ new session" modal. Needs-attention sorts first.
 */

import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { RuntimeInfoDto, SessionInfoDto } from "../../shared/protocol.js";
import { api } from "../api.js";
import { Modal, relativeTime, StatusChip, Topbar } from "../components/common.js";
import type { AppStore } from "../state/store.js";

function runtimeStatus(runtime: RuntimeInfoDto): "running" | "attention" | "idle" | "error" {
	if (runtime.needsAttention) return "attention";
	if (runtime.state.isStreaming || runtime.state.isCompacting) return "running";
	return "idle";
}

function shortenPath(path: string): string {
	return path.replace(/^\/home\/[^/]+/, "~");
}

function SessionCard(props: { store: AppStore; runtime: RuntimeInfoDto }): JSX.Element {
	const status = () => runtimeStatus(props.runtime);
	const session = () => props.store.sessions[props.runtime.key];
	const liveAgents = () => props.runtime.backgroundAgents.filter((a) => a.status === "running");
	const doneAgents = () => props.runtime.backgroundAgents.filter((a) => a.status !== "running");
	const tasks = () => session()?.tasks ?? [];
	const tasksDone = () => tasks().filter((t) => t.status === "completed").length;
	const ctx = () => props.runtime.state.contextUsage;
	const activity = () => {
		const s = session();
		if (s?.workingText) return `▸ ${s.workingText}`;
		if (s?.suggestedCommand) return `suggested next: ${s.suggestedCommand}`;
		return undefined;
	};

	return (
		<article class="session-card" classList={{ attention: status() === "attention", error: !!session()?.lastError }}>
			<div class="session-title">
				<span class="name">{props.runtime.state.sessionName ?? props.runtime.state.sessionId.slice(0, 8)}</span>
				<Show when={session()?.lastError} fallback={<StatusChip status={status()} />}>
					<StatusChip status="error" />
				</Show>
			</div>
			<Show when={status() === "attention"}>
				<p class="attention-reason">
					{session()?.uiRequests[0] ? `waiting for input — ${session()!.uiRequests[0].title}` : "needs attention"}
				</p>
			</Show>
			<Show when={session()?.lastError}>
				<p class="error-reason">{session()!.lastError}</p>
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
				<Show when={props.runtime.state.model}>
					<span>{props.runtime.state.model!.id}</span>
					<span>·</span>
				</Show>
				<Show when={ctx() && ctx()!.percent !== null}>
					<span>ctx {ctx()!.percent!.toFixed(0)}%</span>
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
						await props.store.refreshFleet();
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
			await props.store.refreshFleet();
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

	const groups = createMemo(() => {
		const fleet = props.store.fleet();
		const byProject = new Map<string, { runtimes: RuntimeInfoDto[]; disk: SessionInfoDto[] }>();
		for (const runtime of fleet.runtimes) {
			const group = byProject.get(runtime.cwd) ?? { runtimes: [], disk: [] };
			group.runtimes.push(runtime);
			byProject.set(runtime.cwd, group);
		}
		const liveSessionFiles = new Set(fleet.runtimes.map((r) => r.state.sessionFile).filter(Boolean));
		for (const session of fleet.diskSessions) {
			if (liveSessionFiles.has(session.path)) continue; // already live
			const group = byProject.get(session.cwd) ?? { runtimes: [], disk: [] };
			group.disk.push(session);
			byProject.set(session.cwd, group);
		}
		// Attention-first sort within each group; groups with attention first.
		const entries = [...byProject.entries()];
		for (const [, group] of entries) {
			group.runtimes.sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention));
		}
		entries.sort(
			([, a], [, b]) =>
				Number(b.runtimes.some((r) => r.needsAttention)) - Number(a.runtimes.some((r) => r.needsAttention)),
		);
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

	async function resume(session: SessionInfoDto) {
		const runtime = await api.createRuntime(session.cwd, { sessionPath: session.path });
		await props.store.refreshFleet();
		props.store.navigate({ screen: "session", key: runtime.key });
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

				<Show
					when={groups().length > 0}
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
					<For each={groups()}>
						{([project, group]) => (
							<section class="project-group">
								<div class="group-head">
									<h2>{shortenPath(project)}</h2>
									<span class="muted small">
										{group.runtimes.length} live · {group.disk.length} on disk
									</span>
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
								<Show when={group.runtimes.length > 0}>
									<div class="session-grid">
										<For each={group.runtimes}>
											{(runtime) => <SessionCard store={props.store} runtime={runtime} />}
										</For>
									</div>
								</Show>
								<Show when={group.disk.length > 0}>
									<p class="disk-label">on disk</p>
									<For each={group.disk.slice(0, 5)}>
										{(session) => (
											<div class="disk-row">
												<span class="name" classList={{ muted: !session.name }}>
													{session.name ?? `“${session.firstMessage.slice(0, 60)}…”`}
												</span>
												<span class="meta">
													{session.messageCount} msgs · {relativeTime(session.modified)}
												</span>
												<span class="actions">
													<button type="button" class="btn btn-small" onClick={() => resume(session)}>
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
								</Show>
							</section>
						)}
					</For>
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
										await props.store.refreshFleet();
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
