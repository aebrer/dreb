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
import { homedir, hostname } from "os";
import { join } from "path";
import { createBuddyRng } from "./buddy-prng.js";
import { rollEyes, rollHat, rollSpecies, rollStats } from "./buddy-species.js";
import type { BuddyState, CompanionBones, StoredCompanion } from "./buddy-types.js";
import { STAT_NAMES } from "./buddy-types.js";

const BUDDY_SALT = "dreb-buddy-v1";
const BUDDY_FILENAME = "buddy.json";

/** Ollama model config for buddy reactions */
const OLLAMA_MODEL: Model<"openai-completions"> = {
	id: "llama3.2",
	name: "Llama 3.2 (Ollama)",
	api: "openai-completions",
	provider: "ollama",
	baseUrl: "http://localhost:11434/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 256,
	compat: {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
	},
};

/** Prompt for soul generation (uses parent LLM, not Ollama) */
const SOUL_GENERATION_PROMPT = `You are generating a companion character for a coding assistant terminal app. Based on the species, rarity, and stats below, generate a creative name (one word, max 12 chars) and a one-sentence personality description.

Species: {species}
Rarity: {rarity}
Stats: {stats}
Shiny: {shiny}

Respond in EXACTLY this format:
NAME: <name>
PERSONALITY: <one sentence personality>`;

/** Prompt for buddy reactions via Ollama */
const REACTION_PROMPT = `You are {name}, a {species} companion in a terminal coding app. You are {personality}. React to this event with a short, in-character quip (max 20 words). No quotes, no prefixes, just the quip.

Event: {event}`;

const NAME_CALL_PROMPT = `You are {name}, a {species} companion in a terminal coding app. You are {personality}. The user called your name. Respond with a short, friendly greeting (max 25 words). No quotes, no prefixes, just your response.`;

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
		const res = await fetch("http://localhost:11434/api/tags");
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

/** Pick the first available Ollama model, preferring llama3.2 */
function pickOllamaModel(models: string[]): string {
	const preferred = models.find((m) => m.startsWith("llama3.2") || m.startsWith("llama3.1"));
	return preferred ?? models[0];
}

// =============================================================================
// Persistence
// =============================================================================

function getBuddyPath(): string {
	// Use ~/.dreb/agent/buddy.json consistent with other config paths
	const configDir = process.env.DREB_CODING_AGENT_DIR;
	const agentDir = configDir
		? configDir.startsWith("~/")
			? homedir() + configDir.slice(1)
			: configDir
		: join(homedir(), ".dreb", "agent");
	return join(agentDir, BUDDY_FILENAME);
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
				hatchedAt: data.hatchedAt ?? new Date().toISOString(),
				visible: data.visible !== false,
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
 * Generate a soul (name + personality) using the parent LLM.
 * Only called on first hatch or reroll.
 */
async function generateSoul(
	bones: CompanionBones,
	parentModel: Model<"openai-completions">,
): Promise<{ name: string; personality: string }> {
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
		const response = await completeSimple(parentModel, context);
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");

		// Parse NAME: ... and PERSONALITY: ...
		const nameMatch = text.match(/NAME:\s*(.+)/i);
		const personalityMatch = text.match(/PERSONALITY:\s*(.+)/i);

		let name = nameMatch?.[1]?.trim() ?? bones.species;
		const personality = personalityMatch?.[1]?.trim() ?? `A ${bones.rarity} ${bones.species} companion.`;

		// Enforce name length
		if (name.length > 12) name = name.slice(0, 12);

		return { name, personality };
	} catch {
		// Fallback if LLM fails
		return {
			name: bones.species,
			personality: `A ${bones.rarity} ${bones.species} companion.`,
		};
	}
}

// =============================================================================
// BuddyManager
// =============================================================================

export class BuddyManager {
	private state: BuddyState | null = null;
	private ollamaStatus: OllamaStatus | null = null;

	/** Get current buddy state (loads from disk if needed) */
	getState(): BuddyState | null {
		if (this.state) return this.state;
		return null;
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
	async hatch(parentModel: Model<"openai-completions">): Promise<BuddyState> {
		const stored = loadStored();
		const rerollCount = stored?.rerollCount ?? 0;

		const bones = rollBones(rerollCount);
		const { name, personality } = await generateSoul(bones, parentModel);

		const newStored: StoredCompanion = {
			rerollCount,
			name,
			personality,
			hatchedAt: new Date().toISOString(),
			visible: true,
		};

		saveStored(newStored);
		this.state = { ...bones, ...newStored };
		return this.state;
	}

	/**
	 * Reroll the buddy — new bones + new soul.
	 */
	async reroll(parentModel: Model<"openai-completions">): Promise<BuddyState> {
		const stored = loadStored();
		const newRerollCount = (stored?.rerollCount ?? 0) + 1;

		const bones = rollBones(newRerollCount);
		const { name, personality } = await generateSoul(bones, parentModel);

		const newStored: StoredCompanion = {
			rerollCount: newRerollCount,
			name,
			personality,
			hatchedAt: new Date().toISOString(),
			visible: true,
		};

		saveStored(newStored);
		this.state = { ...bones, ...newStored };
		return this.state;
	}

	/** Set visibility (persists to disk) */
	setVisible(visible: boolean): void {
		const stored = loadStored();
		if (!stored) return;
		stored.visible = visible;
		saveStored(stored);
		if (this.state) {
			this.state.visible = visible;
		}
	}

	/** Get buddy's name (for name-call detection) */
	getName(): string | null {
		return this.state?.name ?? loadStored()?.name ?? null;
	}

	/**
	 * Generate a reaction to an event using Ollama.
	 * Returns null if Ollama is unavailable.
	 */
	async react(event: string): Promise<string | null> {
		if (!this.state) return null;

		// Check Ollama lazily
		if (!this.ollamaStatus) {
			this.ollamaStatus = await checkOllama();
		}
		if (!this.ollamaStatus.available) return null;

		const modelName = pickOllamaModel(this.ollamaStatus.models);
		const model: Model<"openai-completions"> = {
			...OLLAMA_MODEL,
			id: modelName,
			name: `${modelName} (Ollama)`,
		};

		const prompt = REACTION_PROMPT.replace("{name}", this.state.name)
			.replace("{species}", this.state.species)
			.replace("{personality}", this.state.personality)
			.replace("{event}", event);

		const context: Context = {
			systemPrompt: "Respond with a short in-character quip. Max 20 words.",
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		};

		try {
			const response = await completeSimple(model, context, { apiKey: "ollama" });
			if (response.stopReason === "error") return null;

			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("")
				.trim();

			return text || null;
		} catch {
			return null;
		}
	}

	/**
	 * Respond to the user calling the buddy's name.
	 * Uses Ollama for the response.
	 */
	async respondToNameCall(): Promise<string | null> {
		if (!this.state) return null;

		// Check Ollama lazily
		if (!this.ollamaStatus) {
			this.ollamaStatus = await checkOllama();
		}
		if (!this.ollamaStatus.available) return `${this.state.name} wiggles happily!`;

		const modelName = pickOllamaModel(this.ollamaStatus.models);
		const model: Model<"openai-completions"> = {
			...OLLAMA_MODEL,
			id: modelName,
			name: `${modelName} (Ollama)`,
		};

		const prompt = NAME_CALL_PROMPT.replace("{name}", this.state.name)
			.replace("{species}", this.state.species)
			.replace("{personality}", this.state.personality);

		const context: Context = {
			systemPrompt: "Respond with a short friendly greeting. Max 25 words.",
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		};

		try {
			const response = await completeSimple(model, context, { apiKey: "ollama" });
			if (response.stopReason === "error") return `${this.state.name} wiggles happily!`;

			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("")
				.trim();

			return text || `${this.state.name} wiggles happily!`;
		} catch {
			return `${this.state.name} wiggles happily!`;
		}
	}

	/** Reset Ollama status cache (e.g. after detecting it became available) */
	resetOllamaCache(): void {
		this.ollamaStatus = null;
	}
}
