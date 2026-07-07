/**
 * Transcript — renders reducer entries following the export-html renderer's
 * structure (renderEntry/renderToolCall): user boxes, assistant plain text
 * with collapsed thinking, tool cards with bespoke read/write/edit/bash
 * treatment, summary and custom cards.
 */

import { For, type JSX, Match, Show, Switch } from "solid-js";
import type { AssistantEntry, ToolEntry, TranscriptEntry } from "../state/reducer.js";

function toolArgSummary(entry: ToolEntry): string {
	const args = entry.args as Record<string, unknown> | undefined;
	if (!args || typeof args !== "object") return "";
	switch (entry.toolName) {
		case "read":
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
	return (
		<details class="tool" open={props.entry.status === "running"}>
			<summary>
				<span class="tool-name">{props.entry.toolName}</span>
				<span class="tool-arg">{toolArgSummary(props.entry)}</span>
				<span class={`tool-status ${status().cls}`}>{status().text}</span>
			</summary>
			<Show when={props.entry.resultText}>
				<div class="tool-result">
					<Show when={isDiff()} fallback={<pre>{props.entry.resultText}</pre>}>
						<DiffBody text={props.entry.resultText} />
					</Show>
				</div>
			</Show>
		</details>
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
			</div>
			<For each={props.entry.blocks}>
				{(block, index) => (
					<Show
						when={block.kind === "thinking"}
						fallback={
							<div class="entry-body">
								<p
									classList={{
										"streaming-cursor": props.entry.streaming && index() === props.entry.blocks.length - 1,
									}}
								>
									{block.text}
								</p>
							</div>
						}
					>
						<details class="thinking">
							<summary>thinking</summary>
							<div class="thinking-body">{block.text}</div>
						</details>
					</Show>
				)}
			</For>
		</div>
	);
}

export function Transcript(props: { entries: TranscriptEntry[]; who?: string; userLabel?: string }): JSX.Element {
	return (
		<For each={props.entries}>
			{(entry) => (
				<Switch>
					<Match when={entry.kind === "user"}>
						<div class="entry user">
							<div class="entry-head">
								<span>{props.userLabel ?? "you"}</span>
							</div>
							<div class="entry-body">{(entry as { text: string }).text}</div>
						</div>
					</Match>
					<Match when={entry.kind === "assistant"}>
						<AssistantBlockView entry={entry as AssistantEntry} who={props.who ?? "dreb"} />
					</Match>
					<Match when={entry.kind === "tool"}>
						<ToolCard entry={entry as ToolEntry} />
					</Match>
					<Match when={entry.kind === "summary"}>
						<div class="entry summary-card">
							<details>
								<summary>
									{(entry as { label: string }).label === "compaction"
										? "context compacted"
										: "branch summary"}
									<Show when={(entry as { tokensBefore?: number }).tokensBefore}>
										{" "}
										— {(entry as { tokensBefore?: number }).tokensBefore!.toLocaleString()} tokens summarized
									</Show>
								</summary>
								<div class="entry-body" style={{ "margin-top": "8px" }}>
									{(entry as { text: string }).text}
								</div>
							</details>
						</div>
					</Match>
					<Match when={entry.kind === "custom"}>
						<div class="entry custom-card">
							<div class="entry-head">
								<span>{(entry as { tag: string }).tag}</span>
							</div>
							<div class="entry-body">{(entry as { text: string }).text}</div>
						</div>
					</Match>
				</Switch>
			)}
		</For>
	);
}
