import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage, ThinkingLevel } from "@dreb/agent-core";
import { RpcClient, type RpcSessionState } from "@dreb/coding-agent/rpc";
import { SessionApi } from "./sessions.js";

export type DashboardAgentEvent = { type: string; [key: string]: unknown };
export type RuntimeEventListener = (event: DashboardAgentEvent) => void;

export interface RpcClientLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: RuntimeEventListener): () => void;
	prompt(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
	steer(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
	followUp(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
	abort(): Promise<void>;
	getState(): Promise<RpcSessionState>;
	getMessages(): Promise<AgentMessage[]>;
	setModel(provider: string, modelId: string): Promise<unknown>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void>;
	setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void>;
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
	getAvailableModels?(): Promise<unknown[]>;
}

export interface RuntimeRequest {
	id?: string;
	cwd: string;
	sessionPath?: string;
	provider?: string;
	model?: string;
}

export interface RuntimeFactoryOptions {
	cwd: string;
	provider?: string;
	model?: string;
}

export type RuntimeFactory = (options: RuntimeFactoryOptions) => RpcClientLike;

export interface RuntimePoolOptions {
	factory?: RuntimeFactory;
	sessionApi?: SessionApi;
	validateSessionProject?: boolean;
}

export class DashboardRuntime {
	private client: RpcClientLike | null = null;
	private started = false;
	private readonly listeners = new Set<RuntimeEventListener>();

	constructor(
		readonly id: string,
		readonly cwd: string,
		readonly sessionPath: string | undefined,
		private readonly factory: RuntimeFactory,
		private readonly provider?: string,
		private readonly model?: string,
	) {}

	async start(): Promise<void> {
		if (this.started) return;
		this.client = this.factory({ cwd: this.cwd, provider: this.provider, model: this.model });
		this.client.onEvent((event) => this.fanout(event));
		await this.client.start();
		if (this.sessionPath) {
			const result = await this.client.switchSession(this.sessionPath);
			if (result.cancelled) throw new Error("Session switch was cancelled");
		}
		this.started = true;
	}

	async stop(): Promise<void> {
		if (!this.client) return;
		await this.client.stop();
		this.client = null;
		this.started = false;
	}

	onEvent(listener: RuntimeEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
		await this.requireClient().prompt(message, images);
	}

	async steer(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
		await this.requireClient().steer(message, images);
	}

	async followUp(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
		await this.requireClient().followUp(message, images);
	}

	async abort(): Promise<void> {
		await this.requireClient().abort();
	}

	async getState(): Promise<RpcSessionState> {
		return this.requireClient().getState();
	}

	async getMessages(): Promise<AgentMessage[]> {
		return this.requireClient().getMessages();
	}

	async setModel(provider: string, modelId: string): Promise<unknown> {
		return this.requireClient().setModel(provider, modelId);
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.requireClient().setThinkingLevel(level);
	}

	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.requireClient().setSteeringMode(mode);
	}

	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.requireClient().setFollowUpMode(mode);
	}

	async getAvailableModels(): Promise<unknown[]> {
		return (await this.requireClient().getAvailableModels?.()) ?? [];
	}

	private requireClient(): RpcClientLike {
		if (!this.client || !this.started) throw new Error("Runtime is not started");
		return this.client;
	}

	private fanout(event: DashboardAgentEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

export class DashboardRuntimePool {
	private readonly runtimes = new Map<string, DashboardRuntime>();
	private readonly factory: RuntimeFactory;
	private readonly sessionApi: SessionApi;
	private readonly validateSessionProject: boolean;

	constructor(options: RuntimePoolOptions = {}) {
		this.factory = options.factory ?? defaultRuntimeFactory;
		this.sessionApi = options.sessionApi ?? new SessionApi();
		this.validateSessionProject = options.validateSessionProject ?? true;
	}

	async getOrCreate(request: RuntimeRequest): Promise<DashboardRuntime> {
		const cwd = resolve(request.cwd);
		const id = request.id ?? runtimeId(cwd, request.sessionPath);
		const existing = this.runtimes.get(id);
		if (existing) {
			if (existing.cwd !== cwd) throw new Error("Runtime cannot switch projects; create a separate runtime");
			if ((existing.sessionPath ?? "") !== (request.sessionPath ?? "")) {
				throw new Error("Runtime cannot switch sessions; create a separate runtime");
			}
			return existing;
		}

		if (request.sessionPath && this.validateSessionProject) {
			const sessions = await this.sessionApi.listProject(cwd);
			if (!sessions.some((session) => session.path === request.sessionPath)) {
				throw new Error("Session does not belong to the requested project");
			}
		}

		const runtime = new DashboardRuntime(id, cwd, request.sessionPath, this.factory, request.provider, request.model);
		this.runtimes.set(id, runtime);
		try {
			await runtime.start();
			return runtime;
		} catch (error) {
			this.runtimes.delete(id);
			throw error;
		}
	}

	async stop(id: string): Promise<void> {
		const runtime = this.runtimes.get(id);
		if (!runtime) return;
		this.runtimes.delete(id);
		await runtime.stop();
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
	}
}

export function runtimeId(cwd: string, sessionPath?: string): string {
	return Buffer.from(JSON.stringify({ cwd: resolve(cwd), sessionPath: sessionPath ?? null })).toString("base64url");
}

export function defaultRuntimeFactory(options: RuntimeFactoryOptions): RpcClientLike {
	return new RpcClient({
		cliPath: resolveDrebCliPath(),
		cwd: options.cwd,
		provider: options.provider,
		model: options.model,
		args: ["--ui", "dashboard"],
	}) as unknown as RpcClientLike;
}

function resolveDrebCliPath(): string {
	const resolved = import.meta.resolve("@dreb/coding-agent");
	const distDir = dirname(fileURLToPath(resolved));
	return join(distDir, "cli.js");
}
