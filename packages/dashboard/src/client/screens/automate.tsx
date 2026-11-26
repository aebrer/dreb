import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { AutomationRun } from "../../shared/automation.js";
import type { FleetRuntimeSnapshotDto } from "../../shared/protocol.js";
import { api } from "../api.js";
import { BannerRegion, FleetCard, StatusChip, Topbar } from "../components/common.js";
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

function RunCard(props: { run: AutomationRun; now: number; onError: (message: string) => void }): JSX.Element {
	const [stopping, setStopping] = createSignal(false);
	const tone = () => (running(props.run) ? "running" : props.run.status === "stopped" ? "idle" : "error");
	const latest = () => props.run.decisions.at(-1);
	const href = (ref: string) => routeToHash({ screen: "automation", runId: props.run.id, ref });
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
	return (
		<FleetCard status={tone()}>
			<div class="session-title">
				<span class="name" title={props.run.draft.instructions}>
					{props.run.draft.instructions}
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
					Setup
				</a>
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
			</div>
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
			props.store.navigate({ screen: "session", key: runtime.key, automationSetup: true });
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreating(false);
		}
	}

	const card = (run: AutomationRun) => <RunCard run={run} now={now()} onError={setActionError} />;
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
	onCleanup(() => controller.abort());
	onMount(async () => {
		try {
			if (props.record === "report") {
				const { runs } = await api.automations(controller.signal);
				const run = runs.find((item) => item.id === props.runId);
				if (run?.report === undefined) throw new Error("Final report not found.");
				setReport(run.report);
			} else {
				const { messages } = await api.automationTranscript(props.runId, props.record, controller.signal);
				setEntries(messagesToEntries(messages as MessageLike[]));
			}
		} catch (err) {
			if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
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
								<Transcript entries={entries()} />
							</Show>
						</Show>
					</Show>
				</div>
			</main>
		</div>
	);
}
