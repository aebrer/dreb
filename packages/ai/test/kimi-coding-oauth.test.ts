import { afterEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../src/types.js";
import {
	buildKimiHeaders,
	type KimiModelInfo,
	kimiCodingOAuthProvider,
	listModels,
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
	verification_uri_complete: "https://auth.kimi.com/device?user_code=WXYZ-1234&source=kimi-code",
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
		vi.unstubAllEnvs();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// ------------------------------------------------------------------------
	// buildKimiHeaders
	// ------------------------------------------------------------------------
	describe("buildKimiHeaders", () => {
		it("returns the current Kimi Code identity headers", () => {
			const headers = buildKimiHeaders();
			expect(headers["User-Agent"]).toMatch(/^dreb\/\d+\.\d+\.\d+/);
			expect(headers["X-Msh-Platform"]).toBe("kimi_code_cli");
			expect(headers["X-Msh-Version"]).toBe(headers["User-Agent"].slice("dreb/".length));
			expect(headers["X-Msh-Device-Name"]).toBeTruthy();
			expect(headers["X-Msh-Device-Model"]).toBeTruthy();
			expect(headers["X-Msh-Device-Id"]).toBeTruthy();
			expect(headers["X-Msh-Os-Version"]).toBeTruthy();
		});

		it("reuses the stable Kimi Code device ID", () => {
			const first = buildKimiHeaders()["X-Msh-Device-Id"];
			const second = buildKimiHeaders()["X-Msh-Device-Id"];
			expect(first).toBeTruthy();
			expect(second).toBe(first);
		});

		it("loads custom headers below identity-header precedence", () => {
			vi.stubEnv("KIMI_CODE_CUSTOM_HEADERS", "X-Custom: enabled\nX-Msh-Platform: overridden");
			const headers = buildKimiHeaders();
			expect(headers["X-Custom"]).toBe("enabled");
			expect(headers["X-Msh-Platform"]).toBe("kimi_code_cli");
		});

		it("keeps request authorization above custom-header precedence", async () => {
			vi.stubEnv("KIMI_CODE_CUSTOM_HEADERS", "Authorization: custom-value");
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_input: unknown, init?: RequestInit) => {
					expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access-token");
					return jsonResponse({ data: [] });
				}),
			);
			await listModels("access-token");
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
					expect(String(init?.body)).toBe("client_id=17e5f671-d194-4dfb-9706-5516cb48c098");
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
							return jsonResponse({ error: "authorization_pending" }, 400);
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

			// The server-provided complete verification URI is passed through unchanged.
			expect(authCalls).toHaveLength(1);
			const authUrl = new URL(authCalls[0].url);
			expect(authUrl.origin + authUrl.pathname).toBe("https://auth.kimi.com/device");
			expect(authUrl.searchParams.get("user_code")).toBe("WXYZ-1234");
			expect(authUrl.searchParams.get("source")).toBe("kimi-code");
			expect(authCalls[0].instructions).toContain("WXYZ-1234");

			// Credentials include the full discovered model list and legacy extras
			expect(creds.refresh).toBe("kimi-refresh-token-456");
			expect(creds.access).toBe("kimi-access-token-123");
			expect(creds.expires).toBeGreaterThan(Date.now());
			expect(creds.models).toEqual(MOCK_MODELS_RESPONSE.data);
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
				jsonResponse({ error: "authorization_pending" }, 400),
				jsonResponse({ error: "authorization_pending" }, 400),
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
				jsonResponse({ error: "authorization_pending" }, 400),
				jsonResponse({ error: "slow_down", interval: 10 }, 400),
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

		it("restarts the device flow after expired_token", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));
			let tokenPolls = 0;
			let authPrompts = 0;

			const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === DEVICE_AUTH_URL) return jsonResponse(MOCK_DEVICE_CODE_RESPONSE);
				if (url === TOKEN_URL && String(init?.body).includes("grant_type=urn")) {
					tokenPolls++;
					return tokenPolls === 1
						? jsonResponse({ error: "expired_token", error_description: "code expired" }, 400)
						: jsonResponse(MOCK_TOKEN_SUCCESS);
				}
				if (url === MODELS_URL) return jsonResponse(MOCK_MODELS_RESPONSE);
				throw new Error(`Unexpected URL: ${url}`);
			});
			vi.stubGlobal("fetch", fetchMock);

			const loginPromise = loginKimiCoding({ onAuth: () => authPrompts++ });
			await vi.advanceTimersByTimeAsync(10_000);
			const credentials = await loginPromise;

			expect(credentials.access).toBe(MOCK_TOKEN_SUCCESS.access_token);
			expect(authPrompts).toBe(2);
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
					return jsonResponse({ error: "authorization_pending" }, 400);
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
	// Abort signal
	// ------------------------------------------------------------------------
	describe("abort signal", () => {
		it("loginKimiCoding rejects with 'Login cancelled' when signal is aborted before polling", async () => {
			const controller = new AbortController();
			controller.abort();

			const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);

				if (url === DEVICE_AUTH_URL) {
					return jsonResponse(MOCK_DEVICE_CODE_RESPONSE);
				}

				if (url === TOKEN_URL && String(init?.body).includes("grant_type=urn")) {
					return jsonResponse({ error: "authorization_pending" }, 400);
				}

				throw new Error(`Unexpected URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			await expect(
				loginKimiCoding({
					onAuth: () => {},
					signal: controller.signal,
				}),
			).rejects.toThrow("Login cancelled");
		});

		it("loginKimiCoding rejects with 'Login cancelled' when signal is aborted during polling", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

			const controller = new AbortController();
			let pollCount = 0;

			const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);

				if (url === DEVICE_AUTH_URL) {
					return jsonResponse(MOCK_DEVICE_CODE_RESPONSE);
				}

				if (url === TOKEN_URL && String(init?.body).includes("grant_type=urn")) {
					pollCount++;
					return jsonResponse({ error: "authorization_pending" }, 400);
				}

				throw new Error(`Unexpected URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			const loginPromise = loginKimiCoding({
				onAuth: () => {},
				signal: controller.signal,
			});

			// First poll at interval (5s)
			await vi.advanceTimersByTimeAsync(5000);
			expect(pollCount).toBe(1);

			// Abort during the wait before the next poll
			controller.abort();

			await expect(loginPromise).rejects.toThrow("Login cancelled");
		});

		it("refreshWithRetry rejects with 'Refresh cancelled' when signal is aborted", async () => {
			const controller = new AbortController();
			controller.abort();

			const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url === TOKEN_URL) {
					return new Response("service unavailable", { status: 503 });
				}
				throw new Error(`Unexpected URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			// Call refreshKimiCodingToken with signal to test the underlying refreshWithRetry
			await expect(
				refreshKimiCodingToken(
					{
						refresh: "old-refresh",
						access: "old-access",
						expires: 0,
					},
					controller.signal,
				),
			).rejects.toThrow("Refresh cancelled");

			// Should not have made any fetch calls
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	// ------------------------------------------------------------------------
	// Network error retry
	// ------------------------------------------------------------------------
	describe("network error retry in refresh", () => {
		it("retries on TypeError (network failure) and then succeeds", async () => {
			let tokenCall = 0;

			const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);

				if (url === TOKEN_URL) {
					tokenCall++;
					if (tokenCall === 1) {
						throw new TypeError("fetch failed");
					}
					return jsonResponse({
						access_token: "retried-access",
						refresh_token: "retried-refresh",
						expires_in: 3600,
					});
				}

				if (url === MODELS_URL) {
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
			expect(tokenCall).toBe(2);
		});

		it("retries on ECONNREFUSED and then succeeds", async () => {
			let tokenCall = 0;

			const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);

				if (url === TOKEN_URL) {
					tokenCall++;
					if (tokenCall === 1) {
						throw new Error("connect ECONNREFUSED 127.0.0.1:443");
					}
					return jsonResponse({
						access_token: "retried-access",
						refresh_token: "retried-refresh",
						expires_in: 3600,
					});
				}

				if (url === MODELS_URL) {
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
			expect(tokenCall).toBe(2);
		});
	});

	// ------------------------------------------------------------------------
	// Unexpected poll response
	// ------------------------------------------------------------------------
	describe("unexpected poll response", () => {
		it("throws on response object with neither access_token nor error", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

			const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);

				if (url === DEVICE_AUTH_URL) {
					return jsonResponse(MOCK_DEVICE_CODE_RESPONSE);
				}

				if (url === TOKEN_URL && String(init?.body).includes("grant_type=urn")) {
					return jsonResponse({ foo: "bar", baz: 42 });
				}

				throw new Error(`Unexpected URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			const loginPromise = loginKimiCoding({
				onAuth: () => {},
			});

			const rejection = expect(loginPromise).rejects.toThrow("Unexpected token response");

			await vi.advanceTimersByTimeAsync(5000);

			await rejection;
		});
	});

	// ------------------------------------------------------------------------
	// listModels failure resilience
	// ------------------------------------------------------------------------
	describe("listModels failure resilience", () => {
		it("loginKimiCoding proceeds without model enrichment when listModels fails", async () => {
			const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);

				if (url === DEVICE_AUTH_URL) {
					return jsonResponse(MOCK_DEVICE_CODE_RESPONSE);
				}

				if (url === TOKEN_URL) {
					if (String(init?.body).includes("grant_type=urn")) {
						return jsonResponse(MOCK_TOKEN_SUCCESS);
					}
					throw new Error(`Unexpected TOKEN_URL call`);
				}

				if (url === MODELS_URL) {
					throw new Error("Models endpoint is down");
				}

				throw new Error(`Unexpected URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			const creds = await loginKimiCoding({
				onAuth: () => {},
				onProgress: () => {},
			});

			expect(creds.access).toBe("kimi-access-token-123");
			expect(creds.refresh).toBe("kimi-refresh-token-456");
			expect(creds.modelId).toBeUndefined();
			expect(creds.contextLength).toBeUndefined();
			expect(creds.modelDisplay).toBeUndefined();
		});

		it("refreshKimiCodingToken proceeds without model enrichment when listModels fails", async () => {
			const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);

				if (url === TOKEN_URL) {
					return jsonResponse({
						access_token: "new-access",
						refresh_token: "new-refresh",
						expires_in: 3600,
					});
				}

				if (url === MODELS_URL) {
					throw new Error("Models endpoint is down");
				}

				throw new Error(`Unexpected URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			const fresh = await refreshKimiCodingToken({
				refresh: "old-refresh",
				access: "old-access",
				expires: 0,
			});

			expect(fresh.access).toBe("new-access");
			expect(fresh.refresh).toBe("new-refresh");
			expect(fresh.models).toBeUndefined();
			expect(fresh.modelId).toBeUndefined();
			expect(fresh.contextLength).toBeUndefined();
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
			expect(fresh.models).toEqual(MOCK_MODELS_RESPONSE.data);
			expect(fresh.modelId).toBe("kimi-k2-0715-chat");
			expect(fresh.contextLength).toBe(131072);
		});

		it("clears stale entitlements after a successful empty discovery", async () => {
			const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url === TOKEN_URL) {
					return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
				}
				if (url === MODELS_URL) return jsonResponse({ data: [] });
				throw new Error(`Unexpected URL: ${url}`);
			});
			vi.stubGlobal("fetch", fetchMock);

			const fresh = await refreshKimiCodingToken({
				refresh: "old-refresh",
				access: "old-access",
				expires: 0,
				models: MOCK_MODELS_RESPONSE.data,
				modelId: "kimi-k2-0715-chat",
				contextLength: 131072,
			} as OAuthCredentials);

			expect(fresh.models).toEqual([]);
			expect(fresh.modelId).toBeUndefined();
			expect(fresh.contextLength).toBeUndefined();
		});

		it("rejects incomplete token refresh responses", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => jsonResponse({ access_token: "new-access", refresh_token: "", expires_in: 0 })),
			);

			await expect(
				refreshKimiCodingToken({ refresh: "old-refresh", access: "old-access", expires: 0 }),
			).rejects.toThrow("Invalid token response fields");
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
				expires: Date.now() + 120_000,
			};
			expect(kimiCodingOAuthProvider.getApiKey(creds)).toBe("my-access-token");
		});
	});

	// ------------------------------------------------------------------------
	// modifyModels
	// ------------------------------------------------------------------------
	describe("modifyModels", () => {
		const buildStaticModels = () => [
			{
				id: "kimi-for-coding",
				name: "Kimi For Coding",
				api: "openai-completions" as const,
				provider: "kimi-coding-oauth" as const,
				baseUrl: "https://api.kimi.com/coding/v1",
				reasoning: true,
				input: ["text", "image"] as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 32768,
				compat: { thinkingFormat: "kimi" as const, supportsDeveloperRole: false as const },
			},
			{
				id: "k3",
				name: "Kimi K3",
				api: "openai-completions" as const,
				provider: "kimi-coding-oauth" as const,
				baseUrl: "https://api.kimi.com/coding/v1",
				reasoning: true,
				input: ["text", "image"] as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1048576,
				maxTokens: 32768,
				compat: { thinkingFormat: "kimi" as const, supportsDeveloperRole: false as const },
			},
			{
				id: "kimi-for-coding-highspeed",
				name: "Kimi For Coding Highspeed",
				api: "openai-completions" as const,
				provider: "kimi-coding-oauth" as const,
				baseUrl: "https://api.kimi.com/coding/v1",
				reasoning: true,
				input: ["text", "image"] as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 32768,
				compat: { thinkingFormat: "kimi" as const, supportsDeveloperRole: false as const },
			},
		];

		it("keeps static fallbacks when no discovery is available", () => {
			const creds: OAuthCredentials = {
				refresh: "r",
				access: "a",
				expires: Date.now() + 120_000,
			};

			const result = kimiCodingOAuthProvider.modifyModels!(buildStaticModels(), creds);
			const ids = result.map((m) => m.id).sort();

			expect(ids).toEqual(["k3", "kimi-for-coding", "kimi-for-coding-highspeed"]);
			for (const m of result) {
				expect(m.headers).toMatchObject({
					"User-Agent": expect.stringMatching(/^dreb\//),
					"X-Msh-Platform": "kimi_code_cli",
				});
				expect(m.input).toContain("image");
			}
		});

		it("matches discovered models by ID and updates metadata", () => {
			const creds: OAuthCredentials & { models?: KimiModelInfo[] } = {
				refresh: "r",
				access: "a",
				expires: Date.now() + 120_000,
				models: [
					{
						id: "k3",
						display_name: "Kimi K3 Discovered",
						context_length: 2097152,
						supports_reasoning: false,
						supports_image_in: false,
						supports_tool_use: true,
						supports_thinking_type: "only",
						protocol: "kimi",
						think_efforts: {
							support: true,
							valid_efforts: ["low", "high", "max"],
							default_effort: "max",
						},
					},
				],
			};

			const result = kimiCodingOAuthProvider.modifyModels!(buildStaticModels(), creds);
			const k3 = result.find((m) => m.id === "k3");

			expect(k3).toBeDefined();
			expect(k3?.name).toBe("Kimi K3 Discovered");
			expect(k3?.contextWindow).toBe(2097152);
			expect(k3?.input).toEqual(["text"]);
			expect(k3?.reasoning).toBe(true);
			expect((k3 as Model<"openai-completions"> | undefined)?.compat?.reasoningEffortMap).toEqual({
				minimal: "low",
				low: "low",
				medium: "high",
				high: "high",
				xhigh: "max",
			});
			expect(k3?.headers).toMatchObject({ "X-Msh-Platform": "kimi_code_cli" });
		});

		it("templates future discovered IDs from the static fallback", () => {
			const creds: OAuthCredentials & { models?: KimiModelInfo[] } = {
				refresh: "r",
				access: "a",
				expires: Date.now() + 120_000,
				models: [
					{
						id: "kimi-future-model",
						display_name: "Kimi Future",
						context_length: 524288,
					},
				],
			};

			const result = kimiCodingOAuthProvider.modifyModels!(buildStaticModels(), creds);
			const future = result.find((m) => m.id === "kimi-future-model");

			expect(future).toBeDefined();
			expect(future?.name).toBe("Kimi Future");
			expect(future?.contextWindow).toBe(524288);
			expect(future?.reasoning).toBe(false);
			expect(future?.baseUrl).toBe("https://api.kimi.com/coding/v1");
			expect(future?.input).toEqual(["text"]);
		});

		it("preserves distinct IDs and exposes discovered entitlements", () => {
			const creds: OAuthCredentials & { models?: KimiModelInfo[] } = {
				refresh: "r",
				access: "a",
				expires: Date.now() + 120_000,
				models: [
					{ id: "k3", display_name: "K3", context_length: 1048576 },
					{ id: "k3", display_name: "K3 dup", context_length: 1048576 },
					{ id: "kimi-for-coding", display_name: "Default", context_length: 262144 },
				],
			};

			const result = kimiCodingOAuthProvider.modifyModels!(buildStaticModels(), creds);
			const ids = result.map((m) => m.id);

			expect(new Set(ids).size).toBe(ids.length);
			expect(ids).toContain("k3");
			expect(ids).toContain("kimi-for-coding");
			expect(ids).not.toContain("kimi-for-coding-highspeed");
		});

		it("omits discovered models that require an unsupported protocol or lack tool use", () => {
			const creds: OAuthCredentials & { models?: KimiModelInfo[] } = {
				refresh: "r",
				access: "a",
				expires: Date.now() + 120_000,
				models: [
					{ id: "k3", display_name: "K3", context_length: 1048576, protocol: "anthropic" },
					{
						id: "kimi-for-coding",
						display_name: "Default",
						context_length: 262144,
						supports_tool_use: false,
					},
				],
			};

			const result = kimiCodingOAuthProvider.modifyModels!(buildStaticModels(), creds);
			expect(result.filter((model) => model.provider === "kimi-coding-oauth")).toEqual([]);
		});

		it("treats successful discovery as authoritative", () => {
			const creds: OAuthCredentials & { models?: KimiModelInfo[] } = {
				refresh: "r",
				access: "a",
				expires: Date.now() + 120_000,
				models: [{ id: "k3", display_name: "K3", context_length: 1048576 }],
			};

			const result = kimiCodingOAuthProvider.modifyModels!(buildStaticModels(), creds);

			expect(result.filter((m) => m.provider === "kimi-coding-oauth").map((m) => m.id)).toEqual(["k3"]);
		});

		it("preserves static IDs and appends an unknown legacy model", () => {
			const creds: OAuthCredentials & {
				modelId?: string;
				contextLength?: number;
			} = {
				refresh: "r",
				access: "a",
				expires: Date.now() + 120_000,
				modelId: "kimi-k2-0715-chat",
				contextLength: 131072,
			};

			const result = kimiCodingOAuthProvider.modifyModels!(buildStaticModels(), creds);
			const ids = result.map((m) => m.id);

			expect(ids).toEqual(["kimi-for-coding", "k3", "kimi-for-coding-highspeed", "kimi-k2-0715-chat"]);
			expect(new Set(ids).size).toBe(ids.length);
			expect(result.at(-1)?.contextWindow).toBe(131072);
			for (const m of result) {
				expect(m.headers).toMatchObject({ "X-Msh-Platform": "kimi_code_cli" });
			}
		});

		it("leaves non-Kimi-OAuth models unchanged", () => {
			const creds: OAuthCredentials = {
				refresh: "r",
				access: "a",
				expires: Date.now() + 120_000,
			};

			const otherModel = {
				id: "other-model",
				name: "Other",
				api: "openai-completions" as const,
				provider: "other-provider" as const,
				baseUrl: "https://other.example.com",
				reasoning: false,
				input: ["text"] as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 2048,
			};

			const result = kimiCodingOAuthProvider.modifyModels!([...buildStaticModels(), otherModel], creds);
			const other = result.find((m) => m.provider === "other-provider");

			expect(other?.headers).toBeUndefined();
			expect(other?.id).toBe("other-model");
			expect(other?.contextWindow).toBe(8192);
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
