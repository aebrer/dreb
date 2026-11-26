import { createMemo, createResource, createSignal, For, type JSX, Show } from "solid-js";
import { type AutomationModel, type AutomationSetupMessage, isAutomationActive } from "../../shared/automation.js";
import type { ModelInfoDto } from "../../shared/protocol.js";
import { api } from "../api.js";
import { Topbar } from "../components/common.js";
import { runtimeProjectChoices } from "../components/resume-session-modal.js";
import { MarkdownBody, Transcript } from "../components/transcript.js";
import { type MessageLike, messagesToEntries } from "../state/reducer.js";
import type { AppStore } from "../state/store.js";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function result<T>(promise: Promise<T>): Promise<{ value?: T; error?: string }> {
	try {
		return { value: await promise };
	} catch (error) {
		return { error: errorText(error) };
	}
}

function selectModelKey(model: AutomationModel): string {
	return JSON.stringify([model.provider, model.id]);
}

function ModelSelect(props: {
	id: string;
	label: string;
	models: ModelInfoDto[];
	value: string;
	onSelect: (key: string) => void;
	disabled: boolean;
}): JSX.Element {
	const groups = createMemo(() => {
		const groups = new Map<string, ModelInfoDto[]>();
		for (const model of props.models) {
			const group = groups.get(model.provider);
			if (group) group.push(model);
			else groups.set(model.provider, [model]);
		}
		return [...groups];
	});
	return (
		<div class="field">
			<label for={props.id}>{props.label}</label>
			<select
				id={props.id}
				value={props.value}
				disabled={props.disabled}
				onChange={(event) => props.onSelect(event.currentTarget.value)}
			>
				<option value="">Choose a model</option>
				<For each={groups()}>
					{([provider, models]) => (
						<optgroup label={provider}>
							<For each={models}>
								{(model) => <option value={selectModelKey(model)}>{model.name || model.id}</option>}
							</For>
						</optgroup>
					)}
				</For>
			</select>
		</div>
	);
}

function NewGoal(props: { store: AppStore; onStarted: () => void; onCancel: () => void }): JSX.Element {
	const [cwd, setCwd] = createSignal("");
	const [project, setProject] = createSignal<string>();
	const [models, setModels] = createSignal<ModelInfoDto[]>([]);
	const [workerKey, setWorkerKey] = createSignal("");
	const [guardKey, setGuardKey] = createSignal("");
	const [draft, setDraft] = createSignal("");
	const [messages, setMessages] = createSignal<AutomationSetupMessage[]>([]);
	const [instructions, setInstructions] = createSignal<string | null>(null);
	const [busy, setBusy] = createSignal<"project" | "reply" | "launch">();
	const [error, setError] = createSignal<string>();
	const worker = () => models().find((model) => selectModelKey(model) === workerKey());
	const guard = () => models().find((model) => selectModelKey(model) === guardKey());

	async function chooseProject() {
		if (!cwd().trim() || busy()) return;
		setBusy("project");
		setError(undefined);
		try {
			const selected = await api.automationModels(cwd());
			setProject(selected.cwd);
			setModels(selected.models);
			setWorkerKey("");
			setGuardKey("");
		} catch (error) {
			setError(errorText(error));
		} finally {
			setBusy(undefined);
		}
	}

	async function send() {
		const path = project();
		const model = worker();
		const text = draft();
		if (!path || !model || !text.trim() || busy()) return;
		const next: AutomationSetupMessage[] = [...messages(), { role: "user", text }];
		setBusy("reply");
		setError(undefined);
		setInstructions(null);
		try {
			const reply = await api.automationSetup(path, { provider: model.provider, id: model.id }, next);
			setMessages([...next, { role: "assistant", text: reply.message }]);
			setInstructions(reply.instructions);
			setDraft("");
		} catch (error) {
			setError(errorText(error));
		} finally {
			setBusy(undefined);
		}
	}

	async function start() {
		const path = project();
		const workerModel = worker();
		const guardModel = guard();
		const text = instructions();
		if (!path || !workerModel || !guardModel || !text || draft().trim() || busy()) return;
		setBusy("launch");
		setError(undefined);
		try {
			await api.launchAutomation({ cwd: path, workerModel, guardModel, instructions: text });
			props.onStarted();
		} catch (error) {
			setError(errorText(error));
		} finally {
			setBusy(undefined);
		}
	}

	return (
		<section class="automate-panel" aria-label="New goal">
			<h2>New goal</h2>
			<Show
				when={project()}
				fallback={
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void chooseProject();
						}}
					>
						<div class="field">
							<label for="automation-project">Project directory</label>
							<input
								id="automation-project"
								value={cwd()}
								disabled={Boolean(busy())}
								onInput={(event) => setCwd(event.currentTarget.value)}
							/>
						</div>
						<div class="recent-projects">
							<For each={runtimeProjectChoices(props.store.fleet())}>
								{(path) => (
									<button type="button" disabled={Boolean(busy())} onClick={() => setCwd(path)}>
										{path}
									</button>
								)}
							</For>
						</div>
						<button class="btn" type="submit" disabled={Boolean(busy()) || !cwd().trim()}>
							{busy() === "project" ? "Checking…" : "Use project"}
						</button>
					</form>
				}
			>
				{(path) => (
					<>
						<p>
							<code>{path()}</code>
						</p>
						<div class="automation-models">
							<ModelSelect
								id="automation-worker-model"
								label="Orchestrator model"
								models={models()}
								value={workerKey()}
								onSelect={setWorkerKey}
								disabled={Boolean(busy())}
							/>
							<ModelSelect
								id="automation-guard-model"
								label="Guard model"
								models={models()}
								value={guardKey()}
								onSelect={setGuardKey}
								disabled={Boolean(busy())}
							/>
						</div>
						<Show when={models().length === 0}>
							<output>No available models for this project.</output>
						</Show>
						<p class="muted">
							Tell dreb what you want done, what it can decide, and when to stop. Setup uses the orchestrator
							model in a separate conversation.
						</p>
						<div class="automation-chat" role="log" aria-label="Setup chat">
							<For each={messages()}>
								{(message) => (
									<div class={`entry ${message.role}`}>
										<strong>{message.role === "user" ? "You" : "Setup"}</strong>
										{message.role === "user" ? (
											<div class="entry-body">{message.text}</div>
										) : (
											<MarkdownBody text={message.text} />
										)}
									</div>
								)}
							</For>
							<Show when={busy() === "reply"}>
								<output>Setup is responding…</output>
							</Show>
						</div>
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void send();
							}}
						>
							<div class="field">
								<label for="automation-message">Message</label>
								<textarea
									id="automation-message"
									rows={3}
									value={draft()}
									disabled={Boolean(busy())}
									onInput={(event) => setDraft(event.currentTarget.value)}
								/>
							</div>
							<button class="btn" type="submit" disabled={Boolean(busy()) || !worker() || !draft().trim()}>
								Send
							</button>
						</form>
						<Show when={instructions()}>
							{(text) => (
								<section class="automate-panel automation-proposal">
									<h3>Instructions to hand off</h3>
									<div class="automation-instructions">{text()}</div>
									<button
										class="btn btn-primary"
										type="button"
										disabled={Boolean(busy()) || !worker() || !guard() || Boolean(draft().trim())}
										onClick={() => void start()}
									>
										{busy() === "launch" ? "Starting…" : "Start goal"}
									</button>
								</section>
							)}
						</Show>
					</>
				)}
			</Show>
			<Show when={error()}>
				{(message) => (
					<p class="pair-error" role="alert">
						{message()}
					</p>
				)}
			</Show>
			<button class="btn" type="button" disabled={Boolean(busy())} onClick={props.onCancel}>
				Cancel setup
			</button>
		</section>
	);
}

function RunDetail(props: { id: string; revision: () => string }): JSX.Element {
	const [error, setError] = createSignal<string>();
	const [showSession, setShowSession] = createSignal(false);
	const [stopping, setStopping] = createSignal(false);
	const [detail, { refetch }] = createResource(props.revision, () => result(api.automationRun(props.id)));
	const [transcript] = createResource(
		() => showSession() && props.revision(),
		() => result(api.automationTranscript(props.id)),
	);
	const entries = createMemo(() => messagesToEntries((transcript()?.value?.messages ?? []) as MessageLike[]));
	async function stop() {
		setError(undefined);
		setStopping(true);
		try {
			await api.stopAutomation(props.id);
			await refetch();
		} catch (error) {
			setError(errorText(error));
		} finally {
			setStopping(false);
		}
	}
	return (
		<>
			<a href="#/automate">All automation runs</a>
			<Show when={detail()?.error}>
				{(message) => (
					<p class="pair-error" role="alert">
						{message()}
					</p>
				)}
			</Show>
			<Show when={detail.loading && !detail()}>
				<output>Loading run…</output>
			</Show>
			<Show when={detail()?.value}>
				{(run) => (
					<>
						<h2>Goal run</h2>
						<p>
							{run().status} · <code>{run().cwd}</code>
						</p>
						<Show when={isAutomationActive(run().status)}>
							<button class="btn" type="button" disabled={stopping()} onClick={() => void stop()}>
								Stop run
							</button>
						</Show>
						<Show when={error()}>
							{(message) => (
								<p class="pair-error" role="alert">
									{message()}
								</p>
							)}
						</Show>
						<details class="automate-panel">
							<summary>Agreed instructions and models</summary>
							<div class="automation-instructions">{run().instructions}</div>
							<p>
								Orchestrator: {run().workerModel.provider}/{run().workerModel.id}
								<br />
								Guard: {run().guardModel.provider}/{run().guardModel.id}
							</p>
						</details>
						<Show when={run().outcome || run().finalReport}>
							<section class="automate-panel">
								<h3>Final report</h3>
								<p>{run().outcome}</p>
								<MarkdownBody text={run().finalReport ?? ""} />
							</section>
						</Show>
						<section class="automate-panel">
							<h3>Decision history</h3>
							<Show when={run().decisions.length} fallback={<p class="muted">No guard decisions yet.</p>}>
								<ol class="automation-decisions">
									<For each={run().decisions}>
										{(decision) => (
											<li>
												<strong>{decision.action}</strong> ·{" "}
												<time dateTime={decision.at}>{decision.at}</time>
												<p>{decision.reason}</p>
												<MarkdownBody text={decision.report} />
											</li>
										)}
									</For>
								</ol>
							</Show>
						</section>
						<section class="automate-panel">
							<h3>Work session</h3>
							<Show when={run().hasSession} fallback={<p class="muted">No saved session is available.</p>}>
								<button
									class="btn"
									type="button"
									aria-expanded={showSession()}
									onClick={() => setShowSession(!showSession())}
								>
									{showSession() ? "Hide saved session" : "View saved session"}
								</button>
								<Show when={showSession()}>
									<Show when={transcript.loading && !transcript()}>
										<output>Loading session…</output>
									</Show>
									<Show when={transcript()?.error}>
										{(message) => (
											<p class="pair-error" role="alert">
												{message()}
											</p>
										)}
									</Show>
									<Transcript
										entries={entries()}
										who="orchestrator"
										imageScope={{ runtimeKey: `automation-${props.id}` }}
									/>
								</Show>
							</Show>
						</section>
					</>
				)}
			</Show>
		</>
	);
}

export function AutomateScreen(props: { store: AppStore }): JSX.Element {
	const [editing, setEditing] = createSignal(false);
	const id = () => {
		const route = props.store.route();
		return route.screen === "automate" ? route.id : undefined;
	};
	const revision = () =>
		`${props.store.connection().state}:${props.store.resyncing()}:${props.store.automationRevision()}`;
	const [history, { refetch }] = createResource(
		() => !id() && revision(),
		() => result(api.automationRuns()),
	);
	return (
		<>
			<Topbar store={props.store} active="automate" />
			<main class="automate-screen">
				<h1>Automate</h1>
				<Show
					when={id()}
					keyed
					fallback={
						<>
							<Show
								when={editing()}
								fallback={
									<button class="btn btn-primary" type="button" onClick={() => setEditing(true)}>
										New goal
									</button>
								}
							>
								<NewGoal
									store={props.store}
									onCancel={() => setEditing(false)}
									onStarted={() => {
										setEditing(false);
										void refetch();
									}}
								/>
							</Show>
							<section class="automate-panel" aria-label="Automation history">
								<h2>Runs</h2>
								<Show when={history()?.error}>
									{(message) => (
										<p class="pair-error" role="alert">
											{message()}
										</p>
									)}
								</Show>
								<Show when={history.loading && !history()}>
									<output>Loading runs…</output>
								</Show>
								<Show when={history()?.value}>
									{(response) => (
										<Show when={response().runs.length} fallback={<p class="muted">No runs yet.</p>}>
											<ul class="automation-runs">
												<For each={response().runs}>
													{(run) => (
														<li>
															<a href={`#/automate/${encodeURIComponent(run.id)}`}>{run.taskPreview}</a>
															<p>
																<code>{run.cwd}</code> · {run.status}
															</p>
															<Show when={run.latestDecision}>
																{(decision) => (
																	<p>
																		{decision().action}: {decision().reason}
																	</p>
																)}
															</Show>
															<Show when={run.outcome && run.outcome !== run.latestDecision?.reason}>
																<p>{run.outcome}</p>
															</Show>
														</li>
													)}
												</For>
											</ul>
										</Show>
									)}
								</Show>
							</section>
						</>
					}
				>
					{(runId) => <RunDetail id={runId} revision={revision} />}
				</Show>
			</main>
		</>
	);
}
