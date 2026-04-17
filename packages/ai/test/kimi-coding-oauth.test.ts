import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildKimiHeaders,
	kimiCodingOAuthProvider,
	loginKimiCoding,
	refreshKimiCodingToken,
} from "../src/utils/oauth/kimi-coding.js";
import type { OAuthCredentials } from "../src/utils/oauth/types.js";

// ============================================================================
// Helpers
// ============================================================================

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

const DEVICE_AUTH_URL = "https://auth.kimi.com/api/oauth/device_authorization";
const TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const MODELS_URL = "https://api.kimi.com/coding/v1/models";

const MOCK_DEVICE_CODE_RESPONSE = {
	device_code: "test-device-code",
	user_code: "WXYZ-1234",
	verification_uri: "https://auth.kimi.com/device",
	interval: 5,
	expires_in: 900,
};

const MOCK_TOKEN_SUCCESS = {
	access_token: "kimi-access-token-123",
	refresh_token: "kimi-refresh-token-456",
	expires_in: 3600,
};

const MOCK_MODELS_RESPONSE = {
	data: [
		{
			id: "kimi-k2-0715-chat",
			display_name: "Kimi K2",
			context_length: 131072,
			supports_reasoning: true,
		},
	],
};

// ============================================================================
// Tests
// ============================================================================

describe("Kimi For Coding OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// ------------------------------------------------------------------------
	// buildKimiHeaders
	// ------------------------------------------------------------------------
	describe("buildKimiHeaders", () => {
		it("returns all required headers", () => {
			const headers = buildKimiHeaders();
			expect(headers["User-Agent"]).toBe("KimiCLI/1.35.0");
			expect(headers["X-Msh-Platform"]).toBe("kimi_cli");
			expect(headers["X-Msh-Version"]).toBe("1.35.0");
			expect(headers["X-Msh-Device-Name"]).toBeTruthy();
			expect(headers["X-Msh-Device-Model"]).toBeTruthy();
			expect(headers["X-Msh-Device-Id"]).toBeTruthy();
			expect(headers["X-Msh-Os-Version"]).toBeTruthy();
		});

		it("produces a valid hex device ID", () => {
			const headers = buildKimiHeaders();
			const deviceId = headers["X-Msh-Device-Id"];
			expect(deviceId).toMatch(/^[0-9a-f]{32}$/);
		});

		it("strips non-ASCII from header values", () => {
			// If hostname had non-ASCII, it would be stripped.
			// We can't easily control os.hostname(), but we can verify the result is ASCII.
			const headers = buildKimiHeaders();
			for (const value of Object.values(headers)) {
				expect(value).toMatch(/^[\x20-\x7E]*$/);
			}
		});
	});

	// ------------------------------------------------------------------------
	// Device flow login
	// ------------------------------------------------------------------------
	describe("loginKimiCoding", () => {
		it("completes device flow and discovers models", async () => {
			const authCalls: { url: string; instructions?: string }[] = [];
			const progressCalls: string[] = [];

			const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);

				if (url === DEVICE_AUTH_URL) {
					expect(init?.method).toBe("POST");
					expect(String(init?.body)).toContain("client_id=17e5f671-d194-4dfb-9706-5516cb48c098");
					expect(String(init?.body)).toContain("scope=kimi-code");
					return jsonResponse(MOCK_DEVICE_CODE_RESPONSE);
				}

				if (url === TOKEN_URL) {
					// First poll returns pending, second returns success
					if (init?.body && String(init.body).includes("grant_type=urn")) {
						// It's a device code token poll
						const callCount = fetchMock.mock.calls.filter(
							(c) => getUrl(c[0]) === TOKEN_URL && String(c[1]?.body).includes("grant_type=urn"),
						).length;
						if (callCount === 1) {
							return jsonResponse({ error: "authorization_pending" });
						}
						return jsonResponse(MOCK_TOKEN_SUCCESS);
					}
					throw new Error(`Unexpected TOKEN_URL call: ${String(init?.body)}`);
				}

				if (url === MODELS_URL) {
					return jsonResponse(MOCK_MODELS_RESPONSE);
				}

				throw new Error(`Unexpected fetch URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			const creds = await loginKimiCoding({
				onAuth: (info) => {
					authCalls.push(info);
				},
				onProgress: (msg) => {
					progressCalls.push(msg);
				},
			});

			// Auth callback was called with the verification URI and user code
			expect(authCalls).toHaveLength(1);
			expect(authCalls[0].url).toBe("https://auth.kimi.com/device");
			expect(authCalls[0].instructions).toContain("WXYZ-1234");

			// Credentials include model discovery extras
			expect(creds.refresh).toBe("kimi-refresh-token-456");
			expect(creds.access).toBe("kimi-access-token-123");
			expect(creds.expires).toBeGreaterThan(Date.now());
			expect(creds.modelId).toBe("kimi-k2-0715-chat");
			expect(creds.contextLength).toBe(131072);
			expect(creds.modelDisplay).toBe("Kimi K2");

			// Progress was reported
			expect(progressCalls).toContain("Discovering available models...");
		});

		it("polls with authorization_pending then succeeds", async () => {
			vi.useFakeTimers();
			const startTime = new Date("2026-04-17T00:00:00Z");
			vi.setSystemTime(startTime);

			const pollTimes: number[] = [];
			const tokenResponses = [
				jsonResponse({ error: "authorization_pending" }),
				jsonResponse({ error: "authorization_pending" }),
				jsonResponse(MOCK_TOKEN_SUCCESS),
			];

			const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);

				if (url === DEVICE_AUTH_URL) {
					return jsonResponse(MOCK_DEVICE_CODE_RESPONSE);
				}

				if (url === TOKEN_URL && String(init?.body).includes("grant_type=urn")) {
					pollTimes.push(Date.now());
					const resp = tokenResponses.shift();
					if (!resp) throw new Error("Unexpected extra poll");
					return resp;
				}

				if (url === MODELS_URL) {
					return jsonResponse(MOCK_MODELS_RESPONSE);
				}

				throw new Error(`Unexpected URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			const loginPromise = loginKimiCoding({
				onAuth: () => {},
			});

			// First poll at interval (5s)
			await vi.advanceTimersByTimeAsync(5000);
			expect(pollTimes).toHaveLength(1);

			// Second poll at +5s
			await vi.advanceTimersByTimeAsync(5000);
			expect(pollTimes).toHaveLength(2);

			// Third poll at +5s — success
			await vi.advanceTimersByTimeAsync(5000);
			const creds = await loginPromise;

			expect(pollTimes).toHaveLength(3);
			expect(creds.access).toBe("kimi-access-token-123");
		});

		it("increases interval on slow_down", async () => {
			vi.useFakeTimers();
			const startTime = new Date("2026-04-17T00:00:00Z");
			vi.setSystemTime(startTime);

			const pollTimes: number[] = [];
			const tokenResponses = [
				jsonResponse({ error: "authorization_pending" }),
				jsonResponse({ error: "slow_down", interval: 10 }),
				jsonResponse(MOCK_TOKEN_SUCCESS),
			];

			const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);

				if (url === DEVICE_AUTH_URL) {
					return jsonResponse(MOCK_DEVICE_CODE_RESPONSE);
				}

				if (url === TOKEN_URL && String(init?.body).includes("grant_type=urn")) {
					pollTimes.push(Date.now());
					const resp = tokenResponses.shift();
					if (!resp) throw new Error("Unexpected extra poll");
					return resp;
				}

				if (url === MODELS_URL) {
					return jsonResponse(MOCK_MODELS_RESPONSE);
				}

				throw new Error(`Unexpected URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			const loginPromise = loginKimiCoding({
				onAuth: () => {},
			});

			// First poll at 5s
			await vi.advanceTimersByTimeAsync(5000);
			expect(pollTimes).toHaveLength(1);
			expect(pollTimes[0]).toBe(startTime.getTime() + 5000);

			// Second poll at +5s (still on original interval)
			await vi.advanceTimersByTimeAsync(5000);
			expect(pollTimes).toHaveLength(2);
			expect(pollTimes[1]).toBe(startTime.getTime() + 10000);

			// After slow_down with interval=10, next poll should be at +10s
			await vi.advanceTimersByTimeAsync(9999);
			expect(pollTimes).toHaveLength(2);

			await vi.advanceTimersByTimeAsync(1);
			const creds = await loginPromise;

			expect(pollTimes).toHaveLength(3);
			expect(pollTimes[2]).toBe(startTime.getTime() + 20000);
			expect(creds.access).toBe("kimi-access-token-123");
		});

		it("throws on expired_token", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

			const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);

				if (url === DEVICE_AUTH_URL) {
					return jsonResponse(MOCK_DEVICE_CODE_RESPONSE);
				}

				if (url === TOKEN_URL && String(init?.body).includes("grant_type=urn")) {
					return jsonResponse({ error: "expired_token", error_description: "code expired" });
				}

				throw new Error(`Unexpected URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			const loginPromise = loginKimiCoding({
				onAuth: () => {},
			});

			// Attach rejection handler before advancing timers
			const rejection = expect(loginPromise).rejects.toThrow("Device code expired");

			// Advance to trigger first poll
			await vi.advanceTimersByTimeAsync(5000);

			await rejection;
		});

		it("throws on timeout when deadline passes", async () => {
			vi.useFakeTimers();
			const startTime = new Date("2026-04-17T00:00:00Z");
			vi.setSystemTime(startTime);

			const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);

				if (url === DEVICE_AUTH_URL) {
					// Very short expiry (1 second)
					return jsonResponse({
						...MOCK_DEVICE_CODE_RESPONSE,
						expires_in: 1,
					});
				}

				if (url === TOKEN_URL && String(init?.body).includes("grant_type=urn")) {
					return jsonResponse({ error: "authorization_pending" });
				}

				throw new Error(`Unexpected URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			const loginPromise = loginKimiCoding({
				onAuth: () => {},
			});

			// Attach rejection handler before advancing timers
			const rejection = expect(loginPromise).rejects.toThrow("Device flow timed out");

			// Advance past the 1-second deadline
			await vi.advanceTimersByTimeAsync(2000);

			await rejection;
		});
	});

	// ------------------------------------------------------------------------
	// Token refresh
	// ------------------------------------------------------------------------
	describe("refreshKimiCodingToken", () => {
		it("refreshes token and rediscovers models", async () => {
			const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);

				if (url === TOKEN_URL) {
					expect(String(init?.body)).toContain("grant_type=refresh_token");
					expect(String(init?.body)).toContain("refresh_token=old-refresh");
					return jsonResponse({
						access_token: "new-access",
						refresh_token: "new-refresh",
						expires_in: 3600,
					});
				}

				if (url === MODELS_URL) {
					return jsonResponse(MOCK_MODELS_RESPONSE);
				}

				throw new Error(`Unexpected URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			const oldCreds: OAuthCredentials = {
				refresh: "old-refresh",
				access: "old-access",
				expires: Date.now() - 1000,
			};

			const fresh = await refreshKimiCodingToken(oldCreds);

			expect(fresh.access).toBe("new-access");
			expect(fresh.refresh).toBe("new-refresh");
			expect(fresh.expires).toBeGreaterThan(Date.now());
			expect(fresh.modelId).toBe("kimi-k2-0715-chat");
			expect(fresh.contextLength).toBe(131072);
		});

		it("retries on 429 and then succeeds", async () => {
			const callOrder: string[] = [];
			let tokenCall = 0;

			const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);

				if (url === TOKEN_URL) {
					tokenCall++;
					callOrder.push(`token-${tokenCall}`);
					if (tokenCall === 1) {
						return new Response("rate limited", { status: 429 });
					}
					return jsonResponse({
						access_token: "retried-access",
						refresh_token: "retried-refresh",
						expires_in: 3600,
					});
				}

				if (url === MODELS_URL) {
					callOrder.push("models");
					return jsonResponse(MOCK_MODELS_RESPONSE);
				}

				throw new Error(`Unexpected URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			const fresh = await refreshKimiCodingToken({
				refresh: "old-refresh",
				access: "old-access",
				expires: 0,
			});

			expect(fresh.access).toBe("retried-access");
			expect(callOrder).toEqual(["token-1", "token-2", "models"]);
		});

		it("retries on 503 with exponential backoff and eventually fails", async () => {
			const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);

				if (url === TOKEN_URL) {
					return new Response("service unavailable", { status: 503 });
				}

				throw new Error(`Unexpected URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			await expect(
				refreshKimiCodingToken({
					refresh: "old-refresh",
					access: "old-access",
					expires: 0,
				}),
			).rejects.toThrow("503");

			// Should have been called 3 times (MAX_REFRESH_RETRIES)
			expect(fetchMock).toHaveBeenCalledTimes(3);
		});

		it("fails immediately on non-retriable errors", async () => {
			const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);

				if (url === TOKEN_URL) {
					return new Response("bad request", { status: 400 });
				}

				throw new Error(`Unexpected URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			await expect(
				refreshKimiCodingToken({
					refresh: "old-refresh",
					access: "old-access",
					expires: 0,
				}),
			).rejects.toThrow("400");

			// Should NOT retry on 400
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
	});

	// ------------------------------------------------------------------------
	// getApiKey
	// ------------------------------------------------------------------------
	describe("getApiKey", () => {
		it("returns the access token", () => {
			const creds: OAuthCredentials = {
				refresh: "r",
				access: "my-access-token",
				expires: Date.now() + 1000,
			};
			expect(kimiCodingOAuthProvider.getApiKey(creds)).toBe("my-access-token");
		});
	});

	// ------------------------------------------------------------------------
	// modifyModels
	// ------------------------------------------------------------------------
	describe("modifyModels", () => {
		it("injects Kimi headers and updates model id and contextWindow", () => {
			const creds: OAuthCredentials & {
				modelId?: string;
				contextLength?: number;
			} = {
				refresh: "r",
				access: "a",
				expires: Date.now() + 1000,
				modelId: "kimi-k2-0715-chat",
				contextLength: 131072,
			};

			const models = [
				{
					id: "kimi-default",
					name: "Kimi",
					api: "openai-completions" as const,
					provider: "kimi-coding-oauth",
					baseUrl: "https://api.kimi.com/coding/v1",
					reasoning: false,
					input: ["text"] as ("text" | "image")[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32768,
					maxTokens: 4096,
				},
				{
					id: "other-model",
					name: "Other",
					api: "openai-completions" as const,
					provider: "other-provider",
					baseUrl: "https://other.example.com",
					reasoning: false,
					input: ["text"] as ("text" | "image")[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 2048,
				},
			];

			const result = kimiCodingOAuthProvider.modifyModels!(models, creds);

			// First model should be updated
			expect(result[0].id).toBe("kimi-k2-0715-chat");
			expect(result[0].contextWindow).toBe(131072);
			expect(result[0].headers).toMatchObject({
				"User-Agent": "KimiCLI/1.35.0",
				"X-Msh-Platform": "kimi_cli",
				"X-Msh-Version": "1.35.0",
			});

			// Second model should be unchanged
			expect(result[1].id).toBe("other-model");
			expect(result[1].contextWindow).toBe(8192);
			expect(result[1].headers).toBeUndefined();
		});

		it("does not modify model id when credentials lack modelId", () => {
			const creds: OAuthCredentials = {
				refresh: "r",
				access: "a",
				expires: Date.now() + 1000,
			};

			const models = [
				{
					id: "kimi-default",
					name: "Kimi",
					api: "openai-completions" as const,
					provider: "kimi-coding-oauth",
					baseUrl: "https://api.kimi.com/coding/v1",
					reasoning: false,
					input: ["text"] as ("text" | "image")[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32768,
					maxTokens: 4096,
				},
			];

			const result = kimiCodingOAuthProvider.modifyModels!(models, creds);

			// Headers still injected
			expect(result[0].headers).toMatchObject({
				"X-Msh-Platform": "kimi_cli",
			});
			// But id and contextWindow unchanged
			expect(result[0].id).toBe("kimi-default");
			expect(result[0].contextWindow).toBe(32768);
		});
	});

	// ------------------------------------------------------------------------
	// Provider metadata
	// ------------------------------------------------------------------------
	describe("provider metadata", () => {
		it("has correct id and name", () => {
			expect(kimiCodingOAuthProvider.id).toBe("kimi-coding-oauth");
			expect(kimiCodingOAuthProvider.name).toBe("Kimi For Coding");
		});
	});
});
