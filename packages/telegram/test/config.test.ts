import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const TEST_SECRETS_DIR = join(tmpdir(), "dreb-config-test");
const TEST_SECRETS_FILE = join(TEST_SECRETS_DIR, "telegram.env");

// Use a nonexistent secrets file so tests don't pick up real credentials
const NO_SECRETS = "/tmp/nonexistent-dreb-test-secrets.env";

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
		// Restore original env fully (remove any keys we added, restore originals)
		for (const key of Object.keys(process.env)) {
			if (!(key in origEnv)) delete process.env[key];
		}
		Object.assign(process.env, origEnv);
	});

	it("throws with helpful message if TELEGRAM_BOT_TOKEN is missing", () => {
		expect(() => loadConfig(NO_SECRETS)).toThrow("TELEGRAM_BOT_TOKEN not set");
	});

	it("loads minimal config with just token", () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-token";
		const config = loadConfig(NO_SECRETS);
		expect(config.botToken).toBe("test-token");
		expect(config.allowedUserIds).toEqual([]);
		expect(config.serviceName).toBe("dreb-telegram");
	});

	it("parses allowed user IDs", () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-token";
		process.env.ALLOWED_USER_IDS = "123,456,789";
		const config = loadConfig(NO_SECRETS);
		expect(config.allowedUserIds).toEqual([123, 456, 789]);
	});

	it("throws on invalid user ID", () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-token";
		process.env.ALLOWED_USER_IDS = "123,abc";
		expect(() => loadConfig(NO_SECRETS)).toThrow("Invalid user ID");
	});

	it("handles empty and whitespace user IDs", () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-token";
		process.env.ALLOWED_USER_IDS = "123, , 456,";
		const config = loadConfig(NO_SECRETS);
		expect(config.allowedUserIds).toEqual([123, 456]);
	});

	it("loads all optional fields", () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-token";
		process.env.DREB_WORKING_DIR = "/tmp/test";
		process.env.DREB_PATH = "/usr/bin/dreb";
		process.env.DREB_TELEGRAM_SERVICE = "my-service";
		process.env.DREB_PROVIDER = "anthropic";
		process.env.DREB_MODEL = "claude-opus-4";
		const config = loadConfig(NO_SECRETS);
		expect(config.workingDir).toBe("/tmp/test");
		expect(config.drebPath).toBe("/usr/bin/dreb");
		expect(config.serviceName).toBe("my-service");
		expect(config.provider).toBe("anthropic");
		expect(config.model).toBe("claude-opus-4");
	});

	it("auto-loads secrets from env file", () => {
		mkdirSync(TEST_SECRETS_DIR, { recursive: true });
		writeFileSync(TEST_SECRETS_FILE, "TELEGRAM_BOT_TOKEN=file-token\nALLOWED_USER_IDS=111,222\n");
		try {
			const config = loadConfig(TEST_SECRETS_FILE);
			expect(config.botToken).toBe("file-token");
			expect(config.allowedUserIds).toEqual([111, 222]);
		} finally {
			rmSync(TEST_SECRETS_DIR, { recursive: true, force: true });
		}
	});

	it("env vars take priority over secrets file", () => {
		mkdirSync(TEST_SECRETS_DIR, { recursive: true });
		writeFileSync(TEST_SECRETS_FILE, "TELEGRAM_BOT_TOKEN=file-token\nALLOWED_USER_IDS=111\n");
		process.env.TELEGRAM_BOT_TOKEN = "env-token";
		try {
			const config = loadConfig(TEST_SECRETS_FILE);
			expect(config.botToken).toBe("env-token");
		} finally {
			rmSync(TEST_SECRETS_DIR, { recursive: true, force: true });
		}
	});

	it("handles quoted values and comments in env file", () => {
		mkdirSync(TEST_SECRETS_DIR, { recursive: true });
		writeFileSync(
			TEST_SECRETS_FILE,
			"# This is a comment\nTELEGRAM_BOT_TOKEN=\"quoted-token\"\nALLOWED_USER_IDS='333'\n",
		);
		try {
			const config = loadConfig(TEST_SECRETS_FILE);
			expect(config.botToken).toBe("quoted-token");
			expect(config.allowedUserIds).toEqual([333]);
		} finally {
			rmSync(TEST_SECRETS_DIR, { recursive: true, force: true });
		}
	});
});
