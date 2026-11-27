import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient } from "@dreb/coding-agent/rpc";
import { chromium, devices } from "playwright";
import { expect, it, vi } from "vitest";
// Deliberately exercise the built host and CLI, not Vite-transformed source or a fake RPC client.
import { DashboardAuth } from "../dist/server/auth.js";
import { RuntimePool } from "../dist/server/runtime-pool.js";
import { createDashboardServer } from "../dist/server/server.js";
import type { AutomationDraft, AutomationRun } from "../src/shared/automation.js";

const provider = "offline-fixture";
const model = "inventory-model";
const request = "Inventory the work directory.";
const instructions = "Inventory the work directory and include a file count.";
const inventory = "Inventory: manifest.txt. Available tools: ls.";
const feedback = "The inventory is missing the file count.";
const finalInventory = "Inventory: manifest.txt. File count: 1.";
const conclusion = "Inventory and count verified; the job is complete.";
const stop = `## Inventory review\n\n${conclusion}`;

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
	const finalTurn = Promise.withResolvers<void>();
	async function reply(body: ChatRequest) {
		expect(body).toMatchObject({ model, stream: true });
		const names = body.tools.map(({ function: fn }) => fn.name).sort();
		const last = body.messages.at(-1);
		const content = JSON.stringify(last?.content);
		if (names.includes("propose_automation")) {
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
				case 3: // Launch can close the setup child before this completion is requested.
					expect(last).toMatchObject({ role: "tool", tool_call_id: "proposal2" });
					expect(content).toContain("Approval sent");
					return { content: "The revised inventory is approved." };
			}
		} else if (names.includes("ls")) {
			expect(names).toEqual(draft.orchestrator.tools);
			switch (++calls.worker) {
				case 1:
				case 3:
					expect(content).toContain(instructions);
					return toolCall("inventory", "ls", { path: "." });
				case 2:
				case 4:
					expect(last).toMatchObject({ role: "tool", tool_call_id: "inventory" });
					expect(content).toContain("manifest.txt");
					return { content: inventory };
				case 5:
					// A replacement worker with just the guard's findings would not have its first answer.
					expect(JSON.stringify(body.messages.filter(({ role }) => role === "assistant"))).toContain(inventory);
					expect(content).toContain(feedback);
					await finalTurn.promise;
					return { content: finalInventory };
			}
		} else {
			expect(names).toEqual(draft.guard.tools);
			expect(content).toContain(instructions);
			switch (++calls.guard) {
				case 1:
					expect(content).toContain(inventory);
					return { content: "" }; // Expected guard failure, not a fixture assertion error.
				case 2:
					expect(content).toContain(inventory);
					return { content: `CONTINUE\n${feedback}` };
				case 3:
					expect(content).toContain(finalInventory);
					expect(content).toContain(feedback);
					return { content: `${stop}\n\nSTOP` };
			}
		}
		throw new Error(`Unexpected completion (tools: ${names}; calls: ${JSON.stringify(calls)})`);
	}
	const server = createServer(async (req, res) => {
		try {
			expect([req.method, req.url]).toEqual(["POST", "/v1/chat/completions"]);
			let text = "";
			for await (const chunk of req) text += chunk;
			const response = stream(await reply(JSON.parse(text)));
			res.writeHead(200, { "content-type": "text/event-stream" }).end(response);
		} catch (err) {
			errors.push(err instanceof Error ? err : new Error(String(err)));
			res.writeHead(400).end("Unexpected offline fixture request");
		}
	});
	return { server, calls, errors, finishWorker: finalTurn.resolve };
}

async function listen(server: Server) {
	await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No loopback port");
	return `http://127.0.0.1:${address.port}`;
}

it("approves, reads and relaunches an automation through the mobile dashboard and real RPC children", async ({
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
		name: "Work inventory check",
		cwd,
		instructions,
		orchestrator: { provider, model, tools: ["ls"] },
		guard: { provider, model, tools: ["read"] },
	};
	const stub = scriptedModel(draft);
	const origin = await listen(stub.server);
	onTestFinished(() => stub.server[Symbol.asyncDispose]());
	onTestFinished(() => {
		expect(stub.errors).toEqual([]);
	});
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
		staticDir: join(import.meta.dirname, "../dist/static"),
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
	const browser = await chromium.launch({
		args: ["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1"],
	});
	onTestFinished(() => browser.close());
	const context = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" });
	await context.route("**/*", (route) =>
		new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
	);
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	const list = async (): Promise<{ runs: AutomationRun[]; setups: { key: string }[] }> =>
		(await page.request.get(`${base}/api/automations`)).json();
	const composer = page.getByPlaceholder(/^Message dreb/);
	const back = page.getByRole("link", { name: /^← Automate$/i });
	const main = page.getByRole("main");
	await page.goto(`${base}/#/automate`, { waitUntil: "domcontentloaded" });
	await page.getByRole("button", { name: "New automation", exact: true }).click();
	await composer.fill(request);
	await page.getByRole("button", { name: "send ↵", exact: true }).click();
	const proposal = (text: string) => page.getByRole("region", { name: "Automation draft" }).filter({ hasText: text });
	const first = proposal(request);
	await first.getByText("Request changes", { exact: true }).click();
	await first.getByRole("button", { name: "submit", exact: true }).click();
	const revised = proposal(instructions);
	await revised.getByText("Approve", { exact: true }).click();
	const before = await list();
	expect(before.runs).toEqual([]);
	expect(before.setups).toHaveLength(1);
	expect(await (await page.request.get(`${base}/api/fleet/live`)).json()).toMatchObject({ runtimes: [] });
	const clientsBeforeApproval = spawnClient.mock.calls.length; // Includes the dashboard settings utility.
	await revised.getByRole("button", { name: "submit", exact: true }).click();

	// Host closes setup on launch. The user can still read what they asked for and leave via Automate.
	await composer.waitFor({ state: "hidden" });
	await page.getByText(request, { exact: true }).waitFor();
	await back.click();
	const past = page.getByRole("region", { name: "Past automations" });
	const failedCard = past.getByRole("article").filter({ hasText: /failed/i });
	await failedCard.getByRole("link", { name: "Final report" }).click();
	await main.getByText(/no final assistant text/i).waitFor();
	await main.getByText(inventory, { exact: false }).waitFor();
	await back.click();
	await failedCard.waitFor();
	expect(await page.getByRole("link", { name: "Open setup chat" }).count()).toBe(0);
	const firstList = await list();
	expect(firstList.setups).toEqual([]);
	expect(firstList.runs).toHaveLength(1);
	const [failed] = firstList.runs;
	expect(failed).toMatchObject({ draft, status: "failed", decisions: [] });
	const setupCalls = stub.calls.setup;
	expect([2, 3]).toContain(setupCalls);
	expect(spawnClient).toHaveBeenCalledTimes(clientsBeforeApproval + 2); // worker, failed guard

	// Keep the second worker's final answer pending until its prior answer is visible in the open transcript.
	try {
		await failedCard.getByRole("button", { name: "Relaunch", exact: true }).click();
		const active = page.getByRole("region", { name: "Running automations" });
		await active.getByRole("link", { name: "Orchestrator", exact: true }).click();
		await main.getByText(inventory, { exact: true }).waitFor();
		expect(await main.getByText(finalInventory, { exact: true }).count()).toBe(0);
	} finally {
		stub.finishWorker();
	}
	await main.getByText(finalInventory, { exact: true }).waitFor(); // no reload or navigation
	await back.click();
	const completedCard = past.getByRole("article").filter({ hasText: /stopped/i });
	await completedCard.waitFor();
	const finished = await list();
	expect(finished.setups).toEqual([]);
	expect(finished.runs).toHaveLength(2);
	expect(finished.runs).toContainEqual(failed);
	const run = finished.runs.find(({ id }) => id !== failed.id)!;
	expect(run).toMatchObject({
		draft,
		setupFile: failed.setupFile,
		status: "stopped",
		report: stop,
		decisions: [
			{ action: "continue", report: feedback },
			{ action: "stop", report: stop },
		],
	});
	expect(run.workFile).not.toBe(failed.workFile);
	expect(new Set(run.guardFiles).size).toBe(2);
	expect(stub.calls).toEqual({ setup: setupCalls, worker: 5, guard: 3 });
	const setupLog = await readFile(run.setupFile, "utf8");
	expect(setupLog).toContain("proposal1");
	expect(setupLog).toContain("proposal2");
	await expect.poll(() => pool.list().length, { timeout: 15_000 }).toBe(0);
	expect(spawnClient).toHaveBeenCalledTimes(clientsBeforeApproval + 5); // relaunched worker and two reviews

	// Open each saved record from the second card, then deep-reload it with every RPC child gone.
	const openSaved = async (label: string) => {
		await completedCard.getByRole("link", { name: label, exact: true }).click();
		await back.waitFor();
		await page.reload({ waitUntil: "domcontentloaded" });
	};
	await openSaved("Setup transcript");
	await main.getByText(request, { exact: true }).waitFor();
	expect(await composer.count()).toBe(0);
	await back.click();
	await openSaved("Orchestrator");
	for (const text of [inventory, feedback, finalInventory]) await main.getByText(text, { exact: true }).waitFor();
	await back.click();
	await openSaved("Guard 1");
	await main
		.locator(".entry.assistant")
		.filter({ hasText: `CONTINUE ${feedback}` })
		.waitFor();
	await back.click();
	await openSaved("Guard 2");
	await main.locator(".entry.assistant").getByText(conclusion, { exact: true }).waitFor();
	await back.click();
	await openSaved("Final report");
	await main.getByRole("heading", { name: "Inventory review", exact: true }).waitFor();
	await main.getByText(conclusion, { exact: true }).waitFor();
	await back.click();
	await failedCard.waitFor();
	await completedCard.waitFor();
	expect((await list()).runs).toEqual(finished.runs);
	expect(spawnClient).toHaveBeenCalledTimes(clientsBeforeApproval + 5);
}, 120_000);
