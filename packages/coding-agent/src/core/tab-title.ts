/**
 * Auto-generates a terminal tab title from session context after a threshold
 * number of tool calls. Uses a lightweight single-shot LLM call to produce a
 * concise title — the model aims for a configurable soft target (default 60
 * characters, via TabTitleSettings.maxTitleLength) and the result is hard-capped
 * at 300 characters — then sets it via the terminal's OSC 0 escape.
 *
 * Fires at most once per session. Final failures are reported through the
 * optional onError hook while preserving fire-and-forget behavior.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model } from "@dreb/ai";
import { completeSimple } from "@dreb/ai";
import { CONFIG_DIR_NAME, getPackageDir } from "../config.js";
import { extractUserText, labelMessageEnd, labelToolEnd, RollingContextBuffer } from "./context-buffer.js";
import type { ModelRegistry } from "./model-registry.js";
import type { TabTitleSettings } from "./settings-manager.js";
import { parseAgentFrontmatter, resolveModelForSubagentSpawn } from "./tools/subagent.js";

const DEFAULT_TRIGGER_AFTER = 9;
// Soft target communicated to the model — titles should aim for this length but
// may run longer when clarity demands it. Configurable via TabTitleSettings.maxTitleLength.
const DEFAULT_TITLE_SOFT_TARGET = 60;
// Hidden hard cap — a safety limit that titles are truncated to regardless of the
// soft target. The dashboard has room for long names; the TUI truncates visually.
const TITLE_HARD_CAP = 300;
// Cap on how much of a single user message we feed into the title context.
const MAX_USER_TEXT_CHARS = 2000;
const TITLE_GENERATION_TIMEOUT_MS = 60_000;

function buildTitlePrompt(softTarget: number): string {
	return (
		"You are a headless terminal-tab title generator. You are NOT the assistant in the session — " +
		"you will never speak to the user. Your only job is to output a single short title string, nothing else. " +
		"No quotes, no explanation, no preamble. " +
		"The title disambiguates terminal windows for a human at a glance. " +
		"Base the title PRIMARILY on the user's actual request and the concrete actions taken in THIS session. " +
		"Describe what is being DONE (e.g. 'Fix auth bug', 'Plan subagent refactor', 'Review modal'), " +
		"not just label the invocation. " +
		"Branch, repo, and cwd metadata are SECONDARY — use them only to disambiguate when the user's " +
		"request is otherwise ambiguous. Never let a branch name override the user's actual intent: " +
		"if the branch is 'feature/dashboard-foundation' but the user asked to install a Playwright skill, " +
		"the title is about the Playwright skill, not the dashboard. " +
		"Avoid reference-only formats like '#N' or 'mach6-X #N'. " +
		"Do not include 'dreb' — the caller already adds it. " +
		`Output ONLY the title text. Aim for about ${softTarget} characters; a little longer is fine if needed for clarity.`
	);
}

export interface TabTitleDeps {
	/** Set the terminal tab title (OSC 0). */
	setTitle: (title: string) => void;
	/** Persist the generated title as the session name. Called with the raw title (without "dreb - " prefix). */
	setSessionName?: (name: string) => void;
	/**
	 * Get the current session name, if the session is already named. When this returns a
	 * non-empty string, title generation is skipped — auto-titling only names unnamed
	 * sessions and must never overwrite an existing (e.g. resumed) session's name.
	 */
	getSessionName?: () => string | undefined;
	/** Get the current session messages (for context). */
	getMessages: () => Array<{ role: string; content?: unknown }>;
	/** Get the current model (parent session model — used as fallback). */
	getModel: () => Model<Api> | undefined;
	/** Get model registry for API key resolution. */
	getModelRegistry: () => ModelRegistry;
	/** Get the parent provider name. */
	getProvider: () => string | undefined;
	/**
	 * Get the user's agentModels settings override for a given agent name, if any.
	 * Returns a non-empty fallback list when the user has configured an override.
	 */
	getAgentModelsOverride?: (agentName: string) => string[] | undefined;
	/** Current git branch name, or null/undefined if unavailable. */
	getBranch?: () => string | null | undefined;
	/** Repository name (e.g., dirname of cwd), or undefined. */
	getRepo?: () => string | undefined;
	/** Current working directory, or undefined. */
	getCwd?: () => string | undefined;
	/** Report final title-generation failures without breaking fire-and-forget callers. */
	onError?: (err: unknown) => void;
}

export class TabTitleGenerator {
	private toolCallCount = 0;
	private fired = false;
	private readonly threshold: number;
	private readonly softTarget: number;
	private readonly contextBuffer: RollingContextBuffer;

	constructor(
		private readonly settings: TabTitleSettings | undefined,
		private readonly deps: TabTitleDeps,
	) {
		this.threshold = settings?.triggerAfter ?? DEFAULT_TRIGGER_AFTER;
		// Soft target is configurable but always clamped to the hidden hard cap.
		const configured = settings?.maxTitleLength ?? DEFAULT_TITLE_SOFT_TARGET;
		this.softTarget = Math.max(1, Math.min(configured, TITLE_HARD_CAP));
		this.contextBuffer = new RollingContextBuffer({ maxEntries: 30, maxChars: 6000 });
	}

	/** Whether this generator is enabled. */
	get enabled(): boolean {
		return this.settings?.enabled !== false;
	}

	/**
	 * Called on each tool_execution_end event. Captures context from the event,
	 * increments the counter, and fires title generation when threshold is reached.
	 */
	onToolEnd(event?: { toolName?: string; isError?: boolean; result?: unknown }): void {
		if (event?.toolName) {
			this.contextBuffer.append(labelToolEnd(event as { toolName: string; isError?: boolean; result?: unknown }));
		}

		if (this.fired || !this.enabled) return;

		this.toolCallCount++;
		if (this.toolCallCount >= this.threshold) {
			this.fired = true;
			// Fire-and-forget — report final failures without throwing into the event stream.
			this.generateTitle().catch((err) => this.reportError(err));
		}
	}

	/** Called on message_end events — captures labeled context. */
	onMessageEnd(message: { role: string; content?: unknown }): void {
		if (this.fired) return; // no need to accumulate after fired
		for (const entry of labelMessageEnd(message)) {
			this.contextBuffer.append(entry);
		}
	}

	/** Exposed for testing — the current tool call count. */
	get currentCount(): number {
		return this.toolCallCount;
	}

	/** Exposed for testing — whether the title has been generated. */
	get hasFired(): boolean {
		return this.fired;
	}

	private async generateTitle(): Promise<void> {
		// Skip entirely if the session already has a name (e.g. resumed session).
		// This guards the race where a name is set between generator construction and firing.
		if (this.deps.getSessionName?.()) return;

		// Single timeout bounds the entire pipeline (model probing + API key + LLM call)
		const signal = AbortSignal.timeout(TITLE_GENERATION_TIMEOUT_MS);

		const model = await this.resolveModel(signal);
		if (!model) return;

		const userContext = this.buildContext();
		if (!userContext) return;

		const context: Context = {
			systemPrompt: buildTitlePrompt(this.softTarget),
			messages: [{ role: "user", content: userContext, timestamp: Date.now() }],
		};

		const response = await this.completeWithParentFallback(model, context, signal);
		const title = this.sanitizeTitle(response);
		if (title) {
			// Re-check: a name may have landed during the async LLM call.
			if (this.deps.getSessionName?.()) return;
			this.deps.setTitle(`dreb - ${title}`);
			this.deps.setSessionName?.(title);
		}
	}

	private async completeWithParentFallback(
		model: Model<Api>,
		context: Context,
		signal: AbortSignal,
	): Promise<unknown> {
		const primaryErrorPrefix = `Tab title generation failed with model ${this.formatModel(model)}`;
		try {
			return await this.completeWithModel(model, context, signal);
		} catch (primaryErr) {
			const parentModel = this.deps.getModel();
			if (!parentModel || this.isSameModel(model, parentModel)) {
				throw new Error(`${primaryErrorPrefix}: ${this.formatError(primaryErr)}`, { cause: primaryErr });
			}

			try {
				return await this.completeWithModel(parentModel, context, signal);
			} catch (parentErr) {
				throw new Error(
					`${primaryErrorPrefix}: ${this.formatError(primaryErr)}. ` +
						`Parent fallback ${this.formatModel(parentModel)} also failed: ${this.formatError(parentErr)}`,
					{ cause: parentErr },
				);
			}
		}
	}

	private async completeWithModel(model: Model<Api>, context: Context, signal: AbortSignal): Promise<unknown> {
		const registry = this.deps.getModelRegistry();
		const apiKey = await registry.getApiKey(model);
		return completeSimple(model, context, {
			apiKey,
			maxRetryDelayMs: 0,
			signal,
		});
	}

	private async resolveModel(signal?: AbortSignal): Promise<Model<Api> | undefined> {
		// Try to get the Explore agent's model fallback list
		const exploreModels = this.getExploreAgentModels();
		const parentModel = this.deps.getModel();
		const parentProvider = this.deps.getProvider();
		const registry = this.deps.getModelRegistry();

		if (exploreModels) {
			const resolution = await resolveModelForSubagentSpawn(
				exploreModels,
				parentProvider,
				registry,
				parentModel?.id,
				signal,
				"[tab-title]",
			);
			if (resolution.ok) {
				const found = resolution.provider
					? registry.find(resolution.provider, resolution.modelId)
					: registry.getAvailable().find((m) => m.id === resolution.modelId);
				if (found) return found;
			}
		}

		// Fall back to parent session model
		return parentModel;
	}

	private isSameModel(a: Model<Api>, b: Model<Api>): boolean {
		return a.id === b.id && a.provider === b.provider;
	}

	private formatModel(model: Model<Api>): string {
		return `${model.provider}/${model.id}`;
	}

	private formatError(err: unknown): string {
		if (err instanceof Error) return err.message;
		if (typeof err === "string") return err;
		return String(err);
	}

	private reportError(err: unknown): void {
		const reportedError =
			err instanceof Error
				? err
				: new Error(`Tab title generation failed: ${this.formatError(err)}`, { cause: err });
		this.deps.onError?.(reportedError);
	}

	private getExploreAgentModels(): string | string[] | undefined {
		// Honor the user's agentModels settings override first. The settings key must
		// match the agent name exactly ("Explore", as declared in explore.md frontmatter).
		const override = this.deps.getAgentModelsOverride?.("Explore");
		if (override && override.length > 0) {
			return override;
		}

		// Resolution order mirrors discoverAgentTypes: user override > project > package.
		// First match with a valid model wins.
		const candidates = [
			join(homedir(), CONFIG_DIR_NAME, "agents", "explore.md"),
			join(process.cwd(), ".dreb", "agents", "explore.md"),
			join(getPackageDir(), "agents", "explore.md"),
		];

		for (const agentFile of candidates) {
			try {
				const content = readFileSync(agentFile, "utf-8");
				const parsed = parseAgentFrontmatter(content);
				if (parsed.ok && parsed.config.model) {
					return parsed.config.model;
				}
			} catch {}
		}
		return undefined;
	}

	private buildContext(): string | undefined {
		const lines: string[] = [];

		// Primary signal: the user's actual request(s) from the current session.
		// Pin the FIRST user message (session-defining intent) and append the LATEST
		// user message when it differs, to catch mid-session pivots. Sourced from the
		// live message list rather than the rolling buffer so early intent is never
		// evicted by later tool activity.
		const userIntent = this.collectUserIntent();
		if (userIntent.length > 0) {
			lines.push("User request(s):");
			for (const req of userIntent) {
				lines.push(`- ${req}`);
			}
		}

		// Secondary signal: concrete current-session actions (assistant text + tools).
		const bufferContent = this.contextBuffer.build();
		if (bufferContent) {
			lines.push("");
			lines.push("Session activity:");
			lines.push(bufferContent);
		}

		// Tertiary signal: metadata, for disambiguation only.
		const branch = this.deps.getBranch?.();
		const repo = this.deps.getRepo?.();
		const cwd = this.deps.getCwd?.();
		const metadata: string[] = [];
		if (branch) metadata.push(`Branch: ${branch}`);
		if (repo) metadata.push(`Repo: ${repo}`);
		if (cwd) metadata.push(`Cwd: ${cwd}`);
		if (metadata.length > 0) {
			lines.push("");
			lines.push("Context metadata (secondary — disambiguation only):");
			lines.push(...metadata);
		}

		if (lines.length === 0) return undefined;
		return lines.join("\n");
	}

	/**
	 * Collect the user's intent-bearing requests from the current session's messages.
	 * Returns the first user message, plus the latest user message when it differs.
	 */
	private collectUserIntent(): string[] {
		const messages = this.deps.getMessages?.() ?? [];
		const userTexts: string[] = [];
		for (const message of messages) {
			const text = extractUserText(message);
			if (text) userTexts.push(text.slice(0, MAX_USER_TEXT_CHARS));
		}
		if (userTexts.length === 0) return [];

		const first = userTexts[0];
		const last = userTexts[userTexts.length - 1];
		return first === last ? [first] : [first, last];
	}

	/** Clean up LLM response to a usable tab title. */
	private sanitizeTitle(response: unknown): string | undefined {
		if (!response || typeof response !== "object") return undefined;

		const msg = response as { content?: Array<{ type: string; text?: string }> };
		if (!msg.content || !Array.isArray(msg.content)) return undefined;

		const textPart = msg.content.find((c) => c.type === "text");
		if (!textPart?.text) return undefined;

		let title = textPart.text.trim();
		// Strip surrounding quotes if present
		if ((title.startsWith('"') && title.endsWith('"')) || (title.startsWith("'") && title.endsWith("'"))) {
			title = title.slice(1, -1).trim();
		}
		// Remove newlines
		title = title.replace(/[\r\n]+/g, " ").trim();
		// Truncate to the hidden hard cap (safety limit; the soft target is a prompt hint)
		if (title.length > TITLE_HARD_CAP) {
			title = title.slice(0, TITLE_HARD_CAP);
		}
		return title || undefined;
	}
}
