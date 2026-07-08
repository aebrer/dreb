/**
 * Transcript — renders reducer entries following the export-html renderer's
 * structure (renderEntry/renderToolCall): user boxes, assistant plain text
 * with collapsed thinking, tool cards with bespoke read/write/edit/bash
 * treatment, summary and custom cards.
 */

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import { expandThinking } from "../state/preferences.js";
import type { AgentResultEntry, AssistantEntry, ToolEntry, TranscriptEntry } from "../state/reducer.js";

function renderMarkdown(text: string): string {
	const html = marked.parse(text, { async: false }) as string;
	return DOMPurify.sanitize(html);
}

function getLanguageFromPath(filePath: unknown): string | undefined {
	if (typeof filePath !== "string" || !filePath) return undefined;
	const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	const ext = name.includes(".") ? name.split(".").pop() : name;
	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		sql: "sql",
		html: "html",
		css: "css",
		scss: "scss",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		xml: "xml",
		md: "markdown",
		dockerfile: "dockerfile",
	};
	return ext ? extToLang[ext] : undefined;
}

function toolPath(args: Record<string, unknown> | undefined): unknown {
	return args?.path ?? args?.file_path;
}

function highlightedHtml(text: string, language: string | undefined): string | undefined {
	if (!language || !hljs.getLanguage(language)) return undefined;
	return DOMPurify.sanitize(hljs.highlight(text, { language, ignoreIllegals: true }).value);
}

function HighlightedPre(props: { text: string; language?: string }): JSX.Element {
	const html = () => highlightedHtml(props.text, props.language);
	return (
		<Show when={html()} fallback={<pre>{props.text}</pre>}>
			{(safeHtml) => (
				<pre>
					<code class="hljs" innerHTML={safeHtml()} />
				</pre>
			)}
		</Show>
	);
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

/**
 * Tools whose result text is markdown by contract (mirrors the TUI, which
 * renders these through its Markdown component): subagent completion reports
 * (`## Agent:` headers), skill bodies (SKILL.md), web_fetch extractions
 * (markdown-converted readable text).
 */
const MARKDOWN_RESULT_TOOLS = new Set(["subagent", "skill", "web_fetch"]);

/** Args rendered as full-input sections in the expanded card body, per tool. */
interface ToolInputSection {
	label: string;
	text: string;
	markdown?: boolean;
	language?: string;
}

function toolInputSections(entry: ToolEntry): ToolInputSection[] {
	const args = entry.args as Record<string, unknown> | undefined;
	if (!args || typeof args !== "object") return [];
	switch (entry.toolName) {
		case "bash":
		case "bash (user)":
			return []; // full command already rendered via .tool-command
		case "read":
		case "ls":
		case "edit":
			return []; // path is fully visible in the summary; edit's diff result carries the change
		case "suggest_next":
			return []; // summary + command render via the details-driven result body
		case "write":
			// While running the full content IS the body (no result yet); after
			// completion the result replaces it, so surface the input here.
			return entry.resultText && typeof args.content === "string"
				? [{ label: "content", text: String(args.content), language: getLanguageFromPath(toolPath(args)) }]
				: [];
		case "subagent": {
			const sections: ToolInputSection[] = [];
			if (typeof args.task === "string") sections.push({ label: "task", text: args.task, markdown: true });
			if (Array.isArray(args.tasks)) {
				(args.tasks as Array<Record<string, unknown>>).forEach((task, i) => {
					if (typeof task?.task === "string")
						sections.push({
							label: `task ${i + 1}${task.agent ? ` (${task.agent})` : ""}`,
							text: task.task,
							markdown: true,
						});
				});
			}
			if (Array.isArray(args.chain)) {
				(args.chain as Array<Record<string, unknown>>).forEach((step, i) => {
					if (typeof step?.task === "string")
						sections.push({
							label: `step ${i + 1}${step.agent ? ` (${step.agent})` : ""}`,
							text: step.task,
							markdown: true,
						});
				});
			}
			return sections;
		}
		default: {
			// Generic: every string arg longer than the summary can show, in full.
			const sections: ToolInputSection[] = [];
			for (const [key, value] of Object.entries(args)) {
				const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
				if (text && text.length > 80) sections.push({ label: key, text });
			}
			return sections;
		}
	}
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

const LEGIBLE_OPEN_TOOLS = new Set(["read", "edit", "write", "suggest_next", "bash"]);

function editDiffText(entry: ToolEntry): string | undefined {
	if (entry.toolName !== "edit") return undefined;
	const diff = (entry.details as { diff?: unknown } | undefined)?.diff;
	return typeof diff === "string" ? diff : undefined;
}

function ToolCard(props: { entry: ToolEntry }): JSX.Element {
	const status = () => toolStatus(props.entry);
	const args = () => props.entry.args as Record<string, unknown> | undefined;
	const suggestDetails = () => {
		if (props.entry.toolName !== "suggest_next") return undefined;
		return props.entry.details as { suggestion?: string; summary?: string } | undefined;
	};
	const diffText = () => editDiffText(props.entry);
	const bodyText = () => {
		if (props.entry.toolName === "write" && !props.entry.resultText && typeof args()?.content === "string") {
			return String(args()?.content);
		}
		return props.entry.resultText;
	};
	const bodyLanguage = () => {
		if (props.entry.toolName === "read") return getLanguageFromPath(toolPath(args()));
		if (props.entry.toolName === "write" && !props.entry.resultText) return getLanguageFromPath(toolPath(args()));
		return undefined;
	};
	const bodyIsMarkdown = () => MARKDOWN_RESULT_TOOLS.has(props.entry.toolName) && props.entry.status !== "error";
	const inputSections = () => toolInputSections(props.entry);
	return (
		<details class="tool" open={LEGIBLE_OPEN_TOOLS.has(props.entry.toolName) || props.entry.status === "running"}>
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
			<For each={inputSections()}>
				{(section) => (
					<div class="tool-input">
						<span class="tool-input-label">{section.label}</span>
						<Show
							when={section.markdown}
							fallback={<HighlightedPre text={section.text} language={section.language} />}
						>
							<div class="markdown-body" innerHTML={renderMarkdown(section.text)} />
						</Show>
					</div>
				)}
			</For>
			<Switch>
				<Match when={suggestDetails()}>
					{(details) => (
						<div class="tool-result">
							<Show when={details().summary}>
								<div class="markdown-body" innerHTML={renderMarkdown(details().summary!)} />
							</Show>
							<p class="suggested-command">
								→ <code>{details().suggestion}</code>
							</p>
						</div>
					)}
				</Match>
				<Match when={diffText()}>
					{(diff) => (
						<div class="tool-result">
							<DiffBody text={diff()} />
						</div>
					)}
				</Match>
				<Match when={bodyText()}>
					<div class="tool-result">
						<Switch fallback={<HighlightedPre text={bodyText()} language={bodyLanguage()} />}>
							<Match when={bodyIsMarkdown()}>
								<div class="markdown-body" innerHTML={renderMarkdown(bodyText())} />
							</Match>
						</Switch>
					</div>
				</Match>
			</Switch>
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
