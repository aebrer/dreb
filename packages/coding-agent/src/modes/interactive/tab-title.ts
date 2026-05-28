/**
 * Auto-generates a terminal tab title from session context after a threshold
 * number of tool calls. Uses a lightweight single-shot LLM call to produce a
 * concise ≤30 character title, then sets it via the terminal's OSC 0 escape.
 *
 * Fires at most once per session. Failures are swallowed silently.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Context, Model } from "@dreb/ai";
import { completeSimple } from "@dreb/ai";
import { getPackageDir } from "../../config.js";
import type { ModelRegistry } from "../../core/model-registry.js";
import type { TabTitleSettings } from "../../core/settings-manager.js";
import { parseAgentFrontmatter, resolveModelForSubagentSpawn } from "../../core/tools/subagent.js";

const DEFAULT_TRIGGER_AFTER = 3;
const MAX_TITLE_LENGTH = 30;
const TITLE_GENERATION_TIMEOUT_MS = 60_000;

const TITLE_PROMPT =
	"Summarize this session's task in ≤30 characters for a terminal tab title. " +
	"Output ONLY the title text, nothing else. No quotes, no explanation.";

export interface TabTitleDeps {
	/** Set the terminal tab title (OSC 0). */
	setTitle: (title: string) => void;
	/** Get the current session messages (for context). */
	getMessages: () => Array<{ role: string; content?: unknown }>;
	/** Get the current model (parent session model — used as fallback). */
	getModel: () => Model<Api> | undefined;
	/** Get model registry for API key resolution. */
	getModelRegistry: () => ModelRegistry;
	/** Get the parent provider name. */
	getProvider: () => string | undefined;
}

export class TabTitleGenerator {
	private toolCallCount = 0;
	private fired = false;
	private readonly threshold: number;

	constructor(
		private readonly settings: TabTitleSettings | undefined,
		private readonly deps: TabTitleDeps,
	) {
		this.threshold = settings?.triggerAfter ?? DEFAULT_TRIGGER_AFTER;
	}

	/** Whether this generator is enabled. */
	get enabled(): boolean {
		return this.settings?.enabled !== false;
	}

	/**
	 * Called on each tool_execution_end event. Increments the counter and fires
	 * the title generation when threshold is reached.
	 */
	onToolEnd(): void {
		if (this.fired || !this.enabled) return;

		this.toolCallCount++;
		if (this.toolCallCount >= this.threshold) {
			this.fired = true;
			// Fire-and-forget — never surfaces errors to the user
			this.generateTitle().catch(() => {});
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
		const model = await this.resolveModel();
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
			signal: AbortSignal.timeout(TITLE_GENERATION_TIMEOUT_MS),
		});

		const title = this.sanitizeTitle(response);
		if (title) {
			this.deps.setTitle(`dreb - ${title}`);
		}
	}

	private async resolveModel(): Promise<Model<Api> | undefined> {
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
		try {
			const agentFile = join(getPackageDir(), "agents", "explore.md");
			const content = readFileSync(agentFile, "utf-8");
			const parsed = parseAgentFrontmatter(content);
			if (parsed.ok && parsed.config.model) {
				return parsed.config.model;
			}
		} catch {
			// Fall through to parent model
		}
		return undefined;
	}

	private buildContext(): string | undefined {
		const messages = this.deps.getMessages();
		if (messages.length === 0) return undefined;

		// Extract the first user message for context
		const firstUser = messages.find((m) => m.role === "user");
		if (!firstUser) return undefined;

		const content =
			typeof firstUser.content === "string"
				? firstUser.content
				: Array.isArray(firstUser.content)
					? firstUser.content
							.filter((c: any) => c.type === "text")
							.map((c: any) => c.text)
							.join("\n")
					: "";

		if (!content) return undefined;

		// Truncate long messages — the LLM only needs a summary
		const truncated = content.length > 500 ? `${content.slice(0, 500)}...` : content;
		return `Session task:\n${truncated}`;
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
