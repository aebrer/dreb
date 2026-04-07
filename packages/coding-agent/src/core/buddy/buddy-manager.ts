/**
 * BuddyManager — Core state machine for the buddy companion.
 *
 * Handles: bone rolling, soul generation, persistence, Ollama availability checks.
 * Bones are deterministic from hash(username + hostname + salt + rerollCount).
 * Soul is LLM-generated once on first hatch and persisted to buddy.json.
 */

import type { Context, Model } from "@dreb/ai";
import { completeSimple } from "@dreb/ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { hostname } from "os";
import { join } from "path";
import { getAgentDir } from "../../config.js";
import { createBuddyRng } from "./buddy-prng.js";
import { rollEyes, rollHat, rollSpecies, rollStats } from "./buddy-species.js";
import type { BuddyState, CompanionBones, StoredCompanion } from "./buddy-types.js";
import { STAT_NAMES } from "./buddy-types.js";

const BUDDY_SALT = "dreb-buddy-v1";
const BUDDY_FILENAME = "buddy.json";
const DEFAULT_BACKSTORY = "A mysterious past shrouded in legend.";

/** Base Ollama model config — id/name are set dynamically from available models */
const OLLAMA_MODEL_BASE: Omit<Model<"openai-completions">, "id" | "name"> = {
	api: "openai-completions",
	provider: "ollama",
	baseUrl: "http://localhost:11434/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 2048,
	compat: {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
	},
};

/** Max words for buddy response before truncation */
const MAX_RESPONSE_WORDS = 300;

/** Prompt for soul generation (uses parent LLM, not Ollama) */
const SOUL_GENERATION_PROMPT = `You are generating a companion character for a coding assistant terminal app. Based on the species, rarity, and stats below, generate a creative name, a one-sentence personality description, and a funny fictional backstory.

Species: {species}
Rarity: {rarity}
Stats: {stats}
Shiny: {shiny}

The name must NOT be a common English word, programming keyword, tool name, or command. It should be unique and distinctive — a proper noun that won't appear in normal conversation. The name must be 4-8 characters and easy to type on a QWERTY keyboard — use only common letters (a-z, avoid q, x, z, j). Do not use species name as the name.

Respond in EXACTLY this format:
NAME: <name>
PERSONALITY: <one sentence personality>
BACKSTORY: <2-3 sentence elaborate fictional backstory — funny, absurd, or dramatic. Include specific events, places, former occupations>`;

/** Prompt for buddy reactions via Ollama */
const REACTION_PROMPT = `You are {name}, a {species} companion in a terminal coding app. You are {personality}. Your backstory: {backstory}

Something just happened. React with a short, in-character quip based on the context below. Be specific — reference what actually happened, not just that something happened. Max 20 words. No quotes, no prefixes, just the quip.

Context:
{event}`;

const NAME_CALL_PROMPT = `You are {name}, a {species} companion in a terminal coding app. You are {personality}. Your backstory: {backstory}

The user just said: "{message}"
Recent context: {context}

Respond to what the user said directly. Be in-character, reference your backstory occasionally. Max 30 words. No quotes, no prefixes, just your response.`;

// =============================================================================
// Ollama availability
// =============================================================================

export interface OllamaStatus {
	available: boolean;
	models: string[];
	error?: string;
}

/**
 * Check if Ollama is running and has models available.
 * Uses the /api/tags endpoint.
 */
export async function checkOllama(): Promise<OllamaStatus> {
	try {
		const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(3000) });
		if (!res.ok) {
			return { available: false, models: [], error: `Ollama returned ${res.status}` };
		}
		const data = (await res.json()) as { models?: { name: string }[] };
		const models = (data.models ?? []).map((m) => m.name);
		if (models.length === 0) {
			return { available: false, models: [], error: "No models installed. Run: ollama pull llama3.2" };
		}
		return { available: true, models };
	} catch {
		return { available: false, models: [], error: "Ollama is not running. Start it with: ollama serve" };
	}
}

/**
 * Pick the Ollama model for the buddy.
 * Returns the stored model name if it's available, otherwise null.
 */
function pickOllamaModel(storedModel: string | undefined, availableModels: string[]): string | null {
	if (!storedModel) return null;
	// Check if the stored model is installed (exact match or prefix match without tag)
	const match = availableModels.find((m) => m === storedModel || m.startsWith(`${storedModel}:`));
	return match ?? null;
}

/**
 * Truncate response to a maximum word count, appending "...[truncated]" if exceeded.
 */
export function truncateResponse(text: string, maxWords: number): string {
	const words = text.split(/\s+/);
	if (words.length <= maxWords) return text;
	return `${words.slice(0, maxWords).join(" ")} ...[truncated]`;
}

// =============================================================================
// Persistence
// =============================================================================

function getBuddyPath(): string {
	return join(getAgentDir(), BUDDY_FILENAME);
}

function loadStored(): StoredCompanion | null {
	const path = getBuddyPath();
	if (!existsSync(path)) return null;
	try {
		const data = JSON.parse(readFileSync(path, "utf-8"));
		// Validate required fields
		if (
			typeof data.rerollCount === "number" &&
			typeof data.name === "string" &&
			typeof data.personality === "string"
		) {
			return {
				rerollCount: data.rerollCount,
				name: data.name,
				personality: data.personality,
				backstory: typeof data.backstory === "string" ? data.backstory : DEFAULT_BACKSTORY,
				hatchedAt: data.hatchedAt ?? new Date().toISOString(),
				...(data.hidden !== undefined ? { hidden: data.hidden } : {}),
				...(typeof data.ollamaModel === "string" ? { ollamaModel: data.ollamaModel } : {}),
			};
		}
		return null;
	} catch {
		return null;
	}
}

function saveStored(stored: StoredCompanion): void {
	const path = getBuddyPath();
	const dir = join(path, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, JSON.stringify(stored, null, 2));
}

// =============================================================================
// Bone rolling
// =============================================================================

function rollBones(rerollCount: number): CompanionBones {
	const username = process.env.USER ?? process.env.LOGNAME ?? "user";
	const host = hostname();
	const rng = createBuddyRng(username, host, BUDDY_SALT, rerollCount);

	// Roll species + rarity
	const { species, rarity } = rollSpecies(rng);

	// Roll shiny (1% chance)
	const shiny = rng() < 0.01;

	// Roll eyes and hat
	const eyes = rollEyes(rng);
	const hat = rollHat(rng);

	// Roll stats
	const stats = rollStats(rng, rarity);

	return { species, rarity, shiny, stats, eyeStyle: eyes, hat };
}

// =============================================================================
// Soul generation
// =============================================================================

/**
 * Generate a soul (name + personality + backstory) using the parent LLM.
 * Only called on first hatch or reroll.
 */
async function generateSoul(
	bones: CompanionBones,
	parentModel: Model<"openai-completions">,
	apiKey: string,
): Promise<{ name: string; personality: string; backstory: string }> {
	const statsStr = STAT_NAMES.map((s) => `${s}: ${bones.stats[s]}`).join(", ");
	const prompt = SOUL_GENERATION_PROMPT.replace("{species}", bones.species)
		.replace("{rarity}", bones.rarity)
		.replace("{stats}", statsStr)
		.replace("{shiny}", bones.shiny ? "YES ✨" : "no");

	const context: Context = {
		systemPrompt: "Generate a companion character. Respond in the exact format requested.",
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	};

	try {
		const response = await completeSimple(parentModel, context, { apiKey });
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");

		// Parse NAME: ... and PERSONALITY: ... and BACKSTORY: ...
		const nameMatch = text.match(/NAME:\s*(.+)/i);
		const personalityMatch = text.match(/PERSONALITY:\s*(.+)/i);
		const backstoryMatch = text.match(/BACKSTORY:\s*([\s\S]+)/i);

		let name = nameMatch?.[1]?.trim() ?? bones.species;
		const personality = personalityMatch?.[1]?.trim() ?? `A ${bones.rarity} ${bones.species} companion.`;
		const backstory = backstoryMatch?.[1]?.trim() ?? DEFAULT_BACKSTORY;

		// Enforce name length
		if (name.length > 8) name = name.slice(0, 8);

		return { name, personality, backstory };
	} catch {
		// Fallback if LLM fails
		return {
			name: bones.species,
			personality: `A ${bones.rarity} ${bones.species} companion.`,
			backstory: DEFAULT_BACKSTORY,
		};
	}
}

// =============================================================================
// BuddyManager
// =============================================================================

export class BuddyManager {
	private state: BuddyState | null = null;
	private ollamaStatus: OllamaStatus | null = null;

	/** Get current buddy state (null if not loaded) */
	getState(): BuddyState | null {
		return this.state;
	}

	/** Check if buddy exists on disk */
	hasStoredBuddy(): boolean {
		return loadStored() !== null;
	}

	/**
	 * Load or create buddy state.
	 * If stored buddy exists, loads soul and re-rolls bones.
	 * If no stored buddy, returns null (need to hatch first).
	 */
	load(): BuddyState | null {
		const stored = loadStored();
		if (!stored) return null;

		const bones = rollBones(stored.rerollCount);
		this.state = { ...bones, ...stored };
		return this.state;
	}

	/**
	 * Hatch a new buddy. Generates bones, then uses parent LLM for soul.
	 * Returns the new state.
	 */
	async hatch(parentModel: Model<"openai-completions">, apiKey: string): Promise<BuddyState> {
		const stored = loadStored();
		const rerollCount = stored?.rerollCount ?? 0;

		const bones = rollBones(rerollCount);
		const { name, personality, backstory } = await generateSoul(bones, parentModel, apiKey);

		const newStored: StoredCompanion = {
			rerollCount,
			name,
			personality,
			backstory,
			hatchedAt: new Date().toISOString(),
			...(stored?.ollamaModel ? { ollamaModel: stored.ollamaModel } : {}),
		};

		saveStored(newStored);
		this.state = { ...bones, ...newStored };
		return this.state;
	}

	/**
	 * Reroll the buddy — new bones + new soul.
	 */
	async reroll(parentModel: Model<"openai-completions">, apiKey: string): Promise<BuddyState> {
		const stored = loadStored();
		const newRerollCount = (stored?.rerollCount ?? 0) + 1;

		const bones = rollBones(newRerollCount);
		const { name, personality, backstory } = await generateSoul(bones, parentModel, apiKey);

		const newStored: StoredCompanion = {
			rerollCount: newRerollCount,
			name,
			personality,
			backstory,
			hatchedAt: new Date().toISOString(),
			...(stored?.ollamaModel ? { ollamaModel: stored.ollamaModel } : {}),
		};

		saveStored(newStored);
		this.state = { ...bones, ...newStored };
		return this.state;
	}

	/** Get buddy's name (for name-call detection) */
	getName(): string | null {
		return this.state?.name ?? loadStored()?.name ?? null;
	}

	/**
	 * Shared Ollama chat helper. Checks availability, picks model, runs completion.
	 * Returns the response text, or null if Ollama is unavailable or no model configured.
	 */
	private async ollamaChat(context: Context): Promise<string | null> {
		// Check Ollama lazily, retry if previously unavailable
		if (!this.ollamaStatus || !this.ollamaStatus.available) {
			this.ollamaStatus = await checkOllama();
		}
		if (!this.ollamaStatus.available) return null;

		const modelName = pickOllamaModel(this.state?.ollamaModel, this.ollamaStatus.models);
		if (!modelName) return null;
		const model: Model<"openai-completions"> = {
			...OLLAMA_MODEL_BASE,
			id: modelName,
			name: `${modelName} (Ollama)`,
		};

		let response: import("@dreb/ai").AssistantMessage;
		try {
			response = await completeSimple(model, context, {
				apiKey: "ollama",
				signal: AbortSignal.timeout(120000),
			});
		} catch {
			// Safety net for unexpected sync errors (e.g. provider not found).
			// Normal runtime errors (timeout, connection) are handled via stopReason below.
			this.ollamaStatus = null;
			return null;
		}

		// Connection error — invalidate cache so next attempt re-checks Ollama
		if (response.stopReason === "error") {
			this.ollamaStatus = null;
			return null;
		}

		// Timeout or abort — preserve cache (model is just slow, Ollama is fine)
		if (response.stopReason === "aborted") {
			return null;
		}

		let text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();

		// Truncate overly long responses
		text = truncateResponse(text, MAX_RESPONSE_WORDS);

		return text || null;
	}

	/**
	 * Generate a reaction to an event using Ollama.
	 * Returns null if Ollama is unavailable.
	 */
	async react(event: string): Promise<string | null> {
		if (!this.state) return null;

		const prompt = REACTION_PROMPT.replace("{name}", this.state.name)
			.replace("{species}", this.state.species)
			.replace("{personality}", this.state.personality)
			.replace("{backstory}", this.state.backstory)
			.replace("{event}", event);

		const context: Context = {
			systemPrompt: "Respond with a short in-character quip. Max 20 words.",
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		};

		return this.ollamaChat(context);
	}

	/**
	 * Respond to the user calling the buddy's name.
	 * Uses Ollama for the response.
	 */
	async respondToNameCall(userMessage: string, recentContext: string): Promise<string | null> {
		if (!this.state) return null;

		const prompt = NAME_CALL_PROMPT.replace("{name}", this.state.name)
			.replace("{species}", this.state.species)
			.replace("{personality}", this.state.personality)
			.replace("{backstory}", this.state.backstory)
			.replace("{message}", userMessage)
			.replace("{context}", recentContext);

		const context: Context = {
			systemPrompt: "Respond with a short friendly greeting. Max 30 words.",
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		};

		return this.ollamaChat(context);
	}

	/** Get the configured Ollama model name, or null if not set */
	getOllamaModel(): string | null {
		return this.state?.ollamaModel ?? loadStored()?.ollamaModel ?? null;
	}

	/** Set the Ollama model for buddy reactions. Persists to disk. */
	setOllamaModel(modelName: string): void {
		const stored = loadStored();
		if (stored) {
			stored.ollamaModel = modelName;
			saveStored(stored);
		}
		if (this.state) {
			this.state.ollamaModel = modelName;
		}
		// Invalidate Ollama status cache so next call picks up the new model
		this.ollamaStatus = null;
	}

	/** Reset Ollama status cache (e.g. after detecting it became available) */
	resetOllamaCache(): void {
		this.ollamaStatus = null;
	}

	/** Update the hidden flag in persisted storage */
	setHidden(hidden: boolean): void {
		const stored = loadStored();
		if (stored) {
			stored.hidden = hidden;
			saveStored(stored);
		}
		// Keep in-memory state in sync so reset() reads current hidden flag
		if (this.state) {
			this.state.hidden = hidden;
		}
	}
}
