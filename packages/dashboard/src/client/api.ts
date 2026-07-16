/**
 * REST + SSE client for the dashboard server. Thin fetch wrappers — every
 * non-OK response throws with the server's error message (no silent fallback).
 */

import type {
	AgentTypeDto,
	AuthStatusDto,
	BackgroundAgentDto,
	ClientConnectionDiagnosticDto,
	CommandDto,
	ContextTrustMutationResultDto,
	DashboardResyncDto,
	DirListingDto,
	EventConnectionState,
	EventEnvelope,
	FleetDto,
	ImageAttachmentDto,
	ModelInfoDto,
	PairedDeviceDto,
	PairingCodeDto,
	PendingMessagesDto,
	PerformanceStatsDto,
	ResourcesDto,
	RuntimeInfoDto,
	SessionStatsDto,
	SettingsDto,
	SettingsSaveResultDto,
	TrustedFolderRemovalResultDto,
} from "../shared/protocol.js";

/**
 * Turn a non-JSON error body (typically Express's default HTML 404 page —
 * "Cannot GET /api/…") into a clean, single-line diagnostic. Dumping raw HTML
 * into an error box is unreadable; surface `METHOD /path → status` instead.
 */
function cleanErrorMessage(path: string, init: RequestInit | undefined, status: number, body: unknown): string {
	if (typeof body === "object" && body !== null && "error" in body) return String((body as any).error);
	const text = typeof body === "string" ? body : String(body);
	// Express default 404/500 pages are HTML; never render markup verbatim.
	if (/^\s*<(?:!doctype|html)/i.test(text)) {
		const method = (init?.method ?? "GET").toUpperCase();
		return `${method} ${path} → ${status} ${status === 404 ? "Not Found" : "error"}`;
	}
	return text.trim() || `Request failed (${status})`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	const contentType = res.headers.get("content-type") ?? "";
	const body = contentType.includes("application/json") ? await res.json() : await res.text();
	if (!res.ok) {
		const message = cleanErrorMessage(path, init, res.status, body);
		throw Object.assign(new Error(message), { status: res.status, body });
	}
	return body as T;
}

function json(body: unknown): RequestInit {
	return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export const api = {
	auth: () => request<AuthStatusDto & { needsPairing: boolean; identity?: string; error?: string }>("/api/auth"),
	connectionDiagnostic: (summary: ClientConnectionDiagnosticDto) =>
		request<{ ok: true }>("/api/events/diagnostic", json(summary)),
	pair: (pin: string) => request<{ device: PairedDeviceDto }>("/api/pair", json({ pin })),
	pairingCode: () => request<PairingCodeDto>("/api/pairing-code"),
	devices: () => request<{ devices: PairedDeviceDto[] }>("/api/devices"),
	unpair: (id: string) => request<{ ok: true }>(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),

	fleet: () => request<FleetDto>("/api/fleet"),
	resync: (key?: string, agentId?: string, signal?: AbortSignal) => {
		const query = new URLSearchParams();
		if (key) query.set("key", key);
		if (agentId) query.set("agentId", agentId);
		const suffix = query.size ? `?${query}` : "";
		return request<DashboardResyncDto>(`/api/resync${suffix}`, { signal });
	},
	createRuntime: (cwd: string, opts: { sessionPath?: string; firstPrompt?: string } = {}) =>
		request<RuntimeInfoDto>("/api/runtimes", json({ cwd, ...opts })),
	stopRuntime: (key: string) => request<{ ok: true }>(`/api/runtimes/${key}`, { method: "DELETE" }),
	runtime: (key: string, signal?: AbortSignal) => request<RuntimeInfoDto>(`/api/runtimes/${key}`, { signal }),
	messages: (key: string, signal?: AbortSignal) =>
		request<{ messages: unknown[] }>(`/api/runtimes/${key}/messages`, { signal }),
	pending: (key: string) => request<PendingMessagesDto>(`/api/runtimes/${key}/pending`),
	dequeue: (key: string) => request<PendingMessagesDto>(`/api/runtimes/${key}/dequeue`, { method: "POST" }),
	prompt: (key: string, message: string, mode?: "steer" | "follow_up", images?: ImageAttachmentDto[]) =>
		request<{ ok: true }>(`/api/runtimes/${key}/prompt`, json({ message, mode, images })),
	abort: (key: string) => request<{ ok: true }>(`/api/runtimes/${key}/abort`, { method: "POST" }),
	abortCompaction: (key: string) => request<{ ok: true }>(`/api/runtimes/${key}/abort-compaction`, { method: "POST" }),
	abortRetry: (key: string) => request<{ ok: true }>(`/api/runtimes/${key}/abort-retry`, { method: "POST" }),
	setModel: (key: string, provider: string, modelId: string) =>
		request<{ provider: string; id: string }>(`/api/runtimes/${key}/model`, json({ provider, modelId })),
	models: (key: string) => request<{ models: ModelInfoDto[] }>(`/api/runtimes/${key}/models`),
	setThinking: (key: string, level: string) => request<{ ok: true }>(`/api/runtimes/${key}/thinking`, json({ level })),
	compact: (key: string, instructions?: string) =>
		request<unknown>(`/api/runtimes/${key}/compact`, json({ instructions })),
	rename: (key: string, name: string) => request<{ ok: true }>(`/api/runtimes/${key}/name`, json({ name })),
	stats: (key: string) => request<SessionStatsDto>(`/api/runtimes/${key}/stats`),
	performance: (key: string) => request<PerformanceStatsDto>(`/api/runtimes/${key}/performance`),
	resources: (key: string) => request<ResourcesDto>(`/api/runtimes/${key}/resources`),
	commands: (key: string) => request<{ commands: CommandDto[] }>(`/api/runtimes/${key}/commands`),
	branch: (key: string) => request<{ branch: string | null }>(`/api/runtimes/${key}/branch`),
	forkMessages: (key: string) =>
		request<{ messages: Array<{ entryId: string; text: string }> }>(`/api/runtimes/${key}/fork-messages`),
	fork: (key: string, entryId: string) =>
		request<{ text: string; cancelled: boolean }>(`/api/runtimes/${key}/fork`, json({ entryId })),
	backgroundAgents: (key: string, signal?: AbortSignal) =>
		request<{ agents: BackgroundAgentDto[] }>(`/api/runtimes/${key}/background-agents`, { signal }),
	subagentMessages: (key: string, agentId: string, signal?: AbortSignal) =>
		request<{ agent: BackgroundAgentDto; messages: unknown[] }>(
			`/api/runtimes/${key}/subagents/${encodeURIComponent(agentId)}/messages`,
			{ signal },
		),
	extensionUiResponse: (key: string, response: Record<string, unknown>) =>
		request<{ ok: true }>(`/api/runtimes/${key}/extension-ui-response`, json(response)),
	exportHtmlUrl: (key: string) => `/api/runtimes/${key}/export-html`,

	deleteSession: (path: string) =>
		request<unknown>("/api/sessions", {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path }),
		}),

	settings: () => request<SettingsDto>("/api/settings"),
	saveSettings: (settings: SettingsDto) =>
		request<SettingsSaveResultDto>("/api/settings", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(settings),
		}),
	settingsModels: () => request<{ models: ModelInfoDto[] }>("/api/settings/models"),
	agentTypes: (cwd?: string) =>
		request<{ agentTypes: AgentTypeDto[] }>(
			cwd ? `/api/settings/agent-types?cwd=${encodeURIComponent(cwd)}` : "/api/settings/agent-types",
		),
	version: () => request<{ version: string }>("/api/version"),
	serverInfo: () =>
		request<{ version: string | null; startedAt: string; supervised: boolean; restartable: boolean }>(
			"/api/server/info",
		),
	restartServer: () => request<{ ok: true; restarting: boolean }>("/api/server/restart", { method: "POST" }),
	dailyCost: () => request<{ cost: number }>("/api/daily-cost"),

	listFiles: (path: string) => request<DirListingDto>(`/api/files?path=${encodeURIComponent(path)}`),
	trustContextFolder: (path: string) => request<ContextTrustMutationResultDto>("/api/files/trust", json({ path })),
	untrustContextFolder: (path: string) => request<ContextTrustMutationResultDto>("/api/files/untrust", json({ path })),
	removeTrustedContextFolder: (path: string) =>
		request<TrustedFolderRemovalResultDto>("/api/settings/remove-trusted", json({ path })),
	places: () => request<{ places: Array<{ label: string; path: string }> }>("/api/files/places"),
	downloadUrl: (path: string) => `/api/files/download?path=${encodeURIComponent(path)}`,
	upload: async (dir: string, file: File, overwrite: boolean) => {
		const res = await fetch(
			`/api/files/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}&overwrite=${overwrite}`,
			{ method: "POST", body: file },
		);
		const body = await res.json();
		if (!res.ok) throw Object.assign(new Error(String(body.error ?? res.statusText)), { status: res.status });
		return body as { path: string };
	},
	mkdir: (dir: string, name: string) => request<{ path: string }>("/api/files/mkdir", json({ dir, name })),
};

export interface EventConnectionStatus {
	state: EventConnectionState;
	attempt: number;
	retryDelayMs?: number;
	retryAt?: number;
	lastAppliedSeq?: number;
}

export interface EventStreamHandlers {
	/** Must synchronously apply the event. A thrown error triggers full recovery. */
	onEnvelope: (envelope: EventEnvelope) => void;
	onStatusChange?: (status: EventConnectionStatus) => void;
	/** Protocol/handler failure; the store starts its authoritative full resync. */
	onRecovery?: (reason: "protocol" | "handler" | "watchdog") => void;
	onConnectionMetadata?: (connectionId: string) => void;
}

export interface EventSourceLike {
	readonly readyState: number;
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent<string>) => void) | null;
	onerror: ((event: Event) => void) | null;
	addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
	removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
	close(): void;
}

export interface EventStreamDependencies {
	EventSource?: new (url: string) => EventSourceLike;
	now?: () => number;
	random?: () => number;
	setTimeout?: typeof setTimeout;
	clearTimeout?: typeof clearTimeout;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
	visibility?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
	/** Authenticated /api/auth validation differentiates expiry from a network failure. */
	status?: () => Promise<unknown>;
	diagnostic?: (summary: ClientConnectionDiagnosticDto) => void | Promise<void>;
	baseDelayMs?: number;
	maxDelayMs?: number;
	/** Continuous liveness required before retry backoff resets; default is 60 s. */
	healthyResetMs?: number;
	/** Must exceed the server's 25 s heartbeat interval; default is 60 s. */
	watchdogMs?: number;
}

const EVENT_SOURCE_OPEN = 1;
const DEFAULT_HEALTHY_RESET_MS = 60_000;
const DEFAULT_WATCHDOG_MS = 60_000;

function isEnvelope(value: unknown): value is EventEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const envelope = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(envelope.seq) &&
		(envelope.seq as number) > 0 &&
		typeof envelope.key === "string" &&
		Boolean(envelope.event) &&
		typeof envelope.event === "object" &&
		!Array.isArray(envelope.event)
	);
}

/**
 * Owns exactly one EventSource, retry timer, and watchdog. Native EventSource
 * retries are suppressed by closing every failed source before our guarded,
 * bounded retry is scheduled. Application cursor advancement happens only
 * after the synchronous store reducer accepts an envelope.
 */
export function connectEvents(handlers: EventStreamHandlers, injected: EventStreamDependencies = {}): () => void {
	const EventSourceCtor = injected.EventSource ?? EventSource;
	const now = injected.now ?? Date.now;
	const random = injected.random ?? Math.random;
	const scheduleTimeout = injected.setTimeout ?? setTimeout;
	const cancelTimeout = injected.clearTimeout ?? clearTimeout;
	const scheduleInterval = injected.setInterval ?? setInterval;
	const cancelInterval = injected.clearInterval ?? clearInterval;
	const visibility = injected.visibility ?? document;
	const statusCheck = injected.status ?? api.auth;
	const diagnostic = injected.diagnostic ?? ((summary) => api.connectionDiagnostic(summary));
	const baseDelayMs = injected.baseDelayMs ?? 1_000;
	const maxDelayMs = injected.maxDelayMs ?? 30_000;
	const healthyResetMs = injected.healthyResetMs ?? DEFAULT_HEALTHY_RESET_MS;
	const watchdogMs = injected.watchdogMs ?? DEFAULT_WATCHDOG_MS;
	let source: EventSourceLike | undefined;
	let heartbeatListener: ((event: MessageEvent<string>) => void) | undefined;
	let connectionListener: ((event: MessageEvent<string>) => void) | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let watchdog: ReturnType<typeof setInterval> | undefined;
	let validation: Promise<void> | undefined;
	let generation = 0;
	let stopped = false;
	let attempt = 0;
	let lastAppliedSeq: number | undefined;
	let lastLivenessAt = now();
	let openedAt: number | undefined;
	let connectionId: string | undefined;
	// Diagnostic rates are scoped to an SSE connection, not to the last
	// heartbeat (which would make a busy connection appear artificially fast).
	let measurementStartedAt: number | undefined;
	let eventCount = 0;
	let processingLagTotalMs = 0;
	let processingLagMaxMs = 0;
	let currentState: EventConnectionStatus = { state: "connecting", attempt: 0 };

	function isVisible(): boolean {
		return visibility.visibilityState !== "hidden";
	}

	function publish(next: EventConnectionStatus): void {
		const previousState = currentState.state;
		currentState = { ...next, ...(lastAppliedSeq === undefined ? {} : { lastAppliedSeq }) };
		handlers.onStatusChange?.(currentState);
		if (!connectionId) return;
		const elapsedMinutes = Math.max((now() - (measurementStartedAt ?? now())) / 60_000, 1 / 60);
		void Promise.resolve(
			diagnostic({
				connectionId,
				state: currentState.state,
				...(previousState === currentState.state ? {} : { previousState }),
				attempt,
				...(currentState.retryDelayMs === undefined ? {} : { delayMs: currentState.retryDelayMs }),
				visibility: isVisible() ? "visible" : "hidden",
				...(lastAppliedSeq === undefined ? {} : { lastAppliedSeq }),
				heartbeatAgeMs: Math.max(0, now() - lastLivenessAt),
				eventCount,
				eventRatePerMinute: eventCount / elapsedMinutes,
				processingLagTotalMs,
				processingLagMaxMs,
			}),
		).catch(() => {});
	}

	function clearRetry(): void {
		if (retryTimer !== undefined) cancelTimeout(retryTimer);
		retryTimer = undefined;
	}

	function closeSource(): void {
		if (!source) return;
		if (heartbeatListener) source.removeEventListener("heartbeat", heartbeatListener);
		if (connectionListener) source.removeEventListener("connection", connectionListener);
		heartbeatListener = undefined;
		connectionListener = undefined;
		source.onopen = null;
		source.onmessage = null;
		source.onerror = null;
		source.close();
		source = undefined;
		openedAt = undefined;
		// A new EventSource must not attribute its diagnostics to this connection.
		connectionId = undefined;
		measurementStartedAt = undefined;
		eventCount = 0;
		processingLagTotalMs = 0;
		processingLagMaxMs = 0;
	}

	function delayForAttempt(): number {
		const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
		return Math.min(maxDelayMs, Math.max(0, Math.round(exponential * (0.75 + random() * 0.5))));
	}

	function scheduleRetry(): void {
		if (stopped || retryTimer !== undefined || currentState.state === "auth_failed") return;
		attempt += 1;
		const delay = delayForAttempt();
		const retryAt = now() + delay;
		publish({ state: "retrying", attempt, retryDelayMs: delay, retryAt });
		retryTimer = scheduleTimeout(() => {
			retryTimer = undefined;
			open();
		}, delay);
	}

	function recover(reason: "protocol" | "handler" | "watchdog"): void {
		if (stopped) return;
		// Publish the terminal state while its connection metadata is still valid;
		// closeSource then clears it before the replacement stream is created.
		publish({ state: "resyncing", attempt });
		closeSource();
		handlers.onRecovery?.(reason);
		// Transport stalls need an authenticated status check. Protocol/reducer
		// failures already have a healthy HTTP transport and can retry directly.
		if (reason === "watchdog" && !validation) validateThenRetry();
		else scheduleRetry();
	}

	function validateThenRetry(): void {
		if (validation || stopped) return;
		validation = Promise.resolve(statusCheck())
			.then(() => {
				if (!stopped) scheduleRetry();
			})
			.catch((error: { status?: number }) => {
				if (stopped) return;
				if (error?.status === 401 || error?.status === 403) {
					clearRetry();
					publish({ state: "auth_failed", attempt });
					return;
				}
				scheduleRetry();
			})
			.finally(() => {
				validation = undefined;
			});
	}

	function open(): void {
		if (stopped || source) return;
		clearRetry();
		const sourceGeneration = ++generation;
		publish({ state: "connecting", attempt });
		const url = lastAppliedSeq === undefined ? "/api/events" : `/api/events?lastEventId=${lastAppliedSeq}`;
		const candidate = new EventSourceCtor(url);
		source = candidate;
		// Give a newly-created connection a full watchdog window to open.
		lastLivenessAt = now();
		openedAt = undefined;
		const alive = () => {
			if (stopped || sourceGeneration !== generation || source !== candidate) return;
			lastLivenessAt = now();
			if (attempt > 0 && openedAt !== undefined && lastLivenessAt - openedAt >= healthyResetMs) {
				attempt = 0;
				publish({ state: "connected", attempt });
			}
		};
		candidate.onopen = () => {
			if (stopped || sourceGeneration !== generation || source !== candidate) return;
			openedAt = now();
			alive();
			// A TCP/SSE open alone is not healthy enough to reset backoff. A later
			// heartbeat or application frame must survive healthyResetMs first.
			publish({ state: "connected", attempt });
		};
		heartbeatListener = () => alive();
		candidate.addEventListener("heartbeat", heartbeatListener);
		connectionListener = (message) => {
			if (stopped || sourceGeneration !== generation || source !== candidate) return;
			try {
				const value = JSON.parse(message.data) as { connectionId?: unknown };
				if (typeof value.connectionId !== "string") throw new Error("missing connection id");
				connectionId = value.connectionId;
				measurementStartedAt = now();
				eventCount = 0;
				processingLagTotalMs = 0;
				processingLagMaxMs = 0;
				handlers.onConnectionMetadata?.(connectionId);
				alive();
				// The connection frame arrives after open; re-emit the current state so
				// diagnostics are correctly attributed to this fresh connection.
				publish(currentState);
			} catch {
				recover("protocol");
			}
		};
		candidate.addEventListener("connection", connectionListener);
		candidate.onmessage = (message) => {
			if (stopped || sourceGeneration !== generation || source !== candidate) return;
			lastLivenessAt = now();
			let envelope: EventEnvelope;
			try {
				envelope = JSON.parse(message.data) as EventEnvelope;
				if (!isEnvelope(envelope)) throw new Error("invalid dashboard SSE envelope");
				const isResyncBarrier = envelope.event.type === "dashboard_resync";
				// A resync barrier is allowed to bridge an evicted range or reset the
				// sequence after a server restart. Ordinary events remain strictly
				// increasing and consecutive.
				if (!isResyncBarrier && lastAppliedSeq !== undefined && envelope.seq <= lastAppliedSeq) return;
				if (!isResyncBarrier && lastAppliedSeq !== undefined && envelope.seq !== lastAppliedSeq + 1) {
					throw new Error("dashboard SSE sequence gap");
				}
			} catch {
				recover("protocol");
				return;
			}
			const startedAt = now();
			try {
				handlers.onEnvelope(envelope);
			} catch {
				recover("handler");
				return;
			}
			// Do not move Last-Event-ID until the reducer has accepted the envelope.
			lastAppliedSeq = envelope.seq;
			eventCount += 1;
			const lag = Math.max(0, now() - startedAt);
			processingLagTotalMs += lag;
			processingLagMaxMs = Math.max(processingLagMaxMs, lag);
			alive();
		};
		candidate.onerror = () => {
			if (stopped || sourceGeneration !== generation || source !== candidate) return;
			// Explicitly close first: browser-native EventSource retry is never allowed
			// to race our cursor-aware, generation-guarded retry. Publish first so the
			// old connection receives its terminal diagnostic.
			publish({ state: "disconnected", attempt });
			closeSource();
			validateThenRetry();
		};
	}

	const onVisibilityChange = () => {
		if (stopped || !isVisible() || validation) return;
		// Returning to foreground always validates auth before deciding whether a
		// stale/backgrounded stream can be trusted again.
		validation = Promise.resolve(statusCheck())
			.then(() => {
				if (
					!stopped &&
					(!source || source.readyState !== EVENT_SOURCE_OPEN || now() - lastLivenessAt > watchdogMs)
				) {
					recover("watchdog");
				}
			})
			.catch((error: { status?: number }) => {
				if (stopped) return;
				if (error?.status === 401 || error?.status === 403) {
					clearRetry();
					publish({ state: "auth_failed", attempt });
					closeSource();
					return;
				}
				recover("watchdog");
			})
			.finally(() => {
				validation = undefined;
			});
	};
	visibility.addEventListener("visibilitychange", onVisibilityChange);
	watchdog = scheduleInterval(
		() => {
			if (isVisible() && source && now() - lastLivenessAt > watchdogMs) recover("watchdog");
		},
		Math.min(watchdogMs, 5_000),
	);
	open();

	return () => {
		stopped = true;
		generation += 1;
		clearRetry();
		if (watchdog !== undefined) cancelInterval(watchdog);
		watchdog = undefined;
		visibility.removeEventListener("visibilitychange", onVisibilityChange);
		publish({ state: "disconnected", attempt });
		closeSource();
	};
}
