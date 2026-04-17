/**
 * Kimi For Coding OAuth flow (device code)
 *
 * Authenticates against Moonshot's Kimi API (auth.kimi.com) with scope "kimi-code".
 * Uses the device authorization grant flow to obtain access/refresh tokens,
 * then discovers the user's model entitlement via the /models endpoint.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "../../types.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const KIMI_CLI_VERSION = "1.35.0";
const USER_AGENT = `KimiCLI/${KIMI_CLI_VERSION}`;
const OAUTH_HOST = "https://auth.kimi.com";
const OAUTH_DEVICE_AUTH_URL = `${OAUTH_HOST}/api/oauth/device_authorization`;
const OAUTH_TOKEN_URL = `${OAUTH_HOST}/api/oauth/token`;
const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const OAUTH_SCOPE = "kimi-code";
const OAUTH_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const OAUTH_REFRESH_GRANT = "refresh_token";
const API_BASE_URL = "https://api.kimi.com/coding/v1";

const DEVICE_ID_PATH = path.join(os.homedir(), ".kimi", "device_id");

const MAX_REFRESH_RETRIES = 3;

// ============================================================================
// Device ID
// ============================================================================

function generateDeviceId(): string {
	// UUID v4 without dashes (hex only, 32 chars)
	return "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

function getDeviceId(): string {
	try {
		if (fs.existsSync(DEVICE_ID_PATH)) {
			const id = fs.readFileSync(DEVICE_ID_PATH, "utf-8").trim();
			if (/^[0-9a-f]{32}$/i.test(id)) {
				return id;
			}
		}
	} catch {
		// Fall through to generate
	}

	const id = generateDeviceId();
	try {
		fs.mkdirSync(path.dirname(DEVICE_ID_PATH), { recursive: true });
		fs.writeFileSync(DEVICE_ID_PATH, id, "utf-8");
	} catch {
		// If we can't persist, just use the generated ID for this session
	}
	return id;
}

// ============================================================================
// Header helpers
// ============================================================================

/**
 * Strip non-ASCII characters from a string for use in HTTP header values.
 */
function asciiHeaderValue(value: string): string {
	return value.replace(/[^\x20-\x7E]/g, "");
}

/**
 * Determine the device model string, mirroring kimi-cli logic.
 */
function kimiDeviceModel(): string {
	const platform = os.platform();
	const machine = os.machine?.() || process.arch;

	if (platform === "darwin") {
		let version: string;
		try {
			version = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf-8", timeout: 3000 }).trim();
		} catch {
			version = os.release();
		}
		return `macOS ${version} ${machine}`;
	}

	if (platform === "win32") {
		const release = os.release();
		const buildNumber = Number.parseInt(release.split(".").pop() || "0", 10);
		const label = buildNumber >= 22000 ? "11" : "10";
		return `Windows ${label} ${machine}`;
	}

	// Linux and other
	return `${os.type()} ${os.release()} ${machine}`;
}

/**
 * Build the standard set of headers required on every Kimi API request.
 */
export function buildKimiHeaders(): Record<string, string> {
	return {
		"User-Agent": USER_AGENT,
		"X-Msh-Platform": "kimi_cli",
		"X-Msh-Version": KIMI_CLI_VERSION,
		"X-Msh-Device-Name": asciiHeaderValue(os.hostname()),
		"X-Msh-Device-Model": asciiHeaderValue(kimiDeviceModel()),
		"X-Msh-Device-Id": getDeviceId(),
		"X-Msh-Os-Version": asciiHeaderValue(os.version?.() || `${os.type()} ${os.release()}`),
	};
}

// ============================================================================
// Types
// ============================================================================

type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
};

type TokenSuccessResponse = {
	access_token: string;
	refresh_token: string;
	expires_in: number;
};

export type KimiModelInfo = {
	id: string;
	display_name: string;
	context_length: number;
	supports_reasoning?: boolean;
	[key: string]: unknown;
};

type KimiCredentials = OAuthCredentials & {
	modelId?: string;
	contextLength?: number;
	modelDisplay?: string;
};

// ============================================================================
// Network helpers
// ============================================================================

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}
	return response.json();
}

/**
 * Sleep that can be interrupted by an AbortSignal.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}

		const timeout = setTimeout(resolve, ms);

		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

// ============================================================================
// Model discovery
// ============================================================================

/**
 * List available models from the Kimi API.
 * Returns the model info array from the response's `data` field.
 */
export async function listModels(accessToken: string): Promise<KimiModelInfo[]> {
	const raw = await fetchJson(`${API_BASE_URL}/models`, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			...buildKimiHeaders(),
		},
	});

	if (!raw || typeof raw !== "object") {
		throw new Error("Invalid models response");
	}

	const data = (raw as Record<string, unknown>).data;
	if (!Array.isArray(data)) {
		throw new Error("Invalid models response: expected data array");
	}

	return data as KimiModelInfo[];
}

// ============================================================================
// Device flow
// ============================================================================

async function startDeviceFlow(): Promise<DeviceCodeResponse> {
	const data = await fetchJson(OAUTH_DEVICE_AUTH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...buildKimiHeaders(),
		},
		body: new URLSearchParams({
			client_id: OAUTH_CLIENT_ID,
			scope: OAUTH_SCOPE,
		}),
	});

	if (!data || typeof data !== "object") {
		throw new Error("Invalid device code response");
	}

	const d = data as Record<string, unknown>;
	const device_code = d.device_code;
	const user_code = d.user_code;
	const verification_uri = d.verification_uri;
	const interval = d.interval;
	const expires_in = d.expires_in;

	if (
		typeof device_code !== "string" ||
		typeof user_code !== "string" ||
		typeof verification_uri !== "string" ||
		typeof interval !== "number" ||
		typeof expires_in !== "number"
	) {
		throw new Error("Invalid device code response fields");
	}

	return { device_code, user_code, verification_uri, interval, expires_in };
}

async function pollForAccessToken(
	deviceCode: string,
	intervalSeconds: number,
	expiresIn: number,
	signal?: AbortSignal,
): Promise<TokenSuccessResponse> {
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const remainingMs = deadline - Date.now();
		const waitMs = Math.min(intervalMs, remainingMs);
		await abortableSleep(waitMs, signal);

		const tokenResponse = await fetch(OAUTH_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				...buildKimiHeaders(),
			},
			body: new URLSearchParams({
				client_id: OAUTH_CLIENT_ID,
				device_code: deviceCode,
				grant_type: OAUTH_DEVICE_GRANT,
			}),
		});

		// The token endpoint returns 400 for authorization_pending / slow_down / expired_token.
		// We must read the body regardless of status to handle the OAuth error codes.
		const resp = (await tokenResponse.json()) as Record<string, unknown>;

		// Success: has access_token
		if (typeof resp.access_token === "string") {
			return resp as unknown as TokenSuccessResponse;
		}

		// Error response (RFC 8628 §3.5)
		if (typeof resp.error === "string") {
			const error = resp.error;
			const description = resp.error_description as string | undefined;
			const newInterval = resp.interval as number | undefined;

			if (error === "authorization_pending") {
				continue;
			}

			if (error === "slow_down") {
				intervalMs =
					typeof newInterval === "number" && newInterval > 0
						? newInterval * 1000
						: Math.max(1000, intervalMs + 5000);
				continue;
			}

			if (error === "expired_token") {
				throw new Error("Device code expired. Please try logging in again.");
			}

			const descriptionSuffix = description ? `: ${description}` : "";
			throw new Error(`Device flow failed: ${error}${descriptionSuffix}`);
		}

		// Unexpected response: valid object but no access_token or error field
		throw new Error(`Unexpected token response: ${JSON.stringify(resp)}`);
	}

	throw new Error("Device flow timed out");
}

// ============================================================================
// Refresh with retry
// ============================================================================

const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

class RetriableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RetriableError";
	}
}

/**
 * Heuristic to detect network-level errors that should be retried.
 * Fetch throws TypeError on network failures; some runtimes include
 * recognizable substrings in the message.
 */
function isNetworkError(error: Error): boolean {
	if (error instanceof TypeError) return true;
	const msg = error.message.toLowerCase();
	return ["fetch failed", "econnrefused", "etimedout", "enotfound", "econnreset", "socket hang up"].some((s) =>
		msg.includes(s),
	);
}

async function refreshWithRetry(refreshToken: string, signal?: AbortSignal): Promise<TokenSuccessResponse> {
	let lastError: Error | undefined;

	for (let attempt = 0; attempt < MAX_REFRESH_RETRIES; attempt++) {
		if (signal?.aborted) {
			throw new Error("Refresh cancelled");
		}

		try {
			const response = await fetch(OAUTH_TOKEN_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					...buildKimiHeaders(),
				},
				body: new URLSearchParams({
					client_id: OAUTH_CLIENT_ID,
					refresh_token: refreshToken,
					grant_type: OAUTH_REFRESH_GRANT,
				}),
			});

			// Retry on retriable status codes
			if (RETRYABLE_STATUS_CODES.includes(response.status)) {
				throw new RetriableError(`Token refresh failed with status ${response.status}`);
			}

			if (!response.ok) {
				const text = await response.text();
				throw new Error(`Token refresh failed: ${response.status} ${response.statusText}: ${text}`);
			}

			const raw = await response.json();
			if (!raw || typeof raw !== "object" || typeof (raw as Record<string, unknown>).access_token !== "string") {
				throw new Error("Invalid token refresh response");
			}

			return raw as unknown as TokenSuccessResponse;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Wrap network errors (TypeError from fetch, or common network failure indicators) as retriable
			if (!(lastError instanceof RetriableError) && isNetworkError(lastError)) {
				lastError = new RetriableError(lastError.message);
			}

			// Retry on retriable errors (network failures or retriable HTTP status codes)
			if (lastError instanceof RetriableError && attempt < MAX_REFRESH_RETRIES - 1) {
				const backoffMs = Math.min(1000 * 2 ** attempt, 10000);
				await abortableSleep(backoffMs, signal);
				continue;
			}

			throw lastError;
		}
	}

	throw lastError ?? new Error("Token refresh failed after retries");
}

// ============================================================================
// Login flow
// ============================================================================

export async function loginKimiCoding(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const device = await startDeviceFlow();
	// Kimi's device page expects user_code as a query parameter
	const authUrl = new URL(device.verification_uri);
	authUrl.searchParams.set("user_code", device.user_code);
	options.onAuth({
		url: authUrl.toString(),
		instructions: `Enter code: ${device.user_code}`,
	});

	const tokenResp = await pollForAccessToken(device.device_code, device.interval, device.expires_in, options.signal);

	// Discover model entitlement
	options.onProgress?.("Discovering available models...");
	let models: KimiModelInfo[] = [];
	try {
		models = await listModels(tokenResp.access_token);
	} catch {
		// Proceed without model enrichment if the models endpoint fails
	}

	const credentials: KimiCredentials = {
		refresh: tokenResp.refresh_token,
		access: tokenResp.access_token,
		expires: Date.now() + tokenResp.expires_in * 1000,
	};

	if (models.length > 0) {
		const primary = models[0];
		credentials.modelId = primary.id;
		credentials.contextLength = primary.context_length;
		credentials.modelDisplay = primary.display_name;
	}

	return credentials;
}

// ============================================================================
// Refresh
// ============================================================================

export async function refreshKimiCodingToken(
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const tokenResp = await refreshWithRetry(credentials.refresh, signal);

	// Re-discover model entitlement
	let models: KimiModelInfo[] = [];
	try {
		models = await listModels(tokenResp.access_token);
	} catch {
		// Proceed without model enrichment if the models endpoint fails
	}

	const fresh: KimiCredentials = {
		refresh: tokenResp.refresh_token ?? credentials.refresh,
		access: tokenResp.access_token,
		expires: Date.now() + tokenResp.expires_in * 1000,
	};

	if (models.length > 0) {
		const primary = models[0];
		fresh.modelId = primary.id;
		fresh.contextLength = primary.context_length;
		fresh.modelDisplay = primary.display_name;
	}

	return fresh;
}

// ============================================================================
// Provider
// ============================================================================

export const kimiCodingOAuthProvider: OAuthProviderInterface = {
	id: "kimi-coding-oauth",
	name: "Kimi For Coding",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginKimiCoding({
			onAuth: callbacks.onAuth,
			onProgress: callbacks.onProgress,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshKimiCodingToken(credentials);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
		const creds = credentials as KimiCredentials;
		const headers = buildKimiHeaders();

		return models.map((m) => {
			if (m.provider !== "kimi-coding-oauth") return m;

			const updated = {
				...m,
				headers: { ...headers, ...(m.headers || {}) },
			};

			if (creds.modelId) {
				updated.id = creds.modelId;
			}

			if (creds.contextLength) {
				updated.contextWindow = creds.contextLength;
			}

			return updated;
		});
	},
};
