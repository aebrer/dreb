/**
 * Transcript — renders reducer entries following the export-html renderer's
 * structure (renderEntry/renderToolCall): user boxes, assistant plain text
 * with collapsed thinking, tool cards with bespoke read/write/edit/bash
 * treatment, summary and custom cards.
 */

import DOMPurify from "dompurify";
import { marked } from "marked";
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import { expandThinking } from "../state/preferences.js";
import type { AgentResultEntry, AssistantEntry, ToolEntry, TranscriptEntry } from "../state/reducer.js";

function renderMarkdown(text: string): string {
	const html = marked.parse(text, { async: false }) as string;
	return DOMPurify.sanitize(html);
}

function toolArgSummary(entry: ToolEntry): string {
	const args = entry.args as Record<string, unknown> | undefined;
	if (!args || typeof args !== "object") return "";
	switch (entry.toolName) {
		case "read": {
			const lines = readLineCount(entry);
			return `${String(args.path ?? "")}${lines ? ` · ${lines} lines` : ""}`;
		}
		case "write":
			return String(args.path ?? "");
		case "edit":
			return String(args.path ?? "");
		case "bash":
		case "bash (user)":
			return String(args.command ?? "");
		case "grep":
		case "search":
			return String(args.pattern ?? args.query ?? "");
		case "find":
			return String(args.pattern ?? "");
		case "ls":
			return String(args.path ?? ".");
		case "web_fetch":
			return String(args.url ?? "");
		case "web_search":
			return String(args.query ?? "");
		case "subagent": {
			if (typeof args.task === "string") return args.task.slice(0, 120);
			if (Array.isArray(args.tasks)) return `${args.tasks.length} parallel tasks`;
			if (Array.isArray(args.chain)) return `${args.chain.length}-step chain`;
			return "";
		}
		case "skill":
			return String(args.skill ?? "");
		default: {
			const first = Object.values(args)[0];
			return typeof first === "string" ? first.slice(0, 120) : "";
		}
	}
}

function readLineCount(entry: ToolEntry): number | undefined {
	if (entry.toolName !== "read" || !entry.resultText) return undefined;
	return entry.resultText.split("\n").length;
}

function entryCopyText(entry: TranscriptEntry): string | undefined {
	if (entry.kind === "user") return entry.text;
	if (entry.kind === "assistant") {
		return entry.blocks
			.filter((block) => block.kind === "text")
			.map((block) => block.text)
			.join("\n");
	}
	return undefined;
}

function skillName(text: string): string | undefined {
	return text.match(/^\/skill:([\w-]+)/)?.[1];
}

function toolStatus(entry: ToolEntry): { text: string; cls: string } {
	if (entry.status === "running") {
		const elapsed = Math.floor((Date.now() - entry.startedAt) / 1000);
		return { text: `● running${elapsed > 2 ? ` ${elapsed}s` : ""}`, cls: "running" };
	}
	if (entry.status === "error") return { text: "✕ error", cls: "error" };
	return { text: "done", cls: "" };
}

/** Render an edit-tool diff body with status-colored add/del lines. */
function DiffBody(props: { text: string }): JSX.Element {
	return (
		<pre>
			<For each={props.text.split("\n")}>
				{(line) => (
					<>
						<span classList={{ "diff-add": line.startsWith("+"), "diff-del": line.startsWith("-") }}>{line}</span>
						{"\n"}
					</>
				)}
			</For>
		</pre>
	);
}

function ToolCard(props: { entry: ToolEntry }): JSX.Element {
	const status = () => toolStatus(props.entry);
	const isDiff = () => props.entry.toolName === "edit";
	const args = () => props.entry.args as Record<string, unknown> | undefined;
	const bodyText = () => {
		if (props.entry.toolName === "write" && !props.entry.resultText && typeof args()?.content === "string") {
			return String(args()?.content);
		}
		return props.entry.resultText;
	};
	return (
		<details class="tool" open={props.entry.status === "running"}>
			<summary>
				<span class="tool-name">{props.entry.toolName}</span>
				<span class="tool-arg">{toolArgSummary(props.entry)}</span>
				<span class={`tool-status ${status().cls}`}>{status().text}</span>
			</summary>
			<Show when={props.entry.toolName === "bash" || props.entry.toolName === "bash (user)"}>
				<div class="tool-command">
					<code>{String(args()?.command ?? "")}</code>
				</div>
			</Show>
			<Show when={bodyText()}>
				<div class="tool-result">
					<Show when={isDiff()} fallback={<pre>{bodyText()}</pre>}>
						<DiffBody text={bodyText()} />
					</Show>
				</div>
			</Show>
		</details>
	);
}

function CopyButton(props: { text?: string }): JSX.Element {
	const [state, setState] = createSignal<"idle" | "copied" | "failed">("idle");
	async function copy() {
		if (!props.text) return;
		try {
			await navigator.clipboard.writeText(props.text);
			setState("copied");
		} catch {
			setState("failed");
		}
		setTimeout(() => setState("idle"), 1200);
	}
	return (
		<button type="button" class="entry-action" disabled={!props.text} onClick={copy}>
			{state() === "copied" ? "copied" : state() === "failed" ? "copy failed" : "copy"}
		</button>
	);
}

function AssistantBlockView(props: { entry: AssistantEntry; who: string }): JSX.Element {
	return (
		<div class="entry assistant">
			<div class="entry-head">
				<span>{props.who}</span>
				<Show when={props.entry.model}>
					<span>·</span>
					<span>{props.entry.model}</span>
				</Show>
				<Show when={props.entry.streaming}>
					<span>·</span>
					<span>streaming</span>
				</Show>
				<CopyButton text={entryCopyText(props.entry)} />
			</div>
			<For each={props.entry.blocks}>
				{(block, index) => (
					<Show
						when={block.kind === "thinking"}
						fallback={
							<div class="entry-body">
								<div
									class="markdown-body"
									classList={{
										"streaming-cursor": props.entry.streaming && index() === props.entry.blocks.length - 1,
									}}
									innerHTML={renderMarkdown(block.text)}
								/>
							</div>
						}
					>
						<details class="thinking" open={expandThinking()}>
							<summary>thinking</summary>
							<div class="thinking-body">{block.text}</div>
						</details>
					</Show>
				)}
			</For>
		</div>
	);
}

type TranscriptRenderItem =
	| { kind: "assistant-turn"; entries: Array<AssistantEntry | ToolEntry> }
	| { kind: "entry"; entry: TranscriptEntry };

function transcriptRenderItems(entries: TranscriptEntry[]): TranscriptRenderItem[] {
	const items: TranscriptRenderItem[] = [];
	let index = 0;
	while (index < entries.length) {
		const entry = entries[index];
		if (entry?.kind === "assistant") {
			const turnEntries: Array<AssistantEntry | ToolEntry> = [entry];
			index += 1;
			while (entries[index]?.kind === "tool") {
				turnEntries.push(entries[index] as ToolEntry);
				index += 1;
			}
			items.push({ kind: "assistant-turn", entries: turnEntries });
			continue;
		}
		if (entry) items.push({ kind: "entry", entry });
		index += 1;
	}
	return items;
}

function EntryView(props: { entry: TranscriptEntry; who: string; userLabel: string }): JSX.Element {
	return (
		<Switch>
			<Match when={props.entry.kind === "user"}>
				<div class="entry user">
					<div class="entry-head">
						<Show when={skillName((props.entry as { text: string }).text)}>
							{(name) => <span class="skill-badge">skill: {name()}</span>}
						</Show>
						<CopyButton text={entryCopyText(props.entry)} />
						<span>{props.userLabel}</span>
					</div>
					<div class="entry-body">{(props.entry as { text: string }).text}</div>
				</div>
			</Match>
			<Match when={props.entry.kind === "agent-result"}>
				<AgentResultCard entry={props.entry as AgentResultEntry} />
			</Match>
			<Match when={props.entry.kind === "assistant"}>
				<AssistantBlockView entry={props.entry as AssistantEntry} who={props.who} />
			</Match>
			<Match when={props.entry.kind === "tool"}>
				<ToolCard entry={props.entry as ToolEntry} />
			</Match>
			<Match when={props.entry.kind === "summary"}>
				<div class="entry summary-card">
					<details>
						<summary>
							{(props.entry as { label: string }).label === "compaction"
								? "context compacted"
								: "branch summary"}
							<Show when={(props.entry as { tokensBefore?: number }).tokensBefore}>
								{" "}
								— {(props.entry as { tokensBefore?: number }).tokensBefore!.toLocaleString()} tokens summarized
							</Show>
						</summary>
						<div class="entry-body" style={{ "margin-top": "8px" }}>
							{(props.entry as { text: string }).text}
						</div>
					</details>
				</div>
			</Match>
			<Match when={props.entry.kind === "custom"}>
				<div class="entry custom-card">
					<div class="entry-head">
						<span>{(props.entry as { tag: string }).tag}</span>
					</div>
					<div class="entry-body">{(props.entry as { text: string }).text}</div>
				</div>
			</Match>
		</Switch>
	);
}

function AgentResultCard(props: { entry: AgentResultEntry }): JSX.Element {
	return (
		<div class="entry agent-result-card">
			<details>
				<summary>
					<span>background agent result</span>
					<Show when={props.entry.header}>
						<span class="agent-result-header">{props.entry.header}</span>
					</Show>
				</summary>
				<div class="entry-body markdown-body" innerHTML={renderMarkdown(props.entry.text)} />
			</details>
		</div>
	);
}

export function Transcript(props: { entries: TranscriptEntry[]; who?: string; userLabel?: string }): JSX.Element {
	const who = () => props.who ?? "dreb";
	const userLabel = () => props.userLabel ?? "you";
	return (
		<For each={transcriptRenderItems(props.entries)}>
			{(item) => (
				<Switch>
					<Match when={item.kind === "assistant-turn"}>
						<div class="assistant-turn" data-testid="assistant-turn">
							<For
								each={(item as { kind: "assistant-turn"; entries: Array<AssistantEntry | ToolEntry> }).entries}
							>
								{(entry) => <EntryView entry={entry} who={who()} userLabel={userLabel()} />}
							</For>
						</div>
					</Match>
					<Match when={item.kind === "entry"}>
						<EntryView
							entry={(item as { kind: "entry"; entry: TranscriptEntry }).entry}
							who={who()}
							userLabel={userLabel()}
						/>
					</Match>
				</Switch>
			)}
		</For>
	);
}
