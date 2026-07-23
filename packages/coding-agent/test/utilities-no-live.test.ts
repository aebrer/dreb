import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	chmodSync: vi.fn(),
	existsSync: vi.fn(),
	getOAuthApiKey: vi.fn(),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const isAuthPath = (value: unknown) =>
		typeof value === "string" && value.replaceAll("\\", "/").endsWith("/.dreb/agent/auth.json");
	mocks.chmodSync.mockImplementation(actual.chmodSync);
	mocks.existsSync.mockImplementation((path) => (isAuthPath(path) ? false : actual.existsSync(path)));
	mocks.mkdirSync.mockImplementation(actual.mkdirSync);
	mocks.readFileSync.mockImplementation(actual.readFileSync);
	mocks.writeFileSync.mockImplementation(actual.writeFileSync);
	return {
		...actual,
		chmodSync: mocks.chmodSync,
		existsSync: mocks.existsSync,
		mkdirSync: mocks.mkdirSync,
		readFileSync: mocks.readFileSync,
		writeFileSync: mocks.writeFileSync,
	};
});

vi.mock("@dreb/ai/oauth", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dreb/ai/oauth")>();
	return { ...actual, getOAuthApiKey: mocks.getOAuthApiKey };
});

import { hasAuthForProvider, resolveApiKey } from "./utilities.js";

const originalSkipLiveApi = process.env.DREB_SKIP_LIVE_API;

describe("coding-agent test credential resolution", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	afterEach(() => {
		if (originalSkipLiveApi === undefined) {
			delete process.env.DREB_SKIP_LIVE_API;
		} else {
			process.env.DREB_SKIP_LIVE_API = originalSkipLiveApi;
		}
	});

	it("does not read, refresh, or write credentials when live APIs are disabled", async () => {
		process.env.DREB_SKIP_LIVE_API = "1";

		expect(hasAuthForProvider("google-antigravity")).toBe(false);
		await expect(resolveApiKey("google-antigravity")).resolves.toBeUndefined();
		expect(mocks.existsSync).not.toHaveBeenCalled();
		expect(mocks.readFileSync).not.toHaveBeenCalled();
		expect(mocks.getOAuthApiKey).not.toHaveBeenCalled();
		expect(mocks.mkdirSync).not.toHaveBeenCalled();
		expect(mocks.writeFileSync).not.toHaveBeenCalled();
		expect(mocks.chmodSync).not.toHaveBeenCalled();
	});

	it("still refreshes and saves OAuth credentials when the guard is unset", async () => {
		delete process.env.DREB_SKIP_LIVE_API;
		mocks.existsSync.mockReturnValue(true);
		mocks.readFileSync.mockReturnValue(
			JSON.stringify({
				"google-antigravity": {
					type: "oauth",
					access: "expired-access",
					refresh: "refresh-token",
					expires: 0,
				},
			}),
		);
		mocks.getOAuthApiKey.mockResolvedValue({
			apiKey: "refreshed-api-key",
			newCredentials: {
				access: "refreshed-access",
				refresh: "refresh-token",
				expires: 1_000_000,
			},
		});

		await expect(resolveApiKey("google-antigravity")).resolves.toBe("refreshed-api-key");
		expect(mocks.getOAuthApiKey).toHaveBeenCalledOnce();
		expect(mocks.writeFileSync).toHaveBeenCalledOnce();
		expect(mocks.chmodSync).toHaveBeenCalledOnce();
	});
});
