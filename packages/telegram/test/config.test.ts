import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
	const origEnv = { ...process.env };

	beforeEach(() => {
		// Clean slate
		delete process.env.TELEGRAM_BOT_TOKEN;
		delete process.env.ALLOWED_USER_IDS;
		delete process.env.DREB_WORKING_DIR;
		delete process.env.DREB_PATH;
		delete process.env.DREB_TELEGRAM_SERVICE;
		delete process.env.DREB_PROVIDER;
		delete process.env.DREB_MODEL;
	});

	afterEach(() => {
		Object.assign(process.env, origEnv);
	});

	it("throws if TELEGRAM_BOT_TOKEN is missing", () => {
		expect(() => loadConfig()).toThrow("TELEGRAM_BOT_TOKEN");
	});

	it("loads minimal config with just token", () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-token";
		const config = loadConfig();
		expect(config.botToken).toBe("test-token");
		expect(config.allowedUserIds).toEqual([]);
		expect(config.serviceName).toBe("dreb-telegram");
	});

	it("parses allowed user IDs", () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-token";
		process.env.ALLOWED_USER_IDS = "123,456,789";
		const config = loadConfig();
		expect(config.allowedUserIds).toEqual([123, 456, 789]);
	});

	it("throws on invalid user ID", () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-token";
		process.env.ALLOWED_USER_IDS = "123,abc";
		expect(() => loadConfig()).toThrow("Invalid user ID");
	});

	it("handles empty and whitespace user IDs", () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-token";
		process.env.ALLOWED_USER_IDS = "123, , 456,";
		const config = loadConfig();
		expect(config.allowedUserIds).toEqual([123, 456]);
	});

	it("loads all optional fields", () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-token";
		process.env.DREB_WORKING_DIR = "/tmp/test";
		process.env.DREB_PATH = "/usr/bin/dreb";
		process.env.DREB_TELEGRAM_SERVICE = "my-service";
		process.env.DREB_PROVIDER = "anthropic";
		process.env.DREB_MODEL = "claude-opus-4";
		const config = loadConfig();
		expect(config.workingDir).toBe("/tmp/test");
		expect(config.drebPath).toBe("/usr/bin/dreb");
		expect(config.serviceName).toBe("my-service");
		expect(config.provider).toBe("anthropic");
		expect(config.model).toBe("claude-opus-4");
	});
});
