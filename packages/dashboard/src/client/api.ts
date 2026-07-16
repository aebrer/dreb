/**
 * REST + SSE client for the dashboard server. Thin fetch wrappers — every
 * non-OK response throws with the server's error message (no silent fallback).
 */

import type {
	AgentTypeDto,
	AuthStatusDto,
	BackgroundAgentDto,
	CommandDto,
	ContextTrustMutationResultDto,
	DirListingDto,
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
	pair: (pin: string) => request<{ device: PairedDeviceDto }>("/api/pair", json({ pin })),
	pairingCode: () => request<PairingCodeDto>("/api/pairing-code"),
	devices: () => request<{ devices: PairedDeviceDto[] }>("/api/devices"),
	unpair: (id: string) => request<{ ok: true }>(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),

	fleet: () => request<FleetDto>("/api/fleet"),
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

export interface EventStreamHandlers {
	onEnvelope: (envelope: EventEnvelope) => void;
	onStatusChange?: (connected: boolean) => void;
	/** Buffer gap/server restart — full state refetch required. */
	onResync?: () => void;
}

/**
 * Connect to /api/events with automatic reconnect + Last-Event-ID catch-up.
 * Returns a disconnect function.
 */
export function connectEvents(handlers: EventStreamHandlers): () => void {
	let source: EventSource | null = null;
	let lastEventId: string | undefined;
	let stopped = false;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;

	function open() {
		if (stopped) return;
		const url = lastEventId ? `/api/events?lastEventId=${lastEventId}` : "/api/events";
		source = new EventSource(url);
		source.onopen = () => handlers.onStatusChange?.(true);
		source.onmessage = (msg) => {
			lastEventId = msg.lastEventId || lastEventId;
			let envelope: EventEnvelope;
			try {
				envelope = JSON.parse(msg.data) as EventEnvelope;
			} catch {
				return; // not an envelope (comment/keepalive frames don't reach onmessage anyway)
			}
			handlers.onEnvelope(envelope);
			if (envelope.event?.type === "dashboard_resync") handlers.onResync?.();
		};
		source.onerror = () => {
			handlers.onStatusChange?.(false);
			source?.close();
			source = null;
			if (!stopped) retryTimer = setTimeout(open, 2000);
		};
	}

	open();
	return () => {
		stopped = true;
		if (retryTimer) clearTimeout(retryTimer);
		source?.close();
	};
}
