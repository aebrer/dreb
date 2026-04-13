import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { UserState } from "../src/types.js";

// Use vi.hoisted so the mock factory can reference it after hoisting
const { MockAgentBridge } = vi.hoisted(() => ({
	MockAgentBridge: vi.fn(),
}));

vi.mock("../src/agent-bridge.js", () => ({
	AgentBridge: MockAgentBridge,
}));

// Import after mock setup
import { ensureBridge, ensureBridgeWithSession } from "../src/bridge-lifecycle.js";

function createMockBridge(opts?: { isAlive?: boolean; sessionId?: string | undefined }) {
	return {
		isAlive: opts?.isAlive ?? true,
		sessionId: opts?.sessionId ?? undefined,
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		newSession: vi.fn().mockResolvedValue(true),
		resumeLatest: vi.fn().mockResolvedValue(true),
		onEvent: vi.fn(),
		_config: undefined as Config | undefined,
	};
}

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

describe("ensureBridge", () => {
	let config: Config;

	beforeEach(() => {
		config = createConfig();
		vi.clearAllMocks();
	});

	it("creates a new bridge when none exists, using config.workingDir", async () => {
		const userState = createUserState();
		const mockBridge = createMockBridge();
		MockAgentBridge.mockImplementation((cfg: Config) => {
			mockBridge._config = cfg;
			return mockBridge;
		});

		const result = await ensureBridge(config, userState);

		expect(result).toBe(mockBridge);
		expect(userState.bridge).toBe(mockBridge);
		expect(MockAgentBridge).toHaveBeenCalledOnce();
		expect(MockAgentBridge).toHaveBeenCalledWith(config);
		expect(mockBridge.start).toHaveBeenCalledOnce();
	});

	it("creates a new bridge when existing bridge is dead", async () => {
		const deadBridge = createMockBridge({ isAlive: false });
		const userState = createUserState({ bridge: deadBridge as any });
		const freshBridge = createMockBridge();
		MockAgentBridge.mockImplementation((cfg: Config) => {
			freshBridge._config = cfg;
			return freshBridge;
		});

		const result = await ensureBridge(config, userState);

		expect(result).toBe(freshBridge);
		expect(userState.bridge).toBe(freshBridge);
		expect(MockAgentBridge).toHaveBeenCalledOnce();
		expect(freshBridge.start).toHaveBeenCalledOnce();
	});

	it("reuses existing alive bridge", async () => {
		const aliveBridge = createMockBridge({ isAlive: true });
		const userState = createUserState({ bridge: aliveBridge as any });

		const result = await ensureBridge(config, userState);

		expect(result).toBe(aliveBridge);
		expect(MockAgentBridge).not.toHaveBeenCalled();
		expect(aliveBridge.start).not.toHaveBeenCalled();
	});

	it("overrides config.workingDir with effectiveCwd when set and different", async () => {
		const userState = createUserState({ effectiveCwd: "/custom/dir" });
		const mockBridge = createMockBridge();
		MockAgentBridge.mockImplementation((cfg: Config) => {
			mockBridge._config = cfg;
			return mockBridge;
		});

		await ensureBridge(config, userState);

		expect(MockAgentBridge).toHaveBeenCalledWith({ ...config, workingDir: "/custom/dir" });
	});

	it("uses config.workingDir when effectiveCwd matches it", async () => {
		const userState = createUserState({ effectiveCwd: "/default/dir" });
		const mockBridge = createMockBridge();
		MockAgentBridge.mockImplementation((cfg: Config) => {
			mockBridge._config = cfg;
			return mockBridge;
		});

		await ensureBridge(config, userState);

		// Same object — no override needed
		expect(MockAgentBridge).toHaveBeenCalledWith(config);
	});

	it("wires up background_agent_start event handler", async () => {
		const userState = createUserState();
		const mockBridge = createMockBridge();
		MockAgentBridge.mockReturnValue(mockBridge);

		await ensureBridge(config, userState);

		expect(mockBridge.onEvent).toHaveBeenCalledOnce();
		const listener = mockBridge.onEvent.mock.calls[0][0];

		// Simulate background_agent_start
		listener({ type: "background_agent_start", agentId: "agent-1", agentType: "coder", taskSummary: "fix bug" });

		expect(userState.backgroundAgents.has("agent-1")).toBe(true);
		const tracked = userState.backgroundAgents.get("agent-1")!;
		expect(tracked.agentId).toBe("agent-1");
		expect(tracked.agentType).toBe("coder");
		expect(tracked.taskSummary).toBe("fix bug");
		expect(tracked.startTime).toBeGreaterThan(0);
	});

	it("wires up background_agent_end event handler", async () => {
		const userState = createUserState();
		const mockBridge = createMockBridge();
		MockAgentBridge.mockReturnValue(mockBridge);

		await ensureBridge(config, userState);

		const listener = mockBridge.onEvent.mock.calls[0][0];

		// Start then end an agent
		listener({ type: "background_agent_start", agentId: "agent-1", agentType: "coder", taskSummary: "fix bug" });
		expect(userState.backgroundAgents.has("agent-1")).toBe(true);

		listener({ type: "background_agent_end", agentId: "agent-1" });
		expect(userState.backgroundAgents.has("agent-1")).toBe(false);
	});

	it("ignores unrelated event types", async () => {
		const userState = createUserState();
		const mockBridge = createMockBridge();
		MockAgentBridge.mockReturnValue(mockBridge);

		await ensureBridge(config, userState);

		const listener = mockBridge.onEvent.mock.calls[0][0];

		listener({ type: "some_other_event" });
		expect(userState.backgroundAgents.size).toBe(0);
	});
});

describe("ensureBridgeWithSession", () => {
	let config: Config;

	beforeEach(() => {
		config = createConfig();
		vi.clearAllMocks();
	});

	describe("/new with custom path", () => {
		it("kills existing bridge, creates new one with custom path, calls newSession()", async () => {
			const existingBridge = createMockBridge({ isAlive: true });
			const newBridge = createMockBridge();
			const userState = createUserState({
				bridge: existingBridge as any,
				newSessionFlag: true,
				newSessionCwd: "/custom/path",
				effectiveCwd: "/old/dir",
			});

			MockAgentBridge.mockImplementation((cfg: Config) => {
				newBridge._config = cfg;
				return newBridge;
			});

			const result = await ensureBridgeWithSession(config, userState);

			expect(result).toBe(newBridge);
			expect(existingBridge.stop).toHaveBeenCalledOnce();
			expect(userState.bridge).toBe(newBridge);
			expect(userState.effectiveCwd).toBe("/custom/path");
			expect(MockAgentBridge).toHaveBeenCalledWith({ ...config, workingDir: "/custom/path" });
			expect(newBridge.newSession).toHaveBeenCalledOnce();
			// Flags cleared
			expect(userState.newSessionFlag).toBe(false);
			expect(userState.newSessionCwd).toBeNull();
		});
	});

	describe("bare /new after prior session", () => {
		it("kills bridge, creates new one with effectiveCwd, calls newSession()", async () => {
			const existingBridge = createMockBridge({ isAlive: true });
			const newBridge = createMockBridge();
			// cmdNew now eagerly resolves: newSessionCwd = effectiveCwd ?? config.workingDir
			const userState = createUserState({
				bridge: existingBridge as any,
				newSessionFlag: true,
				newSessionCwd: "/prev/dir",
				effectiveCwd: "/prev/dir",
			});

			MockAgentBridge.mockImplementation((cfg: Config) => {
				newBridge._config = cfg;
				return newBridge;
			});

			const result = await ensureBridgeWithSession(config, userState);

			expect(result).toBe(newBridge);
			expect(existingBridge.stop).toHaveBeenCalledOnce();
			expect(userState.effectiveCwd).toBe("/prev/dir");
			expect(MockAgentBridge).toHaveBeenCalledWith({ ...config, workingDir: "/prev/dir" });
			expect(newBridge.newSession).toHaveBeenCalledOnce();
			expect(userState.newSessionFlag).toBe(false);
			expect(userState.newSessionCwd).toBeNull();
		});
	});

	describe("bare /new with no prior session", () => {
		it("kills bridge, creates new one with config.workingDir, calls newSession()", async () => {
			const newBridge = createMockBridge();
			// cmdNew now eagerly resolves: newSessionCwd = effectiveCwd ?? config.workingDir
			const userState = createUserState({
				newSessionFlag: true,
				newSessionCwd: "/default/dir",
				effectiveCwd: null,
			});

			MockAgentBridge.mockImplementation((cfg: Config) => {
				newBridge._config = cfg;
				return newBridge;
			});

			const result = await ensureBridgeWithSession(config, userState);

			expect(result).toBe(newBridge);
			expect(userState.effectiveCwd).toBe("/default/dir");
			expect(MockAgentBridge).toHaveBeenCalledWith({ ...config, workingDir: "/default/dir" });
			expect(newBridge.newSession).toHaveBeenCalledOnce();
		});
	});

	describe("no new session flag, no existing bridge", () => {
		it("creates bridge, sets effectiveCwd to config.workingDir, calls resumeLatest()", async () => {
			const mockBridge = createMockBridge({ sessionId: undefined });
			const userState = createUserState();

			MockAgentBridge.mockImplementation((cfg: Config) => {
				mockBridge._config = cfg;
				return mockBridge;
			});

			const result = await ensureBridgeWithSession(config, userState);

			expect(result).toBe(mockBridge);
			expect(userState.effectiveCwd).toBe("/default/dir");
			expect(mockBridge.resumeLatest).toHaveBeenCalledOnce();
			expect(mockBridge.newSession).not.toHaveBeenCalled();
		});
	});

	describe("no new session flag, existing bridge with session", () => {
		it("returns existing bridge, no-op", async () => {
			const existingBridge = createMockBridge({ isAlive: true, sessionId: "session-123" });
			const userState = createUserState({
				bridge: existingBridge as any,
				effectiveCwd: "/some/dir",
			});

			const result = await ensureBridgeWithSession(config, userState);

			expect(result).toBe(existingBridge);
			expect(MockAgentBridge).not.toHaveBeenCalled();
			expect(existingBridge.resumeLatest).not.toHaveBeenCalled();
			expect(existingBridge.newSession).not.toHaveBeenCalled();
		});
	});

	describe("no new session flag, existing bridge without session", () => {
		it("returns existing bridge, calls resumeLatest()", async () => {
			const existingBridge = createMockBridge({ isAlive: true, sessionId: undefined });
			const userState = createUserState({
				bridge: existingBridge as any,
				effectiveCwd: "/some/dir",
			});

			const result = await ensureBridgeWithSession(config, userState);

			expect(result).toBe(existingBridge);
			expect(MockAgentBridge).not.toHaveBeenCalled();
			expect(existingBridge.resumeLatest).toHaveBeenCalledOnce();
			expect(existingBridge.newSession).not.toHaveBeenCalled();
		});
	});

	describe("flag cleanup", () => {
		it("clears newSessionFlag and newSessionCwd after handling", async () => {
			const newBridge = createMockBridge();
			const userState = createUserState({
				newSessionFlag: true,
				newSessionCwd: "/custom/path",
			});

			MockAgentBridge.mockReturnValue(newBridge);

			await ensureBridgeWithSession(config, userState);

			expect(userState.newSessionFlag).toBe(false);
			expect(userState.newSessionCwd).toBeNull();
		});
	});
});
