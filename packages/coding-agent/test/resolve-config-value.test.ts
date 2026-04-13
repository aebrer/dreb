import { afterEach, describe, expect, it } from "vitest";
import { clearConfigValueCache, configValueWarnings, resolveConfigValue } from "../src/core/resolve-config-value.js";

describe("resolveConfigValue", () => {
	afterEach(() => {
		clearConfigValueCache();
	});

	it("returns literal value for non-command config", () => {
		expect(resolveConfigValue("my-api-key")).toBe("my-api-key");
	});

	it("returns env var value when it exists", () => {
		process.env.TEST_RESOLVE_CONFIG = "from-env";
		expect(resolveConfigValue("TEST_RESOLVE_CONFIG")).toBe("from-env");
		delete process.env.TEST_RESOLVE_CONFIG;
	});

	it("executes shell command for ! prefix", () => {
		const result = resolveConfigValue("!echo hello-world");
		expect(result).toBe("hello-world");
	});

	it("caches shell command results", () => {
		resolveConfigValue("!echo cached-value");
		// Same command returns cached result
		const result = resolveConfigValue("!echo cached-value");
		expect(result).toBe("cached-value");
	});

	it("clears cache and warnings on clearConfigValueCache", () => {
		resolveConfigValue("!echo test");
		configValueWarnings.push("test warning");
		clearConfigValueCache();
		expect(configValueWarnings).toHaveLength(0);
	});

	it("pushes warning for failed shell commands", () => {
		resolveConfigValue("!nonexistent-command-that-does-not-exist-xyz");
		expect(configValueWarnings.length).toBeGreaterThan(0);
		expect(configValueWarnings[0]).toContain("Config command");
	});

	it("returns undefined for failed shell commands", () => {
		const result = resolveConfigValue("!nonexistent-command-that-does-not-exist-xyz");
		expect(result).toBeUndefined();
	});
});
