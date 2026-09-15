/**
 * Fleet overview — home screen. Live-first: one grid of all live session
 * cards (deterministic order — project path, then session start time;
 * attention/error emphasis never re-orders them), then compact past
 * sessions grouped by project (3 rows + expand). "+ new session" modal.
 */

import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { RuntimeInfoDto, SessionInfoDto } from "../../shared/protocol.js";
import { api } from "../api.js";
import { Modal, relativeTime, Topbar } from "../components/common.js";
import { fleetSidebarOrder } from "../components/fleet-sidebar.js";
import { ResumeSessionModal, runtimeProjectChoices } from "../components/resume-session-modal.js";
import { SessionCardSummary, sessionCardStatus } from "../components/session-card-summary.js";
import { createFleetStatsRefresh } from "../state/fleet-stats-refresh.js";
import type { AppStore } from "../state/store.js";

// Display-only normalization: /tmp children are grouped together in the fleet UI.
// Resume still uses each session's own real cwd and session log path unchanged.
export function fleetGroupKey(cwd: string): string {
	return cwd === "/tmp" || cwd.startsWith("/tmp/") ? "/tmp" : cwd;
}

function shortenPath(path: string): string {
	return path.replace(/^\/home\/[^/]+/, "~");
}

function SessionCard(props: { store: AppStore; runtime: RuntimeInfoDto }): JSX.Element {
	const status = () => sessionCardStatus(props.store, props.runtime);
	return (
		<article class="session-card" classList={{ attention: status() === "attention", error: status() === "error" }}>
			<SessionCardSummary store={props.store} runtime={props.runtime} />
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
	const [resumeSession, setResumeSession] = createSignal<SessionInfoDto>();
	const [expandedGroups, setExpandedGroups] = createSignal<Record<string, boolean>>({});
	const [resumeError, setResumeError] = createSignal<string>();
	const resumeRequests = new Map<string, Promise<void>>();

	// Live sessions: one flat grid, deterministically ordered — alphabetical by
	// project path, then session start time as tiebreak. Stable ordering beats
	// dynamic reordering for UX: cards never jump around as activity ticks.
	const liveRuntimes = createMemo(() => fleetSidebarOrder(props.store.fleet().runtimes));

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

	const recentProjects = createMemo(() => runtimeProjectChoices(props.store.fleet()));

	createFleetStatsRefresh(props.store, () => true);

	function resumeIn(session: SessionInfoDto, cwd: string): Promise<void> {
		const existing = resumeRequests.get(session.path);
		if (existing) return existing;

		const request = Promise.resolve()
			.then(async () => {
				setResumeError(undefined);
				const runtime = await api.createRuntime(cwd, { sessionPath: session.path });
				props.store.upsertRuntime(runtime);
				// Runtime creation is authoritative. Inventory refresh failure is surfaced
				// separately and must not make a successful resume retryable.
				void props.store.refreshDiskSessions().catch(() => {});
				props.store.navigate({ screen: "session", key: runtime.key });
			})
			.finally(() => resumeRequests.delete(session.path));
		resumeRequests.set(session.path, request);
		return request;
	}

	async function resume(session: SessionInfoDto): Promise<void> {
		if (session.cwdAvailable === false) {
			setResumeSession(session);
			return;
		}
		try {
			// Re-resolve the historical path at runtime creation time rather than
			// trusting an inventory-time canonical target that a symlink may outlive.
			await resumeIn(session, session.cwd);
		} catch (err) {
			const status = (err as { status?: unknown })?.status;
			if (status === 400 || status === 404) {
				setResumeSession({ ...session, cwdAvailable: false, resolvedCwd: undefined });
				return;
			}
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
									const newSessionCwd = () => {
										const candidate = sessions.find(
											(session) => session.resolvedCwd || session.cwdAvailable !== false,
										);
										if (!candidate) return undefined;
										return project === "/tmp" ? project : (candidate.resolvedCwd ?? candidate.cwd);
									};
									const unavailable = () => sessions.every((session) => session.cwdAvailable === false);
									return (
										<section class="project-group">
											<div class="group-head">
												<h3>{project ? shortenPath(project) : "(not recorded)"}</h3>
												<span class="muted small">
													{sessions.length} on disk{unavailable() ? " · original path unavailable" : ""}
												</span>
												<Show when={newSessionCwd()}>
													{(cwd) => (
														<button
															type="button"
															class="btn btn-small"
															onClick={() => {
																setNewSessionCwd(cwd());
																setShowNewSession(true);
															}}
														>
															+ new
														</button>
													)}
												</Show>
											</div>
											<For each={visible()}>
												{(session) => (
													<div class="disk-row">
														<span class="name" classList={{ muted: !session.name }}>
															{session.name ?? `“${session.firstMessage.slice(0, 60)}…”`}
														</span>
														<span class="meta">
															{session.cwdAvailable === false ? "original path unavailable · " : ""}
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

			<Show when={resumeSession()}>
				{(session) => (
					<ResumeSessionModal
						historicalCwd={session().cwd}
						historicalUnavailable
						recentProjects={recentProjects()}
						onClose={() => setResumeSession(undefined)}
						onResume={async (cwd) => {
							await resumeIn(session(), cwd);
							setResumeSession(undefined);
						}}
					/>
				)}
			</Show>

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
