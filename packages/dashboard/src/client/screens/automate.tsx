import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { AutomationRun } from "../../shared/automation.js";
import type { FleetRuntimeSnapshotDto } from "../../shared/protocol.js";
import { api } from "../api.js";
import { BannerRegion, FleetCard, Modal, StatusChip, Topbar } from "../components/common.js";
import { MarkdownBody, Transcript } from "../components/transcript.js";
import { type MessageLike, messagesToEntries, type TranscriptEntry } from "../state/reducer.js";
import { type AppStore, routeToHash } from "../state/store.js";

const POLL_MS = 3000;

function ErrorBanner(props: { message: string; dismiss: () => void; warning?: boolean }): JSX.Element {
	return (
		<BannerRegion
			banners={
				props.message
					? [
							{
								key: "automation",
								text: props.message,
								tone: props.warning ? "warning" : "error",
								onDismiss: props.dismiss,
							},
						]
					: []
			}
		/>
	);
}

function running(run: AutomationRun): boolean {
	return run.status === "working" || run.status === "reviewing";
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function RunCard(props: {
	run: AutomationRun;
	now: number;
	store: AppStore;
	past?: boolean;
	onError: (message: string) => void;
	onWarning: (message: string) => void;
}): JSX.Element {
	const [resuming, setResuming] = createSignal(false);
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	const [stopping, setStopping] = createSignal(false);
	const [relaunching, setRelaunching] = createSignal(false);
	const [renaming, setRenaming] = createSignal(false);
	const [nameDraft, setNameDraft] = createSignal(props.run.name ?? props.run.draft.name);
	const [savingName, setSavingName] = createSignal(false);
	const [confirmingDelete, setConfirmingDelete] = createSignal(false);
	const [deleting, setDeleting] = createSignal(false);
	const title = () => props.run.name ?? props.run.draft.name;
	const tone = () => (running(props.run) ? "running" : props.run.status === "stopped" ? "idle" : "error");
	const latest = () => props.run.decisions.at(-1);
	const href = (ref: string) => routeToHash({ screen: "automation", runId: props.run.id, ref });
	async function resumeSetup() {
		if (resuming()) return;
		setResuming(true);
		try {
			const runtime = await api.resumeSavedAutomationSetup(props.run.id);
			if (disposed) return;
			props.store.rememberSetupRuntime(runtime);
			props.store.navigate({ screen: "session", key: runtime.key, automationSetup: true });
		} catch (err) {
			if (!disposed) props.onError(err instanceof Error ? err.message : String(err));
		} finally {
			setResuming(false);
		}
	}
	async function stop() {
		if (stopping()) return;
		setStopping(true);
		try {
			const result = await api.stopAutomation(props.run.id);
			if (result.warning) props.onWarning(result.warning);
			// The inventory poll will move the card to history when the host stops it.
		} catch (err) {
			props.onError(err instanceof Error ? err.message : String(err));
			setStopping(false);
		}
	}
	async function relaunch() {
		if (relaunching()) return;
		setRelaunching(true);
		try {
			await api.relaunchAutomation(props.run.id);
			// The poll surfaces the new attempt; a failure keeps the button available.
		} catch (err) {
			props.onError(err instanceof Error ? err.message : String(err));
		} finally {
			setRelaunching(false);
		}
	}
	async function saveName() {
		if (savingName()) return;
		const next = nameDraft().trim();
		if (!next) return;
		setSavingName(true);
		try {
			await api.renameAutomation(props.run.id, next);
			setRenaming(false);
		} catch (err) {
			props.onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingName(false);
		}
	}
	async function remove() {
		if (deleting()) return;
		setDeleting(true);
		try {
			await api.deleteAutomation(props.run.id);
			// The poll drops the record; the card unmounts before this signal resets.
		} catch (err) {
			props.onError(err instanceof Error ? err.message : String(err));
			setDeleting(false);
			setConfirmingDelete(false);
		}
	}
	const content = (
		<>
			<Show when={!props.past}>
				<div class="session-title">
					<span class="name" title={title()}>
						{title()}
					</span>
					<StatusChip status={tone()} label={props.run.status} />
				</div>
				<span class="session-project" title={props.run.draft.cwd}>
					{props.run.draft.cwd}
				</span>
			</Show>
			<div class="session-meta">
				Elapsed: {elapsed((props.run.endedAt ?? props.now) - props.run.startedAt)} · Compactions:{" "}
				{props.run.compactions} · Guard decisions: {props.run.decisions.length}
			</div>
			<Show when={latest()}>
				{(decision) => (
					<div class="activity">
						Latest: {decision().action} — {decision().report}
					</div>
				)}
			</Show>
			<div class="session-actions">
				<a class="btn btn-small" href={href("setup")}>
					Setup transcript
				</a>
				<button type="button" class="btn btn-small" disabled={resuming()} onClick={resumeSetup}>
					{resuming() ? "Opening setup…" : "Resume setup"}
				</button>
				<Show when={props.run.workFile}>
					<a class="btn btn-small" href={href("work")}>
						Orchestrator
					</a>
				</Show>
				<For each={props.run.guardFiles}>
					{(_, index) => (
						<a class="btn btn-small" href={href(`guard-${index()}`)}>
							Guard {index() + 1}
						</a>
					)}
				</For>
				<Show when={!props.past && props.run.report !== undefined}>
					<a class="btn btn-small" href={href("report")}>
						Final report
					</a>
				</Show>
				<Show when={running(props.run)}>
					<button type="button" class="btn btn-small btn-danger" disabled={stopping()} onClick={stop}>
						{stopping() ? "Stopping…" : "Stop"}
					</button>
				</Show>
				<Show when={!running(props.run)}>
					<button type="button" class="btn btn-small btn-primary" disabled={relaunching()} onClick={relaunch}>
						{relaunching() ? "Relaunching…" : "Relaunch"}
					</button>
					<button type="button" class="btn btn-small" onClick={() => setRenaming(true)}>
						Rename
					</button>
					<button
						type="button"
						class="btn btn-small btn-danger"
						disabled={deleting()}
						onClick={() => setConfirmingDelete(true)}
					>
						Delete
					</button>
				</Show>
			</div>
			<Show when={props.run.decisions.length > 0}>
				<details class="automation-decisions">
					<summary>Decision history</summary>
					<ol>
						<For each={props.run.decisions}>
							{(decision) => (
								<li>
									<strong>{decision.action === "stop" ? "Stop" : "Continue"}</strong> ·{" "}
									<time dateTime={new Date(decision.at).toISOString()}>
										{new Date(decision.at).toLocaleString()}
									</time>
									<MarkdownBody text={decision.report} />
								</li>
							)}
						</For>
					</ol>
				</details>
			</Show>
			<Show when={renaming()}>
				<Modal
					title="Rename automation"
					onDismiss={() => !savingName() && setRenaming(false)}
					actions={
						<>
							<button
								type="button"
								class="btn btn-small"
								disabled={savingName()}
								onClick={() => setRenaming(false)}
							>
								Cancel
							</button>
							<button type="button" class="btn btn-small btn-primary" disabled={savingName()} onClick={saveName}>
								{savingName() ? "Saving…" : "Save"}
							</button>
						</>
					}
				>
					<label class="field">
						Name
						<input
							type="text"
							maxlength={80}
							value={nameDraft()}
							onInput={(e) => setNameDraft(e.currentTarget.value)}
						/>
					</label>
				</Modal>
			</Show>
			<Show when={confirmingDelete()}>
				<Modal
					title="Delete automation"
					onDismiss={() => !deleting() && setConfirmingDelete(false)}
					actions={
						<>
							<button
								type="button"
								class="btn btn-small"
								disabled={deleting()}
								onClick={() => setConfirmingDelete(false)}
							>
								Cancel
							</button>
							<button type="button" class="btn btn-small btn-danger" disabled={deleting()} onClick={remove}>
								{deleting() ? "Deleting…" : "Delete"}
							</button>
						</>
					}
				>
					<p>Delete “{title()}” and its saved history? The work it produced is not changed.</p>
				</Modal>
			</Show>
		</>
	);
	if (!props.past) return <FleetCard status={tone()}>{content}</FleetCard>;
	return (
		<tr class="disk-row automation-history-row">
			<td class="fleet-name-cell">
				<span class="name">{title()}</span>
			</td>
			<td data-label="Status">
				<StatusChip status={tone()} label={props.run.status} />
			</td>
			<td class="automation-history-actions">
				<Show when={props.run.report !== undefined}>
					<a class="btn btn-small" href={href("report")}>
						Final report
					</a>
				</Show>
				<details class="automation-history-details">
					<summary class="btn btn-small">Details</summary>
					{content}
				</details>
			</td>
		</tr>
	);
}

export function AutomateScreen(props: { store: AppStore }): JSX.Element {
	const [creating, setCreating] = createSignal(false);
	const [actionError, setActionError] = createSignal("");
	const [actionWarning, setActionWarning] = createSignal("");
	const [historyIssue, setHistoryIssue] = createSignal<string>();
	const [saveIssue, setSaveIssue] = createSignal("");
	// A dismissed storage warning stays dismissed while the message is unchanged, so the poll does
	// not reopen a banner the owner already acknowledged.
	let dismissedSaveIssue: string | undefined;
	const [inventoryError, setInventoryError] = createSignal("");
	const [loaded, setLoaded] = createSignal(false);
	const [runs, setRuns] = createStore<AutomationRun[]>([]);
	const [setups, setSetups] = createStore<FleetRuntimeSnapshotDto[]>([]);
	const [now, setNow] = createSignal(Date.now());
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => {
		controller.abort();
		clearTimeout(timer);
	});

	async function poll() {
		try {
			const result = await api.automations(controller.signal);
			if (controller.signal.aborted) return;
			// Preserve card identity (including focus and pending Stop) across fresh JSON snapshots.
			setRuns(
				reconcile(
					result.runs.toSorted(
						(a, b) =>
							compareText(a.draft.cwd, b.draft.cwd) || a.startedAt - b.startedAt || compareText(a.id, b.id),
					),
				),
			);
			setSetups(
				reconcile(
					(result.setups ?? []).toSorted(
						(a, b) =>
							compareText(a.cwd, b.cwd) || compareText(a.createdAt, b.createdAt) || compareText(a.key, b.key),
					),
					{ key: "key" },
				),
			);
			setNow(Date.now());
			setLoaded(true);
			setHistoryIssue(result.historyIssue);
			setSaveIssue(result.saveIssue === dismissedSaveIssue ? "" : (result.saveIssue ?? ""));
			setInventoryError("");
		} catch (err) {
			if (!controller.signal.aborted) setInventoryError(err instanceof Error ? err.message : String(err));
		} finally {
			if (!controller.signal.aborted) timer = setTimeout(poll, POLL_MS);
		}
	}
	onMount(() => void poll());
	const live = createMemo(() => runs.filter(running));
	const past = createMemo(() =>
		Map.groupBy(
			runs.filter((run) => !running(run)),
			(run) => run.draft.cwd,
		),
	);

	async function newAutomation() {
		if (creating()) return;
		setCreating(true);
		setActionError("");
		try {
			const runtime = await api.setupAutomation();
			if (controller.signal.aborted) return;
			props.store.rememberSetupRuntime(runtime);
			props.store.navigate({ screen: "session", key: runtime.key, automationSetup: true });
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreating(false);
		}
	}

	const entry = (run: AutomationRun, inHistory = false) => (
		<RunCard
			run={run}
			now={now()}
			store={props.store}
			past={inHistory}
			onError={setActionError}
			onWarning={setActionWarning}
		/>
	);
	return (
		<div class="screen-fill">
			<Topbar store={props.store} active="automate" />
			<ErrorBanner message={actionError()} dismiss={() => setActionError("")} />
			<ErrorBanner message={actionWarning()} dismiss={() => setActionWarning("")} warning />
			<ErrorBanner
				message={saveIssue()}
				dismiss={() => {
					dismissedSaveIssue = saveIssue();
					setSaveIssue("");
				}}
				warning
			/>
			<ErrorBanner message={inventoryError()} dismiss={() => setInventoryError("")} />
			<main class="container">
				<div class="fleet-head">
					<h1>automate</h1>
					<button
						type="button"
						class="btn btn-primary"
						disabled={creating() || !!historyIssue()}
						onClick={newAutomation}
					>
						{creating() ? "Opening setup…" : "New automation"}
					</button>
				</div>
				<Show when={historyIssue()}>
					<p class="pair-error" role="alert">
						{historyIssue()}
					</p>
				</Show>
				<Show
					when={loaded()}
					fallback={<p class="muted">{inventoryError() ? "Inventory unavailable." : "Loading automations…"}</p>}
				>
					<Show when={setups.length > 0}>
						<section class="live-sessions" aria-label="Setup chats">
							<h2>Setup chats</h2>
							<div class="session-grid">
								<For each={setups}>
									{(setup) => {
										const tone = () =>
											setup.error
												? "error"
												: setup.needsAttention
													? "attention"
													: setup.state.isStreaming || setup.state.isRetrying || setup.state.isCompacting
														? "running"
														: "idle";
										return (
											<FleetCard status={tone()}>
												<div class="session-title">
													<span class="name">{setup.state.sessionName ?? "Automation setup"}</span>
													<StatusChip status={tone()} />
												</div>
												<span class="session-project" title={setup.cwd}>
													{setup.cwd}
												</span>
												<div class="session-actions">
													<a
														class="btn btn-small"
														href={routeToHash({
															screen: "session",
															key: setup.key,
															automationSetup: true,
														})}
													>
														Open setup chat
													</a>
												</div>
											</FleetCard>
										);
									}}
								</For>
							</div>
						</section>
					</Show>
					<section class="live-sessions" aria-label="Running automations">
						<h2>Running automations</h2>
						<div class="session-grid">
							<For each={live()} fallback={<p class="muted">No running automations.</p>}>
								{(run) => entry(run)}
							</For>
						</div>
					</section>
					<section class="past-sessions" aria-label="Past automations">
						<h2>Past automations</h2>
						<Show when={past().size} fallback={<p class="muted">No past automations.</p>}>
							<table class="fleet-session-table automation-history">
								<caption class="fleet-visually-hidden">Past automations grouped by project</caption>
								<thead>
									<tr>
										<th scope="col">Job</th>
										<th scope="col" class="fleet-static-heading">
											Status
										</th>
										<th scope="col" class="fleet-static-heading">
											Actions
										</th>
									</tr>
								</thead>
								<For each={[...past().keys()]}>
									{(cwd) => (
										<tbody class="project-group">
											<tr class="fleet-project-row">
												<th scope="rowgroup" colSpan={3}>
													<div class="group-head">
														<h3>{cwd}</h3>
													</div>
												</th>
											</tr>
											<For each={past().get(cwd)}>{(run) => entry(run, true)}</For>
										</tbody>
									)}
								</For>
							</table>
						</Show>
					</section>
				</Show>
			</main>
		</div>
	);
}

/** A saved record never attaches to a runtime, even when its run is still active. */
export function AutomationRecordScreen(props: { store: AppStore; runId: string; record: string }): JSX.Element {
	const [savedEntries, setSavedEntries] = createSignal<TranscriptEntry[]>([]);
	const [partialEntry, setPartialEntry] = createSignal<TranscriptEntry>();
	const entries = createMemo(() => {
		const partial = partialEntry();
		return partial ? [...savedEntries(), partial] : savedEntries();
	});
	const [report, setReport] = createSignal("");
	const [error, setError] = createSignal("");
	const [loading, setLoading] = createSignal(true);
	const controller = new AbortController();
	const transcript = props.record !== "report";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	// Polling is for growth: a transcript stops changing when its run stops, and the server
	// says so with each payload. Keep the last raw payload to skip rebuilding entries when
	// nothing arrived, so read state (window, expanded cards) survives idle polls.
	const [live, setLive] = createSignal(true);
	let lastPayload = "";
	onCleanup(() => {
		stopped = true;
		controller.abort();
		clearTimeout(timer);
	});
	// Refresh saved messages and the current RPC assistant snapshot in the same read-only view.
	async function load(reportOnlyOnce = false) {
		try {
			if (props.record === "report") {
				const { runs } = await api.automations(controller.signal);
				if (stopped) return;
				const run = runs.find((item) => item.id === props.runId);
				if (run?.report === undefined) throw new Error("Final report not found.");
				setReport(run.report);
			} else {
				const { messages, running, streamMessage } = await api.automationTranscript(
					props.runId,
					props.record,
					controller.signal,
				);
				if (stopped) return;
				setLive(running !== false);
				const payload = JSON.stringify(messages);
				if (payload !== lastPayload) {
					lastPayload = payload;
					setSavedEntries(messagesToEntries(messages as MessageLike[]));
				}
				const partial = streamMessage && messagesToEntries([streamMessage])[0];
				setPartialEntry(partial?.kind === "assistant" ? { ...partial, streaming: true } : undefined);
			}
			if (!stopped) setError("");
		} catch (err) {
			if (stopped) return;
			if (entries().length === 0 || reportOnlyOnce) setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (!stopped) setLoading(false);
		}
	}
	onMount(() => {
		void load(true).finally(() => {
			if (transcript && live() && !stopped) {
				const tick = () => {
					void load().finally(() => {
						if (live() && !stopped) timer = setTimeout(tick, 1500);
					});
				};
				timer = setTimeout(tick, 1500);
			}
		});
	});
	const label =
		props.record === "report"
			? "Final report"
			: props.record === "setup"
				? "Setup conversation"
				: props.record === "work"
					? "Orchestrator transcript"
					: `Guard ${Number(props.record.slice(6)) + 1} review`;
	return (
		<div class="screen-fill">
			<Topbar store={props.store} active="automate" />
			<ErrorBanner message={error()} dismiss={() => setError("")} />
			<main class="chat">
				<div class="chat-inner">
					<a href="#/automate">← Automate</a>
					<h1>{label}</h1>
					<p class="muted small">Run {props.runId} · read-only</p>
					<Show when={!loading()} fallback={<p class="muted">Loading record…</p>}>
						<Show when={props.record !== "report"} fallback={<MarkdownBody text={report()} />}>
							<Show when={entries().length} fallback={!error() && <p class="muted">No saved messages.</p>}>
								{/* Stable resetKey keeps the read window (and "show earlier") across live refreshes,
								    matching the Session and subagent viewers. */}
								<Transcript
									entries={entries()}
									resetKey={`${props.runId}:${props.record}`}
									imageScope={{ automation: { id: props.runId, ref: props.record } }}
								/>
							</Show>
						</Show>
					</Show>
				</div>
			</main>
		</div>
	);
}
