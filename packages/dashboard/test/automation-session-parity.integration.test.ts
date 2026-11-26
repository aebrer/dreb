import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@dreb/coding-agent";
import { chromium, devices, type Page } from "playwright";
import { expect, it, type TestContext, vi } from "vitest";
import { DashboardAuth } from "../dist/server/auth.js";
import { RuntimePool } from "../dist/server/runtime-pool.js";
import { createDashboardServer } from "../dist/server/server.js";
import type { RuntimeInfoDto } from "../src/shared/protocol.js";

const vendor = "offline-fixture";
const first = "model-a";
const alternate = "model-b";
const unscoped = "model-c";
const question = "Remember the inventory task.";
const answer = "Inventory task recorded.";
const followUp = "Which task did we record?";
const recall = "We recorded the inventory task.";

async function listen(server: Server) {
	await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("Missing loopback port");
	return `http://127.0.0.1:${addr.port}`;
}

// Check what the resumed agent actually sends, not a UI label or the catalog of available tools.
function modelServer(errors: unknown[]) {
	return createServer(async (req, res) => {
		try {
			expect([req.method, req.url]).toEqual(["POST", "/v1/chat/completions"]);
			let body = "";
			for await (const chunk of req) body += chunk;
			const { model, stream, messages, tools } = JSON.parse(body);
			expect({ model, stream }).toEqual({ model: first, stream: true });
			expect(tools.map((t: { function: { name: string } }) => t.function.name).sort()).toEqual([
				"automation_options",
				"find",
				"grep",
				"ls",
				"propose_automation",
				"read",
			]);
			const resumed = JSON.stringify(messages.at(-1).content).includes(followUp);
			expect(JSON.stringify(messages.at(-1))).toContain(resumed ? followUp : question);
			if (resumed) {
				expect(messages).toContainEqual(expect.objectContaining({ role: "assistant", content: answer }));
			}
			const frame = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({
					id: "chatcmpl-parity",
					object: "chat.completion.chunk",
					created: 1,
					model,
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream" }).end(
				`${frame({ content: resumed ? recall : answer }, null)}${frame({}, "stop")}data: [DONE]\n\n`,
			);
		} catch (err) {
			errors.push(err);
			res.writeHead(400).end(String(err));
		}
	});
}

async function setup({ onTestFinished }: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "dreb-mobile-automation-"));
	onTestFinished(() => rm(home, { recursive: true, force: true }));
	const agentDir = join(home, "agent");
	const cwd = join(home, "work");
	const other = join(home, "other");
	await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(other)]);
	// As in automation.integration.test.ts, RPC children inherit only OS essentials, never host credentials.
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
	const errors: unknown[] = [];
	onTestFinished(() => {
		expect(errors).toEqual([]);
	});
	const model = modelServer(errors);
	const origin = await listen(model);
	onTestFinished(() => model[Symbol.asyncDispose]());
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[vendor]: {
					api: "openai-completions",
					baseUrl: `${origin}/v1`,
					apiKey: "unused-test-key",
					models: [first, alternate, unscoped].map((id) => ({ id, name: id, reasoning: true })),
				},
			},
		}),
	);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: vendor,
			defaultModel: first,
			defaultThinkingLevel: "low",
			enabledModels: [first, alternate].map((id) => `${vendor}/${id}`),
			retry: { enabled: false },
			tabTitle: { enabled: false },
		}),
	);

	const pool = new RuntimePool();
	onTestFinished(() => pool.stopAll());
	const app = createDashboardServer({
		auth: new DashboardAuth(),
		pool,
		automationSetupDir: cwd,
		automationSessionDir: join(agentDir, "automation", "sessions"),
		automationHistoryFile: join(agentDir, "automation", "history.json"),
		staticDir: join(import.meta.dirname, "../dist/static"),
		listAllSessions: () => SessionManager.listAllMetadata(),
		deleteSession: (path) => SessionManager.deleteSession(path),
		renameSession: async (path, name) => SessionManager.renameSession(path, name),
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
	page.setDefaultTimeout(4_000);
	await page.goto(`${base}/#/automate`, { waitUntil: "domcontentloaded" });
	const [created] = await Promise.all([
		page.waitForResponse(`${base}/api/automations/setup`, { timeout: 12_000 }),
		button(page, "New automation").click(),
	]);
	expect(created.ok(), await created.text()).toBe(true);
	const { key } = (await created.json()) as RuntimeInfoDto;
	await page.waitForURL(`${base}/#/automate/setup/${key}`);
	return { page, base, pool, key, cwd, other };
}

const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const overflow = (page: Page) => button(page, "⋯").click();

it("shows scoped models and persists mobile setup model and thinking changes across reload", async (ctx) => {
	const { page, pool, key } = await setup(ctx);
	const client = pool.get(key)!.client;
	const current = (id: string, thinkingLevel: string) => ({ model: { provider: vendor, id }, thinkingLevel });
	expect(await client.getState()).toMatchObject(current(first, "low"));
	const model = (id: string) => button(page, `model: ${vendor}/${id}`);
	const think = (level: string) => button(page, `think: ${level}`);
	await overflow(page);
	const mobileSettings = page.getByRole("button", { name: /^(model|think):/ });
	await expect
		.poll(() => mobileSettings.allTextContents(), { timeout: 2_000 })
		.toEqual([`model: ${vendor}/${first}`, "think: low"]);
	await model(first).click();
	const picker = page.getByRole("dialog", { name: "select model" });
	await picker.getByRole("tab", { name: "scoped", selected: true }).waitFor();
	const ids = picker.locator(".model-row .model-id");
	expect((await ids.allTextContents()).sort()).toEqual([first, alternate]);
	await picker.getByRole("tab", { name: "all" }).click();
	await picker.getByPlaceholder("search models…").fill(vendor);
	await ids.filter({ hasText: unscoped }).waitFor();
	await picker.getByRole("tab", { name: "scoped" }).click();
	await picker
		.locator(".model-row")
		.filter({ has: page.locator(".model-id", { hasText: alternate }) })
		.click();
	await model(alternate).waitFor();
	await think("low").click();
	await think("medium").waitFor();
	expect(await client.getState()).toMatchObject(current(alternate, "medium"));
	await page.reload({ waitUntil: "domcontentloaded" });
	await overflow(page);
	await model(alternate).waitFor();
	await think("medium").waitFor();
	expect(await client.getState()).toMatchObject(current(alternate, "medium"));
}, 45_000);

it("resumes the saved setup chat under Automate with setup tools, including in another directory", async (ctx) => {
	const { page, base, key, cwd, other, pool } = await setup(ctx);
	const send = async (message: string, reply: string) => {
		await page.getByPlaceholder("Message dreb…", { exact: true }).fill(message);
		await button(page, "send ↵").click();
		await page.getByText(reply, { exact: true }).waitFor();
	};
	await send(question, answer);
	const saved = await pool.get(key)!.client.getState();
	let previous = key;
	for (const destination of [cwd, other]) {
		await overflow(page);
		await button(page, "stop runtime").click();
		const banner = page.locator('[data-banner-key="closed"]');
		await banner.waitFor();
		expect(await banner.getByRole("button").allTextContents()).toEqual([
			"Resume session",
			"Choose directory…",
			"Return to Automate",
			"dismiss",
		]);
		let resume = banner.getByRole("button", { name: "Resume session", exact: true });
		if (destination === other) {
			await banner.getByRole("button", { name: "Choose directory…" }).click();
			const dialog = page.getByRole("dialog", { name: "choose runtime directory" });
			await dialog.getByLabel("runtime project path").fill(other);
			resume = dialog.getByRole("button", { name: "resume session", exact: true });
		}
		const [response] = await Promise.all([
			page.waitForResponse(`${base}/api/automations/setup/${previous}/resume`),
			resume.click(),
		]);
		expect(response.request().method()).toBe("POST");
		if (destination === other) expect(response.request().postDataJSON()).toEqual({ cwd: other });
		expect(response.ok(), await response.text()).toBe(true);
		const reopened = (await response.json()) as RuntimeInfoDto;
		expect(reopened).toMatchObject({
			cwd: destination,
			state: { sessionId: saved.sessionId, sessionFile: saved.sessionFile },
		});
		await page.waitForURL(`${base}/#/automate/setup/${reopened.key}`);
		await page.getByText(answer, { exact: true }).waitFor();
		if (destination === cwd) await send(followUp, recall);
		else await page.getByText(recall, { exact: true }).waitFor();
		await page.getByRole("link", { name: "← automate" }).click();
		const chat = page.getByRole("link", { name: "Open setup chat" });
		await chat.waitFor();
		expect(await chat.getAttribute("href")).toBe(`#/automate/setup/${reopened.key}`);
		const fleet = await page.request.get(`${base}/api/fleet/live`);
		expect(await fleet.json()).toMatchObject({ runtimes: [] });
		await chat.click();
		previous = reopened.key;
	}
}, 60_000);
