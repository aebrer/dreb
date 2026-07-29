import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalGuard = process.env.DREB_DISABLE_PROVIDER_E2E;
const testScriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../..", "test.sh");

afterEach(() => {
	if (originalGuard === undefined) {
		delete process.env.DREB_DISABLE_PROVIDER_E2E;
	} else {
		process.env.DREB_DISABLE_PROVIDER_E2E = originalGuard;
	}
	vi.doUnmock("fs");
	vi.doUnmock("os");
	vi.doUnmock("path");
	vi.doUnmock("../src/utils/oauth/index.js");
	vi.resetModules();
});

describe("OAuth provider E2E guard", () => {
	it("does not read or refresh stored OAuth credentials when provider E2E is disabled", async () => {
		const existsSync = vi.fn(() => true);
		const readFileSync = vi.fn(() =>
			JSON.stringify({
				"github-copilot": { type: "oauth", access: "expired", refresh: "refresh-token", expires: 0 },
			}),
		);
		const mkdirSync = vi.fn();
		const writeFileSync = vi.fn();
		const chmodSync = vi.fn();
		const getOAuthApiKey = vi.fn();

		vi.resetModules();
		vi.doMock("fs", () => ({ existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync }));
		vi.doMock("os", () => ({ homedir: () => "/fake/home" }));
		vi.doMock("path", () => ({
			dirname: () => "/fake/home/.dreb/agent",
			join: () => "/fake/home/.dreb/agent/auth.json",
		}));
		vi.doMock("../src/utils/oauth/index.js", () => ({
			getGitHubCopilotBaseUrl: vi.fn(),
			getOAuthApiKey,
		}));

		process.env.DREB_DISABLE_PROVIDER_E2E = "1";
		const { resolveApiKey } = await import("./oauth.js");
		await expect(
			Promise.all(["github-copilot", "google-gemini-cli", "google-antigravity", "openai-codex"].map(resolveApiKey)),
		).resolves.toEqual([undefined, undefined, undefined, undefined]);

		expect(existsSync).not.toHaveBeenCalled();
		expect(readFileSync).not.toHaveBeenCalled();
		expect(getOAuthApiKey).not.toHaveBeenCalled();
		expect(mkdirSync).not.toHaveBeenCalled();
		expect(writeFileSync).not.toHaveBeenCalled();
		expect(chmodSync).not.toHaveBeenCalled();
	});

	it("enables the OAuth guard and clears every environment credential source in the clean test runner", () => {
		const script = readFileSync(testScriptPath, "utf-8");
		expect(script).toContain("DREB_DISABLE_PROVIDER_E2E=1");
		for (const variable of [
			"COPILOT_GITHUB_TOKEN",
			"GH_TOKEN",
			"GITHUB_TOKEN",
			"MINIMAX_CN_API_KEY",
			"ZHIPU_API_KEY",
			"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
			"AWS_CONTAINER_CREDENTIALS_FULL_URI",
			"AWS_WEB_IDENTITY_TOKEN_FILE",
		]) {
			expect(script).toContain(variable);
		}
	});
});
