import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { guardPrompt, orchestratorPrompt, setupPrompt } from "./automation-prompts.js";
import type { ToolDefinition } from "./extensions/types.js";
import type { ModelRegistry } from "./model-registry.js";
import { createAllToolDefinitions, type ToolDef } from "./tools/index.js";

const roleSpec = Type.Object(
	{ provider: Type.String(), model: Type.String(), tools: Type.Array(Type.String()) },
	{ additionalProperties: false },
);
type RoleSpec = Static<typeof roleSpec>;
const draftSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 80 }),
		instructions: Type.String(),
		cwd: Type.String(),
		orchestrator: roleSpec,
		guard: roleSpec,
	},
	{ additionalProperties: false },
);
export type AutomationDraft = Static<typeof draftSchema>;
export type AutomationRoleOptions = { role: "setup" } | ({ role: "orchestrator" | "guard" } & RoleSpec);

const localRead = ["read", "grep", "find", "ls"] as const;
const guard = [...localRead, "web_search", "web_fetch"] as const;
const catalog = { guard, orchestrator: [...guard, "edit", "write"] } as const;
const prompts = { setup: setupPrompt, orchestrator: orchestratorPrompt, guard: guardPrompt };

function validateTools(role: keyof typeof catalog, tools: string[]) {
	const allowed: readonly string[] = catalog[role];
	if (!Array.isArray(allowed) || !Array.isArray(tools) || !tools.every((name) => allowed.includes(name))) {
		throw new Error(`Invalid tool list for ${role}`);
	}
	if (new Set(tools).size !== tools.length) throw new Error(`Duplicate tools for ${role}`);
}

export async function resolveAutomationModel(registry: ModelRegistry, spec: Pick<RoleSpec, "provider" | "model">) {
	const model = registry.find(spec.provider, spec.model);
	if (!model) throw new Error(`Unknown automation model: ${spec.provider}/${spec.model}`);
	if (!(await registry.getApiKey(model))) throw new Error(`No credentials for ${spec.provider}/${spec.model}`);
	return model;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

/** Session-owned authority; rebuilding tools must not reset either the grant or the approval gate. */
export class Automation {
	readonly role: AutomationRoleOptions["role"];
	readonly toolNames: readonly string[];
	readonly prompt: string;
	private generation = 0;
	private approved = false;

	constructor(
		options: AutomationRoleOptions,
		private registry: ModelRegistry,
		private sessionId: () => string,
		private onApproved: (draft: AutomationDraft) => void,
	) {
		this.role = options.role;
		this.prompt = prompts[options.role];
		if (options.role === "setup") {
			this.toolNames = [...localRead, "automation_options", "propose_automation"];
		} else {
			validateTools(options.role, options.tools);
			this.toolNames = [...options.tools];
		}
	}

	invalidateDraft() {
		this.generation++;
	}

	createToolDefinitions(cwd: string, autoResizeImages: boolean): Record<string, ToolDef> {
		const builtins: Record<string, ToolDef> = createAllToolDefinitions(cwd, { read: { autoResizeImages } });
		if (this.role === "setup") {
			builtins.automation_options = {
				name: "automation_options",
				label: "Automation options",
				promptSnippet: "List available models and allowed automation tools",
				description: "List exact available provider/model IDs and allowed tool names for each unattended role.",
				parameters: Type.Object({}),
				execute: async () =>
					textResult(
						JSON.stringify({
							models: this.registry.getAvailable().map(({ provider, id }) => ({ provider, model: id })),
							tools: catalog,
						}),
					),
			};
			builtins.propose_automation = this.proposalTool();
		}
		return Object.fromEntries(this.toolNames.map((name) => [name, builtins[name]]));
	}

	private proposalTool(): ToolDefinition<typeof draftSchema> {
		return {
			name: "propose_automation",
			label: "Propose automation",
			promptSnippet: "Show the complete draft for explicit approval",
			description: "Validate and show the complete proposed job to the user for approval.",
			parameters: draftSchema,
			execute: async (_id, params, signal, _onUpdate, ctx) => {
				const generation = ++this.generation;
				const sessionId = this.sessionId();
				const active = () =>
					!this.approved && !signal?.aborted && generation === this.generation && sessionId === this.sessionId();
				const stale = () => textResult("Proposal is no longer active; no approval sent.");
				if (!active()) return stale();
				const draft = structuredClone(params);
				if (!Value.Check(draftSchema, draft)) throw new Error("Invalid automation draft fields");
				if (!draft.name.trim()) throw new Error("Automation draft name is required");
				if (!draft.instructions.trim()) throw new Error("Automation instructions are required");
				if (!isAbsolute(draft.cwd) || !(await stat(draft.cwd)).isDirectory())
					throw new Error("Automation cwd must be an absolute existing directory");
				for (const role of ["orchestrator", "guard"] as const) {
					validateTools(role, draft[role].tools);
					await resolveAutomationModel(this.registry, draft[role]);
				}
				if (!active()) return stale();
				if (!ctx.hasUI) throw new Error("Approval requires an interactive selection");
				const text = `Name: ${draft.name}\nWorking directory: ${draft.cwd}\nOrchestrator: ${JSON.stringify(draft.orchestrator)}\nGuard: ${JSON.stringify(draft.guard)}\n\nInstructions:\n${draft.instructions}`;
				// Fence the literal draft so Markdown cannot hide or reinterpret any of it.
				let fenceLength = 3;
				for (const match of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
				const fence = "`".repeat(fenceLength);
				const result = await ctx.ui.ask(
					{
						title: "Automation draft",
						questions: [
							{
								question: `${fence}\n${text}\n${fence}`,
								options: ["Approve", "Request changes"],
								allowFreeText: false,
							},
						],
					},
					{ signal },
				);
				if (!active()) return stale();
				const answer = result?.answers[0];
				if (
					!answer ||
					answer.skipped ||
					answer.customText ||
					answer.selected.length !== 1 ||
					answer.selected[0] !== "Approve"
				)
					return textResult("Not approved. Propose a fresh complete draft for any revision.");
				this.approved = true;
				this.onApproved(draft);
				// The host, not this tool, decides whether a run starts; claim only the handoff.
				return textResult("Approval sent to the host. The host reports any problem with starting here.");
			},
		};
	}
}
