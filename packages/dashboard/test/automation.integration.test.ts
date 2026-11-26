import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RpcClient } from "@dreb/coding-agent/rpc";
import { expect, it, vi } from "vitest";
// Deliberately exercise the built host and CLI, not Vite-transformed source or a fake RPC client.
import { DashboardAuth } from "../dist/server/auth.js";
import { RuntimePool } from "../dist/server/runtime-pool.js";
import { createDashboardServer } from "../dist/server/server.js";
import type { AutomationDraft, AutomationRun } from "../src/shared/automation.js";
import type { RuntimeHydrationDto } from "../src/shared/protocol.js";

const provider = "offline-fixture";
const model = "inventory-model";
const request = "Inventory the work directory.";
const instructions = "Inventory the work directory and include a file count.";
const inventory = "Inventory: manifest.txt. Available tools: ls.";
const feedback = "The inventory is missing the file count.";
const finalInventory = "Inventory: manifest.txt. File count: 1.";
const stop = "Inventory and count verified; the job is complete.";

type ChatRequest = {
	model: string;
	stream: boolean;
	messages: { role: string; content: unknown; tool_call_id?: string }[];
	tools: { function: { name: string } }[];
};

function toolCall(id: string, name: string, args: object) {
	return { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

// Same two-chunk completions SSE framing as ai/test/opencode-session-headers.test.ts.
function stream(delta: ReturnType<typeof toolCall> | { content: string }) {
	const chunk = (part: object, finish: string | null) =>
		`data: ${JSON.stringify({ id: "chatcmpl-smoke", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`;
	return `${chunk(delta, null)}${chunk({}, "tool_calls" in delta ? "tool_calls" : "stop")}data: [DONE]\n\n`;
}

function scriptedModel(draft: AutomationDraft) {
	const calls = { setup: 0, worker: 0, guard: 0 };
	const errors: Error[] = [];
	function reply(body: ChatRequest) {
		expect(body).toMatchObject({ model, stream: true });
		const system = JSON.stringify(body.messages.filter(({ role }) => role === "system" || role === "developer"));
		const names = body.tools.map(({ function: fn }) => fn.name).sort();
		const last = body.messages.at(-1);
		const content = JSON.stringify(last?.content);
		if (system.includes("unattended worker and a separate reviewer")) {
			expect(names).toEqual(["automation_options", "find", "grep", "ls", "propose_automation", "read"]);
			switch (++calls.setup) {
				case 1:
					expect(last?.role).toBe("user");
					expect(content).toContain(request);
					return toolCall("proposal1", "propose_automation", { ...draft, instructions: request });
				case 2:
					expect(last).toMatchObject({ role: "tool", tool_call_id: "proposal1" });
					expect(content).toContain("Not approved");
					return toolCall("proposal2", "propose_automation", draft);
				case 3:
					expect(last).toMatchObject({ role: "tool", tool_call_id: "proposal2" });
					expect(content).toContain("Approval sent");
					return { content: "The revised inventory is approved." };
			}
		} else if (system.includes("Guard findings and delegated decisions arrive in this same session")) {
			expect(names).toEqual(draft.orchestrator.tools);
			switch (++calls.worker) {
				case 1:
					expect(content).toContain(instructions);
					return toolCall("inventory", "ls", { path: "." });
				case 2:
					expect(last).toMatchObject({ role: "tool", tool_call_id: "inventory" });
					expect(content).toContain("manifest.txt");
					return { content: inventory };
				case 3:
					// A replacement worker with just the guard's findings would not have its first answer.
					expect(JSON.stringify(body.messages.filter(({ role }) => role === "assistant"))).toContain(inventory);
					expect(content).toContain(feedback);
					return { content: finalInventory };
			}
		} else if (system.includes("Independently compare the work evidence")) {
			expect(names).toEqual(draft.guard.tools);
			expect(content).toContain(instructions);
			switch (++calls.guard) {
				case 1:
					expect(content).toContain(inventory);
					return { content: JSON.stringify({ action: "continue", report: feedback }) };
				case 2:
					expect(content).toContain(finalInventory);
					expect(content).toContain(feedback);
					return { content: JSON.stringify({ action: "stop", report: stop }) };
			}
		}
		throw new Error(`Unexpected completion (tools: ${names}; calls: ${JSON.stringify(calls)})`);
	}
	const server = createServer(async (req, res) => {
		try {
			expect([req.method, req.url]).toEqual(["POST", "/v1/chat/completions"]);
			let text = "";
			for await (const chunk of req) text += chunk;
			const response = stream(reply(JSON.parse(text)));
			res.writeHead(200, { "content-type": "text/event-stream" }).end(response);
		} catch (err) {
			errors.push(err instanceof Error ? err : new Error(String(err)));
			res.writeHead(400).end("Unexpected offline fixture request");
		}
	});
	return { server, calls, errors };
}

async function listen(server: Server) {
	await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No loopback port");
	return `http://127.0.0.1:${address.port}`;
}

it("runs a revised, explicitly approved automation through the compiled dashboard and RPC children", async ({
	onTestFinished,
}) => {
	const home = await mkdtemp(join(tmpdir(), "dreb-automation-"));
	onTestFinished(() => rm(home, { recursive: true, force: true }));
	const agentDir = join(home, "agent");
	const cwd = join(home, "work");
	await Promise.all([mkdir(agentDir), mkdir(cwd)]);
	await writeFile(join(cwd, "manifest.txt"), "smoke fixture\n");
	// RpcClient inherits process.env. Allowlist rather than chasing each provider's credentials,
	// proxies, package paths, etc. Vitest restores the worker's environment after the children exit.
	onTestFinished(() => {
		vi.unstubAllEnvs();
	});
	for (const key of Object.keys(process.env)) {
		if (!["PATH", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TMP", "TEMP", "TMPDIR"].includes(key.toUpperCase()))
			vi.stubEnv(key, undefined);
	}
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("DREB_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("DREB_OFFLINE", "1");
	const draft = {
		cwd,
		instructions,
		orchestrator: { provider, model, tools: ["ls"] },
		guard: { provider, model, tools: ["read"] },
	};
	const stub = scriptedModel(draft);
	const origin = await listen(stub.server);
	onTestFinished(() => stub.server[Symbol.asyncDispose]());
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[provider]: {
					api: "openai-completions",
					baseUrl: `${origin}/v1`,
					apiKey: "unused-test-key",
					models: [{ id: model, name: model }],
				},
			},
		}),
	);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: provider,
			defaultModel: model,
			retry: { enabled: false },
			tabTitle: { enabled: false },
		}),
	);

	const spawnClient = vi.fn((options: ConstructorParameters<typeof RpcClient>[0]) => new RpcClient(options));
	const pool = new RuntimePool({ clientFactory: spawnClient });
	onTestFinished(() => pool.stopAll());
	const app = createDashboardServer({
		auth: new DashboardAuth(),
		pool,
		automationSetupDir: home,
		automationSessionDir: join(agentDir, "sessions"),
		automationHistoryFile: join(agentDir, "runs.json"),
		listAllSessions: async () => [],
		deleteSession: async () => {
			throw new Error("Unexpected delete");
		},
		renameSession: async () => {
			throw new Error("Unexpected rename");
		},
	});
	onTestFinished(() => app.closeDashboard());
	const http = createServer(app);
	const base = await listen(http);
	onTestFinished(() => http[Symbol.asyncDispose]());
	async function api<T>(path: string, body?: object): Promise<T> {
		const res = await fetch(
			base + path,
			body === undefined
				? {}
				: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
		);
		const text = await res.text();
		if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`);
		return JSON.parse(text);
	}
	async function until<T>(label: string, read: () => Promise<T | undefined>): Promise<T> {
		const deadline = Date.now() + 20_000;
		do {
			if (stub.errors.length) throw stub.errors[0];
			const value = await read();
			if (value !== undefined) return value;
			await delay(50);
		} while (Date.now() < deadline);
		throw new Error(`Timed out waiting for ${label}; model calls: ${JSON.stringify(stub.calls)}`);
	}
	const list = () => api<{ runs: AutomationRun[] }>("/api/automations");
	const { key } = await api<{ key: string }>("/api/automations/setup", {});
	expect(key).toBeTruthy();
	expect(await api("/api/automations")).toMatchObject({ setups: [{ key }] });
	expect(await api("/api/fleet/live")).toMatchObject({ runtimes: [] });
	const runtime = `/api/runtimes/${encodeURIComponent(key)}`;
	await api(`${runtime}/prompt`, { message: request });
	async function selection(title: string) {
		return until(title, async () => {
			const { pendingExtensionUiRequests } = await api<RuntimeHydrationDto>(`${runtime}/hydrate`);
			return pendingExtensionUiRequests?.find(
				(dialog) => dialog.method === "ask" && dialog.questions?.[0]?.question.includes(title),
			);
		});
	}
	const answer = (id: string, value: string) =>
		api(`${runtime}/extension-ui-response`, { type: "extension_ui_response", id, answers: [{ selected: [value] }] });
	const first = await selection(request);
	expect(first.questions?.[0]?.options).toContain("Request changes");
	await answer(first.id, "Request changes");
	const revised = await selection(instructions);
	expect(revised.id).not.toBe(first.id);
	expect(revised.questions?.[0]?.options).toContain("Approve");
	expect((await list()).runs).toEqual([]);
	expect(spawnClient).toHaveBeenCalledTimes(1);
	await answer(revised.id, "Approve");
	const run = await until("terminal report", async () => {
		const { runs } = await list();
		if (!runs.length) return undefined;
		expect(runs).toHaveLength(1);
		return ["working", "reviewing"].includes(runs[0].status) ? undefined : runs[0];
	});
	expect(run).toMatchObject({
		draft,
		status: "stopped",
		report: stop,
		decisions: [
			{ action: "continue", report: feedback },
			{ action: "stop", report: stop },
		],
	});
	expect(new Set(run.guardFiles).size).toBe(2);
	expect(stub.calls.worker).toBe(3);
	expect(stub.calls.guard).toBe(2);

	// With every child gone, reading any report (even via a short-lived utility runtime) must not spawn one.
	await pool.stop(key);
	await until("role runtime cleanup", async () => (pool.list().length === 0 ? true : undefined));
	expect(spawnClient).toHaveBeenCalledTimes(4); // setup, same worker twice, two independent reviews
	const transcript = async (ref: string) =>
		(await api<{ messages: unknown[] }>(`/api/automations/${encodeURIComponent(run.id)}/transcripts/${ref}`))
			.messages;
	const setup = JSON.stringify(await transcript("setup"));
	expect(setup).toContain("proposal1");
	expect(setup).toContain("proposal2");
	const work = await transcript("work");
	expect(work).toContainEqual(
		expect.objectContaining({ role: "custom", customType: "automation-guard-feedback", content: feedback }),
	);
	expect(JSON.stringify(work)).toContain(inventory);
	expect(JSON.stringify(work)).toContain(finalInventory);
	for (const [index, verdict] of [feedback, stop].entries()) {
		const guard = await transcript(`guard-${index}`);
		expect(JSON.stringify(guard.at(-1))).toContain(verdict);
	}
	expect((await list()).runs).toEqual([run]);
	expect(spawnClient).toHaveBeenCalledTimes(4);
	expect(stub.errors).toEqual([]);
}, 90_000);
