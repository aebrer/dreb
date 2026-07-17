/**
 * Kimi For Coding OAuth flow (device code)
 *
 * Authenticates against Moonshot's Kimi API (auth.kimi.com) using the current Kimi Code device identity.
 * Uses the device authorization grant flow to obtain access/refresh tokens,
 * then discovers the user's model entitlement via the /models endpoint.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "../../types.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

function readDrebVersion(): string {
	try {
		const pkg = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf-8")) as {
			version?: unknown;
		};
		if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
	} catch {
		// Fall back for unusual bundlers that omit package.json.
	}
	return "unknown";
}

const DREB_VERSION = readDrebVersion();
const USER_AGENT = `dreb/${DREB_VERSION}`;
const OAUTH_HOST = "https://auth.kimi.com";
const OAUTH_DEVICE_AUTH_URL = `${OAUTH_HOST}/api/oauth/device_authorization`;
const OAUTH_TOKEN_URL = `${OAUTH_HOST}/api/oauth/token`;
const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const OAUTH_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const OAUTH_REFRESH_GRANT = "refresh_token";
const API_BASE_URL = "https://api.kimi.com/coding/v1";

const KIMI_CODE_HOME = path.join(os.homedir(), ".kimi-code");
const DEVICE_ID_PATH = path.join(KIMI_CODE_HOME, "device_id");

const MAX_REFRESH_RETRIES = 3;
const MAX_DEVICE_FLOW_MS = 15 * 60 * 1000;

// ============================================================================
// Device ID
// ============================================================================

let sessionDeviceId: string | undefined;

function getDeviceId(): string {
	if (sessionDeviceId) return sessionDeviceId;
	try {
		if (fs.existsSync(DEVICE_ID_PATH)) {
			const id = fs.readFileSync(DEVICE_ID_PATH, "utf-8").trim();
			if (id.length > 0) {
				sessionDeviceId = id;
				return id;
			}
		}
	} catch {
		// Fall through to generate.
	}

	const id = randomUUID();
	sessionDeviceId = id;
	try {
		fs.mkdirSync(KIMI_CODE_HOME, { recursive: true, mode: 0o700 });
		fs.writeFileSync(DEVICE_ID_PATH, id, { encoding: "utf-8", mode: 0o600 });
	} catch {
		// If we can't persist, just use the generated ID for this session.
	}
	return id;
}

// ============================================================================
// Header helpers
// ============================================================================

/**
 * Strip non-ASCII characters from a string for use in HTTP header values.
 */
function asciiHeaderValue(value: string, fallback = "unknown"): string {
	const cleaned = value.replace(/[^\x20-\x7E]/g, "").trim();
	return cleaned.length > 0 ? cleaned : fallback;
}

function customKimiHeaders(): Record<string, string> {
	const raw = process.env.KIMI_CODE_CUSTOM_HEADERS?.trim();
	if (!raw) return {};
	const headers: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const name = line.slice(0, colon).trim();
		if (!name) continue;
		headers[name] = line.slice(colon + 1).trim();
	}
	return headers;
}

/**
 * Determine the device model string, mirroring kimi-cli logic.
 */
function kimiDeviceModel(): string {
	const platform = os.platform();
	const machine = os.arch();

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
		return `Windows ${os.release()} ${machine}`;
	}

	// Linux and other
	return `${os.type()} ${os.release()} ${machine}`.trim();
}

/**
 * Build the standard set of headers required on every Kimi API request.
 */
export function buildKimiHeaders(): Record<string, string> {
	return {
		...customKimiHeaders(),
		"User-Agent": USER_AGENT,
		"X-Msh-Platform": "kimi_code_cli",
		"X-Msh-Version": DREB_VERSION,
		"X-Msh-Device-Name": asciiHeaderValue(os.hostname()),
		"X-Msh-Device-Model": asciiHeaderValue(kimiDeviceModel()),
		"X-Msh-Device-Id": getDeviceId(),
		"X-Msh-Os-Version": asciiHeaderValue(os.release()),
	};
}

// ============================================================================
// Types
// ============================================================================

type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri_complete: string;
	interval: number;
	expires_in: number;
};

type TokenSuccessResponse = {
	access_token: string;
	refresh_token: string;
	expires_in: number;
};

function parseTokenSuccess(response: Record<string, unknown>): TokenSuccessResponse {
	if (
		typeof response.access_token !== "string" ||
		response.access_token.length === 0 ||
		typeof response.refresh_token !== "string" ||
		response.refresh_token.length === 0 ||
		typeof response.expires_in !== "number" ||
		!Number.isFinite(response.expires_in) ||
		response.expires_in <= 0
	) {
		throw new Error("Invalid token response fields");
	}
	return response as unknown as TokenSuccessResponse;
}

export type KimiModelInfo = {
	id: string;
	display_name: string;
	context_length: number;
	supports_reasoning?: boolean;
	supports_image_in?: boolean;
	supports_video_in?: boolean;
	supports_tool_use?: boolean;
	supports_thinking_type?: "only" | "no" | "both";
	think_efforts?: {
		support?: boolean;
		valid_efforts?: string[];
		default_effort?: string;
	};
	protocol?: "kimi" | "anthropic" | string;
	[key: string]: unknown;
};

type KimiCredentials = OAuthCredentials & {
	/** Full list of models discovered from the Kimi API. */
	models?: KimiModelInfo[];
	/** @deprecated Kept for legacy credential compatibility; derived from models[0]. */
	modelId?: string;
	/** @deprecated Kept for legacy credential compatibility; derived from models[0]. */
	contextLength?: number;
	/** @deprecated Kept for legacy credential compatibility; derived from models[0]. */
	modelDisplay?: string;
};

// ============================================================================
// Network helpers
// ============================================================================

const REQUEST_TIMEOUT_MS = 30_000;

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

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
export async function listModels(accessToken: string, signal?: AbortSignal): Promise<KimiModelInfo[]> {
	const raw = await fetchJson(`${API_BASE_URL}/models`, {
		signal: requestSignal(signal),
		headers: {
			...buildKimiHeaders(),
			Authorization: `Bearer ${accessToken}`,
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

async function startDeviceFlow(signal?: AbortSignal): Promise<DeviceCodeResponse> {
	const data = await fetchJson(OAUTH_DEVICE_AUTH_URL, {
		method: "POST",
		signal: requestSignal(signal),
		headers: {
			...buildKimiHeaders(),
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID }),
	});

	if (!data || typeof data !== "object") {
		throw new Error("Invalid device code response");
	}

	const d = data as Record<string, unknown>;
	const device_code = d.device_code;
	const user_code = d.user_code;
	const verification_uri_complete =
		typeof d.verification_uri_complete === "string"
			? d.verification_uri_complete
			: typeof d.verification_uri === "string"
				? `${d.verification_uri}${d.verification_uri.includes("?") ? "&" : "?"}user_code=${encodeURIComponent(user_code as string)}`
				: undefined;
	const interval = d.interval;
	const expires_in = d.expires_in;

	if (
		typeof device_code !== "string" ||
		typeof user_code !== "string" ||
		typeof verification_uri_complete !== "string" ||
		typeof interval !== "number" ||
		typeof expires_in !== "number"
	) {
		throw new Error("Invalid device code response fields");
	}

	return { device_code, user_code, verification_uri_complete, interval, expires_in };
}

class DeviceCodeExpiredError extends Error {
	constructor() {
		super("Device code expired");
		this.name = "DeviceCodeExpiredError";
	}
}

async function pollForAccessToken(
	deviceCode: string,
	intervalSeconds: number,
	expiresIn: number,
	signal?: AbortSignal,
	overallDeadline = Date.now() + MAX_DEVICE_FLOW_MS,
): Promise<TokenSuccessResponse> {
	const deadline = Math.min(Date.now() + expiresIn * 1000, overallDeadline);
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
			signal: requestSignal(signal),
			headers: {
				...buildKimiHeaders(),
				"Content-Type": "application/x-www-form-urlencoded",
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
			return parseTokenSuccess(resp);
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
				throw new DeviceCodeExpiredError();
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
	if (error instanceof TypeError || error.name === "TimeoutError") return true;
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
				signal: requestSignal(signal),
				headers: {
					...buildKimiHeaders(),
					"Content-Type": "application/x-www-form-urlencoded",
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
			if (!raw || typeof raw !== "object") throw new Error("Invalid token refresh response");
			return parseTokenSuccess(raw as Record<string, unknown>);
		} catch (error) {
			if (signal?.aborted) throw new Error("Refresh cancelled");
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
	const overallDeadline = Date.now() + MAX_DEVICE_FLOW_MS;
	let tokenResp: TokenSuccessResponse;
	while (true) {
		const device = await startDeviceFlow(options.signal);
		options.onAuth({
			url: device.verification_uri_complete,
			instructions: `Enter code: ${device.user_code}`,
		});

		try {
			tokenResp = await pollForAccessToken(
				device.device_code,
				device.interval,
				device.expires_in,
				options.signal,
				overallDeadline,
			);
			break;
		} catch (error) {
			if (error instanceof DeviceCodeExpiredError && Date.now() < overallDeadline) continue;
			throw error;
		}
	}

	// Discover model entitlement. Undefined means discovery failed; an empty
	// array is a successful, authoritative response.
	options.onProgress?.("Discovering available models...");
	let models: KimiModelInfo[] | undefined;
	try {
		models = await listModels(tokenResp.access_token, options.signal);
	} catch {
		if (options.signal?.aborted) throw new Error("Login cancelled");
		// Proceed without model enrichment if the models endpoint fails
	}

	const credentials: KimiCredentials = {
		refresh: tokenResp.refresh_token,
		access: tokenResp.access_token,
		expires: Date.now() + tokenResp.expires_in * 1000,
	};

	if (models) {
		credentials.models = models;
		const primary = models[0];
		if (primary) {
			credentials.modelId = primary.id;
			credentials.contextLength = primary.context_length;
			credentials.modelDisplay = primary.display_name;
		}
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

	// Re-discover model entitlement. Undefined means discovery failed; an empty
	// array is a successful, authoritative response.
	let models: KimiModelInfo[] | undefined;
	try {
		models = await listModels(tokenResp.access_token, signal);
	} catch {
		if (signal?.aborted) throw new Error("Refresh cancelled");
		// Proceed without model enrichment if the models endpoint fails
	}

	const oldCreds = credentials as KimiCredentials;
	const fresh: KimiCredentials = {
		refresh: tokenResp.refresh_token ?? credentials.refresh,
		access: tokenResp.access_token,
		expires: Date.now() + tokenResp.expires_in * 1000,
		models: oldCreds.models,
		modelId: oldCreds.modelId,
		contextLength: oldCreds.contextLength,
		modelDisplay: oldCreds.modelDisplay,
	};

	if (models) {
		fresh.models = models;
		const primary = models[0];
		fresh.modelId = primary?.id;
		fresh.contextLength = primary?.context_length;
		fresh.modelDisplay = primary?.display_name;
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

		const staticModels = models.filter((m) => m.provider === "kimi-coding-oauth");
		if (staticModels.length === 0) {
			return models;
		}

		const injectHeaders = (m: Model<Api>): Model<Api> => ({
			...m,
			headers: { ...(m.headers || {}), ...headers },
		});

		const staticById = new Map(staticModels.map((m) => [m.id, m]));
		const fallbackTemplate = staticById.get("kimi-for-coding") ?? staticModels[0];

		// No discovery (or failed discovery): keep the static fallback list intact.
		// Legacy credentials describe one discovered model, so enrich or append only
		// that model rather than collapsing every static entry to the same ID.
		const discovered = creds.models;
		if (!discovered) {
			const fallbackModels = models.map((m) => {
				if (m.provider !== "kimi-coding-oauth") return m;

				const updated: Model<Api> = {
					...m,
					// The OAuth coding endpoint accepts OpenAI-style image_url data URLs;
					// keep this capability even if static metadata is stale.
					input: Array.from(new Set([...m.input, "image" as const])),
				};
				if (creds.modelId === m.id && creds.contextLength) {
					updated.contextWindow = creds.contextLength;
				}
				if (creds.modelId === m.id && creds.modelDisplay) {
					updated.name = creds.modelDisplay;
				}
				return injectHeaders(updated);
			});

			if (creds.modelId && !staticById.has(creds.modelId)) {
				fallbackModels.push(
					injectHeaders({
						...fallbackTemplate,
						id: creds.modelId,
						name: creds.modelDisplay || creds.modelId,
						contextWindow: creds.contextLength || fallbackTemplate.contextWindow,
					}),
				);
			}
			return fallbackModels;
		}

		const discoveredInput = (base: Model<Api>, info: KimiModelInfo): Model<Api>["input"] => {
			if (info.supports_image_in === true) return Array.from(new Set([...base.input, "image" as const]));
			if (info.supports_image_in === false) return base.input.filter((input) => input !== "image");
			return base.input;
		};

		const discoveredCompat = (base: Model<Api>, info: KimiModelInfo): Model<Api>["compat"] => {
			const valid = info.think_efforts?.support ? info.think_efforts.valid_efforts : undefined;
			if (!valid || valid.length === 0) return base.compat;
			const efforts = new Set(valid);
			const declaredDefault = info.think_efforts?.default_effort;
			const validDefault = declaredDefault && efforts.has(declaredDefault) ? declaredDefault : undefined;
			const choose = (...preferences: string[]): string =>
				preferences.find((effort) => efforts.has(effort)) ?? validDefault ?? valid[0];
			return {
				...base.compat,
				reasoningEffortMap: {
					minimal: choose("minimal", "low", "medium", "high", "max"),
					low: choose("low", "minimal", "medium", "high", "max"),
					medium: choose("medium", "high", "low", "max"),
					high: choose("high", "medium", "max", "low"),
					xhigh: choose("max", "xhigh", "high", "medium", "low"),
				},
			};
		};

		// Apply discovered metadata to a static model, preserving its static shape.
		const applyDiscovery = (staticModel: Model<Api>, info: KimiModelInfo): Model<Api> => {
			const updated: Model<Api> = {
				...staticModel,
				id: info.id,
				name: info.display_name || info.id,
				contextWindow: info.context_length || staticModel.contextWindow,
				input: discoveredInput(staticModel, info),
				compat: discoveredCompat(staticModel, info),
			};
			if (info.supports_thinking_type === "only") {
				updated.reasoning = true;
			} else if (info.supports_thinking_type === "no") {
				updated.reasoning = false;
			} else if (typeof info.supports_reasoning === "boolean") {
				updated.reasoning = info.supports_reasoning;
			}
			return injectHeaders(updated);
		};

		// Safely template a future/discovered model ID using the static fallback.
		const templateDiscovery = (info: KimiModelInfo): Model<Api> => {
			const templated: Model<Api> = {
				...fallbackTemplate,
				id: info.id,
				name: info.display_name || info.id,
				contextWindow: info.context_length || fallbackTemplate.contextWindow,
				reasoning:
					info.supports_thinking_type === undefined
						? (info.supports_reasoning ?? false)
						: info.supports_thinking_type !== "no",
				input: info.supports_image_in === true ? ["text", "image"] : ["text"],
				compat: discoveredCompat(fallbackTemplate, info),
			};
			return injectHeaders(templated);
		};

		// The official client treats only the explicit "anthropic" protocol as a
		// separate wire format; absent and future values use the default Kimi route.
		const supportedDiscovered = discovered.filter(
			(info) => info.supports_tool_use !== false && info.protocol !== "anthropic",
		);
		const result: Model<Api>[] = [];
		const seen = new Set<string>();

		// 1. Walk the original model list to preserve order, replacing discovered
		//    static models and dropping undiscovered entries. A successful response
		//    is authoritative for the subscription's current entitlements.
		for (const m of models) {
			if (m.provider !== "kimi-coding-oauth") {
				result.push(m);
				continue;
			}

			const info = staticById.has(m.id) ? supportedDiscovered.find((d) => d.id === m.id) : undefined;
			if (info) {
				result.push(applyDiscovery(m, info));
				seen.add(info.id);
			}
		}

		// 2. Discovered models with IDs not present in the static list are templated
		//    from the fallback so future model IDs are safely usable.
		for (const info of supportedDiscovered) {
			if (!seen.has(info.id)) {
				result.push(templateDiscovery(info));
				seen.add(info.id);
			}
		}

		return result;
	},
};
