/**
 * Transcript — renders reducer entries following the export-html renderer's
 * structure (renderEntry/renderToolCall): user boxes, assistant plain text
 * with collapsed thinking, tool cards with bespoke read/write/edit/bash
 * treatment, summary and custom cards.
 */

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";
import { createEffect, createMemo, createSignal, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import { createStickToBottom } from "../scrolling.js";
import { expandThinking, isToolAutoOpen } from "../state/preferences.js";
import type { AgentResultEntry, AssistantEntry, ToolEntry, TranscriptEntry } from "../state/reducer.js";

const STREAM_RENDER_THROTTLE_MS = 150;
export const TRANSCRIPT_WINDOW_SIZE = 150;
const LARGE_TOOL_OUTPUT_LIMIT = 200 * 1024;

function renderMarkdown(text: string): string {
	const html = marked.parse(text, { async: false }) as string;
	return DOMPurify.sanitize(html);
}

function throttledString(
	source: () => string,
	active: () => boolean,
	delayMs = STREAM_RENDER_THROTTLE_MS,
): () => string {
	const [value, setValue] = createSignal(source());
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending = source();

	const clearTimer = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	createEffect(() => {
		const next = source();
		const shouldThrottle = active();
		pending = next;
		if (!shouldThrottle) {
			clearTimer();
			setValue(next);
			return;
		}
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			setValue(pending);
		}, delayMs);
	});

	onCleanup(clearTimer);
	return value;
}

function formatOutputSize(bytes: number): string {
	const kib = bytes / 1024;
	if (kib < 1024) return `${Math.round(kib)} KB`;
	return `${(kib / 1024).toFixed(1)} MB`;
}

function MarkdownBody(props: {
	text: string;
	class?: string;
	classList?: Record<string, boolean | undefined>;
	throttle?: boolean;
}): JSX.Element {
	const text = throttledString(
		() => props.text,
		() => props.throttle === true,
	);
	const html = createMemo(() => renderMarkdown(text()));
	return <div class={props.class ?? "markdown-body"} classList={props.classList} innerHTML={html()} />;
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

function HighlightedPre(props: {
	text: string;
	language?: string;
	autoScroll?: boolean;
	throttle?: boolean;
}): JSX.Element {
	let preRef: HTMLPreElement | undefined;
	const text = throttledString(
		() => props.text,
		() => props.throttle === true,
	);
	const html = createMemo(() => highlightedHtml(text(), props.language));
	const stickToBottom = createStickToBottom({ scroller: () => preRef, threshold: 24 });

	createEffect(() => {
		text();
		props.language;
		if (props.autoScroll) stickToBottom.notifyContentChanged();
	});
	onCleanup(() => stickToBottom.dispose());

	return (
		<pre
			ref={preRef}
			onTouchStart={() => {
				if (props.autoScroll) stickToBottom.handleTouchStart();
			}}
			onTouchEnd={() => {
				if (props.autoScroll) stickToBottom.handleTouchEnd();
			}}
			onScroll={() => {
				if (props.autoScroll) stickToBottom.handleScroll();
			}}
		>
			<Show when={html()} fallback={text()}>
				{(safeHtml) => <code class="hljs" innerHTML={safeHtml()} />}
			</Show>
		</pre>
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

function editDiffText(entry: ToolEntry): string | undefined {
	if (entry.toolName !== "edit") return undefined;
	const diff = (entry.details as { diff?: unknown } | undefined)?.diff;
	return typeof diff === "string" ? diff : undefined;
}

function ToolResultBody(props: {
	text: string;
	language?: string;
	markdown: boolean;
	autoScroll?: boolean;
	throttle?: boolean;
}): JSX.Element {
	const [showFull, setShowFull] = createSignal(false);
	const isOversized = () => props.text.length > LARGE_TOOL_OUTPUT_LIMIT;
	createEffect(() => {
		if (!isOversized()) setShowFull(false);
	});
	const visibleText = () => (isOversized() && !showFull() ? props.text.slice(-LARGE_TOOL_OUTPUT_LIMIT) : props.text);
	return (
		<>
			<Show when={isOversized() && !showFull()}>
				<div class="tool-output-truncated">
					output truncated — showing last {formatOutputSize(LARGE_TOOL_OUTPUT_LIMIT)} of{" "}
					{formatOutputSize(props.text.length)}.{" "}
					<button type="button" class="entry-action" onClick={() => setShowFull(true)}>
						show full ({formatOutputSize(props.text.length)})
					</button>
				</div>
			</Show>
			<Show
				when={props.markdown}
				fallback={
					<HighlightedPre
						text={visibleText()}
						language={props.language}
						autoScroll={props.autoScroll}
						throttle={props.throttle}
					/>
				}
			>
				<MarkdownBody text={visibleText()} throttle={props.throttle} />
			</Show>
		</>
	);
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
	const isBash = () => props.entry.toolName === "bash" || props.entry.toolName === "bash (user)";
	const inputSections = () => toolInputSections(props.entry);
	const autoOpen = () => isToolAutoOpen(props.entry.toolName);
	const [open, setOpen] = createSignal(autoOpen() || props.entry.status === "running");
	let wasRunning = props.entry.status === "running";
	let userToggled = false;
	let suppressToggle = false;
	let suppressTimer: ReturnType<typeof setTimeout> | undefined;
	const setProgrammaticOpen = (next: boolean) => {
		if (open() === next) return;
		suppressToggle = true;
		setOpen(next);
		if (suppressTimer) clearTimeout(suppressTimer);
		suppressTimer = setTimeout(() => {
			suppressToggle = false;
			suppressTimer = undefined;
		}, 0);
	};
	createEffect(() => {
		const running = props.entry.status === "running";
		const shouldAutoOpen = autoOpen();
		if (running) {
			userToggled = false;
			setProgrammaticOpen(true);
		} else if (wasRunning) {
			userToggled = false;
			setProgrammaticOpen(shouldAutoOpen);
		} else if (!userToggled) {
			setProgrammaticOpen(shouldAutoOpen);
		}
		wasRunning = running;
	});
	onCleanup(() => {
		if (suppressTimer) clearTimeout(suppressTimer);
	});
	return (
		<details
			class="tool"
			open={open()}
			onToggle={(event) => {
				const next = event.currentTarget.open;
				if (suppressToggle) {
					setOpen(next);
					return;
				}
				if (props.entry.status === "running" && !next) {
					suppressToggle = true;
					event.currentTarget.open = true;
					setOpen(true);
					if (suppressTimer) clearTimeout(suppressTimer);
					suppressTimer = setTimeout(() => {
						suppressToggle = false;
						suppressTimer = undefined;
					}, 0);
					return;
				}
				userToggled = true;
				setOpen(next);
			}}
		>
			<summary>
				<span class="tool-name">{props.entry.toolName}</span>
				<span class="tool-arg">{toolArgSummary(props.entry)}</span>
				<span class={`tool-status ${status().cls}`}>{status().text}</span>
			</summary>
			<Show when={open()}>
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
								<MarkdownBody text={section.text} />
							</Show>
						</div>
					)}
				</For>
				<Switch>
					<Match when={suggestDetails()}>
						{(details) => (
							<div class="tool-result">
								<Show when={details().summary}>
									<MarkdownBody text={details().summary!} />
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
						{(text) => (
							<div class="tool-result">
								<ToolResultBody
									text={text()}
									language={bodyLanguage()}
									markdown={bodyIsMarkdown()}
									autoScroll={isBash()}
									throttle={props.entry.status === "running"}
								/>
							</div>
						)}
					</Match>
				</Switch>
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
								<MarkdownBody
									text={block.text}
									classList={{
										"streaming-cursor": props.entry.streaming && index() === props.entry.blocks.length - 1,
									}}
									throttle={props.entry.streaming}
								/>
							</div>
						}
					>
						<details class="thinking" open={expandThinking()}>
							<summary>thinking</summary>
							<MarkdownBody
								text={block.text}
								class="thinking-body markdown-body"
								throttle={props.entry.streaming}
							/>
						</details>
					</Show>
				)}
			</For>
		</div>
	);
}

export type TranscriptRenderItem =
	| { kind: "assistant-turn"; entries: Array<AssistantEntry | ToolEntry> }
	| { kind: "entry"; entry: TranscriptEntry };

function canReuseEntryItem(
	item: TranscriptRenderItem | undefined,
	entry: TranscriptEntry,
): item is TranscriptRenderItem {
	return item?.kind === "entry" && item.entry === entry;
}

function canReuseAssistantTurn(
	item: TranscriptRenderItem | undefined,
	entries: Array<AssistantEntry | ToolEntry>,
): item is TranscriptRenderItem {
	return (
		item?.kind === "assistant-turn" &&
		item.entries.length === entries.length &&
		item.entries.every((entry, index) => entry === entries[index])
	);
}

export function transcriptRenderItems(
	entries: TranscriptEntry[],
	previous: TranscriptRenderItem[] = [],
): TranscriptRenderItem[] {
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
			const previousItem = previous[items.length];
			items.push(
				canReuseAssistantTurn(previousItem, turnEntries)
					? previousItem
					: { kind: "assistant-turn", entries: turnEntries },
			);
			continue;
		}
		if (entry) {
			const previousItem = previous[items.length];
			items.push(canReuseEntryItem(previousItem, entry) ? previousItem : { kind: "entry", entry });
		}
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
				<MarkdownBody text={props.entry.text} class="entry-body markdown-body" />
			</details>
		</div>
	);
}

export function Transcript(props: {
	entries: TranscriptEntry[];
	who?: string;
	userLabel?: string;
	resetKey?: unknown;
}): JSX.Element {
	const who = () => props.who ?? "dreb";
	const userLabel = () => props.userLabel ?? "you";
	const renderItems = createMemo<TranscriptRenderItem[]>((previous) => transcriptRenderItems(props.entries, previous));
	const [visibleCount, setVisibleCount] = createSignal(TRANSCRIPT_WINDOW_SIZE);
	let lastResetKey: unknown;
	createEffect(() => {
		const resetKey = props.resetKey ?? props.entries;
		if (resetKey === lastResetKey) return;
		lastResetKey = resetKey;
		setVisibleCount(TRANSCRIPT_WINDOW_SIZE);
	});
	const visibleItems = createMemo(() => {
		const items = renderItems();
		const count = visibleCount();
		return items.length > count ? items.slice(-count) : items;
	});
	const hiddenCount = () => Math.max(0, renderItems().length - visibleItems().length);
	return (
		<>
			<Show when={hiddenCount() > 0}>
				<div class="transcript-window-control">
					<button
						type="button"
						class="btn btn-small"
						onClick={() =>
							setVisibleCount(Math.min(renderItems().length, visibleCount() + TRANSCRIPT_WINDOW_SIZE))
						}
					>
						show earlier {Math.min(TRANSCRIPT_WINDOW_SIZE, hiddenCount())} ({hiddenCount()} hidden)
					</button>
				</div>
			</Show>
			<For each={visibleItems()}>
				{(item) => (
					<Switch>
						<Match when={item.kind === "assistant-turn"}>
							<div class="assistant-turn" data-testid="assistant-turn">
								<For
									each={
										(item as { kind: "assistant-turn"; entries: Array<AssistantEntry | ToolEntry> }).entries
									}
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
		</>
	);
}
