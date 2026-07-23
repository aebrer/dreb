import { describe, expect, it } from "vitest";
import { shouldRunBedrockExtensiveTests } from "./bedrock-utils.js";

describe("shouldRunBedrockExtensiveTests", () => {
	const enabledEnvironment: NodeJS.ProcessEnv = {
		AWS_PROFILE: "test-profile",
		BEDROCK_EXTENSIVE_MODEL_TEST: "1",
	};

	it("disables live model calls when DREB_SKIP_LIVE_API is set", () => {
		expect(shouldRunBedrockExtensiveTests({ ...enabledEnvironment, DREB_SKIP_LIVE_API: "1" })).toBe(false);
	});

	it("preserves explicitly enabled live model calls when the guard is unset", () => {
		expect(shouldRunBedrockExtensiveTests(enabledEnvironment)).toBe(true);
	});
});
