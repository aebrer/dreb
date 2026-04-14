import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { UserState } from "../src/types.js";

const { mockSafeSend } = vi.hoisted(() => ({
	mockSafeSend: vi.fn().mockResolvedValue(1),
}));

vi.mock("../src/util/telegram.js", () => ({
	safeSend: mockSafeSend,
	log: vi.fn(),
}));

import { cmdSessionAnalysis } from "../src/commands/agent.js";

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

describe("cmdSessionAnalysis", () => {
	let ctx: ReturnType<typeof createMockContext>;

	beforeEach(() => {
		ctx = createMockContext();
		vi.clearAllMocks();
	});

	it("sends 'No active session' when bridge is null", async () => {
		const userState = createUserState({ bridge: null });
		await cmdSessionAnalysis(ctx, userState);

		expect(mockSafeSend).toHaveBeenCalledWith(expect.anything(), 100, "No active session.");
	});

	it("sends 'No active session' when bridge is not alive", async () => {
		const mockBridge = { isAlive: false } as any;
		const userState = createUserState({ bridge: mockBridge });
		await cmdSessionAnalysis(ctx, userState);

		expect(mockSafeSend).toHaveBeenCalledWith(expect.anything(), 100, "No active session.");
	});

	it("sends 'No analysis available' when bridge returns null", async () => {
		const mockBridge = {
			isAlive: true,
			getSessionAnalysis: vi.fn().mockResolvedValue(null),
		} as any;
		const userState = createUserState({ bridge: mockBridge });
		await cmdSessionAnalysis(ctx, userState);

		// First call is the "Analyzing..." message, second is the result
		expect(mockSafeSend).toHaveBeenCalledWith(expect.anything(), 100, expect.stringContaining("Analyzing"));
		expect(mockSafeSend).toHaveBeenCalledWith(expect.anything(), 100, "No analysis available.");
	});

	it("formats and sends analysis data when available", async () => {
		const mockAnalysis = {
			current: {
				sessionId: "test-123",
				model: "claude-sonnet-4-20250514",
				provider: "anthropic",
				totalToolCalls: 42,
				totalCost: 0.15,
				totalTokens: 20000,
				readEditRatio: 3.5,
				writeVsEditPercent: 15,
				errorRate: 2.4,
				selfCorrectionPer1K: 1.2,
				toolDistribution: { read: 20, edit: 10, bash: 8, grep: 4 },
				timeline: [],
			},
			timeline: null,
			groups: null,
			comparison: null,
			trend: null,
		};

		const mockBridge = {
			isAlive: true,
			getSessionAnalysis: vi.fn().mockResolvedValue(mockAnalysis),
		} as any;
		const userState = createUserState({ bridge: mockBridge });
		await cmdSessionAnalysis(ctx, userState);

		// Should have sent the analyzing message + the result
		expect(mockSafeSend).toHaveBeenCalledTimes(2);

		// The result message should contain key metrics
		const resultCall = mockSafeSend.mock.calls[1];
		const message = resultCall[2] as string;
		expect(message).toContain("Session Analysis");
		expect(message).toContain("3.5"); // readEditRatio
		expect(message).toContain("15%"); // writeVsEditPercent
		expect(message).toContain("2.4%"); // errorRate
		expect(message).toContain("Tool Distribution");
		expect(message).toContain("noisy proxies");
	});

	it("handles bridge error gracefully", async () => {
		const mockBridge = {
			isAlive: true,
			getSessionAnalysis: vi.fn().mockRejectedValue(new Error("connection lost")),
		} as any;
		const userState = createUserState({ bridge: mockBridge });
		await cmdSessionAnalysis(ctx, userState);

		expect(mockSafeSend).toHaveBeenCalledWith(
			expect.anything(),
			100,
			expect.stringContaining("Failed to get analysis"),
		);
	});
});
