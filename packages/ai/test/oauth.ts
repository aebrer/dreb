/**
 * Test helper for resolving API keys from ~/.dreb/agent/auth.json
 *
 * Supports both API key and OAuth credentials.
 * OAuth tokens are automatically refreshed if expired and saved back to auth.json.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { getGitHubCopilotBaseUrl, getOAuthApiKey } from "../src/utils/oauth/index.js";
import type { OAuthCredentials, OAuthProvider } from "../src/utils/oauth/types.js";

/**
 * Override a github-copilot model's `baseUrl` with the API endpoint derived
 * from the resolved OAuth token's `proxy-ep`.
 *
 * This mirrors the production `modifyModels` hook in `github-copilot.ts`, which
 * rewrites the hardcoded `api.individual.githubcopilot.com` base URL to the
 * correct proxy for the account type (individual / business / enterprise).
 * Without this, business/enterprise tokens are routed to the individual
 * endpoint and the API responds with `421 Misdirected Request`.
 *
 * No-ops for non-copilot models or when the token is unavailable (the matching
 * E2E tests skip themselves when the token is absent).
 */
export function applyCopilotBaseUrl<T extends { provider: string; baseUrl: string }>(
	model: T,
	token: string | undefined,
): T {
	if (model.provider !== "github-copilot" || !token) return model;
	return { ...model, baseUrl: getGitHubCopilotBaseUrl(token) };
}

const AUTH_PATH = join(homedir(), ".dreb", "agent", "auth.json");

type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

type OAuthCredentialEntry = {
	type: "oauth";
} & OAuthCredentials;

type AuthCredential = ApiKeyCredential | OAuthCredentialEntry;

type AuthStorage = Record<string, AuthCredential>;

function loadAuthStorage(): AuthStorage {
	if (!existsSync(AUTH_PATH)) {
		return {};
	}
	try {
		const content = readFileSync(AUTH_PATH, "utf-8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

function saveAuthStorage(storage: AuthStorage): void {
	const configDir = dirname(AUTH_PATH);
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
	}
	writeFileSync(AUTH_PATH, JSON.stringify(storage, null, 2), "utf-8");
	chmodSync(AUTH_PATH, 0o600);
}

/**
 * Resolve API key for a provider from ~/.dreb/agent/auth.json
 *
 * For API key credentials, returns the key directly.
 * For OAuth credentials, returns the access token (refreshing if expired and saving back).
 *
 * For google-gemini-cli and google-antigravity, returns JSON-encoded { token, projectId }
 */
export async function resolveApiKey(provider: string): Promise<string | undefined> {
	if (process.env.DREB_SKIP_LIVE_API === "1") return undefined;

	const storage = loadAuthStorage();
	const entry = storage[provider];

	if (!entry) return undefined;

	if (entry.type === "api_key") {
		return entry.key;
	}

	if (entry.type === "oauth") {
		// Build OAuthCredentials record for getOAuthApiKey
		const oauthCredentials: Record<string, OAuthCredentials> = {};
		for (const [key, value] of Object.entries(storage)) {
			if (value.type === "oauth") {
				const { type: _, ...creds } = value;
				oauthCredentials[key] = creds;
			}
		}

		let result: Awaited<ReturnType<typeof getOAuthApiKey>> | undefined;
		try {
			result = await getOAuthApiKey(provider as OAuthProvider, oauthCredentials);
		} catch {
			// Provider not registered as OAuth (e.g. "anthropic" with an OAuth entry
			// in auth.json but no OAuth handler registered in the test environment)
			return undefined;
		}
		if (!result) return undefined;

		// Save refreshed credentials back to auth.json
		storage[provider] = { type: "oauth", ...result.newCredentials };
		saveAuthStorage(storage);

		return result.apiKey;
	}

	return undefined;
}
