/**
 * BuddyController — Frontend-agnostic controller for the buddy companion.
 *
 * Owns: context buffer, idle timer, reaction throttle, name-call detection.
 * Extracted from InteractiveMode so both TUI and Telegram can compose it
 * without duplicating ~150 lines of buddy wiring logic.
 *
 * The host (TUI or Telegram) provides callbacks for frontend-specific rendering:
 * - onSpeech(text) — display a speech bubble / message
 * - onThinkingStart() / onThinkingEnd() — show/hide thinking indicator
 *
 * Policies are configurable via BuddyControllerConfig so the TUI (no limits)
 * and Telegram (activity gating + reaction budget) can use different strategies.
 */

import type { BuddyManager } from "./buddy-manager.js";
import type { BuddyState } from "./buddy-types.js";

/** Frontend-provided callbacks for buddy rendering */
export interface BuddyCallbacks {
	/** Display a speech/reaction message from the buddy */
	onSpeech: (text: string) => void;
	/** Show a thinking/loading indicator */
	onThinkingStart: () => void;
	/** Hide the thinking/loading indicator */
	onThinkingEnd: () => void;
	/** Hatch a new buddy — frontend resolves API key and calls manager.hatch() */
	onHatch: (manager: BuddyManager) => Promise<BuddyState>;
	/** Reroll the buddy — frontend resolves API key and calls manager.reroll() */
	onReroll: (manager: BuddyManager) => Promise<BuddyState>;
}

/** Configuration for buddy behavior — differs between TUI and Telegram */
export interface BuddyControllerConfig {
	/** Max entries in the context buffer (default: 20) */
	contextMaxEntries?: number;
	/** Idle timeout in ms before buddy reacts to silence (default: 30000) */
	idleTimeoutMs?: number;
	/** Minimum ms between reactions (default: 60000) */
	reactionCooldownMs?: number;
	/** If set, pause idle timer when user has been inactive this many ms */
	activityGateMs?: number;
	/** If set, cap reactions to this many per hour */
	reactionsPerHour?: number;
}

/** Subcommand result for frontend to render */
export type BuddyCommandResult =
	| { type: "hatch"; state: BuddyState }
	| { type: "show"; state: BuddyState }
	| { type: "reroll"; state: BuddyState }
	| { type: "pet" }
	| { type: "stats"; state: BuddyState }
	| { type: "off" }
	| { type: "warning"; message: string }
	| { type: "error"; message: string };

export class BuddyController {
	private contextBuffer: string[] = [];
	private lastReactionTime = 0;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private lastActivityTime = 0;
	private reactionTimestamps: number[] = []; // for budget tracking
	/** When false, all active functionality is disabled: no reactions, name-calls,
	 *  idle timer, or Ollama calls. Context capture (passive) still happens. */
	enabled = true;

	readonly manager: BuddyManager;
	private readonly callbacks: BuddyCallbacks;
	private readonly config: Required<BuddyControllerConfig>;

	constructor(manager: BuddyManager, callbacks: BuddyCallbacks, config?: BuddyControllerConfig) {
		this.manager = manager;
		this.callbacks = callbacks;
		this.config = {
			contextMaxEntries: config?.contextMaxEntries ?? 20,
			idleTimeoutMs: config?.idleTimeoutMs ?? 30_000,
			reactionCooldownMs: config?.reactionCooldownMs ?? 60_000,
			activityGateMs: config?.activityGateMs ?? 0, // 0 = no gating (TUI default)
			reactionsPerHour: config?.reactionsPerHour ?? 0, // 0 = unlimited (TUI default)
		};
	}

	// =========================================================================
	// Context buffer
	// =========================================================================

	/** Append an entry to the buddy context buffer (evicts oldest if at capacity) */
	appendContext(entry: string): void {
		this.contextBuffer.push(entry);
		if (this.contextBuffer.length > this.config.contextMaxEntries) {
			this.contextBuffer.shift();
		}
	}

	/** Build the context buffer into a string for LLM prompts */
	buildContext(): string {
		if (this.contextBuffer.length === 0) {
			return "No recent activity.";
		}
		return this.contextBuffer.join("\n");
	}

	// =========================================================================
	// Activity & idle timer
	// =========================================================================

	/** Mark that user activity occurred (for activity gating) */
	markActivity(): void {
		this.lastActivityTime = Date.now();
	}

	/** Reset the idle timer — called on every user message */
	resetIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
		}

		if (!this.enabled) return;

		if (!this.manager.getState()) return; // No buddy loaded, skip idle timer

		// Activity gating: skip idle timer if user has been inactive too long
		if (this.config.activityGateMs > 0 && this.lastActivityTime > 0) {
			const elapsed = Date.now() - this.lastActivityTime;
			if (elapsed > this.config.activityGateMs) {
				this.idleTimer = null;
				return;
			}
		}

		this.idleTimer = setTimeout(() => {
			const ctx = this.buildContext();
			this.triggerReaction(`It's been quiet for a moment. Recent activity:\n${ctx}`).catch(() => {});
		}, this.config.idleTimeoutMs);
	}

	// =========================================================================
	// Reactions
	// =========================================================================

	/** Check if a reaction is allowed under current throttle and budget */
	private canReact(): boolean {
		if (!this.enabled) return false;

		const now = Date.now();

		// Cooldown throttle
		if (now - this.lastReactionTime < this.config.reactionCooldownMs) {
			return false;
		}

		// Reaction budget (per hour)
		if (this.config.reactionsPerHour > 0) {
			const oneHourAgo = now - 3_600_000;
			this.reactionTimestamps = this.reactionTimestamps.filter((t) => t > oneHourAgo);
			if (this.reactionTimestamps.length >= this.config.reactionsPerHour) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Trigger a buddy reaction. Throttled by cooldown and budget.
	 * Calls onThinkingStart/End and onSpeech callbacks.
	 * No-op if disabled.
	 */
	async triggerReaction(event: string): Promise<void> {
		if (!this.canReact()) return;

		this.callbacks.onThinkingStart();
		try {
			const quip = await this.manager.react(event);
			this.callbacks.onThinkingEnd();
			if (quip) {
				this.lastReactionTime = Date.now();
				this.reactionTimestamps.push(Date.now());
				this.callbacks.onSpeech(quip);
			}
		} catch (err) {
			this.callbacks.onThinkingEnd();
			console.error("[buddy] triggerReaction failed:", err instanceof Error ? err.message : err);
		}
	}

	/**
	 * Handle a name-call from the user.
	 * No-op if disabled — returns immediately without calling Ollama.
	 */
	async handleNameCall(userMessage: string): Promise<void> {
		if (!this.enabled) return;
		let state = this.manager.getState();
		if (!state) {
			// Try loading from disk (buddy may have been hatched in another frontend)
			state = this.manager.load();
		}
		if (!state) return;

		this.callbacks.onThinkingStart();
		try {
			const response = await this.manager.respondToNameCall(userMessage, this.buildContext());
			this.callbacks.onThinkingEnd();
			if (response) {
				this.callbacks.onSpeech(response);
			}
		} catch (err) {
			this.callbacks.onThinkingEnd();
			console.error("[buddy] handleNameCall failed:", err instanceof Error ? err.message : err);
		}
	}

	/** Check if a message contains the buddy's name (word-boundary matching).
	 *  Returns false if disabled. */
	detectNameCall(text: string): boolean {
		if (!this.enabled) return false;
		const name = this.manager.getName();
		if (!name) return false;
		try {
			const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const regex = new RegExp(`\\b${escaped}\\b`, "i");
			return regex.test(text);
		} catch {
			return false;
		}
	}

	// =========================================================================
	// Event handling
	// =========================================================================

	/**
	 * Process an agent event for buddy context capture and reaction triggers.
	 * The host calls this from its event handler.
	 *
	 * Context capture always happens. Reactions are gated by `enabled`.
	 */
	handleEvent(event: { type: string; [key: string]: any }): void {
		const state = this.manager.getState();
		if (!state) return; // No buddy loaded

		switch (event.type) {
			case "message_end": {
				if (event.message?.role === "assistant") {
					const textParts = event.message.content
						?.filter((c: any) => c.type === "text")
						?.map((c: any) => c.text)
						?.join("")
						?.slice(0, 200);
					if (textParts) {
						this.appendContext(`Assistant: ${textParts}`);
					}
					const toolCalls = event.message.content?.filter((c: any) => c.type === "toolCall") ?? [];
					if (toolCalls.length > 0) {
						const tools = toolCalls.map((c: any) => c.name).join(", ");
						this.appendContext(`Called tools: ${tools}`);
					}
				}
				break;
			}

			case "tool_execution_end": {
				// Context capture (always)
				const status = event.isError ? "failed" : "completed";
				const output = event.result?.output || event.result?.content;
				const outputText =
					typeof output === "string"
						? output.slice(0, 100)
						: Array.isArray(output)
							? output
									.filter((c: any) => c.type === "text")
									.map((c: any) => c.text)
									.join("")
									.slice(0, 100)
							: "";
				this.appendContext(`Tool ${event.toolName} ${status}${outputText ? `: ${outputText}` : ""}`);

				// Reaction on error (gated by enabled)
				if (event.isError && this.enabled) {
					let errorText = "unknown error";
					const result = event.result;
					if (result?.content && Array.isArray(result.content)) {
						errorText = result.content
							.filter((c: any) => c.type === "text")
							.map((c: any) => c.text)
							.join("")
							.slice(0, 200);
					} else if (typeof result?.error === "string") {
						errorText = result.error.slice(0, 200);
					}
					if (!errorText) errorText = "unknown error";
					this.triggerReaction(`Tool "${event.toolName}" failed: ${errorText}`).catch(() => {});
				}
				break;
			}

			case "agent_end": {
				if (this.enabled) {
					const ctx = this.buildContext();
					this.triggerReaction(`The agent finished responding. Recent activity:\n${ctx}`).catch(() => {});
				}
				break;
			}
		}
	}

	/**
	 * Process a user message — captures context, resets idle, checks name-call.
	 * Context capture always happens. Active features gated by `enabled`.
	 * Returns true if a name-call was detected and is being handled.
	 */
	processUserMessage(text: string): boolean {
		this.appendContext(`User: ${text}`);
		this.markActivity();
		this.resetIdleTimer();

		// Name-call detection (gated by enabled via detectNameCall)
		if (this.detectNameCall(text)) {
			this.handleNameCall(text).catch(() => {});
			return true;
		}
		return false;
	}

	// =========================================================================
	// Command handling
	// =========================================================================

	/**
	 * Handle a /buddy command. Returns a result object for the frontend to render.
	 * Hatch/reroll are delegated to the frontend via onHatch/onReroll callbacks.
	 */
	async handleCommand(subcommand: string): Promise<BuddyCommandResult> {
		switch (subcommand) {
			case "pet": {
				if (!this.manager.getState()) {
					return { type: "warning", message: "No buddy to pet! Use /buddy to hatch one first." };
				}
				return { type: "pet" };
			}
			case "reroll": {
				if (!this.manager.hasStoredBuddy()) {
					return { type: "warning", message: "No buddy to reroll! Use /buddy to hatch one first." };
				}
				this.callbacks.onThinkingStart();
				try {
					const state = await this.callbacks.onReroll(this.manager);
					this.callbacks.onThinkingEnd();
					this.enabled = true;
					this.manager.setHidden(false);
					return { type: "reroll", state };
				} catch (err) {
					this.callbacks.onThinkingEnd();
					return { type: "error", message: `Reroll failed: ${err instanceof Error ? err.message : String(err)}` };
				}
			}
			case "stats": {
				const state = this.manager.getState();
				if (!state) {
					return { type: "warning", message: "No buddy to show stats for! Use /buddy to hatch one first." };
				}
				return { type: "stats", state };
			}
			case "off": {
				this.enabled = false;
				this.manager.setHidden(true);
				this.stop();
				return { type: "off" };
			}
			default: {
				// No subcommand: hatch or show
				if (this.manager.getState()) {
					// Already showing — just enable and return
					this.enabled = true;
					this.manager.setHidden(false);
					return { type: "show", state: this.manager.getState()! };
				}

				// Try to load existing buddy
				const existing = this.manager.load();
				if (existing) {
					this.enabled = true;
					this.manager.setHidden(false);
					return { type: "show", state: existing };
				}

				// Hatch new buddy
				this.callbacks.onThinkingStart();
				try {
					const hatchState = await this.callbacks.onHatch(this.manager);
					this.callbacks.onThinkingEnd();
					this.enabled = true;
					return { type: "hatch", state: hatchState };
				} catch (err) {
					this.callbacks.onThinkingEnd();
					return { type: "error", message: `Hatch failed: ${err instanceof Error ? err.message : String(err)}` };
				}
			}
		}
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	/** Start the controller — auto-load buddy if one exists */
	start(): BuddyState | null {
		const existing = this.manager.load();
		if (existing) {
			// If buddy was hidden (via /buddy off), keep it loaded but disabled
			this.enabled = !existing.hidden;
			return existing;
		}
		return null;
	}

	/** Stop the controller — clear timers */
	stop(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}

	/** Full reset — clear context buffer, idle timer, reaction budget.
	 *  Respects persisted hidden state so bridge reconnects don't undo /buddy off. */
	reset(): void {
		this.stop();
		this.contextBuffer = [];
		this.lastReactionTime = 0;
		this.reactionTimestamps = [];
		// Re-enable unless buddy was explicitly hidden via /buddy off
		const state = this.manager.getState() ?? this.manager.load();
		this.enabled = state ? !state.hidden : true;
	}
}
