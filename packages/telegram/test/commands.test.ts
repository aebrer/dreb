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
