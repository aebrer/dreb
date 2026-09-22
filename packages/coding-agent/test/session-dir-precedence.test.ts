import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getSubagentSessionsDir, resolveConfiguredDirectory } from "../src/config.js";

const mocks = vi.hoisted(() => ({
	state: {
		hookSessionDir: undefined as string | undefined,
		capturedSessionDir: undefined as string | undefined,
		capturedInventoryRoot: undefined as string | undefined,
	},
	createAgentSession: vi.fn(
		async (options: {
			sessionManager?: { getSessionDir(): string; getCustomSessionInventoryRoot(): string | undefined };
		}) => {
			mocks.state.capturedSessionDir = options.sessionManager?.getSessionDir();
			mocks.state.capturedInventoryRoot = options.sessionManager?.getCustomSessionInventoryRoot();
			return {
				session: {
					model: { id: "test-model", provider: "test", reasoning: false },
					thinkingLevel: "off",
					setThinkingLevel: vi.fn(),
				},
				modelFallbackMessage: undefined,
			};
		},
	),
	runPrintMode: vi.fn(async () => 0),
	selectSession: vi.fn(),
}));

vi.mock("../src/core/sdk.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		createAgentSession: mocks.createAgentSession,
	};
});

vi.mock("../src/modes/index.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		runPrintMode: mocks.runPrintMode,
	};
});

vi.mock("../src/cli/session-picker.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		selectSession: mocks.selectSession,
	};
});

vi.mock("../src/core/resource-loader.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		DefaultResourceLoader: class {
			async reload(): Promise<void> {}

			getExtensions() {
				const handlers = new Map();
				if (mocks.state.hookSessionDir) {
					handlers.set("session_directory", [async () => ({ sessionDir: mocks.state.hookSessionDir })]);
				}
				return {
					extensions: [{ path: "/mock-extension.ts", handlers, flags: new Map() }],
					errors: [],
					runtime: {
						pendingProviderRegistrations: [],
						flagValues: new Map(),
					},
				};
			}
		},
	};
});

describe("resolveConfiguredDirectory", () => {
	it("preserves absolute paths", () => {
		const absolute = join(tmpdir(), "absolute-sessions");
		expect(resolveConfiguredDirectory(absolute, "/unused/base")).toBe(absolute);
	});

	it("expands tilde paths from the home directory", () => {
		expect(resolveConfiguredDirectory("~/session-logs", "/unused/base")).toBe(join(homedir(), "session-logs"));
		expect(resolveConfiguredDirectory("~//session-logs", "/unused/base")).toBe(join(homedir(), "session-logs"));
		expect(resolveConfiguredDirectory("~\\session-logs", "/unused/base")).toBe(join(homedir(), "session-logs"));
		expect(resolveConfiguredDirectory("~", "/unused/base")).toBe(homedir());
	});

	it("resolves relative paths against the explicit base and treats whitespace as unset", () => {
		const base = join(tmpdir(), "runtime-cwd");
		expect(resolveConfiguredDirectory("./session-logs", base)).toBe(resolve(base, "session-logs"));
		expect(getSubagentSessionsDir("./child-logs", base)).toBe(resolve(base, "child-logs"));
		expect(resolveConfiguredDirectory("   ", base)).toBeUndefined();
	});
});

describe("sessionDir precedence", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let originalCwd: string;
	let runtimeCwd: string;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let originalIsTTY: boolean | undefined;

	beforeEach(() => {
		vi.resetModules();
		mocks.state.hookSessionDir = "./hook-sessions";
		mocks.state.capturedSessionDir = undefined;
		mocks.state.capturedInventoryRoot = undefined;
		mocks.createAgentSession.mockClear();
		mocks.runPrintMode.mockClear();
		mocks.selectSession.mockReset();

		tempDir = join(tmpdir(), `dreb-session-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".dreb"), { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalExitCode = process.exitCode;
		originalIsTTY = process.stdin.isTTY;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
		runtimeCwd = process.cwd();
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("prefers settings sessionDir over the session_directory hook for new sessions", async () => {
		writeFileSync(join(projectDir, ".dreb", "settings.json"), JSON.stringify({ sessionDir: "./settings-sessions" }));

		const { main } = await import("../src/main.js");
		await main(["--print", "test prompt"]);

		expect(mocks.state.capturedSessionDir).toBe(join(runtimeCwd, "settings-sessions"));
		expect(mocks.runPrintMode).toHaveBeenCalledOnce();
	}, 15_000);

	it("resolves a relative extension hook directory against the runtime cwd", async () => {
		const { main } = await import("../src/main.js");
		await main(["--print", "test prompt"]);

		expect(mocks.state.capturedSessionDir).toBe(join(runtimeCwd, "hook-sessions"));
		expect(mocks.runPrintMode).toHaveBeenCalledOnce();
	}, 15_000);

	it("prefers CLI --session-dir over settings and the session_directory hook", async () => {
		writeFileSync(join(projectDir, ".dreb", "settings.json"), JSON.stringify({ sessionDir: "./settings-sessions" }));

		const { main } = await import("../src/main.js");
		await main(["--print", "--session-dir", "./cli-sessions", "test prompt"]);

		expect(mocks.state.capturedSessionDir).toBe(join(runtimeCwd, "cli-sessions"));
		expect(mocks.runPrintMode).toHaveBeenCalledOnce();
	}, 15_000);

	it("retains the configured inventory root when active-session persistence is disabled", async () => {
		const { main } = await import("../src/main.js");
		await main(["--print", "--no-session", "--session-dir", "./history", "test prompt"]);

		expect(mocks.state.capturedSessionDir).toBe("");
		expect(mocks.state.capturedInventoryRoot).toBe(join(runtimeCwd, "history"));
		expect(mocks.runPrintMode).toHaveBeenCalledOnce();
	}, 15_000);

	it("uses settings sessionDir ahead of the session_directory hook for --resume", async () => {
		writeFileSync(join(projectDir, ".dreb", "settings.json"), JSON.stringify({ sessionDir: "./settings-sessions" }));

		const { SessionManager } = await import("../src/core/session-manager.js");
		const listSpy = vi.spyOn(SessionManager, "list");
		mocks.selectSession.mockImplementation(async (listCurrent: (onProgress: () => void) => Promise<unknown>) => {
			await listCurrent(() => {});
			return join(projectDir, "picked-session.jsonl");
		});

		const { main } = await import("../src/main.js");
		await main(["--print", "--resume"]);

		expect(listSpy).toHaveBeenCalledWith(
			expect.any(String),
			join(runtimeCwd, "settings-sessions"),
			expect.any(Function),
		);
		expect(mocks.state.capturedSessionDir).toBe(join(runtimeCwd, "settings-sessions"));
		expect(mocks.runPrintMode).toHaveBeenCalledOnce();
	}, 15_000);
});
