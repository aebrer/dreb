/**
 * Fleet overview — home screen. Live-first: one grid of all live session
 * cards (stable path/start order by default, user-selected sorting otherwise), then compact past
 * sessions grouped by project (3 rows + expand) with resume / rename / delete.
 * Screen-local name/path search and live-only attention filtering. "+ new session" modal.
 */

import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { RuntimeInfoDto, SessionInfoDto } from "../../shared/protocol.js";
import { api } from "../api.js";
import { Modal, relativeTime, Topbar } from "../components/common.js";
import { FleetSortHeader, FleetSortReset, fleetColumnSort } from "../components/fleet-sort-headers.js";
import { RenameSessionModal } from "../components/rename-session-modal.js";
import { ResumeSessionModal, runtimeProjectChoices } from "../components/resume-session-modal.js";
import { SessionCardSummary, sessionCardStatus } from "../components/session-card-summary.js";
import {
	filterFleetDiskSessions,
	filterFleetRuntimes,
	fleetDisplayPath,
	normalizeFleetQuery,
} from "../state/fleet-filtering.js";
import {
	countUnknownOriginalCreation,
	diskSessionDisplayName,
	type FleetSortKey,
	runtimeDisplayName,
	sortFleetDiskGroups,
	sortFleetRuntimes,
} from "../state/fleet-sorting.js";
import { createFleetStatsRefresh } from "../state/fleet-stats-refresh.js";
import { fleetSort } from "../state/preferences.js";
import type { AppStore } from "../state/store.js";

export { fleetGroupKey } from "../state/fleet-sorting.js";

const SORT_HELP: Record<FleetSortKey, string> = {
	default:
		"Live cards keep a stable project/start order; past sessions are newest first. Session sidebars always stay stable.",
	activity: "Live cards can move as activity updates. Past project groups follow their first sorted session.",
	created:
		"Original session creation, not runtime start. Unknown dates sort last until saved-session metadata is available.",
	started: "Live sessions only. Past sessions keep their default newest-first order in either direction.",
	name: "Sorts the displayed session names. Past project groups follow their first sorted session; sidebars stay stable.",
	path: "Live cards use their runtime path; past sessions keep their historical project groups. Sidebars stay stable.",
};

function SessionTime(props: { value: string; label: string }): JSX.Element {
	const timestamp = () => Date.parse(props.value);
	return (
		<Show when={Number.isFinite(timestamp())} fallback={<span title={`Unknown ${props.label}`}>—</span>}>
			<time dateTime={props.value} title={new Date(timestamp()).toLocaleString()}>
				{relativeTime(props.value)}
			</time>
		</Show>
	);
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
									{fleetDisplayPath(project)}
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
	const [deleteBusy, setDeleteBusy] = createSignal(false);
	const [deleteError, setDeleteError] = createSignal<string>();
	const [renameTarget, setRenameTarget] = createSignal<SessionInfoDto>();
	const [resumeSession, setResumeSession] = createSignal<SessionInfoDto>();
	const [expandedGroups, setExpandedGroups] = createSignal<Record<string, boolean>>({});
	const [query, setQuery] = createSignal("");
	const [attentionOnly, setAttentionOnly] = createSignal(false);
	const searchActive = createMemo(() => !!normalizeFleetQuery(query()));
	const filtersActive = createMemo(() => searchActive() || attentionOnly());
	const [resumeError, setResumeError] = createSignal<string>();
	const resumeRequests = new Map<string, Promise<void>>();
	let fleetMain: HTMLElement | undefined;

	// Moving an existing card/group with insertBefore can blur its focused control.
	// Restore only a still-mounted control, after reconciliation, and never steal
	// focus from a newly focused control/dialog or a different route.
	function retainFocusAcrossReorder(): void {
		const focused = document.activeElement;
		if (!(focused instanceof HTMLElement) || !fleetMain?.contains(focused)) return;
		queueMicrotask(() => {
			if (focused.isConnected && fleetMain?.isConnected && document.activeElement === document.body) {
				focused.focus({ preventScroll: true });
			}
		});
	}

	const liveRuntimes = createMemo(() => {
		retainFocusAcrossReorder();
		const fleet = props.store.fleet();
		const localName = (runtime: RuntimeInfoDto) => props.store.sessions[runtime.key]?.sessionName;
		return sortFleetRuntimes(
			filterFleetRuntimes(fleet.runtimes, query(), attentionOnly(), localName),
			fleet.diskSessions,
			fleetSort(),
			(runtime) => runtimeDisplayName(runtime, localName(runtime)),
		);
	});
	const liveByKey = createMemo(() => new Map(liveRuntimes().map((runtime) => [runtime.key, runtime])));
	const diskGroups = createMemo(() => {
		retainFocusAcrossReorder();
		const fleet = props.store.fleet();
		// Filter before grouping so each group follows its first matching member.
		// Always exclude ALL live files, including runtimes hidden by either filter.
		return sortFleetDiskGroups(filterFleetDiskSessions(fleet.diskSessions, query()), fleet.runtimes, fleetSort());
	});
	const diskByProject = createMemo(() => new Map(diskGroups()));
	// Visible counterpart to the screen-reader help: says why some cards sit last.
	// Counts only the live cards currently shown, so it agrees with active filters.
	const unknownLiveCreation = createMemo(() => {
		if (fleetSort().key !== "created") return 0;
		return countUnknownOriginalCreation(liveRuntimes(), props.store.fleet().diskSessions);
	});
	const matchingPastCount = createMemo(() => diskGroups().reduce((total, [, sessions]) => total + sessions.length, 0));
	const hasPastSessions = createMemo(() => {
		const fleet = props.store.fleet();
		const liveFiles = new Set(fleet.runtimes.map((runtime) => runtime.state.sessionFile).filter(Boolean));
		return fleet.diskSessions.some((session) => !liveFiles.has(session.path));
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

	function closeDeleteConfirm(): void {
		if (deleteBusy()) return;
		setConfirmDelete(undefined);
		setDeleteError(undefined);
	}

	async function confirmDeletion(session: SessionInfoDto): Promise<void> {
		if (deleteBusy()) return;
		setDeleteBusy(true);
		setDeleteError(undefined);
		try {
			await api.deleteSession(session.path);
		} catch (err) {
			setDeleteError(`Failed to delete session: ${err instanceof Error ? err.message : String(err)}`);
			return;
		} finally {
			setDeleteBusy(false);
		}
		setConfirmDelete(undefined);
		// Inventory refresh failures surface through the fleet error banner.
		void props.store.refreshDiskSessions().catch(() => {});
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
			<main class="container" ref={fleetMain}>
				<div class="fleet-head">
					<div>
						<h1>fleet</h1>
						<div class="fleet-counts muted small">
							<fieldset class="fleet-live-filters" aria-label="Filter live sessions">
								<button
									type="button"
									class="fleet-count-filter"
									aria-pressed={!attentionOnly()}
									onClick={() => setAttentionOnly(false)}
								>
									{counts().live} live
								</button>
								<span aria-hidden="true">·</span>
								<button
									type="button"
									class="fleet-count-filter"
									aria-pressed={attentionOnly()}
									onClick={() => setAttentionOnly((current) => !current)}
								>
									{counts().attention} needs attention
								</button>
							</fieldset>
							<span aria-hidden="true">·</span>
							<span>{counts().disk} on disk</span>
						</div>
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

				<div class="fleet-filters">
					<div class="fleet-search-field">
						<label for="fleet-search">Search sessions</label>
						<input
							id="fleet-search"
							class="input"
							type="search"
							placeholder="Session name or project path…"
							value={query()}
							onInput={(event) => setQuery(event.currentTarget.value)}
						/>
					</div>
					<button
						type="button"
						class="btn fleet-clear-filters"
						disabled={!query() && !attentionOnly()}
						onClick={() => {
							setQuery("");
							setAttentionOnly(false);
						}}
					>
						Clear filters
					</button>
					<output class="fleet-filter-results muted small" aria-live="polite" aria-atomic="true">
						<Show when={attentionOnly()}>Needs attention · live sessions only. </Show>
						{filtersActive()
							? `${liveRuntimes().length} matching live sessions · ${matchingPastCount()} matching past sessions. Past groups preview up to 3 matches unless expanded.`
							: ""}
					</output>
				</div>

				<output id="fleet-sort-help" class="fleet-visually-hidden">
					{SORT_HELP[fleetSort().key]}
				</output>

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
					when={counts().live > 0 || counts().disk > 0 || props.store.fleetError()}
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
					<Show when={counts().live > 0 || attentionOnly()}>
						<section class="live-sessions" aria-labelledby="live-sessions-heading">
							<div class="fleet-section-head">
								<h2 id="live-sessions-heading">live sessions</h2>
								<fieldset
									class="fleet-live-headers"
									aria-label="Sort live sessions"
									aria-describedby="fleet-sort-help"
								>
									<FleetSortHeader sortKey="name" label="Session" />
									<FleetSortHeader sortKey="created" label="Created" />
									<FleetSortHeader sortKey="started" label="Started" />
									<FleetSortHeader sortKey="activity" label="Last activity" />
									<FleetSortHeader sortKey="path" label="Project" />
									<FleetSortReset />
								</fieldset>
							</div>
							<Show when={liveRuntimes().length === 0}>
								<p class="muted">No live sessions match these filters.</p>
							</Show>
							<Show when={unknownLiveCreation() > 0}>
								<p class="fleet-live-note muted small">
									{unknownLiveCreation() === 1
										? "1 live session has no known creation date yet, so it is listed last."
										: `${unknownLiveCreation()} live sessions have no known creation date yet, so they are listed last.`}
								</p>
							</Show>
							<div class="session-grid">
								<For each={liveRuntimes().map((runtime) => runtime.key)}>
									{(key) => (
										<Show when={liveByKey().get(key)}>
											{(runtime) => <SessionCard store={props.store} runtime={runtime()} />}
										</Show>
									)}
								</For>
							</div>
						</section>
					</Show>

					<Show when={hasPastSessions()}>
						<section class="past-sessions" aria-labelledby="past-sessions-heading">
							<div class="fleet-section-head">
								<h2 id="past-sessions-heading">past sessions</h2>
								<fieldset class="fleet-project-order" aria-label="Sort past projects">
									<FleetSortHeader sortKey="path" label="Project" />
									<FleetSortReset />
								</fieldset>
							</div>
							<Show when={fleetSort().key === "started"}>
								<p class="fleet-history-note muted small">
									Runtime started applies to live sessions only. Past sessions stay newest first.
								</p>
							</Show>
							<Show when={resumeError()}>
								<p class="pair-error">{resumeError()}</p>
							</Show>
							<Show when={diskGroups().length === 0}>
								<p class="muted">No past sessions match this search.</p>
							</Show>
							<table class="fleet-session-table" aria-describedby="fleet-sort-help">
								<caption class="fleet-visually-hidden">
									Past sessions grouped by project. Click a heading to sort all groups; click again to reverse.
									Messages are informational.
								</caption>
								<thead>
									<tr>
										<th scope="col" id="fleet-session-column" aria-sort={fleetColumnSort("name")}>
											<FleetSortHeader sortKey="name" label="Session" />
										</th>
										<th
											scope="col"
											id="fleet-created-column"
											class="fleet-date-column"
											aria-sort={fleetColumnSort("created")}
										>
											<FleetSortHeader sortKey="created" label="Created" />
										</th>
										<th
											scope="col"
											id="fleet-activity-column"
											class="fleet-date-column"
											aria-sort={fleetColumnSort("activity")}
										>
											<FleetSortHeader sortKey="activity" label="Last activity" />
										</th>
										<th
											scope="col"
											id="fleet-messages-column"
											class="fleet-messages-column fleet-static-heading"
										>
											Messages
										</th>
										<th
											scope="col"
											id="fleet-actions-column"
											class="fleet-actions-column fleet-static-heading"
										>
											Actions
										</th>
									</tr>
								</thead>
								<For each={diskGroups().map(([project]) => project)}>
									{(project) => {
										const sessions = () => diskByProject().get(project) ?? [];
										const expanded = () => expandedGroups()[project] ?? false;
										const visible = () => (expanded() ? sessions() : sessions().slice(0, 3));
										const byPath = createMemo(
											() => new Map(sessions().map((session) => [session.path, session])),
										);
										const newSessionCwd = () => {
											const candidate = sessions().find(
												(session) => session.resolvedCwd || session.cwdAvailable !== false,
											);
											if (!candidate) return undefined;
											return project === "/tmp" ? project : (candidate.resolvedCwd ?? candidate.cwd);
										};
										const unavailable = () => sessions().every((session) => session.cwdAvailable === false);
										return (
											<tbody class="project-group">
												<tr class="fleet-project-row">
													<th scope="rowgroup" colSpan={5}>
														<div class="group-head">
															<h3>{project ? fleetDisplayPath(project) : "(not recorded)"}</h3>
															<span class="muted small">
																{sessions().length} {searchActive() ? "matching sessions" : "on disk"}
																{unavailable() ? " · original path unavailable" : ""}
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
													</th>
												</tr>
												<For each={visible().map((session) => session.path)}>
													{(path) => (
														<Show when={byPath().get(path)}>
															{(session) => (
																<tr class="disk-row">
																	<td class="fleet-name-cell" headers="fleet-session-column">
																		<span class="name" classList={{ muted: !session().name }}>
																			{diskSessionDisplayName(session())}
																		</span>
																		<Show when={session().cwdAvailable === false}>
																			<span class="meta disk-path-status">
																				original path unavailable
																			</span>
																		</Show>
																	</td>
																	<td
																		class="disk-created"
																		headers="fleet-created-column"
																		data-label="Created"
																	>
																		<SessionTime value={session().created} label="session creation" />
																	</td>
																	<td
																		class="disk-activity"
																		headers="fleet-activity-column"
																		data-label="Last activity"
																	>
																		<SessionTime value={session().modified} label="last activity" />
																	</td>
																	<td
																		class="disk-messages"
																		headers="fleet-messages-column"
																		data-label="Messages"
																	>
																		{session().messageCount}
																	</td>
																	<td headers="fleet-actions-column" class="fleet-actions-cell">
																		<span class="actions">
																			<button
																				type="button"
																				class="btn btn-small"
																				onClick={() => resume(session())}
																			>
																				resume
																			</button>
																			<button
																				type="button"
																				class="btn btn-small"
																				onClick={() => setRenameTarget(session())}
																			>
																				rename
																			</button>
																			<button
																				type="button"
																				class="btn btn-small btn-danger"
																				onClick={() => {
																					setDeleteError(undefined);
																					setConfirmDelete(session());
																				}}
																			>
																				delete
																			</button>
																		</span>
																	</td>
																</tr>
															)}
														</Show>
													)}
												</For>
												<Show when={sessions().length > 3}>
													<tr class="fleet-more-row">
														<td colSpan={5}>
															<button
																type="button"
																class="disk-more"
																onClick={() =>
																	setExpandedGroups((current) => ({
																		...current,
																		[project]: !expanded(),
																	}))
																}
															>
																{expanded()
																	? "show fewer ←"
																	: `all ${sessions().length} ${searchActive() ? "matches" : "on disk"} →`}
															</button>
														</td>
													</tr>
												</Show>
											</tbody>
										);
									}}
								</For>
							</table>
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

			<Show when={renameTarget()} keyed>
				{(session) => (
					<RenameSessionModal
						session={session}
						onClose={() => setRenameTarget(undefined)}
						onGenerate={async (signal) => (await api.generateSessionTitle(session.path, signal)).title}
						onRename={async (name) => {
							await api.renameDiskSession(session.path, name);
							setRenameTarget(undefined);
							// Inventory refresh failures surface through the fleet error banner.
							void props.store.refreshDiskSessions().catch(() => {});
						}}
					/>
				)}
			</Show>

			<Show when={confirmDelete()}>
				{(session) => (
					<Modal
						title="delete session?"
						onDismiss={closeDeleteConfirm}
						actions={
							<>
								<button
									type="button"
									class="btn btn-small"
									disabled={deleteBusy()}
									onClick={closeDeleteConfirm}
								>
									cancel
								</button>
								<button
									type="button"
									class="btn btn-small btn-danger"
									disabled={deleteBusy()}
									onClick={() => void confirmDeletion(session())}
								>
									{deleteBusy() ? "deleting…" : "delete"}
								</button>
							</>
						}
					>
						<p>
							{session().name ?? session().firstMessage.slice(0, 80)} — {session().messageCount} messages. The
							session file is moved to trash where supported.
						</p>
						<Show when={deleteError()}>
							<p class="pair-error" role="alert">
								{deleteError()}
							</p>
						</Show>
					</Modal>
				)}
			</Show>
		</div>
	);
}
