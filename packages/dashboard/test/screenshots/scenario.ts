/**
 * The fictional world rendered in the README screenshots.
 *
 * Everything here is invented: projects, paths, prompts, code, costs, and agent
 * activity. Paths live under a fictional `/home/demo` home so the dashboard
 * renders them as `~/projects/...`, exactly like a real host would. All times are
 * fixed offsets from {@link SCENARIO_NOW}, which the harness also uses for the
 * browser clock and the runtime pool clock — so relative times ("4m ago") never
 * drift between captures.
 */

import type {
	ModelInfo,
	RpcAgentTypeInfo,
	RpcBackgroundAgentInfo,
	RpcEvent,
	RpcExtensionUIRequest,
	RpcPerformanceStats,
	RpcSessionState,
	RpcSessionTask,
	RpcSettingsSnapshot,
} from "@dreb/coding-agent/rpc";
import { type FixtureModel, SessionBuilder, type SessionFixture, text, thinking, toolCall } from "./session-builder.js";

/** The instant every screenshot is rendered at. */
export const SCENARIO_NOW = "2026-03-18T15:30:00.000Z";
export const NOW_MS = Date.parse(SCENARIO_NOW);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The showcase session spans 153 s and its final in-flight tool call started 8 s before "now". */
const TIDEWATCH_START = NOW_MS - 161_000;
/** Both background agents launch 31 s into the showcase session. */
const SUBAGENT_START = TIDEWATCH_START + 31_000;
const KILN_START = NOW_MS - 6 * MINUTE;

/** Fictional user home; rendered by the dashboard as `~`. */
export const FIXTURE_HOME = "/home/demo";
/**
 * Fleet's default order is project path, so these parents deliberately place the
 * showcase session first and the idle session last.
 */
export const FIXTURE_PROJECTS = {
	tidewatch: `${FIXTURE_HOME}/code/tidewatch`,
	kiln: `${FIXTURE_HOME}/projects/kiln`,
	pantry: `${FIXTURE_HOME}/projects/pantry-api`,
	fieldNotes: `${FIXTURE_HOME}/sites/field-notes`,
	dotfiles: `${FIXTURE_HOME}/dotfiles`,
} as const;

/** Every directory a fixture session records; the harness resolves exactly these as available. */
export const FIXTURE_DIRECTORIES: readonly string[] = Object.values(FIXTURE_PROJECTS);

type StateModel = NonNullable<RpcSessionState["model"]>;

function stateModel(
	fixture: FixtureModel,
	name: string,
	contextWindow: number,
	cost: { input: number; output: number },
): StateModel {
	return {
		id: fixture.id,
		name,
		api: fixture.api,
		provider: fixture.provider,
		baseUrl: "https://models.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost: { ...cost, cacheRead: cost.input / 10, cacheWrite: cost.input * 1.25 },
		contextWindow,
		maxTokens: 64_000,
	};
}

const OPUS: FixtureModel = { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages" };
const SONNET: FixtureModel = { provider: "anthropic", id: "claude-sonnet-5-5", api: "anthropic-messages" };
const GPT: FixtureModel = { provider: "openai", id: "gpt-5.5", api: "openai-responses" };
const GEMINI: FixtureModel = { provider: "google", id: "gemini-3.1-pro", api: "google-generative-ai" };

const MODELS = {
	opus: stateModel(OPUS, "Claude Opus 5.5", 200_000, { input: 5, output: 25 }),
	sonnet: stateModel(SONNET, "Claude Sonnet 5.5", 200_000, { input: 3, output: 15 }),
	gpt: stateModel(GPT, "GPT-5.5", 400_000, { input: 1.25, output: 10 }),
	gemini: stateModel(GEMINI, "Gemini 3.1 Pro", 1_000_000, { input: 2, output: 12 }),
};

export const AVAILABLE_MODELS: ModelInfo[] = [
	{ provider: "anthropic", id: "claude-opus-5-5", contextWindow: 200_000, reasoning: true },
	{ provider: "anthropic", id: "claude-sonnet-5-5", contextWindow: 200_000, reasoning: true },
	{ provider: "anthropic", id: "claude-haiku-5-5", contextWindow: 200_000, reasoning: true },
	{ provider: "openai", id: "gpt-5.5", contextWindow: 400_000, reasoning: true },
	{ provider: "google", id: "gemini-3.1-pro", contextWindow: 1_000_000, reasoning: true },
];

export const AGENT_TYPES: RpcAgentTypeInfo[] = [
	{ name: "Explore", description: "Codebase and web exploration — find files, search code, answer questions." },
	{ name: "code-reviewer", description: "Reviews code changes for correctness and maintainability." },
	{ name: "feature-dev", description: "General-purpose coder for targeted implementation work." },
];

export const SETTINGS: RpcSettingsSnapshot = {
	defaultProvider: "anthropic",
	defaultModel: "claude-opus-5-5",
	defaultThinkingLevel: "medium",
	steeringMode: "all",
	followUpMode: "one-at-a-time",
	compactionEnabled: true,
	continueAfterAutoCompaction: false,
	retryEnabled: true,
	maxConcurrentSubagents: 4,
	imageAutoResize: true,
	blockImages: false,
	enableSkillCommands: true,
	autoLoadNestedContext: false,
	trustedContextFolders: [],
	effectiveTrustedContextRoots: [],
	hideThinkingBlock: false,
	singleModelMode: false,
	agentModels: {},
	resolvedScopedModels: [],
	scopeWarnings: [],
	hasProjectEnabledModelsOverride: false,
	enabledModelsSource: "default",
};

const THINKING_LEVELS: RpcSessionState["availableThinkingLevels"] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

// ---------------------------------------------------------------------------
// Showcase session: tidewatch — running, with tool cards and two subagents.
// ---------------------------------------------------------------------------

const STATIONS_SOURCE = `import { request } from "./http.js";
import type { Station } from "./types.js";

const API_BASE = "https://api.tidewatch.example/v2";

export interface FetchOptions {
	/** Skip any cached copy and fetch fresh metadata. */
	refresh?: boolean;
}

/** Look up a tide station's metadata and harmonic constituents. */
export async function fetchStation(id: string): Promise<Station> {
	const response = await request(\`\${API_BASE}/stations/\${encodeURIComponent(id)}\`);
	if (!response.ok) {
		throw new Error(\`Station \${id} lookup failed: HTTP \${response.status}\`);
	}
	return (await response.json()) as Station;
}
`;

const STATIONS_DIFF = [
	"    ...",
	" 11 /** Look up a tide station's metadata and harmonic constituents. */",
	"-12 export async function fetchStation(id: string): Promise<Station> {",
	"+12 export async function fetchStation(id: string, options: FetchOptions = {}): Promise<Station> {",
	"+13 \tif (!options.refresh) {",
	"+14 \t\tconst cached = await readCachedStation(id, STATION_TTL_MS);",
	"+15 \t\tif (cached) return cached;",
	"+16 \t}",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: quoted TypeScript source contains a template literal
	" 17 \tconst response = await request(`${API_BASE}/stations/${encodeURIComponent(id)}`);",
	" 18 \tif (!response.ok) {",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: quoted TypeScript source contains a template literal
	" 19 \t\tthrow new Error(`Station ${id} lookup failed: HTTP ${response.status}`);",
	" 20 \t}",
	"-17 \treturn (await response.json()) as Station;",
	"+21 \tconst station = (await response.json()) as Station;",
	"+22 \tawait writeCachedStation(station);",
	"+23 \treturn station;",
	" 24 }",
].join("\n");

const README_DIFF = [
	"    ...",
	" 42 ## Usage",
	" 43 ",
	" 44 ```sh",
	" 45 tidewatch forecast --station 9414290",
	"+46 tidewatch forecast --station 9414290 --refresh",
	" 47 ```",
	" 48 ",
	"+49 Station metadata is cached for 24 hours in your platform cache directory",
	"+50 (for example `~/.cache/tidewatch`). Pass `--refresh` to ignore the cache.",
	"+51 ",
	" 52 ## Stations",
].join("\n");

const TEST_OUTPUT = ` RUN  v4.1.0 ~/code/tidewatch

 ✓ test/station-cache.test.ts (5 tests) 41ms
 ✓ test/stations.test.ts (6 tests) 23ms
 ✓ test/forecast.test.ts (9 tests) 57ms

 Test Files  3 passed (3)
      Tests  20 passed (20)
   Duration  1.12s`;

/** The showcase session's in-flight tool call; the live replay reports it as executing. */
const TIDEWATCH_IN_FLIGHT = toolCall("call_tw_06", "bash", { command: "npm run typecheck && npm run lint" });

function showcaseSession(): SessionFixture {
	const grep = toolCall("call_tw_01", "grep", { pattern: "fetchStation\\(", path: "src" });
	const read = toolCall("call_tw_02", "read", { path: "src/stations.ts" });
	const subagents = toolCall("call_tw_03", "subagent", {
		tasks: [
			{ agent: "Explore", task: "Find how tidewatch resolves its config and cache directories" },
			{ agent: "Explore", task: "Check how the existing tests mock HTTP for station lookups" },
		],
	});
	const edit = toolCall("call_tw_04", "edit", {
		path: "src/stations.ts",
		oldText: "export async function fetchStation(id: string): Promise<Station> {",
		newText: "export async function fetchStation(id: string, options: FetchOptions = {}): Promise<Station> {",
	});
	const tests = toolCall("call_tw_05", "bash", { command: "npm test -- station forecast" });
	const readme = toolCall("call_tw_07", "edit", {
		path: "README.md",
		oldText: "tidewatch forecast --station 9414290\n```\n\n## Stations",
		newText: [
			"tidewatch forecast --station 9414290",
			"tidewatch forecast --station 9414290 --refresh",
			"```",
			"",
			"Station metadata is cached for 24 hours in your platform cache directory",
			"(for example `~/.cache/tidewatch`). Pass `--refresh` to ignore the cache.",
			"",
			"## Stations",
		].join("\n"),
	});
	const typecheck = TIDEWATCH_IN_FLIGHT;

	return new SessionBuilder({
		id: "3c1f6a2e-7d44-4b8e-9a51-2f0c8d9e6b13",
		cwd: FIXTURE_PROJECTS.tidewatch,
		startedAt: TIDEWATCH_START,
		name: "Offline cache for station data",
		model: OPUS,
		thinkingLevel: "high",
	})
		.user(
			"`tidewatch forecast` re-downloads station metadata on every run, which is painfully slow on a boat's " +
				"connection. Add an on-disk cache with a 24-hour TTL, make `--refresh` bypass it, and cover both paths with tests.",
		)
		.after(9)
		.assistant(
			[
				thinking(
					"Station metadata barely changes, so a TTL cache is safe. First find every caller of fetchStation " +
						"so the cache sits in one place instead of being duplicated per command.",
				),
				text("I'll start by finding where station data is fetched."),
				grep,
			],
			{ input: 9_420, output: 168 },
		)
		.after(1)
		.toolResult(
			grep,
			[
				"src/stations.ts:12:export async function fetchStation(id: string): Promise<Station> {",
				"src/commands/forecast.ts:42:  const station = await fetchStation(options.station);",
				"src/commands/stations.ts:27:  const station = await fetchStation(id);",
			].join("\n"),
		)
		.after(6)
		.assistant([read], { input: 9_870, output: 52, cacheRead: 9_300 })
		.after(1)
		.toolResult(read, STATIONS_SOURCE)
		.after(14)
		.assistant(
			[
				text(
					"Both commands go through `fetchStation`, so the cache belongs there. While I write it, two " +
						"background agents will check the existing directory helpers and the test setup.",
				),
				subagents,
			],
			{ input: 10_640, output: 214, cacheRead: 9_800 },
		)
		.after(1)
		.toolResult(
			subagents,
			[
				"2 background agents started:",
				"  4e7a91 (Explore): Find how tidewatch resolves its config and cache directories",
				"  b83f0c (Explore): Check how the existing tests mock HTTP for station lookups",
				"",
				"Each will notify independently when complete.",
			].join("\n"),
		)
		.after(48)
		.assistant(
			[
				thinking(
					"The config helper already exposes cacheDir() via env-paths, so reuse it. Read the cache before " +
						"the request and write it after a successful response; --refresh skips the read only.",
				),
				edit,
			],
			{ input: 13_950, output: 1_240, cacheRead: 10_400 },
		)
		.after(1)
		.toolResult(edit, "Successfully replaced text in src/stations.ts.", { diff: STATIONS_DIFF, firstChangedLine: 12 })
		.after(52)
		.assistant([text("Cache and tests are in. Running the affected suites."), tests], {
			input: 16_210,
			output: 96,
			cacheRead: 13_900,
		})
		.after(4)
		.toolResult(tests, TEST_OUTPUT)
		.after(9)
		.assistant([text("All 20 tests pass. Documenting the cache and the new flag in the README."), readme], {
			input: 16_980,
			output: 188,
			cacheRead: 16_100,
		})
		.after(1)
		.toolResult(readme, "Successfully replaced text in README.md.", { diff: README_DIFF, firstChangedLine: 46 })
		.after(6)
		.assistant(
			[
				text(
					[
						"Cache, tests, and docs are done. Running the typecheck and linter as a final check.",
						"",
						"What changed:",
						"",
						"- **`src/station-cache.ts`** — reads and writes `<cacheDir>/stations/<id>.json` with a 24-hour TTL; " +
							"corrupt or expired entries are ignored rather than thrown.",
						"- **`fetchStation`** checks the cache first and stores fresh responses; `--refresh` skips the read.",
						"- **Tests** cover a cache hit, an expired entry, a corrupt file, and `--refresh` forcing a fetch.",
					].join("\n"),
				),
				typecheck,
			],
			{ input: 17_420, output: 296, cacheRead: 16_900 },
		)
		.build();
}

function exploreDirectoriesSubagent(): SessionFixture {
	const grep = toolCall("call_sa_01", "grep", { pattern: "env-paths|cacheDir|configDir", path: "src" });
	const read = toolCall("call_sa_02", "read", { path: "src/config.ts" });
	return new SessionBuilder({
		id: "4e7a91d2-0c3b-4f6a-8e15-6b2d9f0a7c48",
		cwd: FIXTURE_PROJECTS.tidewatch,
		startedAt: SUBAGENT_START,
		model: SONNET,
		agentType: "Explore",
	})
		.user("Find how tidewatch resolves its config and cache directories")
		.after(5)
		.assistant([text("Searching for directory helpers."), grep], { input: 3_210, output: 61 })
		.after(1)
		.toolResult(
			grep,
			[
				'src/config.ts:3:import envPaths from "env-paths";',
				"src/config.ts:9:export function configDir(): string {",
				"src/config.ts:13:export function cacheDir(): string {",
			].join("\n"),
		)
		.after(4)
		.assistant([read], { input: 3_480, output: 40 })
		.after(1)
		.toolResult(
			read,
			[
				'import { mkdirSync } from "node:fs";',
				'import envPaths from "env-paths";',
				"",
				'const paths = envPaths("tidewatch", { suffix: "" });',
				"",
				"export function configDir(): string {",
				"\treturn paths.config;",
				"}",
				"",
				"export function cacheDir(): string {",
				"\tmkdirSync(paths.cache, { recursive: true });",
				"\treturn paths.cache;",
				"}",
			].join("\n"),
		)
		.after(9)
		.assistant(
			[
				text(
					[
						"`src/config.ts` already resolves both directories through **env-paths**:",
						"",
						"- `configDir()` → platform config dir (e.g. `~/.config/tidewatch`)",
						"- `cacheDir()` → platform cache dir (e.g. `~/.cache/tidewatch`), created on first use",
						"",
						"Nothing caches station data yet, so `cacheDir()` is the natural home for a `stations/` subdirectory.",
					].join("\n"),
				),
			],
			{ input: 3_910, output: 188 },
		)
		.build();
}

function exploreTestsSubagent(): SessionFixture {
	const find = toolCall("call_sb_01", "find", { pattern: "*.test.ts", path: "test" });
	const read = toolCall("call_sb_02", "read", { path: "test/stations.test.ts" });
	const grep = toolCall("call_sb_03", "grep", { pattern: "vi\\.mock|msw|fetchMock", path: "test" });
	return new SessionBuilder({
		id: "b83f0c57-9a1e-4d2b-b6f4-0e8c3a5d7f92",
		cwd: FIXTURE_PROJECTS.tidewatch,
		startedAt: SUBAGENT_START,
		model: SONNET,
		agentType: "Explore",
	})
		.user("Check how the existing tests mock HTTP for station lookups")
		.after(4)
		.assistant([text("Listing the test files first."), find], { input: 3_150, output: 48 })
		.after(1)
		.toolResult(find, ["test/forecast.test.ts", "test/stations.test.ts", "test/helpers/http.ts"].join("\n"))
		.after(35)
		.assistant([read], { input: 3_390, output: 37 })
		.after(1)
		.toolResult(
			read,
			[
				'import { afterEach, describe, expect, it } from "vitest";',
				'import { fetchStation } from "../src/stations.js";',
				'import { mockStation, resetHttp } from "./helpers/http.js";',
				"",
				'describe("fetchStation", () => {',
				"\tafterEach(resetHttp);",
				"",
				'\tit("returns station metadata", async () => {',
				'\t\tmockStation("9414290", { name: "San Francisco" });',
				'\t\tawait expect(fetchStation("9414290")).resolves.toMatchObject({ name: "San Francisco" });',
				"\t});",
				"});",
			].join("\n"),
		)
		.after(70)
		.assistant(
			[
				text(
					"Tests stub HTTP through `test/helpers/http.ts` rather than a mocking library. Checking whether " +
						"anything else intercepts requests.",
				),
				grep,
			],
			{ input: 3_820, output: 96 },
		)
		.after(11)
		.toolResult(
			grep,
			[
				"test/helpers/http.ts:4:const routes = new Map<string, Response>();",
				'test/helpers/http.ts:11:vi.mock("../../src/http.js", () => ({ request: (url: string) => routes.get(url) }));',
			].join("\n"),
		)
		.build();
}

// ---------------------------------------------------------------------------
// Other live sessions
// ---------------------------------------------------------------------------

const PANTRY_QUESTION =
	"Should `/items` paginate with opaque cursors or page numbers? Cursors stay stable while items are added; " +
	"page numbers are simpler for the admin table.";

function pantrySession(): SessionFixture {
	const read = toolCall("call_pa_01", "read", { path: "internal/http/items.go" });
	const ask = toolCall("call_pa_02", "ask_user", {
		questions: [{ question: PANTRY_QUESTION, options: ["Opaque cursors", "Page numbers"] }],
	});
	return new SessionBuilder({
		id: "8d2b4e61-5f0a-4c79-a3d8-1e6f9b2c0a57",
		cwd: FIXTURE_PROJECTS.pantry,
		startedAt: NOW_MS - 41 * MINUTE,
		name: "Paginate the /items endpoint",
		model: GPT,
		thinkingLevel: "medium",
	})
		.user("`GET /items` returns every row and times out for large households. Add pagination.")
		.after(7)
		.assistant([read], { input: 6_200, output: 44 })
		.after(1)
		.toolResult(
			read,
			"func (h *Handler) ListItems(w http.ResponseWriter, r *http.Request) {\n\titems, err := h.store.AllItems(r.Context())\n\t// ...\n}",
		)
		.after(12)
		.assistant(
			[
				text(
					"Before I change the response shape: should pagination use opaque cursors or page numbers? " +
						"Cursors stay stable while items are added; page numbers are simpler for the admin table.",
				),
				ask,
			],
			{ input: 6_900, output: 140 },
		)
		.build();
}

function fieldNotesSession(): SessionFixture {
	return new SessionBuilder({
		id: "c47e9a03-2b6d-4e18-9f5c-7a0d3b8e1f26",
		cwd: FIXTURE_PROJECTS.fieldNotes,
		startedAt: NOW_MS - 2 * HOUR,
		name: "Fix broken links after the docs move",
		model: SONNET,
		thinkingLevel: "low",
	})
		.user("The docs moved from /docs to /guide last week and the link checker is red. Fix the links.")
		.after(95)
		.assistant(
			[
				text(
					"Fixed 14 broken links across 9 pages, added redirects for the old docs URLs, and the link " +
						"checker now runs in CI. The site builds with no warnings.",
				),
			],
			{ input: 21_300, output: 410 },
		)
		.build();
}

function kilnSession(): SessionFixture {
	const bash = toolCall("call_ki_01", "bash", { command: "npm run build" });
	return new SessionBuilder({
		id: "e5a90b18-6c2f-4d73-8b41-9f3e0d6a2c84",
		cwd: FIXTURE_PROJECTS.kiln,
		startedAt: KILN_START,
		name: "Upgrade the build to Vite 8",
		model: GEMINI,
		thinkingLevel: "medium",
	})
		.user("Upgrade kiln's build to Vite 8 and fix whatever breaks.")
		.after(330)
		.assistant(
			[
				text(
					"Vite 8 drops the CommonJS config loader, so I converted the Vite config to ESM. Rebuilding to " +
						"check the plugin hooks.",
				),
				bash,
			],
			{ input: 18_400, output: 260 },
		)
		.build();
}

// ---------------------------------------------------------------------------
// Past (on-disk) sessions
// ---------------------------------------------------------------------------

interface PastSessionSpec {
	id: string;
	cwd: string;
	name: string;
	ageMs: number;
	model: FixtureModel;
	prompt: string;
	answer: string;
	/** Extra user/assistant turns so message counts vary. */
	followUps?: number;
}

const PAST_SESSIONS: PastSessionSpec[] = [
	{
		id: "0a6f3d92-4e1b-4c58-9d27-b8e5f1c3a046",
		cwd: FIXTURE_PROJECTS.tidewatch,
		name: "Export tide charts as PNG",
		ageMs: 2 * DAY + 3 * HOUR,
		model: OPUS,
		prompt: "Add `tidewatch chart --png` that renders the 48-hour tide curve to an image.",
		answer: "Added `--png` using the existing SVG renderer plus resvg; the output is 1200×600 by default.",
		followUps: 3,
	},
	{
		id: "1b7e4c03-5f2a-4d69-8e38-c9f6a2d4b157",
		cwd: FIXTURE_PROJECTS.tidewatch,
		name: "Fix DST offset in high-tide times",
		ageMs: 5 * DAY + 6 * HOUR,
		model: SONNET,
		prompt: "High-tide times are an hour off for stations that observe daylight saving time.",
		answer: "Times now convert through the station's IANA zone instead of a fixed UTC offset.",
		followUps: 2,
	},
	{
		id: "2c8f5d14-6a3b-4e7a-9f49-d0a7b3e5c268",
		cwd: FIXTURE_PROJECTS.tidewatch,
		name: "Set up the release workflow",
		ageMs: 12 * DAY + 3 * HOUR,
		model: OPUS,
		prompt: "Publish to npm when a GitHub release is created.",
		answer: "Added a release workflow with provenance and a version check against package.json.",
		followUps: 1,
	},
	{
		id: "3d9a6e25-7b4c-4f8b-a05a-e1b8c4f6d379",
		cwd: FIXTURE_PROJECTS.tidewatch,
		name: "Scaffold the CLI",
		ageMs: 23 * DAY + 1 * HOUR,
		model: SONNET,
		prompt: "Scaffold a TypeScript CLI called tidewatch with forecast and stations commands.",
		answer: "Scaffolded the CLI with both commands, vitest, and a build script.",
		followUps: 4,
	},
	{
		id: "4eab7f36-8c5d-4a9c-b16b-f2c9d5a7e48a",
		cwd: FIXTURE_PROJECTS.pantry,
		name: "Add request logging middleware",
		ageMs: 1 * DAY + 2 * HOUR,
		model: GPT,
		prompt: "Log method, path, status, and latency for every request.",
		answer: "Added structured request logging with a request id, and skipped the health check endpoint.",
		followUps: 2,
	},
	{
		id: "5fbc8a47-9d6e-4bad-827c-a3dae6b8f59b",
		cwd: FIXTURE_PROJECTS.pantry,
		name: "Migrate to Postgres 17",
		ageMs: 9 * DAY + 2 * HOUR,
		model: OPUS,
		prompt: "Upgrade the local and CI databases to Postgres 17.",
		answer: "Updated compose and CI images, and the migrations pass unchanged on 17.",
		followUps: 1,
	},
	{
		id: "60cd9b58-ae7f-4cbe-938d-b4ebf7c9a6ac",
		cwd: FIXTURE_PROJECTS.fieldNotes,
		name: "Move the docs to /guide",
		ageMs: 3 * DAY + 4 * HOUR,
		model: SONNET,
		prompt: "Move the docs from /docs to /guide and update the navigation.",
		answer: "Moved 31 pages and rebuilt the sidebar navigation from front matter.",
		followUps: 2,
	},
	{
		id: "71deac69-bf80-4dcf-a49e-c5fca8dab7bd",
		cwd: FIXTURE_PROJECTS.kiln,
		name: "Cache the dependency graph between builds",
		ageMs: 6 * DAY + 5 * HOUR,
		model: GEMINI,
		prompt: "Rebuilds re-scan every import. Cache the dependency graph between runs.",
		answer: "The graph is cached by content hash; warm rebuilds are about 4× faster.",
		followUps: 3,
	},
	{
		id: "82efbd7a-c091-4ed0-b5af-d60eb9ebc8ce",
		cwd: FIXTURE_PROJECTS.dotfiles,
		name: "Tidy shell aliases",
		ageMs: 27 * DAY + 5 * HOUR,
		model: SONNET,
		prompt: "Remove unused shell aliases and group the rest by tool.",
		answer: "Removed 12 unused aliases and grouped the rest into git, node, and navigation sections.",
	},
];

function pastSession(spec: PastSessionSpec): SessionFixture {
	const builder = new SessionBuilder({
		id: spec.id,
		cwd: spec.cwd,
		startedAt: NOW_MS - spec.ageMs,
		name: spec.name,
		model: spec.model,
	})
		.user(spec.prompt)
		.after(40)
		.assistant([text(spec.answer)], { input: 8_000, output: 300 });
	for (let turn = 0; turn < (spec.followUps ?? 0); turn += 1) {
		builder
			.after(120)
			.user("Looks good — anything else to clean up?")
			.after(30)
			.assistant([text("Nothing else outstanding; the change is ready to commit.")], { input: 9_000, output: 60 });
	}
	return builder.build();
}

// ---------------------------------------------------------------------------
// Live runtime scenarios
// ---------------------------------------------------------------------------

export interface SubagentScenario {
	info: Omit<RpcBackgroundAgentInfo, "sessionFile" | "sessionDir">;
	session: SessionFixture;
}

export interface LiveRuntimeScenario {
	/** Stable handle for shot definitions. */
	slug: "tidewatch" | "pantry" | "fieldNotes" | "kiln";
	session: SessionFixture;
	model: StateModel;
	thinkingLevel: RpcSessionState["thinkingLevel"];
	status: "running" | "attention" | "idle";
	/** Runtime start (ms epoch); fixes the fleet's stable created ordering. */
	createdAt: number;
	/** Last runtime event (ms epoch); rendered as relative activity time. */
	lastActivity: number;
	tasks: RpcSessionTask[];
	contextTokens: number;
	tokensTotal: number;
	cost: number;
	subagentCost?: number;
	gitBranch: string;
	subagents: SubagentScenario[];
	/** A blocking question the agent is waiting on (needs-attention status). */
	pendingRequest?: Extract<RpcExtensionUIRequest, { method: "ask" }>;
	performance?: RpcPerformanceStats["models"][number];
	/**
	 * Events emitted once a browser is connected, so the captured screen shows the
	 * live state a real session would stream (e.g. the tool currently executing)
	 * instead of the generic state restored from a snapshot.
	 */
	liveEvents?: RpcEvent[];
}

export interface Scenario {
	live: LiveRuntimeScenario[];
	past: SessionFixture[];
}

/** Build the complete fictional world. Pure and deterministic. */
export function buildScenario(): Scenario {
	const tidewatch = showcaseSession();
	const pantry = pantrySession();
	return {
		live: [
			{
				slug: "tidewatch",
				session: tidewatch,
				model: MODELS.opus,
				thinkingLevel: "high",
				status: "running",
				createdAt: TIDEWATCH_START,
				lastActivity: tidewatch.endedAt,
				tasks: [
					{ id: "t1", title: "Find every caller of fetchStation", status: "completed" },
					{ id: "t2", title: "Add station cache with a 24-hour TTL", status: "completed" },
					{ id: "t3", title: "Test cache hit, expiry, corruption, and --refresh", status: "completed" },
					{ id: "t4", title: "Document caching and --refresh in the README", status: "completed" },
					{ id: "t5", title: "Typecheck and lint", status: "in_progress" },
				],
				contextTokens: 61_400,
				tokensTotal: 186_400,
				cost: 1.42,
				subagentCost: 0.18,
				gitBranch: "feat/station-cache",
				liveEvents: [
					{
						type: "tool_execution_start",
						toolCallId: TIDEWATCH_IN_FLIGHT.id,
						toolName: TIDEWATCH_IN_FLIGHT.name,
						args: TIDEWATCH_IN_FLIGHT.arguments,
					},
				],
				subagents: [
					{
						info: {
							agentId: "b83f0c",
							agentType: "Explore",
							taskSummary: "Check how the existing tests mock HTTP for station lookups",
							startedAt: new Date(SUBAGENT_START).toISOString(),
							status: "running",
							cwd: FIXTURE_PROJECTS.tidewatch,
						},
						session: exploreTestsSubagent(),
					},
					{
						info: {
							agentId: "4e7a91",
							agentType: "Explore",
							taskSummary: "Find how tidewatch resolves its config and cache directories",
							startedAt: new Date(SUBAGENT_START).toISOString(),
							status: "completed",
							cwd: FIXTURE_PROJECTS.tidewatch,
						},
						session: exploreDirectoriesSubagent(),
					},
				],
				performance: {
					provider: OPUS.provider,
					modelId: OPUS.id,
					rolling: { median: 64, mean: 66, count: 100 },
					delta: {
						baselineMedian: 61,
						recentMedian: 64,
						percentDelta: 4.9,
						direction: "above",
						baselineCount: 80,
						recentCount: 20,
					},
				},
			},
			{
				slug: "pantry",
				session: pantry,
				model: MODELS.gpt,
				thinkingLevel: "medium",
				status: "attention",
				createdAt: NOW_MS - 41 * MINUTE,
				lastActivity: pantry.endedAt,
				tasks: [
					{ id: "p1", title: "Read the current /items handler", status: "completed" },
					{ id: "p2", title: "Choose the pagination scheme", status: "in_progress" },
					{ id: "p3", title: "Paginate the store query", status: "pending" },
					{ id: "p4", title: "Update API docs and tests", status: "pending" },
				],
				contextTokens: 31_200,
				tokensTotal: 24_800,
				cost: 0.21,
				gitBranch: "items-pagination",
				subagents: [],
				pendingRequest: {
					type: "extension_ui_request",
					id: "ask-pantry-1",
					method: "ask",
					title: "Pagination scheme",
					questions: [
						{
							question: PANTRY_QUESTION,
							title: "Pagination",
							options: ["Opaque cursors", "Page numbers"],
							allowFreeText: true,
						},
					],
				},
			},
			{
				slug: "fieldNotes",
				session: fieldNotesSession(),
				model: MODELS.sonnet,
				thinkingLevel: "low",
				status: "idle",
				createdAt: NOW_MS - 2 * HOUR,
				lastActivity: NOW_MS - 2 * HOUR + 95_000,
				tasks: [],
				contextTokens: 21_710,
				tokensTotal: 61_200,
				cost: 0.38,
				gitBranch: "main",
				subagents: [],
			},
			{
				slug: "kiln",
				session: kilnSession(),
				model: MODELS.gemini,
				thinkingLevel: "medium",
				status: "running",
				createdAt: KILN_START,
				lastActivity: KILN_START + 330_000,
				tasks: [
					{ id: "k1", title: "Bump vite and plugins", status: "completed" },
					{ id: "k2", title: "Convert the config to ESM", status: "completed" },
					{ id: "k3", title: "Fix plugin hook changes", status: "in_progress" },
				],
				contextTokens: 148_000,
				tokensTotal: 74_900,
				cost: 0.29,
				gitBranch: "vite-8",
				subagents: [],
			},
		],
		past: PAST_SESSIONS.map(pastSession),
	};
}

/** Look up a live runtime scenario by slug; throws for an unknown slug. */
export function liveScenario(scenario: Scenario, slug: LiveRuntimeScenario["slug"]): LiveRuntimeScenario {
	const found = scenario.live.find((runtime) => runtime.slug === slug);
	if (!found) throw new Error(`Unknown screenshot scenario runtime: ${slug}`);
	return found;
}

export { THINKING_LEVELS };
