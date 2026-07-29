import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveApiKey } from "./oauth.js";

const originalGuard = process.env.DREB_DISABLE_PROVIDER_E2E;
const testScriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../..", "test.sh");

afterEach(() => {
	if (originalGuard === undefined) {
		delete process.env.DREB_DISABLE_PROVIDER_E2E;
	} else {
		process.env.DREB_DISABLE_PROVIDER_E2E = originalGuard;
	}
});

describe("OAuth provider E2E guard", () => {
	it("does not read or refresh stored OAuth credentials when provider E2E is disabled", async () => {
		process.env.DREB_DISABLE_PROVIDER_E2E = "1";
		await expect(resolveApiKey("github-copilot")).resolves.toBeUndefined();
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
