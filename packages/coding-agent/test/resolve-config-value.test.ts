import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigValueCache, configValueWarnings, resolveConfigValue } from "../src/core/resolve-config-value.js";

describe("resolveConfigValue", () => {
	afterEach(() => {
		clearConfigValueCache();
		delete process.env.TEST_TEMPLATE_ENV;
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

	it("resolves {env:VAR} templates with surrounding text and trims", () => {
		process.env.TEST_TEMPLATE_ENV = "  http://127.0.0.1:1234  ";
		expect(resolveConfigValue("{env:TEST_TEMPLATE_ENV}/v1")).toBe("http://127.0.0.1:1234/v1");
		delete process.env.TEST_TEMPLATE_ENV;
	});

	it("resolves {file:PATH} templates and trims file contents", () => {
		const dir = mkdtempSync(join(tmpdir(), "dreb-config-template-"));
		try {
			const file = join(dir, "secret");
			writeFileSync(file, "  file-secret\n");
			expect(resolveConfigValue(`{file:${file}}`)).toBe("file-secret");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fall back to the token text when resolution fails", () => {
		delete process.env.TEST_TEMPLATE_MISSING;
		expect(resolveConfigValue("{env:TEST_TEMPLATE_MISSING}")).toBeUndefined();
		expect(resolveConfigValue("{env:TEST_TEMPLATE_MISSING}")).toBeUndefined();
		const missing = join(tmpdir(), `dreb-missing-${Date.now()}-${Math.random()}.txt`);
		expect(resolveConfigValue(`{file:${missing}}`)).toBeUndefined();
		expect(configValueWarnings.filter((w) => w.includes("TEST_TEMPLATE_MISSING"))).toHaveLength(1);
		expect(configValueWarnings.some((w) => w.includes(`{file:${missing}}`))).toBe(true);
	});

	it("runs !command values through the shell without expanding template syntax", () => {
		process.env.TEST_TEMPLATE_ENV = "must-not-be-substituted";
		expect(resolveConfigValue("!echo '{env:TEST_TEMPLATE_ENV}'")).toBe("{env:TEST_TEMPLATE_ENV}");
	});

	it("never re-resolves a template result as an env name or command", () => {
		process.env.TEST_TEMPLATE_ENV = "TEST_RESOLVE_CONFIG";
		process.env.TEST_RESOLVE_CONFIG = "should-not-be-used";
		try {
			expect(resolveConfigValue("{env:TEST_TEMPLATE_ENV}")).toBe("TEST_RESOLVE_CONFIG");
			process.env.TEST_TEMPLATE_ENV = "!echo executed";
			expect(resolveConfigValue("{env:TEST_TEMPLATE_ENV}")).toBe("!echo executed");
		} finally {
			delete process.env.TEST_RESOLVE_CONFIG;
		}
	});
});
