import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	chmodSync: vi.fn(),
	existsSync: vi.fn(),
	getGitHubCopilotBaseUrl: vi.fn(),
	getOAuthApiKey: vi.fn(),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

vi.mock("fs", () => ({
	chmodSync: mocks.chmodSync,
	existsSync: mocks.existsSync,
	mkdirSync: mocks.mkdirSync,
	readFileSync: mocks.readFileSync,
	writeFileSync: mocks.writeFileSync,
}));

vi.mock("../src/utils/oauth/index.js", () => ({
	getGitHubCopilotBaseUrl: mocks.getGitHubCopilotBaseUrl,
	getOAuthApiKey: mocks.getOAuthApiKey,
}));

import { resolveApiKey } from "./oauth.js";

const originalSkipLiveApi = process.env.DREB_SKIP_LIVE_API;

describe("test OAuth credential resolution", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.existsSync.mockReturnValue(true);
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

		await expect(resolveApiKey("openai-codex")).resolves.toBeUndefined();
		expect(mocks.existsSync).not.toHaveBeenCalled();
		expect(mocks.readFileSync).not.toHaveBeenCalled();
		expect(mocks.getOAuthApiKey).not.toHaveBeenCalled();
		expect(mocks.mkdirSync).not.toHaveBeenCalled();
		expect(mocks.writeFileSync).not.toHaveBeenCalled();
		expect(mocks.chmodSync).not.toHaveBeenCalled();
	});

	it("still refreshes and saves OAuth credentials when the guard is unset", async () => {
		delete process.env.DREB_SKIP_LIVE_API;
		mocks.readFileSync.mockReturnValue(
			JSON.stringify({
				"openai-codex": {
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

		await expect(resolveApiKey("openai-codex")).resolves.toBe("refreshed-api-key");
		expect(mocks.getOAuthApiKey).toHaveBeenCalledOnce();
		expect(mocks.writeFileSync).toHaveBeenCalledOnce();
		expect(mocks.chmodSync).toHaveBeenCalledOnce();
	});
});
