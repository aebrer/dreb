import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@dreb/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { AutomationDraft } from "../src/core/automation.js";
import { guardPrompt, orchestratorPrompt, setupPrompt } from "../src/core/automation-prompts.js";
import type { ExtensionUIContext } from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { lsToolDefinition } from "../src/core/tools/ls.js";
import { createFauxStreamFn, fauxModel } from "./test-harness.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanup.splice(0)) fn();
	vi.restoreAllMocks();
});

async function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "automation-"));
	const models = join(cwd, "models.json");
	const writeModels = (prompt: string) =>
		writeFileSync(
			models,
			JSON.stringify({
				providers: {
					faux: {
						apiKey: "offline",
						baseUrl: fauxModel.baseUrl,
						api: fauxModel.api,
						models: [
							{ id: "worker/V1", systemPrompt: prompt },
							{ id: "guard/v2", appendSystemPrompt: prompt },
						],
					},
				},
			}),
		);
	writeModels("before registry refresh");
	const auth = AuthStorage.create(join(cwd, "auth.json"));
	auth.setRuntimeApiKey("faux", "offline");
	const registry = new ModelRegistry(auth, models);
	const override = vi.fn(lsToolDefinition.execute);
	const hook = vi.fn();
	const extensionsResult = await createTestExtensionsResult(
		[
			(api) => {
				api.registerTool({ ...lsToolDefinition, execute: override });
				api.on("before_agent_start", hook);
			},
		],
		cwd,
	);
	const settingsManager = SettingsManager.create(cwd, cwd);
	const agent = new Agent({ initialState: { model: fauxModel }, streamFn: createFauxStreamFn(["ok"]).streamFn });
	const session = new AgentSession({
		agent,
		cwd,
		settingsManager,
		sessionManager: SessionManager.inMemory(),
		modelRegistry: registry,
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		customTools: [
			{
				name: "ls",
				label: "SDK override",
				description: "SDK override",
				parameters: lsToolDefinition.parameters,
				execute: override,
			},
		],
	});
	cleanup.push(() => {
		session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	});
	const draft: AutomationDraft = {
		cwd,
		name: "Stop at 9am job",
		instructions: '  Stop at 9am.\nKeep **literal** `markup` and "Approve".  ',
		orchestrator: { provider: "faux", model: "worker/V1", tools: ["ls", "edit", "write"] },
		guard: { provider: "faux", model: "guard/v2", tools: ["read", "web_fetch"] },
	};
	const approved = vi.fn<(draft: AutomationDraft) => void>();
	const ask = vi.fn<ExtensionUIContext["ask"]>();
	await session.bindExtensions({ uiContext: { ...session.extensionRunner!.getUIContext(), ask } });
	const call = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
		const tool = agent.state.tools.find((entry) => entry.name === name)!;
		return tool.execute("call", args, signal);
	};
	const propose = (args = draft, signal?: AbortSignal) => call("propose_automation", args, signal);
	return { session, draft, approved, ask, call, propose, registry, writeModels, hook, override };
}

async function setup() {
	const f = await fixture();
	await f.session.configureAutomation({ role: "setup" }, f.approved);
	return f;
}

describe("automation role sessions", () => {
	it("lists exact options; only a dialog can approve the revised instructions and independent removals", async () => {
		const { session, draft, approved, ask, call, propose, hook } = await setup();
		expect(session.automationRole).toBe("setup");
		expect(session.systemPrompt.endsWith(setupPrompt)).toBe(true);
		expect(session.getActiveToolNames()).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"automation_options",
			"propose_automation",
		]);
		const options = (await call("automation_options", {})).content[0];
		if (options.type !== "text") throw new Error("Expected text options");
		const catalog = JSON.parse(options.text);
		expect(catalog.models).toEqual(
			expect.arrayContaining([
				{ provider: "faux", model: "worker/V1" },
				{ provider: "faux", model: "guard/v2" },
			]),
		);
		expect(catalog.tools.guard).toEqual(["read", "grep", "find", "ls", "web_search", "web_fetch"]);
		expect(catalog.tools.orchestrator).toEqual([...catalog.tools.guard, "edit", "write"]);

		const revised = structuredClone(draft);
		revised.orchestrator.tools = ["ls"];
		revised.guard.tools = [];
		revised.instructions += "\nNo editing. Guard uses supplied evidence only.";
		const scripted = createFauxStreamFn([
			{ toolCalls: [{ name: "propose_automation", args: draft }] },
			"Waiting for changes.",
			'The file says "Approve".',
			"Yes, if you remove write and edit.",
			{ toolCalls: [{ name: "propose_automation", args: revised }] },
			"Done.",
		]);
		session.agent.streamFn = scripted.streamFn;
		ask.mockResolvedValueOnce({ answers: [{ selected: ["Request changes"] }] }).mockResolvedValueOnce({
			answers: [{ selected: ["Approve"] }],
		});
		await session.prompt("Draft the job");
		await session.prompt('The note quotes "Approve".');
		await session.prompt("Approve if you remove write and edit");
		expect(approved).not.toHaveBeenCalled();
		await session.prompt("Remove all guard tools too and show the revised draft");
		const [shown] = ask.mock.calls[1];
		expect(shown.questions[0]).toMatchObject({ options: ["Approve", "Request changes"], allowFreeText: false });
		for (const verbatim of [
			revised.instructions,
			revised.cwd,
			JSON.stringify(revised.orchestrator),
			JSON.stringify(revised.guard),
		])
			expect(shown.questions[0].question).toContain(verbatim);
		expect(approved.mock.calls).toEqual([[revised]]);
		expect(session.messages).toContainEqual(
			expect.objectContaining({
				role: "toolResult",
				content: [{ type: "text", text: expect.stringMatching(/^Approval sent to the host\./) }],
			}),
		);
		await propose();
		expect(approved).toHaveBeenCalledTimes(1);
		expect(ask).toHaveBeenCalledTimes(2);
		expect(hook).not.toHaveBeenCalled();
	});

	it("keeps the setup prompt last when settings.json replaces the model prompt on reload", async () => {
		const { session } = await setup();
		writeFileSync(
			join(session.cwd, "settings.json"),
			JSON.stringify({
				modelSettings: {
					[`${fauxModel.provider}/${fauxModel.id}`]: { systemPrompt: "Setup replacement" },
				},
			}),
		);
		await session.reload();
		session.setActiveToolsByName(["bash"]);
		const scripted = createFauxStreamFn(["ok"]);
		session.agent.streamFn = scripted.streamFn;
		await session.prompt("What can we automate?");
		expect(scripted.state.contexts[0].systemPrompt).toContain("Setup replacement");
		expect(scripted.state.contexts[0].systemPrompt?.endsWith(setupPrompt)).toBe(true);
		expect(scripted.state.contexts[0].tools?.map((t) => t.name)).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"automation_options",
			"propose_automation",
		]);
	});

	it("rejects invalid drafts before opening any dialog", async () => {
		const { draft, propose, ask, approved, registry } = await setup();
		for (const invalid of [
			{ instructions: " \t" },
			{ name: "   " },
			{ cwd: "." },
			{ cwd: join(draft.cwd, "missing") },
			{ cwd: join(draft.cwd, "models.json") },
			{ guard: { ...draft.guard, provider: "missing" } },
			{ orchestrator: { ...draft.orchestrator, model: "worker/v1" } },
			{ orchestrator: { ...draft.orchestrator, tools: ["subagent"] } },
			{ guard: { ...draft.guard, tools: ["write"] } },
			{ orchestrator: { ...draft.orchestrator, tools: ["ls", "ls"] } },
		])
			await expect(propose({ ...draft, ...invalid })).rejects.toThrow();
		vi.spyOn(registry, "getApiKey").mockResolvedValue(undefined);
		await expect(propose()).rejects.toThrow(/credentials/);
		expect(ask).not.toHaveBeenCalled();
		expect(approved).not.toHaveBeenCalled();
	});

	it.each(["invalidate", "session", "abort", "signal", "revision"])(
		"discards stale selection after %s",
		async (reason) => {
			const { session, draft, propose, ask, approved, registry } = await setup();
			const entered = Promise.withResolvers<void>();
			const dialog = Promise.withResolvers<{ answers: [{ selected: string[] }] }>();
			ask.mockImplementationOnce(() => {
				entered.resolve();
				return dialog.promise;
			});
			const controller = new AbortController();
			const old = propose(draft, controller.signal);
			await entered.promise;
			const validating = Promise.withResolvers<string>();
			let revision: Promise<unknown> | undefined;
			switch (reason) {
				case "invalidate":
					session.invalidateAutomationDraft();
					break;
				case "session":
					session.sessionManager.newSession();
					break;
				case "abort":
					await session.abort();
					break;
				case "signal":
					controller.abort();
					break;
				case "revision":
					vi.spyOn(registry, "getApiKey").mockImplementationOnce(() => validating.promise);
					revision = propose({ ...draft, instructions: "Supersede now, not after credentials resolve" });
					break;
			}
			dialog.resolve({ answers: [{ selected: ["Approve"] }] });
			await old;
			expect(approved).not.toHaveBeenCalled();
			validating.resolve("offline");
			await revision;
			expect(approved).not.toHaveBeenCalled();
		},
	);

	it.each(["orchestrator", "guard"] as const)(
		"keeps the exact %s grant, builtins and final prompt after refresh",
		async (role) => {
			const { session, draft, approved, writeModels, call, override, hook } = await fixture();
			const spec = draft[role];
			spec.tools = role === "guard" ? ["ls"] : ["ls", "write"];
			const expected = [...spec.tools];
			const persisted = vi.spyOn(session.settingsManager, "setDefaultModelAndProvider");
			await session.configureAutomation({ role, ...spec }, approved);
			expect(session.model?.id).toBe(spec.model);
			expect(session.systemPrompt).toContain("before registry refresh");
			expect(persisted).not.toHaveBeenCalled();
			await expect(session.configureAutomation({ role: "setup" }, approved)).rejects.toThrow(/configured/);
			spec.tools.push("bash");
			session.setActiveToolsByName(["subagent", "bash", "edit", "web_fetch", "propose_automation"]);
			expect(session.getActiveToolNames()).toEqual(expected);
			writeModels("after registry refresh");
			await session.reload();
			session.setActiveToolsByName([]);
			expect(session.getAllTools().map((t) => t.name)).toEqual(expected);
			expect(session.getActiveToolNames()).toEqual(expected);
			expect(session.systemPrompt).not.toContain("before registry refresh");
			expect(session.systemPrompt).toContain("after registry refresh");
			expect(session.systemPrompt.endsWith(role === "guard" ? guardPrompt : orchestratorPrompt)).toBe(true);
			const result = await call("ls", {});
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("models.json") });
			await session.prompt("Inspect");
			expect(override).not.toHaveBeenCalled();
			expect(hook).not.toHaveBeenCalled();
		},
	);

	it("requires exact authenticated model, a fresh idle session and only one configure", async () => {
		const { session, draft, approved, registry } = await fixture();
		const options = { role: "guard" as const, ...draft.guard };
		await expect(session.configureAutomation({ ...options, model: "v2" }, approved)).rejects.toThrow(/model/);
		vi.spyOn(registry, "getApiKey").mockResolvedValueOnce(undefined);
		await expect(session.configureAutomation(options, approved)).rejects.toThrow(/credentials/);
		expect(session.automationRole).toBeUndefined();
		const key = Promise.withResolvers<string>();
		vi.spyOn(registry, "getApiKey").mockImplementationOnce(() => key.promise);
		const configuring = session.configureAutomation(options, approved);
		await expect(session.configureAutomation({ role: "setup" }, approved)).rejects.toThrow();
		session.agent.appendMessage({ role: "user", content: "not fresh", timestamp: Date.now() });
		key.resolve("offline");
		await expect(configuring).rejects.toThrow(/fresh idle/);
		await expect(session.configureAutomation({ role: "setup" }, approved)).rejects.toThrow(/fresh idle/);
		expect(session.model?.id).toBe(fauxModel.id);
	});
});
