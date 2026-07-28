import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";

type ScenarioId = "single" | "multiple" | "free-text" | "multiline" | "timeout" | "aborted";
type Surface = "dashboard" | "tui";

interface Scenario {
	id: ScenarioId;
	label: string;
	title: string;
	question: string;
	options: string[];
	multiSelect?: boolean;
	multiline?: boolean;
	terminal?: "timed out" | "cancelled";
}

const scenarios: Scenario[] = [
	{
		id: "single",
		label: "single choice",
		title: "Choose an implementation",
		question: "Which persistence strategy should I use?",
		options: ["SQLite", "PostgreSQL", "Keep the current JSON file"],
	},
	{
		id: "multiple",
		label: "multiple choice",
		title: "Select validation targets",
		question: "Which checks should run before each release?",
		options: ["Unit tests", "Browser tests", "Type checking", "Workspace link verification"],
		multiSelect: true,
	},
	{
		id: "free-text",
		label: "free text",
		title: "Name the new command",
		question: "What should the user-facing command be called?",
		options: [],
	},
	{
		id: "multiline",
		label: "multiline",
		title: "Describe the migration constraint",
		question: "What compatibility requirements must the migration preserve?",
		options: [],
		multiline: true,
	},
	{
		id: "timeout",
		label: "timeout",
		title: "Choose a deployment window",
		question: "When may I restart the production service?",
		options: ["Now", "After 18:00 UTC"],
		terminal: "timed out",
	},
	{
		id: "aborted",
		label: "abort",
		title: "Confirm the target",
		question: "Which environment should receive this change?",
		options: ["Staging", "Production"],
		terminal: "cancelled",
	},
];

function answerSummary(selected: string[], custom: string): string {
	return [...selected, custom.trim()].filter(Boolean).join("; ");
}

function AskPanel(props: { scenario: Scenario; surface: Surface }): JSX.Element {
	const [selected, setSelected] = createSignal<string[]>([]);
	const [custom, setCustom] = createSignal("");
	const [outcome, setOutcome] = createSignal<"answered" | "skipped" | undefined>();
	const terminal = () => props.scenario.terminal;
	const disabled = () => terminal() !== undefined || outcome() !== undefined;
	const inputId = () => `${props.surface}-${props.scenario.id}-custom`;
	const groupName = () => `${props.surface}-${props.scenario.id}-options`;

	createEffect(() => {
		props.scenario.id;
		setSelected([]);
		setCustom("");
		setOutcome(undefined);
	});

	const toggle = (option: string) => {
		if (disabled()) return;
		if (!props.scenario.multiSelect) {
			setSelected([option]);
			return;
		}
		setSelected((current) =>
			current.includes(option) ? current.filter((value) => value !== option) : [...current, option],
		);
	};
	const submit = () => {
		if (!disabled() && answerSummary(selected(), custom())) setOutcome("answered");
	};

	return (
		<section
			class={`surface surface-${props.surface}`}
			data-testid={`${props.surface}-surface`}
			aria-label={`${props.surface === "dashboard" ? "Dashboard" : "TUI"} ask user prototype`}
		>
			<div class="surface-heading">
				<span>{props.surface === "dashboard" ? "Dashboard" : "TUI"}</span>
				<span class="attention">◆ needs attention</span>
			</div>
			<div class="question-frame">
				<header>
					<strong>
						{props.surface === "tui" ? "? " : ""}
						{props.scenario.title}
					</strong>
					<span class="timer" classList={{ expired: terminal() === "timed out" }}>
						{terminal() === "timed out"
							? "timed out"
							: terminal() === "cancelled"
								? "cancelled"
								: "01:42 remaining"}
					</span>
				</header>
				<p class="question">{props.scenario.question}</p>

				<Show when={!terminal()} fallback={<TerminalState kind={terminal()!} />}>
					<Show when={props.scenario.options.length > 0}>
						<fieldset disabled={disabled()}>
							<legend>{props.scenario.multiSelect ? "Choose one or more" : "Choose one"}</legend>
							<For each={props.scenario.options}>
								{(option) => (
									<label class="option" classList={{ selected: selected().includes(option) }}>
										<input
											type={props.scenario.multiSelect ? "checkbox" : "radio"}
											name={groupName()}
											checked={selected().includes(option)}
											onChange={() => toggle(option)}
										/>
										<Show when={props.surface === "tui"}>
											<span class="control-glyph" aria-hidden="true">
												{props.scenario.multiSelect
													? selected().includes(option)
														? "[x]"
														: "[ ]"
													: selected().includes(option)
														? "(●)"
														: "( )"}
											</span>
										</Show>
										<span>{option}</span>
									</label>
								)}
							</For>
						</fieldset>
					</Show>

					<div class="custom-answer">
						<label for={inputId()}>
							{props.scenario.options.length > 0 ? "Or type your own answer" : "Your answer"}
						</label>
						<Show
							when={props.scenario.multiline}
							fallback={
								<input
									id={inputId()}
									type="text"
									value={custom()}
									disabled={disabled()}
									placeholder="Type a different answer…"
									onInput={(event) => setCustom(event.currentTarget.value)}
								/>
							}
						>
							<textarea
								id={inputId()}
								rows="5"
								value={custom()}
								disabled={disabled()}
								placeholder="Add details and constraints…"
								onInput={(event) => setCustom(event.currentTarget.value)}
							/>
						</Show>
					</div>

					<Show
						when={!outcome()}
						fallback={
							<output class={`result result-${outcome()}`}>
								{outcome() === "skipped"
									? "Question skipped — the agent will continue."
									: `Answer: ${answerSummary(selected(), custom())}`}
							</output>
						}
					>
						<footer>
							<span class="hint">Esc skips without answering</span>
							<div class="actions">
								<button type="button" class="button secondary" onClick={() => setOutcome("skipped")}>
									Skip
								</button>
								<button
									type="button"
									class="button primary"
									disabled={!answerSummary(selected(), custom())}
									onClick={submit}
								>
									Submit answer
								</button>
							</div>
						</footer>
					</Show>
				</Show>
			</div>
		</section>
	);
}

function TerminalState(props: { kind: "timed out" | "cancelled" }): JSX.Element {
	return (
		<output class="terminal-state">
			<strong>{props.kind === "timed out" ? "No answer received" : "Question cancelled"}</strong>
			<span>
				{props.kind === "timed out"
					? "The time limit elapsed. The agent will continue without an answer."
					: "The request was aborted. The agent will continue without an answer."}
			</span>
		</output>
	);
}

export function AskUserPrototype(): JSX.Element {
	const [scenarioId, setScenarioId] = createSignal<ScenarioId>("single");
	const scenario = () => scenarios.find((item) => item.id === scenarioId()) ?? scenarios[0];

	onMount(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			document.querySelectorAll<HTMLButtonElement>("[data-testid$='-surface'] .secondary").forEach((button) => {
				button.click();
			});
		};
		window.addEventListener("keydown", onKeyDown);
		onCleanup(() => window.removeEventListener("keydown", onKeyDown));
	});

	return (
		<main>
			<style>{prototypeStyles}</style>
			<header class="prototype-header">
				<div>
					<p class="eyebrow">development-only UX prototype</p>
					<h1>
						<code>ask_user</code> cross-surface interaction
					</h1>
					<p class="intro">Compare equivalent Dashboard and terminal treatments before runtime wiring begins.</p>
				</div>
				<section class="contract" aria-label="Interaction contract">
					<strong>Shared contract</strong>
					<span>Options stay visible while typing</span>
					<span>Free text is available by default</span>
					<span>Multiple selections combine with custom text</span>
					<span>Skip, Escape, timeout, and abort always continue safely</span>
				</section>
			</header>

			<nav class="scenario-picker" aria-label="Prototype state">
				<For each={scenarios}>
					{(item) => (
						<button
							type="button"
							classList={{ active: scenarioId() === item.id }}
							onClick={() => setScenarioId(item.id)}
						>
							{item.label}
						</button>
					)}
				</For>
			</nav>

			<div class="comparison">
				<AskPanel scenario={scenario()} surface="dashboard" />
				<AskPanel scenario={scenario()} surface="tui" />
			</div>
		</main>
	);
}

const prototypeStyles = `
:root { color-scheme: dark; font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace; background: #0a0a0a; color: #f2f2f2; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: radial-gradient(circle at 50% -20%, #243226 0, #0a0a0a 38rem); }
button, input, textarea { font: inherit; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid #8bd99b; outline-offset: 2px; }
main { width: min(1240px, calc(100% - 32px)); margin: 0 auto; padding: 40px 0 64px; }
.prototype-header { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 440px); gap: 32px; align-items: end; border-bottom: 1px solid #424242; padding-bottom: 26px; }
.eyebrow { color: #8bd99b; text-transform: uppercase; letter-spacing: .12em; font-size: 12px; margin: 0 0 10px; }
h1 { font-size: clamp(24px, 4vw, 42px); line-height: 1.08; margin: 0; max-width: 720px; }
h1 code { color: #8bd99b; }
.intro { color: #adadad; max-width: 620px; line-height: 1.55; }
.contract { border: 1px solid #48594c; background: #111a13; padding: 16px; display: grid; gap: 7px; font-size: 12px; color: #c8d6ca; }
.contract strong { color: #8bd99b; margin-bottom: 4px; }
.contract span::before { content: "✓ "; color: #8bd99b; }
.scenario-picker { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0; }
.scenario-picker button { color: #bdbdbd; background: #111; border: 1px solid #444; padding: 8px 12px; cursor: pointer; }
.scenario-picker button:hover { border-color: #777; color: white; }
.scenario-picker button.active { background: #d9f7df; border-color: #d9f7df; color: #101510; }
.comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; align-items: start; }
.surface { min-width: 0; }
.surface-heading { display: flex; justify-content: space-between; align-items: center; color: #aaa; font-size: 12px; text-transform: uppercase; letter-spacing: .1em; margin-bottom: 8px; }
.attention { color: #f0be62; letter-spacing: 0; text-transform: none; }
.question-frame { min-height: 510px; border: 1px solid #555; background: #151515; box-shadow: 0 20px 50px #0008; padding: 24px; }
.surface-dashboard .question-frame { border-radius: 8px; background: #171817; }
.surface-tui .question-frame { border: 1px solid #7b7b7b; box-shadow: inset 0 0 0 1px #202020, 0 20px 50px #0008; }
.surface-tui .question-frame::before { content: "┌─ dreb question ─────────────────────────────┐"; display: block; color: #777; overflow: hidden; white-space: nowrap; margin: -19px -15px 16px; }
.question-frame > header { display: flex; align-items: start; justify-content: space-between; gap: 16px; padding-bottom: 14px; border-bottom: 1px solid #414141; }
.question-frame > header strong { color: #fff; }
.surface-tui .question-frame > header strong { color: #8bd99b; }
.timer { color: #91c79b; white-space: nowrap; font-size: 12px; }
.timer.expired { color: #e69686; }
.question { color: #ddd; line-height: 1.5; margin: 18px 0; }
fieldset { border: 0; padding: 0; margin: 0 0 18px; display: grid; gap: 7px; }
legend { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px; }
.option { display: flex; gap: 10px; align-items: center; border: 1px solid #3d3d3d; padding: 10px 12px; cursor: pointer; color: #d0d0d0; }
.surface-dashboard .option { border-radius: 5px; }
.option:hover { border-color: #777; }
.option.selected { border-color: #78c989; background: #18251b; color: white; }
.surface-dashboard .option input { width: 16px; height: 16px; margin: 0 2px 0 0; accent-color: #78c989; flex: 0 0 auto; cursor: pointer; }
.surface-tui .option input { position: absolute; opacity: 0; pointer-events: none; }
.control-glyph { color: #777; min-width: 26px; }
.option.selected .control-glyph { color: #8bd99b; }
.custom-answer { display: grid; gap: 7px; }
.custom-answer label { color: #aaa; font-size: 12px; }
.custom-answer input, .custom-answer textarea { width: 100%; color: #f2f2f2; background: #0b0b0b; border: 1px solid #555; border-radius: 4px; padding: 10px 11px; resize: vertical; }
.surface-tui .custom-answer input, .surface-tui .custom-answer textarea { border-radius: 0; border-color: #777; }
footer { border-top: 1px solid #414141; margin-top: 22px; padding-top: 16px; display: flex; gap: 16px; justify-content: space-between; align-items: center; }
.hint { color: #777; font-size: 11px; }
.actions { display: flex; gap: 8px; }
.button { border: 1px solid #666; padding: 8px 12px; cursor: pointer; }
.button.secondary { color: #ccc; background: transparent; }
.button.primary { color: #101510; background: #a9e6b5; border-color: #a9e6b5; }
.button:disabled { opacity: .35; cursor: not-allowed; }
.result, .terminal-state { display: block; width: 100%; margin-top: 22px; border: 1px solid #4f7657; background: #142019; color: #bce4c4; padding: 14px; line-height: 1.45; }
.result-skipped, .terminal-state { border-color: #6e624b; background: #211d14; color: #e4d4b5; }
.terminal-state { min-height: 150px; display: grid; place-content: center; text-align: center; gap: 10px; }
.terminal-state span { color: #b8ab92; max-width: 400px; }
@media (max-width: 850px) { .prototype-header, .comparison { grid-template-columns: 1fr; } .question-frame { min-height: 0; } }
@media (max-width: 500px) { main { width: min(100% - 20px, 1240px); padding-top: 24px; } .question-frame { padding: 17px; } footer { align-items: stretch; flex-direction: column; } .actions { justify-content: flex-end; } }
`;

const root = document.querySelector("#app");
if (root) render(() => <AskUserPrototype />, root);
