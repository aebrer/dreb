import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOAuthApiKey, registerOAuthProvider, unregisterOAuthProvider } from "../src/utils/oauth/index.js";
import { isOAuthTokenExpired, REFRESH_BUFFER_MS } from "../src/utils/oauth/types.js";
import type { OAuthCredentials } from "../src/utils/oauth/types.js";

describe("isOAuthTokenExpired", () => {
	it("returns false when now is exactly 1ms before the buffer boundary", () => {
		const expires = 1_000_000;
		const now = expires - REFRESH_BUFFER_MS - 1;
		const credentials = { refresh: "r", access: "a", expires };
		expect(isOAuthTokenExpired(credentials, now)).toBe(false);
	});

	it("returns true when now is exactly at the buffer boundary", () => {
		const expires = 1_000_000;
		const now = expires - REFRESH_BUFFER_MS;
		const credentials = { refresh: "r", access: "a", expires };
		expect(isOAuthTokenExpired(credentials, now)).toBe(true);
	});

	it("returns true when now is exactly 1ms past the buffer boundary", () => {
		const expires = 1_000_000;
		const now = expires - REFRESH_BUFFER_MS + 1;
		const credentials = { refresh: "r", access: "a", expires };
		expect(isOAuthTokenExpired(credentials, now)).toBe(true);
	});

	it("returns true for non-finite expires values", () => {
		expect(isOAuthTokenExpired({ refresh: "r", access: "a", expires: NaN }, 0)).toBe(true);
		expect(isOAuthTokenExpired({ refresh: "r", access: "a", expires: undefined as any }, 0)).toBe(true);
		expect(isOAuthTokenExpired({ refresh: "r", access: "a", expires: Infinity }, 0)).toBe(true);
	});

	it("defaults now to Date.now()", () => {
		const future = Date.now() + 3600_000;
		const credentials = { refresh: "r", access: "a", expires: future };
		expect(isOAuthTokenExpired(credentials)).toBe(false);

		const past = Date.now() - 1000;
		const expired = { refresh: "r", access: "a", expires: past };
		expect(isOAuthTokenExpired(expired)).toBe(true);
	});
});

describe("getOAuthApiKey", () => {
	const providerId = `test-oauth-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;

	beforeEach(() => {
		registerOAuthProvider({
			id: providerId,
			name: "Test OAuth Provider",
			async login() {
				throw new Error("Not used in this test");
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: "refreshed-access-token",
					expires: Date.now() + 3600_000,
				};
			},
			getApiKey(credentials) {
				return `Bearer ${credentials.access}`;
			},
		});
	});

	afterEach(() => {
		unregisterOAuthProvider(providerId);
		vi.useRealTimers();
	});

	it("returns current access token when token is far from expiry", async () => {
		const now = 1_000_000;
		vi.setSystemTime(now);

		const credentials: Record<string, OAuthCredentials> = {
			[providerId]: {
				refresh: "refresh-token",
				access: "current-access-token",
				expires: now + REFRESH_BUFFER_MS + 5000,
			},
		};

		const result = await getOAuthApiKey(providerId, credentials);
		expect(result).not.toBeNull();
		expect(result?.apiKey).toBe("Bearer current-access-token");
		expect(result?.newCredentials.access).toBe("current-access-token");
	});

	it("refreshes token when within the proactive buffer", async () => {
		const now = 1_000_000;
		vi.setSystemTime(now);

		const credentials: Record<string, OAuthCredentials> = {
			[providerId]: {
				refresh: "refresh-token",
				access: "current-access-token",
				expires: now + REFRESH_BUFFER_MS - 1000,
			},
		};

		const result = await getOAuthApiKey(providerId, credentials);
		expect(result).not.toBeNull();
		expect(result?.apiKey).toBe("Bearer refreshed-access-token");
		expect(result?.newCredentials.access).toBe("refreshed-access-token");
	});

	it("refreshes short-lifetime tokens that are immediately within the buffer", async () => {
		const now = 1_000_000;
		vi.setSystemTime(now);

		unregisterOAuthProvider(providerId);
		registerOAuthProvider({
			id: providerId,
			name: "Short Token Provider",
			async login() {
				throw new Error("Not used");
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: "long-lived-token",
					expires: now + 3600_000,
				};
			},
			getApiKey(credentials) {
				return `Bearer ${credentials.access}`;
			},
		});

		const credentials: Record<string, OAuthCredentials> = {
			[providerId]: {
				refresh: "refresh-token",
				access: "short-lived-token",
				expires: now + 30_000,
			},
		};

		const result = await getOAuthApiKey(providerId, credentials);
		expect(result).not.toBeNull();
		expect(result?.apiKey).toBe("Bearer long-lived-token");
		expect(result?.newCredentials.access).toBe("long-lived-token");
		expect(result?.newCredentials.expires).toBe(now + 3600_000);
	});

	it("refreshes token when already expired", async () => {
		const now = 1_000_000;
		vi.setSystemTime(now);

		const credentials: Record<string, OAuthCredentials> = {
			[providerId]: {
				refresh: "refresh-token",
				access: "expired-access-token",
				expires: now - 1000,
			},
		};

		const result = await getOAuthApiKey(providerId, credentials);
		expect(result).not.toBeNull();
		expect(result?.apiKey).toBe("Bearer refreshed-access-token");
		expect(result?.newCredentials.access).toBe("refreshed-access-token");
	});

	it("returns null when credentials are missing", async () => {
		const credentials: Record<string, OAuthCredentials> = {};
		const result = await getOAuthApiKey(providerId, credentials);
		expect(result).toBeNull();
	});

	it("throws wrapped error when refresh fails", async () => {
		const now = 1_000_000;
		vi.setSystemTime(now);

		unregisterOAuthProvider(providerId);
		registerOAuthProvider({
			id: providerId,
			name: "Failing Provider",
			async login() {
				throw new Error("Not used");
			},
			async refreshToken() {
				throw new Error("network error");
			},
			getApiKey(credentials) {
				return `Bearer ${credentials.access}`;
			},
		});

		const credentials: Record<string, OAuthCredentials> = {
			[providerId]: {
				refresh: "refresh-token",
				access: "expired-access-token",
				expires: now - 1000,
			},
		};

		await expect(getOAuthApiKey(providerId, credentials)).rejects.toThrow(
			`Failed to refresh OAuth token for ${providerId}`,
		);
	});
});
