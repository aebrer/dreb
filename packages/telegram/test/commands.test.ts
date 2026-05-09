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
	existsSync: vi.fn(),
	statSync: vi.fn(),
}));

import { existsSync, statSync } from "node:fs";
import { cmdStats } from "../src/commands/agent.js";
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
	});

	describe("with path argument", () => {
		it("sets flag and resolved CWD, replies with path", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);

			const userState = createUserState();
			await cmdNew(ctx, userState, "/some/path");

			expect(userState.newSessionFlag).toBe(true);
			expect(userState.newSessionCwd).toBe("/some/path");
			expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("/some/path"));
		});

		it("rejects nonexistent path without setting flag", async () => {
			vi.mocked(existsSync).mockReturnValue(false);

			const userState = createUserState();
			await cmdNew(ctx, userState, "/nonexistent");

			expect(userState.newSessionFlag).toBe(false);
			expect(userState.newSessionCwd).toBeNull();
			expect(mockSafeSend).toHaveBeenCalledWith(expect.anything(), 100, expect.stringContaining("not found"));
		});

		it("rejects file path (not a directory) without setting flag", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as any);

			const userState = createUserState();
			await cmdNew(ctx, userState, "/some/file.txt");

			expect(userState.newSessionFlag).toBe(false);
			expect(userState.newSessionCwd).toBeNull();
			expect(mockSafeSend).toHaveBeenCalledWith(expect.anything(), 100, expect.stringContaining("Not a directory"));
		});

		it("expands ~ to home directory", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);

			const userState = createUserState();
			await cmdNew(ctx, userState, "~/projects");

			expect(userState.newSessionFlag).toBe(true);
			// Should not start with ~
			expect(userState.newSessionCwd).not.toMatch(/^~/);
			// Should be an absolute path containing the home dir
			expect(userState.newSessionCwd).toMatch(/^\//);
		});
	});

	describe("bare /new (no path argument)", () => {
		it("resolves to effectiveCwd when set", async () => {
			const userState = createUserState({ effectiveCwd: "/current/project" });
			await cmdNew(ctx, userState, "");

			expect(userState.newSessionFlag).toBe(true);
			expect(userState.newSessionCwd).toBe("/current/project");
			expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("/current/project"));
		});

		it("falls back to config.workingDir when effectiveCwd is null", async () => {
			const userState = createUserState({ effectiveCwd: null });
			await cmdNew(ctx, userState, "");

			expect(userState.newSessionFlag).toBe(true);
			expect(userState.newSessionCwd).toBe("/default/dir");
			expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("/default/dir"));
		});

		it("never sets newSessionCwd to null", async () => {
			const userState = createUserState({ effectiveCwd: null });
			await cmdNew(ctx, userState, "");

			expect(userState.newSessionCwd).not.toBeNull();
		});

		it("always shows the directory in the reply", async () => {
			const userState = createUserState({ effectiveCwd: "/my/project" });
			await cmdNew(ctx, userState, "");

			const reply = ctx.reply.mock.calls[0][0] as string;
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
		perf?: {
			models: Array<{ provider: string; modelId: string; median: number; mean: number; count: number }>;
		} | null;
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
					models: [{ provider: "anthropic", modelId: "claude-3-sonnet", median: 30.5, mean: 32, count: 100 }],
				},
			),
		} as any;
	}

	it("includes performance section when stats are available", async () => {
		const userState = createUserState({ bridge: createMockBridge() });
		await cmdStats(ctx, userState);

		const sentMessage = mockSafeSend.mock.calls[0][2] as string;
		expect(sentMessage).toContain("⚡ *Performance (last 24h):*");
		expect(sentMessage).toContain("anthropic/claude-3-sonnet: ~30.5 tok/s (n=100)");
	});

	it("omits performance section when models array is empty", async () => {
		const userState = createUserState({ bridge: createMockBridge({ perf: { models: [] } }) });
		await cmdStats(ctx, userState);

		const sentMessage = mockSafeSend.mock.calls[0][2] as string;
		expect(sentMessage).not.toContain("⚡ *Performance (last 24h):*");
	});

	it("omits performance section when getPerformanceStats throws", async () => {
		const bridge = createMockBridge();
		bridge.getPerformanceStats = vi.fn().mockRejectedValue(new Error("RPC failed"));
		const userState = createUserState({ bridge });
		await cmdStats(ctx, userState);

		const sentMessage = mockSafeSend.mock.calls[0][2] as string;
		expect(sentMessage).not.toContain("⚡ *Performance (last 24h):*");
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
