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

function ErrorBanner(props: { message: string; dismiss: () => void }): JSX.Element {
	return (
		<BannerRegion
			banners={
				props.message ? [{ key: "automation", text: props.message, tone: "error", onDismiss: props.dismiss }] : []
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
	onError: (message: string) => void;
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
			await api.stopAutomation(props.run.id);
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
	return (
		<FleetCard status={tone()}>
			<div class="session-title">
				<span class="name" title={title()}>
					{title()}
				</span>
				<StatusChip status={tone()} label={props.run.status} />
			</div>
			<span class="session-project" title={props.run.draft.cwd}>
				{props.run.draft.cwd}
			</span>
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
				<Show when={props.run.report !== undefined}>
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
		</FleetCard>
	);
}

export function AutomateScreen(props: { store: AppStore }): JSX.Element {
	const [creating, setCreating] = createSignal(false);
	const [actionError, setActionError] = createSignal("");
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

	const card = (run: AutomationRun) => <RunCard run={run} now={now()} store={props.store} onError={setActionError} />;
	return (
		<div class="screen-fill">
			<Topbar store={props.store} active="automate" />
			<ErrorBanner message={actionError()} dismiss={() => setActionError("")} />
			<ErrorBanner message={inventoryError()} dismiss={() => setInventoryError("")} />
			<main class="container">
				<div class="fleet-head">
					<h1>automate</h1>
					<button type="button" class="btn btn-primary" disabled={creating()} onClick={newAutomation}>
						{creating() ? "Opening setup…" : "New automation"}
					</button>
				</div>
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
								{card}
							</For>
						</div>
					</section>
					<section class="past-sessions" aria-label="Past automations">
						<h2>Past automations</h2>
						<For each={[...past().keys()]} fallback={<p class="muted">No past automations.</p>}>
							{(cwd) => (
								<section>
									<h3 class="group-head">{cwd}</h3>
									<div class="session-grid">
										<For each={past().get(cwd)}>{card}</For>
									</div>
								</section>
							)}
						</For>
					</section>
				</Show>
			</main>
		</div>
	);
}

/** A saved record never attaches to a runtime, even when its run is still active. */
export function AutomationRecordScreen(props: { store: AppStore; runId: string; record: string }): JSX.Element {
	const [entries, setEntries] = createSignal<TranscriptEntry[]>([]);
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
	// A running run keeps appending to its saved transcript. Re-reading on a timer streams
	// new messages into the same read-only view, so an open transcript needs no reload.
	async function load(reportOnlyOnce = false) {
		try {
			if (props.record === "report") {
				const { runs } = await api.automations(controller.signal);
				if (stopped) return;
				const run = runs.find((item) => item.id === props.runId);
				if (run?.report === undefined) throw new Error("Final report not found.");
				setReport(run.report);
			} else {
				const { messages, running } = await api.automationTranscript(props.runId, props.record, controller.signal);
				if (stopped) return;
				setLive(running !== false);
				const payload = JSON.stringify(messages);
				if (payload !== lastPayload) {
					lastPayload = payload;
					setEntries(messagesToEntries(messages as MessageLike[]));
				}
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
								<Transcript entries={entries()} resetKey={`${props.runId}:${props.record}`} />
							</Show>
						</Show>
					</Show>
				</div>
			</main>
		</div>
	);
}
