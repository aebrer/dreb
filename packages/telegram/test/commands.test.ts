import { join } from "node:path";
import type { RpcPerformanceStats } from "@dreb/coding-agent/rpc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { UserState } from "../src/types.js";

// Mock telegram utilities (cmdNew uses safeSend)
const { mockSafeSend } = vi.hoisted(() => ({
	mockSafeSend: vi.fn().mockResolvedValue(1),
}));

vi.mock("../src/util/telegram.js", () => ({
	safeSend: mockSafeSend,
	log: vi.fn(),
}));

// Mock fs operations for path validation
vi.mock("node:fs", () => ({
	statSync: vi.fn(),
}));

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return {
		...actual,
		homedir: vi.fn(() => "/home/testuser"),
	};
});

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { cmdStats, cmdThinking } from "../src/commands/agent.js";
// Import after mock setup
import { cmdNew } from "../src/commands/core.js";

function createConfig(overrides?: Partial<Config>): Config {
	return {
		botToken: "test-token",
		allowedUserIds: [],
		workingDir: "/default/dir",
		drebPath: "/usr/bin/dreb",
		serviceName: "dreb-telegram",
		...overrides,
	};
}

function createUserState(overrides?: Partial<UserState>): UserState {
	return {
		bridge: null,
		config: createConfig(),
		promptInFlight: false,
		newSessionFlag: false,
		newSessionCwd: null,
		effectiveCwd: null,
		backgroundAgents: new Map(),
		stopRequested: false,
		buddyController: null,
		outbox: [],
		...overrides,
	};
}

function createMockContext() {
	return {
		reply: vi.fn().mockResolvedValue({}),
		api: {
			sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
		},
		chat: { id: 100 },
		from: { id: 42 },
	} as any;
}

describe("cmdNew", () => {
	let ctx: ReturnType<typeof createMockContext>;

	beforeEach(() => {
		ctx = createMockContext();
		vi.clearAllMocks();
		vi.mocked(statSync).mockReset();
	});

	describe("with path argument", () => {
		it("sets flag and resolved CWD, replies with path", async () => {
			vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);

			const userState = createUserState();
			await cmdNew(ctx, userState, "/some/path");

			expect(userState.newSessionFlag).toBe(true);
			expect(userState.newSessionCwd).toBe("/some/path");
			expect(mockSafeSend).toHaveBeenCalledWith(
				ctx.api,
				100,
				"🆕 Next message will start a fresh session in `/some/path`",
			);
		});

		it("preserves state when success confirmation cannot be delivered", async () => {
			vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);
			mockSafeSend.mockResolvedValueOnce(0);

			const userState = createUserState({ newSessionFlag: true, newSessionCwd: "/previous/path" });
			await cmdNew(ctx, userState, "/some/path");

			expect(userState.newSessionFlag).toBe(true);
			expect(userState.newSessionCwd).toBe("/previous/path");
			expect(mockSafeSend).toHaveBeenCalledWith(
				ctx.api,
				100,
				"🆕 Next message will start a fresh session in `/some/path`",
			);
		});

		it("rejects nonexistent path without setting flag", async () => {
			vi.mocked(statSync).mockReturnValue(undefined as any);

			const userState = createUserState();
			await cmdNew(ctx, userState, "/nonexistent");

			expect(userState.newSessionFlag).toBe(false);
			expect(userState.newSessionCwd).toBeNull();
			expect(mockSafeSend).toHaveBeenCalledWith(expect.anything(), 100, expect.stringContaining("not found"));
		});

		it("reports statSync errors without setting flag", async () => {
			vi.mocked(statSync).mockImplementation(() => {
				throw new Error("EACCES: permission denied");
			});

			const userState = createUserState();
			await cmdNew(ctx, userState, "/forbidden");

			expect(userState.newSessionFlag).toBe(false);
			expect(userState.newSessionCwd).toBeNull();
			const sent = mockSafeSend.mock.calls[0][2] as string;
			expect(sent).toContain("Cannot access directory");
			expect(sent).toContain("EACCES");
		});

		it("rejects file path (not a directory) from shorthand without setting flag", async () => {
			vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as any);

			const expectedPath = join(homedir(), "projects", "file.txt");
			const userState = createUserState();
			await cmdNew(ctx, userState, "projects file.txt");

			expect(userState.newSessionFlag).toBe(false);
			expect(userState.newSessionCwd).toBeNull();
			const sent = mockSafeSend.mock.calls[0][2] as string;
			expect(sent).toContain("Not a directory");
			expect(sent).toContain(expectedPath);
		});

		it("rejects file path (not a directory) without setting flag", async () => {
			vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as any);

			const userState = createUserState();
			await cmdNew(ctx, userState, "/some/file.txt");

			expect(userState.newSessionFlag).toBe(false);
			expect(userState.newSessionCwd).toBeNull();
			expect(mockSafeSend).toHaveBeenCalledWith(expect.anything(), 100, expect.stringContaining("Not a directory"));
		});

		it("expands ~ to home directory", async () => {
			vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);

			const userState = createUserState();
			await cmdNew(ctx, userState, "~/projects");

			expect(userState.newSessionFlag).toBe(true);
			expect(userState.newSessionCwd).toBe("/home/testuser/projects");
		});

		it("expands mobile shorthand tokens to a home-relative path", async () => {
			vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);

			const expectedPath = join(homedir(), "projects", "dreb");
			const userState = createUserState();
			await cmdNew(ctx, userState, "projects dreb");

			expect(userState.newSessionFlag).toBe(true);
			expect(userState.newSessionCwd).toBe(expectedPath);
			expect(mockSafeSend).toHaveBeenCalledWith(
				ctx.api,
				100,
				`🆕 Next message will start a fresh session in \`${expectedPath}\``,
			);
		});

		it("respects quoted spans in shorthand", async () => {
			vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);

			const expectedPath = join(homedir(), "My Projects", "dreb");
			const userState = createUserState();
			await cmdNew(ctx, userState, '"My Projects" dreb');

			expect(userState.newSessionFlag).toBe(true);
			expect(userState.newSessionCwd).toBe(expectedPath);
			expect(mockSafeSend).toHaveBeenCalledWith(
				ctx.api,
				100,
				`🆕 Next message will start a fresh session in \`${expectedPath}\``,
			);
		});

		it("reports invalid shorthand without setting flag", async () => {
			const userState = createUserState();
			await cmdNew(ctx, userState, "..");

			expect(userState.newSessionFlag).toBe(false);
			expect(userState.newSessionCwd).toBeNull();
			expect(statSync).not.toHaveBeenCalled();
			expect(mockSafeSend).toHaveBeenCalledWith(
				expect.anything(),
				100,
				expect.stringContaining("Invalid /new shorthand"),
			);
		});

		it("reports the resolved candidate when shorthand path does not exist", async () => {
			vi.mocked(statSync).mockReturnValue(undefined as any);

			const userState = createUserState();
			await cmdNew(ctx, userState, "projects missing");

			expect(userState.newSessionFlag).toBe(false);
			expect(userState.newSessionCwd).toBeNull();
			const sent = mockSafeSend.mock.calls[0][2] as string;
			expect(sent).toContain("not found");
			expect(sent).toContain("projects/missing");
		});

		it("reports the resolved candidate when quoted shorthand path does not exist", async () => {
			vi.mocked(statSync).mockReturnValue(undefined as any);

			const expectedPath = join(homedir(), "My Projects", "missing");
			const userState = createUserState();
			await cmdNew(ctx, userState, '"My Projects" missing');

			expect(userState.newSessionFlag).toBe(false);
			expect(userState.newSessionCwd).toBeNull();
			const sent = mockSafeSend.mock.calls[0][2] as string;
			expect(sent).toContain("not found");
			expect(sent).toContain(expectedPath);
		});
	});

	describe("bare /new (no path argument)", () => {
		it("resolves to effectiveCwd when set", async () => {
			const userState = createUserState({ effectiveCwd: "/current/project" });
			await cmdNew(ctx, userState, "");

			expect(userState.newSessionFlag).toBe(true);
			expect(userState.newSessionCwd).toBe("/current/project");
			expect(mockSafeSend).toHaveBeenCalledWith(
				ctx.api,
				100,
				"🆕 Next message will start a fresh session in `/current/project`",
			);
		});

		it("falls back to config.workingDir when effectiveCwd is null", async () => {
			const userState = createUserState({ effectiveCwd: null });
			await cmdNew(ctx, userState, "");

			expect(userState.newSessionFlag).toBe(true);
			expect(userState.newSessionCwd).toBe("/default/dir");
			expect(mockSafeSend).toHaveBeenCalledWith(
				ctx.api,
				100,
				"🆕 Next message will start a fresh session in `/default/dir`",
			);
		});

		it("preserves state when success confirmation cannot be delivered", async () => {
			mockSafeSend.mockResolvedValueOnce(0);

			const userState = createUserState({
				effectiveCwd: "/current/project",
				newSessionFlag: true,
				newSessionCwd: "/previous/path",
			});
			await cmdNew(ctx, userState, "");

			expect(userState.newSessionFlag).toBe(true);
			expect(userState.newSessionCwd).toBe("/previous/path");
			expect(mockSafeSend).toHaveBeenCalledWith(
				ctx.api,
				100,
				"🆕 Next message will start a fresh session in `/current/project`",
			);
		});

		it("never sets newSessionCwd to null", async () => {
			const userState = createUserState({ effectiveCwd: null });
			await cmdNew(ctx, userState, "");

			expect(userState.newSessionCwd).not.toBeNull();
		});

		it("always shows the directory in the reply", async () => {
			const userState = createUserState({ effectiveCwd: "/my/project" });
			await cmdNew(ctx, userState, "");

			const reply = mockSafeSend.mock.calls[0][2] as string;
			expect(reply).toContain("/my/project");
			// Should NOT be the generic "fresh session" message without a path
			expect(reply).not.toBe("🆕 Next message will start a fresh session.");
		});
	});
});

describe("cmdStats", () => {
	let ctx: ReturnType<typeof createMockContext>;

	beforeEach(() => {
		ctx = createMockContext();
		vi.clearAllMocks();
	});

	function createMockBridge(overrides?: {
		stats?: Partial<{
			userMessages: number;
			assistantMessages: number;
			toolCalls: number;
			tokens: { total: number; input: number; output: number; cacheRead?: number };
			cost: number;
			contextUsage: { percent: number; tokens: number; contextWindow: number };
		}>;
		perf?: RpcPerformanceStats | null;
	}) {
		return {
			isAlive: true,
			getSessionStats: vi.fn().mockResolvedValue(
				overrides?.stats ?? {
					userMessages: 2,
					assistantMessages: 3,
					toolCalls: 1,
					tokens: { total: 5000, input: 3000, output: 2000 },
					cost: 0.05,
					contextUsage: { percent: 10, tokens: 5000, contextWindow: 50000 },
				},
			),
			getPerformanceStats: vi.fn().mockResolvedValue(
				overrides?.perf ?? {
					models: [
						{
							provider: "anthropic",
							modelId: "claude-3-sonnet",
							rolling: { median: 30.5, mean: 32, count: 100 },
							delta: {
								baselineMedian: 25,
								recentMedian: 30,
								percentDelta: 20,
								direction: "above" as const,
								baselineCount: 10000,
								recentCount: 10,
							},
						},
					],
				},
			),
		} as any;
	}

	it("includes performance section when stats are available", async () => {
		const userState = createUserState({ bridge: createMockBridge() });
		await cmdStats(ctx, userState);

		const sentMessage = mockSafeSend.mock.calls[0][2] as string;
		expect(sentMessage).toContain("⚡ *Performance:*");
		expect(sentMessage).toContain("anthropic/claude-3-sonnet: ~31 tok/s [100] · 20% ↑ median [10000]");
		expect(sentMessage).not.toContain("last 24h");
	});

	it.each([
		{
			name: "below trend",
			delta: { direction: "below" as const, percentDelta: -19.6, recentCount: 10, baselineCount: 10000 },
			expected: "  anthropic/claude-3-sonnet: ~31 tok/s [100] · 20% ↓ median [10000]",
		},
		{
			name: "stable trend",
			delta: { direction: "stable" as const, percentDelta: 0.8, recentCount: 10, baselineCount: 10000 },
			expected: "  anthropic/claude-3-sonnet: ~31 tok/s [100] · 0% → median [10000]",
		},
		{
			name: "insufficient recent samples",
			delta: { direction: "above" as const, percentDelta: 20, recentCount: 2, baselineCount: 10000 },
			expected: "  anthropic/claude-3-sonnet: ~31 tok/s [100]",
		},
		{
			name: "insufficient baseline samples",
			delta: { direction: "above" as const, percentDelta: 20, recentCount: 10, baselineCount: 2 },
			expected: "  anthropic/claude-3-sonnet: ~31 tok/s [100]",
		},
	])("formats $name with TUI semantics", async ({ delta, expected }) => {
		const bridge = createMockBridge();
		const perf = await bridge.getPerformanceStats();
		Object.assign(perf.models[0].delta, delta);
		const userState = createUserState({ bridge });

		await cmdStats(ctx, userState);

		const sentMessage = mockSafeSend.mock.calls[0][2] as string;
		const modelLine = sentMessage.split("\n").find((line) => line.includes("anthropic/claude-3-sonnet"));
		expect(modelLine).toBe(expected);
	});

	it("omits performance section when models array is empty", async () => {
		const userState = createUserState({ bridge: createMockBridge({ perf: { models: [] } }) });
		await cmdStats(ctx, userState);

		const sentMessage = mockSafeSend.mock.calls[0][2] as string;
		expect(sentMessage).not.toContain("⚡ *Performance:*");
	});

	it("omits models with fewer than three rolling samples", async () => {
		const bridge = createMockBridge();
		const perf = await bridge.getPerformanceStats();
		perf.models[0].rolling.count = 2;
		const userState = createUserState({ bridge });
		await cmdStats(ctx, userState);

		const sentMessage = mockSafeSend.mock.calls[0][2] as string;
		expect(sentMessage).not.toContain("⚡ *Performance:*");
	});

	it("omits performance section when getPerformanceStats throws", async () => {
		const bridge = createMockBridge();
		bridge.getPerformanceStats = vi.fn().mockRejectedValue(new Error("RPC failed"));
		const userState = createUserState({ bridge });
		await cmdStats(ctx, userState);

		const sentMessage = mockSafeSend.mock.calls[0][2] as string;
		expect(sentMessage).not.toContain("⚡ *Performance:*");
		expect(sentMessage).toContain("Session Stats");
	});

	it("replies with 'No active session' when bridge is null", async () => {
		const userState = createUserState({ bridge: null });
		await cmdStats(ctx, userState);

		expect(mockSafeSend).toHaveBeenCalledWith(expect.anything(), 100, "No active session.");
	});

	it("replies with 'No stats available' when getSessionStats returns null", async () => {
		const bridge = createMockBridge();
		bridge.getSessionStats = vi.fn().mockResolvedValue(null);
		const userState = createUserState({ bridge });
		await cmdStats(ctx, userState);

		expect(mockSafeSend).toHaveBeenCalledWith(expect.anything(), 100, "No stats available.");
	});

	it("replies with error message when getSessionStats throws", async () => {
		const bridge = createMockBridge();
		bridge.getSessionStats = vi.fn().mockRejectedValue(new Error("RPC timeout"));
		const userState = createUserState({ bridge });
		await cmdStats(ctx, userState);

		expect(mockSafeSend).toHaveBeenCalledWith(expect.anything(), 100, expect.stringContaining("Failed to get stats"));
		expect(mockSafeSend).toHaveBeenCalledWith(expect.anything(), 100, expect.stringContaining("RPC timeout"));
	});
});

describe("cmdThinking", () => {
	beforeEach(() => vi.clearAllMocks());

	it.each(["xhigh", "max"])("accepts %s", async (level) => {
		const bridge = { isAlive: true, setThinkingLevel: vi.fn().mockResolvedValue(undefined) } as any;
		await cmdThinking(createMockContext(), createUserState({ bridge }), level);
		expect(bridge.setThinkingLevel).toHaveBeenCalledWith(level);
	});

	it("lists the complete scale for invalid input", async () => {
		const bridge = { isAlive: true, setThinkingLevel: vi.fn() } as any;
		await cmdThinking(createMockContext(), createUserState({ bridge }), "ultra");
		expect(mockSafeSend).toHaveBeenCalledWith(
			expect.anything(),
			100,
			"Invalid level. Options: off, minimal, low, medium, high, xhigh, max",
		);
	});
});
