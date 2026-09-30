import { describe, expect, it } from "vitest";
import { shouldRunBedrockExtensiveTests } from "./bedrock-utils.js";

describe("shouldRunBedrockExtensiveTests", () => {
	const enabledEnvironment: NodeJS.ProcessEnv = {
		AWS_PROFILE: "test-profile",
		BEDROCK_EXTENSIVE_MODEL_TEST: "1",
		DREB_LIVE_API: "1",
	};

	it("disables live model calls unless DREB_LIVE_API=1", () => {
		const { DREB_LIVE_API: _, ...withoutOptIn } = enabledEnvironment;
		expect(shouldRunBedrockExtensiveTests(withoutOptIn)).toBe(false);
		expect(shouldRunBedrockExtensiveTests({ ...enabledEnvironment, DREB_LIVE_API: "0" })).toBe(false);
	});

	it("runs explicitly enabled live model calls when opted in", () => {
		expect(shouldRunBedrockExtensiveTests(enabledEnvironment)).toBe(true);
	});
});
