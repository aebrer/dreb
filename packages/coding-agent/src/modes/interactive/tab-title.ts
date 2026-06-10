/**
 * Auto-generates a terminal tab title from session context after a threshold
 * number of tool calls. Uses a lightweight single-shot LLM call to produce a
 * concise ≤30 character title, then sets it via the terminal's OSC 0 escape.
 *
 * Fires at most once per session. Failures are swallowed silently.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model } from "@dreb/ai";
import { completeSimple } from "@dreb/ai";
import { CONFIG_DIR_NAME, getPackageDir } from "../../config.js";
import { labelMessageEnd, labelToolEnd, RollingContextBuffer } from "../../core/context-buffer.js";
import type { ModelRegistry } from "../../core/model-registry.js";
import type { TabTitleSettings } from "../../core/settings-manager.js";
import { parseAgentFrontmatter, resolveModelForSubagentSpawn } from "../../core/tools/subagent.js";

const DEFAULT_TRIGGER_AFTER = 9;
const MAX_TITLE_LENGTH = 30;
const TITLE_GENERATION_TIMEOUT_MS = 60_000;

const TITLE_PROMPT =
	"You are a headless terminal-tab title generator. You are NOT the assistant in the session — " +
	"you will never speak to the user. Your only job is to output a single short title string, nothing else. " +
	"No quotes, no explanation, no preamble. " +
	"The title disambiguates terminal windows for a human at a glance. " +
	"Describe what is being DONE (e.g. 'Fix auth bug', 'Plan subagent refactor', 'Review modal'), " +
	"not just label the invocation. " +
	"If a branch name is present, abbreviate it to its semantic slug " +
	"(e.g. feature/issue-217-copy-selector-modal → copy-selector) and combine with the action. " +
	"Avoid reference-only formats like '#N' or 'mach6-X #N'. " +
	"Do not include 'dreb' — the caller already adds it. " +
	"Output ONLY the title text, ≤30 characters.";

export interface TabTitleDeps {
	/** Set the terminal tab title (OSC 0). */
	setTitle: (title: string) => void;
	/** Persist the generated title as the session name. Called with the raw title (without "dreb - " prefix). */
	setSessionName?: (name: string) => void;
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
}

export class TabTitleGenerator {
	private toolCallCount = 0;
	private fired = false;
	private readonly threshold: number;
	private readonly contextBuffer: RollingContextBuffer;

	constructor(
		private readonly settings: TabTitleSettings | undefined,
		private readonly deps: TabTitleDeps,
	) {
		this.threshold = settings?.triggerAfter ?? DEFAULT_TRIGGER_AFTER;
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
			// Fire-and-forget — never surfaces errors to the user
			this.generateTitle().catch(() => {});
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
		// Single timeout bounds the entire pipeline (model probing + API key + LLM call)
		const signal = AbortSignal.timeout(TITLE_GENERATION_TIMEOUT_MS);

		const model = await this.resolveModel(signal);
		if (!model) return;

		const registry = this.deps.getModelRegistry();
		const apiKey = await registry.getApiKey(model);

		const userContext = this.buildContext();
		if (!userContext) return;

		const context: Context = {
			systemPrompt: TITLE_PROMPT,
			messages: [{ role: "user", content: userContext, timestamp: Date.now() }],
		};

		const response = await completeSimple(model, context, {
			apiKey,
			maxRetryDelayMs: 0,
			signal,
		});

		const title = this.sanitizeTitle(response);
		if (title) {
			this.deps.setTitle(`dreb - ${title}`);
			this.deps.setSessionName?.(title);
		}
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
				// Find the resolved model in registry
				const available = registry.getAvailable();
				const found = available.find((m) => m.id === resolution.modelId);
				if (found) return found;
			}
		}

		// Fall back to parent session model
		return parentModel;
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

		// Metadata block
		const branch = this.deps.getBranch?.();
		const repo = this.deps.getRepo?.();
		const cwd = this.deps.getCwd?.();
		if (branch) lines.push(`Branch: ${branch}`);
		if (repo) lines.push(`Repo: ${repo}`);
		if (cwd) lines.push(`Cwd: ${cwd}`);

		// Rolling buffer
		const bufferContent = this.contextBuffer.build();
		if (bufferContent) lines.push(bufferContent);

		if (lines.length === 0) return undefined;
		return lines.join("\n");
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
		// Truncate to max length
		if (title.length > MAX_TITLE_LENGTH) {
			title = title.slice(0, MAX_TITLE_LENGTH);
		}
		return title || undefined;
	}
}
