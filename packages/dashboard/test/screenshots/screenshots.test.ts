/**
 * README screenshot harness tests.
 *
 * The smoke tests run the real harness — real dashboard server, real client
 * build, real Chromium — over the fictional scenario, fully offline (Google Fonts
 * are stubbed). They fail if the harness rots (a screen needs an RPC member the
 * fixture runtime lacks, a selector disappears, an API call errors) or if a
 * rendered screen could leak host data. The docs-sync tests keep the shot list,
 * the committed images, and both READMEs consistent.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SESSION_VERSION, SessionManager } from "@dreb/coding-agent";
import type { RpcEvent } from "@dreb/coding-agent/rpc";
import type { Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_OUT_DIR, parseCaptureArgs } from "./capture-args.js";
import { createFixtureRpcClient, FixtureRpcFailures, fixtureControls } from "./fixture-rpc-client.js";
import { buildDashboardClient, runScreenshotHarness, ScreenshotHarnessError } from "./harness.js";
import { findLeaks, leakNeedles } from "./leak-guard.js";
import { buildScenario, FIXTURE_DIRECTORIES, FIXTURE_HOME, liveScenario } from "./scenario.js";
import { type SessionFixture, toJsonl } from "./session-builder.js";
import { SHOTS, selectShots, shotViewport } from "./shots.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DASHBOARD_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCREENSHOT_DIR = join(DASHBOARD_ROOT, "docs", "screenshots");
const RAW_SCREENSHOT_BASE = "https://raw.githubusercontent.com/aebrer/dreb/master/packages/dashboard/docs/screenshots/";

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}
afterAll(async () => {
	await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Width and height from a PNG's IHDR chunk. */
async function pngSize(path: string): Promise<{ width: number; height: number }> {
	const bytes = await readFile(path);
	expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function expectedPixels(name: string): { width: number; height: number } {
	const shot = SHOTS.find((candidate) => candidate.name === name);
	if (!shot) throw new Error(`unknown shot ${name}`);
	const viewport = shotViewport(shot);
	return { width: viewport.width * viewport.deviceScaleFactor, height: viewport.height * viewport.deviceScaleFactor };
}

function allFixtures(): SessionFixture[] {
	const scenario = buildScenario();
	return [
		...scenario.live.flatMap((runtime) => [runtime.session, ...runtime.subagents.map((agent) => agent.session)]),
		...scenario.past,
	];
}

describe("leak guard", () => {
	const host = { homeDir: "/home/alice", username: "alice", hostname: "alice-workstation" };

	it("flags the host home, user paths, hostname, and sandbox in any casing", () => {
		const needles = leakNeedles(host, "/tmp/dreb-screenshots-abc");
		const haystack = [
			"cwd /home/alice/projects/secret",
			"C:\\Users\\alice\\src",
			"/Users/alice/work",
			"connected to ALICE-WORKSTATION",
			"file /tmp/dreb-screenshots-abc/agent/sessions/x.jsonl",
		].join("\n");
		const labels = findLeaks(haystack, needles).map((finding) => finding.label);
		expect(labels).toEqual(
			expect.arrayContaining(["sandbox directory", "real home directory", "real user home path", "real hostname"]),
		);
		expect(findLeaks("/Users/alice/work", needles)).toEqual([
			expect.objectContaining({ label: "real user home path", context: "/Users/alice/work" }),
		]);
	});

	it("passes fictional scenario text and ignores bare short usernames and loopback hostnames", () => {
		const needles = leakNeedles({ homeDir: "/home/runner", username: "runner", hostname: "localhost" }, "/tmp/sb");
		expect(findLeaks("~/code/tidewatch · the test runner passed on localhost", needles)).toEqual([]);
		expect(needles.map((needle) => needle.value)).not.toContain("localhost");
		expect(findLeaks("/home/runner/work/dreb", needles)).not.toEqual([]);
	});
});

describe("capture arguments", () => {
	it("defaults to the committed screenshot directory", () => {
		expect(parseCaptureArgs([])).toEqual({ outDir: DEFAULT_OUT_DIR, only: [], help: false });
		expect(DEFAULT_OUT_DIR.replace(/\/$/, "")).toBe(SCREENSHOT_DIR);
	});

	it("parses --out, repeated --only, and --help", () => {
		const args = parseCaptureArgs([
			"--out",
			"/tmp/x",
			"--only",
			"fleet-desktop-dark",
			"--only",
			"session-mobile-dark",
		]);
		expect(args).toEqual({ outDir: "/tmp/x", only: ["fleet-desktop-dark", "session-mobile-dark"], help: false });
		expect(parseCaptureArgs(["-h"]).help).toBe(true);
	});

	it("rejects missing values and unknown arguments", () => {
		expect(() => parseCaptureArgs(["--out"])).toThrow("--out requires a directory");
		expect(() => parseCaptureArgs(["--only", "--out"])).toThrow("--only requires a shot name");
		expect(() => parseCaptureArgs(["--bogus"])).toThrow("Unknown argument: --bogus");
	});
});

describe("shot list", () => {
	it("has unique names and resolves filters", () => {
		const names = SHOTS.map((shot) => shot.name);
		expect(new Set(names).size).toBe(names.length);
		expect(selectShots(undefined)).toBe(SHOTS);
		expect(selectShots(["settings-themes-desktop"]).map((shot) => shot.name)).toEqual(["settings-themes-desktop"]);
	});

	it("covers desktop and mobile, mostly dark with one light shot", () => {
		expect(SHOTS.filter((shot) => shot.colorMode === "light")).toHaveLength(1);
		expect(new Set(SHOTS.map((shot) => shot.viewport))).toEqual(new Set(["desktop", "mobile"]));
	});

	it("rejects unknown shot names loudly", () => {
		expect(() => selectShots(["fleet-desktop-drak"])).toThrow(/Unknown screenshot\(s\): fleet-desktop-drak/);
	});
});

describe("scenario fixtures", () => {
	it("are current-version sessions in fictional project directories only", () => {
		const fixtures = allFixtures();
		expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(fixtures.length);
		for (const fixture of fixtures) {
			const [header] = fixture.entries;
			expect(header).toMatchObject({ type: "session", version: CURRENT_SESSION_VERSION, id: fixture.id });
			expect(fixture.cwd.startsWith(`${FIXTURE_HOME}/`)).toBe(true);
			expect(FIXTURE_DIRECTORIES).toContain(fixture.cwd);
			expect(fixture.fileName).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]{36}\.jsonl$/);
			const serialized = toJsonl(fixture);
			expect(serialized).not.toMatch(/\/Users\/|C:\\\\Users/);
			expect(serialized.match(/\/home\/[^/"\s]+/g)?.every((path) => path === FIXTURE_HOME) ?? true).toBe(true);
		}
	});

	it("round-trip through the real session parser and inventory", async () => {
		const dir = await tempDir("dreb-screenshot-fixtures-");
		const scenario = buildScenario();
		for (const fixture of [...scenario.live.map((runtime) => runtime.session), ...scenario.past]) {
			const path = join(dir, fixture.fileName);
			await writeFile(path, toJsonl(fixture));
			expect(SessionManager.open(path).buildSessionContext().messages).toEqual(fixture.messages);
		}
		const inventory = await SessionManager.listAllMetadataFromDir(dir);
		expect(inventory).toHaveLength(scenario.live.length + scenario.past.length);
		expect(inventory.map((session) => session.name)).toContain("Offline cache for station data");
		expect(inventory.every((session) => session.messageCount > 0)).toBe(true);
	});

	it("is deterministic", () => {
		expect(JSON.stringify(buildScenario())).toBe(JSON.stringify(buildScenario()));
	});
});

describe("fixture RPC runtime", () => {
	async function boundClient() {
		const dir = await tempDir("dreb-screenshot-rpc-");
		const scenario = buildScenario();
		const runtime = liveScenario(scenario, "pantry");
		const path = join(dir, runtime.session.fileName);
		await writeFile(path, toJsonl(runtime.session));
		const failures = new FixtureRpcFailures();
		const client = createFixtureRpcClient({
			scenario,
			binding: { scenario: runtime, paths: { sessionFile: () => path } },
			version: "9.9.9",
			failures,
		});
		return { client, failures, runtime, path };
	}

	it("serves the materialized transcript through the real session parser", async () => {
		const { client, runtime, path } = await boundClient();
		await client.start();
		expect(await client.getMessages()).toEqual(runtime.session.messages);
		const state = await client.getState();
		expect(state).toMatchObject({
			sessionFile: path,
			sessionName: "Paginate the /items endpoint",
			isStreaming: true,
		});
		expect(state.contextUsage?.percent).toBeCloseTo((runtime.contextTokens / runtime.model.contextWindow) * 100);
	});

	it("emits the ordering barrier before returning a dashboard snapshot", async () => {
		const { client, runtime } = await boundClient();
		await client.start();
		const events: RpcEvent[] = [];
		client.onEvent((event) => events.push(event));
		const snapshot = await client.getDashboardSnapshot();
		expect(events).toEqual([{ type: "dashboard_snapshot_barrier", snapshotId: snapshot.snapshotId }]);
		expect(snapshot.pendingExtensionUiRequests).toEqual([runtime.pendingRequest]);
	});

	it("replays lifecycle events that set running, attention, and idle status", async () => {
		const { client, runtime } = await boundClient();
		const events: RpcEvent[] = [];
		client.onEvent((event) => events.push(event));
		fixtureControls(client).replayLifecycle();
		expect(events.map((event) => event.type)).toEqual(["agent_start", "extension_ui_request"]);
		expect(events[1]).toBe(runtime.pendingRequest);
	});

	it("throws and records any RPC member it does not implement", async () => {
		const { client, failures } = await boundClient();
		expect(() => client.prompt("hello")).toThrow(/does not implement RpcClient\.prompt\(\)/);
		expect(failures.messages).toEqual([expect.stringContaining("RpcClient.prompt()")]);
	});

	it("rejects session reads on the session-less utility runtime but serves settings", async () => {
		const failures = new FixtureRpcFailures();
		const client = createFixtureRpcClient({ scenario: buildScenario(), version: "9.9.9", failures });
		await client.start();
		expect(await client.getVersion()).toBe("9.9.9");
		expect((await client.getSettings()).defaultModel).toBe("claude-opus-5-5");
		await expect(client.getState()).rejects.toThrow(/utility runtime has no session/);
		expect(failures.messages).toHaveLength(1);
	});
});

/** Every `<img>` that shows a committed screenshot: its shot name and alt text. */
function screenshotImages(markdown: string): Array<{ src: string; name: string; alt: string | undefined }> {
	return [...markdown.matchAll(/<img\b[^>]*>/g)].flatMap(([tag]) => {
		const src = /\bsrc="([^"]+)"/.exec(tag)?.[1];
		const name = src ? /docs\/screenshots\/([a-z0-9-]+)\.png$/.exec(src)?.[1] : undefined;
		if (!src || !name) return [];
		return [{ src, name, alt: /\balt="([^"]*)"/.exec(tag)?.[1] }];
	});
}

describe("committed screenshots and READMEs", () => {
	it("commit exactly one correctly sized image per shot", async () => {
		const committed = (await readdir(SCREENSHOT_DIR)).filter((file) => file.endsWith(".png")).sort();
		expect(committed).toEqual(SHOTS.map((shot) => `${shot.name}.png`).sort());
		for (const shot of SHOTS) {
			expect(await pngSize(join(SCREENSHOT_DIR, `${shot.name}.png`))).toEqual(expectedPixels(shot.name));
		}
	});

	it("reference every shot from the root README via relative paths, with no placeholders left", async () => {
		const readme = await readFile(join(REPO_ROOT, "README.md"), "utf8");
		expect(readme).not.toContain("<!-- screenshot:");
		const referenced = new Set(
			[...readme.matchAll(/packages\/dashboard\/docs\/screenshots\/([a-z0-9-]+)\.png/g)].map((match) => match[1]),
		);
		expect([...referenced].sort()).toEqual(SHOTS.map((shot) => shot.name).sort());
	});

	it("reference shots from the dashboard README via absolute URLs that render on npm", async () => {
		const readme = await readFile(join(DASHBOARD_ROOT, "README.md"), "utf8");
		const all = [...readme.matchAll(/([^\s("']*)docs\/screenshots\/([a-z0-9-]+)\.png/g)];
		expect(all.length).toBeGreaterThan(0);
		for (const [, prefix, name] of all) {
			expect(`${prefix}docs/screenshots/`).toBe(RAW_SCREENSHOT_BASE);
			expect(SHOTS.map((shot) => shot.name)).toContain(name);
		}
	});

	it("use each shot's alt text wherever its image appears", async () => {
		for (const path of [join(REPO_ROOT, "README.md"), join(DASHBOARD_ROOT, "README.md")]) {
			const images = screenshotImages(await readFile(path, "utf8"));
			expect(images.length).toBeGreaterThan(0);
			for (const image of images) {
				expect(image.alt, `${path}: ${image.src}`).toBe(SHOTS.find((shot) => shot.name === image.name)?.alt);
			}
		}
	});
});

describe("screenshot harness (offline smoke)", () => {
	let clientDir: string;
	let firstRun: string;

	beforeAll(async () => {
		clientDir = await tempDir("dreb-screenshot-client-");
		await buildDashboardClient(clientDir);
	}, 120_000);

	it("renders every shot from fixtures without host data, errors, or stray requests", async () => {
		const homeBefore = process.env.HOME;
		const agentDirBefore = process.env.DREB_CODING_AGENT_DIR;
		firstRun = await tempDir("dreb-screenshot-smoke-");
		const results = await runScreenshotHarness({ outDir: firstRun, shots: SHOTS, fonts: "stub", clientDir });
		expect(results.map((result) => result.shot.name)).toEqual(SHOTS.map((shot) => shot.name));
		for (const result of results) {
			expect(await pngSize(result.path)).toEqual(expectedPixels(result.shot.name));
		}
		expect(process.env.HOME).toBe(homeBefore);
		expect(process.env.DREB_CODING_AGENT_DIR).toBe(agentDirBefore);
	}, 180_000);

	it("produces byte-identical images on a second run", async () => {
		const secondRun = await tempDir("dreb-screenshot-repeat-");
		await runScreenshotHarness({ outDir: secondRun, shots: SHOTS, fonts: "stub", clientDir });
		for (const shot of SHOTS) {
			const [first, second] = await Promise.all([
				readFile(join(firstRun, `${shot.name}.png`)),
				readFile(join(secondRun, `${shot.name}.png`)),
			]);
			expect(second.equals(first), `${shot.name}.png differs between runs`).toBe(true);
		}
	}, 180_000);

	it("refuses to write a screenshot whose rendered DOM matches a leak needle", async () => {
		const outDir = await tempDir("dreb-screenshot-leak-");
		await expect(
			runScreenshotHarness({
				outDir,
				shots: selectShots(["fleet-desktop-dark"]),
				fonts: "stub",
				clientDir,
				extraLeakNeedles: [{ label: "test needle", value: "Offline cache for station data" }],
			}),
		).rejects.toThrow(/would publish host data:\n- test needle/);
		expect(await readdir(outDir)).toEqual([]);
	}, 120_000);

	it("refuses to write a screenshot whose form-control value matches a leak needle", async () => {
		const outDir = await tempDir("dreb-screenshot-leak-value-");
		const needle = "/home/alice/private-project";
		const [fleet] = selectShots(["fleet-desktop-dark"]);
		await expect(
			runScreenshotHarness({
				outDir,
				shots: [
					{
						...fleet,
						// Only the live `value` property changes: it is painted, but it is neither
						// text content nor an attribute, and no input event lets the app echo it.
						prepare: async (page) => {
							await page
								.locator("input")
								.first()
								.evaluate((input, value) => {
									(input as unknown as { value: string }).value = value;
								}, needle);
						},
					},
				],
				fonts: "stub",
				clientDir,
				extraLeakNeedles: [{ label: "test needle", value: needle }],
			}),
		).rejects.toThrow(/would publish host data:\n- test needle/);
		expect(await readdir(outDir)).toEqual([]);
	}, 120_000);

	describe("network font check", () => {
		const FONT_FACE_CSS = `@font-face { font-family: "IBM Plex Mono"; src: url(https://fonts.gstatic.com/fixture/plex-mono.woff2) format("woff2"); }`;
		const stylesheet = (body: string) => (route: Route) =>
			route.fulfill({ status: 200, contentType: "text/css", body });
		const runNetworkShot = (outDir: string, googleFontsRoute: (route: Route) => Promise<void>) =>
			runScreenshotHarness({
				outDir,
				shots: selectShots(["fleet-desktop-dark"]),
				fonts: "network",
				clientDir,
				googleFontsRoute,
			});

		it.each<[string, (route: Route) => Promise<void>]>([
			["is unreachable", (route) => route.abort("internetdisconnected")],
			["serves a stylesheet without the face", stylesheet("/* filtered */")],
			[
				"serves the stylesheet but not the font file",
				(route) =>
					new URL(route.request().url()).origin === "https://fonts.googleapis.com"
						? stylesheet(FONT_FACE_CSS)(route)
						: route.fulfill({ status: 404, body: "" }),
			],
		])(
			"fails with a clear message when Google Fonts %s",
			async (_case, googleFontsRoute) => {
				const outDir = await tempDir("dreb-screenshot-font-");
				await expect(runNetworkShot(outDir, googleFontsRoute)).rejects.toThrow(
					/IBM Plex Mono did not load from Google Fonts/,
				);
				expect(await readdir(outDir)).toEqual([]);
			},
			120_000,
		);

		it("captures once the face actually loads", async () => {
			const fontBytes = await readFile(join(DASHBOARD_ROOT, "src/client/assets/fonts/jetbrains-mono.woff2"));
			const outDir = await tempDir("dreb-screenshot-font-");
			const [result] = await runNetworkShot(outDir, (route) =>
				new URL(route.request().url()).origin === "https://fonts.googleapis.com"
					? stylesheet(FONT_FACE_CSS)(route)
					: route.fulfill({ status: 200, contentType: "font/woff2", body: fontBytes }),
			);
			expect(result.path).toBe(join(outDir, "fleet-desktop-dark.png"));
			expect(await pngSize(result.path)).toEqual(expectedPixels("fleet-desktop-dark"));
		}, 120_000);
	});

	it("rejects an empty shot list", async () => {
		await expect(runScreenshotHarness({ outDir: firstRun, shots: [], fonts: "stub" })).rejects.toBeInstanceOf(
			ScreenshotHarnessError,
		);
	});
});
