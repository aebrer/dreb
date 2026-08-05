// @vitest-environment jsdom

import { createSignal } from "solid-js";
import { render } from "solid-js/web/dist/web.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	settings: vi.fn(),
	settingsModels: vi.fn(),
	saveSettings: vi.fn(),
}));

vi.mock("../../src/client/api.js", () => ({ api: apiMocks }));

import { ScopedModelsEditor } from "../../src/client/components/scoped-models-editor.js";
import type { ModelInfoDto, SettingsDto } from "../../src/shared/protocol.js";

const models: ModelInfoDto[] = [
	{ provider: "anthropic", id: "sonnet", name: "Sonnet", contextWindow: 1, reasoning: true },
	{ provider: "anthropic", id: "opus", name: "Opus", contextWindow: 1, reasoning: true },
	{ provider: "openai", id: "gpt", name: "GPT", contextWindow: 1, reasoning: false },
];

function snapshot(update: Partial<SettingsDto> = {}): SettingsDto {
	return {
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		compactionEnabled: true,
		retryEnabled: true,
		resolvedScopedModels: [],
		scopeWarnings: [],
		hasProjectEnabledModelsOverride: false,
		enabledModelsSource: "default",
		...update,
	};
}

const disposers: Array<() => void> = [];

async function flush(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function mount(props: { cwd?: string; onCwdChange?: (cwd: string | undefined) => void } = {}): HTMLElement {
	const root = document.createElement("div");
	document.body.append(root);
	disposers.push(
		render(
			() => (
				<ScopedModelsEditor
					cwd={props.cwd}
					projectRoots={["/project/a", "/project/b"]}
					onCwdChange={props.onCwdChange ?? (() => {})}
				/>
			),
			root,
		),
	);
	return root;
}

function button(root: HTMLElement, text: string): HTMLButtonElement {
	const match = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent?.trim() === text,
	);
	if (!match) throw new Error(`button not found: ${text}`);
	return match;
}

function modelCheckbox(root: HTMLElement, id: string): HTMLInputElement {
	const label = [...root.querySelectorAll<HTMLLabelElement>(".scoped-model-choice")].find((candidate) =>
		candidate.textContent?.includes(id),
	);
	const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
	if (!input) throw new Error(`model checkbox not found: ${id}`);
	return input;
}

beforeEach(() => {
	apiMocks.settings.mockReset().mockResolvedValue(snapshot());
	apiMocks.settingsModels.mockReset().mockResolvedValue({ models });
	apiMocks.saveSettings.mockReset().mockImplementation(async (update: { enabledModels?: string[] | null }) =>
		update.enabledModels === null
			? snapshot()
			: snapshot({
					enabledModels: update.enabledModels ?? [],
					enabledModelsSource: "global",
					resolvedScopedModels: (update.enabledModels ?? []).map((key) => {
						const [provider, ...id] = key.split("/");
						return { provider: provider!, id: id.join("/") };
					}),
				}),
	);
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	document.body.replaceChildren();
});

describe("ScopedModelsEditor", () => {
	it("keeps implicit all in registry order and materializes a partial scope on disable", async () => {
		const root = mount();
		await flush();

		expect(root.querySelector(".scoped-models-order")?.textContent).toContain("All available models");
		expect(root.querySelectorAll<HTMLButtonElement>(".scoped-model-move-controls button")[0]?.disabled).toBe(true);

		modelCheckbox(root, "opus").click();
		button(root, "save").click();
		await flush();

		expect(apiMocks.saveSettings).toHaveBeenCalledWith(
			{ enabledModels: ["anthropic/sonnet", "openai/gpt"] },
			undefined,
		);
	});

	it("toggles a whole provider even when search filters its visible models", async () => {
		const root = mount();
		await flush();
		const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
		search.value = "Sonnet";
		search.dispatchEvent(new InputEvent("input", { bubbles: true }));
		const providerToggle = root.querySelector<HTMLInputElement>(
			'.scoped-model-provider-heading input[type="checkbox"]',
		)!;
		providerToggle.click();
		button(root, "save").click();
		await flush();
		expect(apiMocks.saveSettings).toHaveBeenCalledWith({ enabledModels: ["openai/gpt"] }, undefined);
	});

	it("saves accessible partial reordering and leaves boundary controls disabled", async () => {
		apiMocks.settings.mockResolvedValue(
			snapshot({
				enabledModels: ["openai/gpt", "anthropic/sonnet"],
				enabledModelsSource: "global",
				resolvedScopedModels: [
					{ provider: "openai", id: "gpt" },
					{ provider: "anthropic", id: "sonnet" },
				],
			}),
		);
		const root = mount();
		await flush();
		const moveUp = root.querySelector<HTMLButtonElement>('[aria-label="Move openai/gpt up"]')!;
		expect(moveUp.disabled).toBe(true);
		root.querySelector<HTMLButtonElement>('[aria-label="Move openai/gpt down"]')!.click();
		button(root, "save").click();
		await flush();
		expect(apiMocks.saveSettings).toHaveBeenCalledWith(
			{ enabledModels: ["anthropic/sonnet", "openai/gpt"] },
			undefined,
		);
	});

	it("collapses a restored complete inventory to an explicit null clear", async () => {
		apiMocks.settings.mockResolvedValue(
			snapshot({
				enabledModels: ["anthropic/sonnet"],
				enabledModelsSource: "global",
				resolvedScopedModels: [{ provider: "anthropic", id: "sonnet" }],
			}),
		);
		const root = mount();
		await flush();

		button(root, "enable all").click();
		button(root, "save").click();
		await flush();
		expect(apiMocks.saveSettings).toHaveBeenCalledWith({ enabledModels: null }, undefined);
	});

	it("blocks zero-model saves, supports reset, and preserves failed staged edits", async () => {
		apiMocks.settings.mockResolvedValue(
			snapshot({
				enabledModels: ["anthropic/sonnet"],
				enabledModelsSource: "global",
				resolvedScopedModels: [{ provider: "anthropic", id: "sonnet" }],
			}),
		);
		const root = mount();
		await flush();

		modelCheckbox(root, "sonnet").click();
		expect(root.textContent).toContain("At least one model must remain enabled");
		expect(button(root, "save").disabled).toBe(true);
		expect(apiMocks.saveSettings).not.toHaveBeenCalled();

		button(root, "reset").click();
		modelCheckbox(root, "gpt").click();
		apiMocks.saveSettings.mockRejectedValueOnce(new Error("disk full"));
		button(root, "save").click();
		await flush();
		expect(root.textContent).toContain("disk full");
		expect(modelCheckbox(root, "gpt").checked).toBe(true);
		expect(root.textContent).toContain("unsaved changes");
	});

	it("keeps a persisted legacy empty scope visibly invalid through reset", async () => {
		apiMocks.settings.mockResolvedValue(
			snapshot({
				enabledModels: [],
				enabledModelsSource: "global",
				resolvedScopedModels: [],
			}),
		);
		const root = mount();
		await flush();

		expect(root.querySelector(".scoped-models-order")?.textContent).not.toContain("All available models");
		expect(root.querySelector(".scoped-models-order")?.textContent).toContain("0 enabled models");
		expect(root.textContent).toContain("At least one model must remain enabled");
		expect(button(root, "save").disabled).toBe(true);

		modelCheckbox(root, "sonnet").click();
		expect(root.textContent).not.toContain("At least one model must remain enabled");
		button(root, "reset").click();

		expect(root.querySelector(".scoped-models-order")?.textContent).not.toContain("All available models");
		expect(root.querySelector(".scoped-models-order")?.textContent).toContain("0 enabled models");
		expect(root.textContent).toContain("At least one model must remain enabled");
		expect(button(root, "save").disabled).toBe(true);
		expect(apiMocks.saveSettings).not.toHaveBeenCalled();
	});

	it("shows legacy diagnostics and returned project-shadow warnings verbatim", async () => {
		apiMocks.settings.mockResolvedValue(
			snapshot({
				enabledModels: ["anthropic/*", "missing"],
				enabledModelsSource: "project",
				hasProjectEnabledModelsOverride: true,
				resolvedScopedModels: [{ provider: "anthropic", id: "sonnet" }],
				scopeWarnings: [{ pattern: "missing", message: 'No models match pattern "missing"' }],
			}),
		);
		apiMocks.saveSettings.mockResolvedValueOnce({
			...snapshot({
				enabledModels: ["openai/gpt"],
				enabledModelsSource: "project",
				hasProjectEnabledModelsOverride: true,
				resolvedScopedModels: [{ provider: "openai", id: "gpt" }],
			}),
			warnings: ["project shadow warning, verbatim"],
		});
		const root = mount({ cwd: "/project/a" });
		await flush();

		expect(apiMocks.settings).toHaveBeenCalledWith("/project/a");
		expect(apiMocks.settingsModels).toHaveBeenCalledWith("/project/a");
		expect(root.textContent).toContain('No models match pattern "missing"');
		expect(root.textContent).toContain("Saving an edited legacy scope");
		modelCheckbox(root, "gpt").click();
		button(root, "save").click();
		await flush();
		expect(apiMocks.saveSettings).toHaveBeenCalledWith(
			{ enabledModels: ["anthropic/sonnet", "openai/gpt"] },
			"/project/a",
		);
		expect(root.textContent).toContain("project shadow warning, verbatim");
		expect(root.querySelector(".scoped-models-order")?.textContent).toContain("openai/gpt");
		expect(root.querySelector(".scoped-models-order")?.textContent).not.toContain("anthropic/sonnet");
		expect(modelCheckbox(root, "gpt").checked).toBe(true);
		expect(modelCheckbox(root, "sonnet").checked).toBe(false);
		expect(root.textContent).not.toContain("unsaved changes");

		modelCheckbox(root, "sonnet").click();
		expect(root.textContent).toContain("unsaved changes");
		button(root, "reset").click();
		expect(modelCheckbox(root, "gpt").checked).toBe(true);
		expect(modelCheckbox(root, "sonnet").checked).toBe(false);
		expect(root.textContent).not.toContain("unsaved changes");
	});

	it.each(["settings", "inventory"] as const)(
		"shows initial %s load failures verbatim without exposing controls",
		async (failure) => {
			const message = `${failure} unavailable`;
			if (failure === "settings") apiMocks.settings.mockRejectedValue(new Error(message));
			else apiMocks.settingsModels.mockRejectedValue(new Error(message));

			const root = mount();
			await flush();

			expect(root.textContent).toContain(message);
			expect(root.querySelector(".scoped-models-grid")).toBeNull();
			expect(
				[...root.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "save"),
			).toBe(false);
			expect(apiMocks.saveSettings).not.toHaveBeenCalled();
		},
	);

	it.each(["settings", "inventory"] as const)(
		"hides stale project controls when the next context's %s load fails",
		async (failure) => {
			const projectA = snapshot({
				enabledModels: ["anthropic/sonnet"],
				enabledModelsSource: "project",
				hasProjectEnabledModelsOverride: true,
				resolvedScopedModels: [{ provider: "anthropic", id: "sonnet" }],
			});
			const message = `project b ${failure} unavailable`;
			apiMocks.settings.mockImplementation((cwd?: string) =>
				cwd === "/project/b" && failure === "settings"
					? Promise.reject(new Error(message))
					: Promise.resolve(projectA),
			);
			apiMocks.settingsModels.mockImplementation((cwd?: string) =>
				cwd === "/project/b" && failure === "inventory"
					? Promise.reject(new Error(message))
					: Promise.resolve({ models }),
			);

			const [cwd, setCwd] = createSignal<string | undefined>("/project/a");
			const root = document.createElement("div");
			document.body.append(root);
			disposers.push(
				render(
					() => (
						<ScopedModelsEditor cwd={cwd()} projectRoots={["/project/a", "/project/b"]} onCwdChange={setCwd} />
					),
					root,
				),
			);
			await flush();

			modelCheckbox(root, "gpt").click();
			expect(root.textContent).toContain("unsaved changes");
			expect(root.textContent).toContain("shadows global writes");

			setCwd("/project/b");
			await flush();

			expect(root.textContent).toContain(message);
			expect(root.querySelector(".scoped-models-grid")).toBeNull();
			expect(root.textContent).not.toContain("unsaved changes");
			expect(root.textContent).not.toContain("shadows global writes");
			expect(
				[...root.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "save"),
			).toBe(false);
			expect(apiMocks.saveSettings).not.toHaveBeenCalled();
		},
	);

	it("hides stale controls and status while a different project context loads", async () => {
		const projectA = snapshot({
			enabledModels: ["anthropic/sonnet"],
			enabledModelsSource: "project",
			hasProjectEnabledModelsOverride: true,
			resolvedScopedModels: [{ provider: "anthropic", id: "sonnet" }],
		});
		const projectB = snapshot({
			enabledModels: ["openai/gpt"],
			enabledModelsSource: "project",
			hasProjectEnabledModelsOverride: true,
			resolvedScopedModels: [{ provider: "openai", id: "gpt" }],
		});
		let resolveSettingsB!: (settings: SettingsDto) => void;
		let resolveModelsB!: (inventory: { models: ModelInfoDto[] }) => void;
		apiMocks.settings.mockImplementation((cwd?: string) =>
			cwd === "/project/b"
				? new Promise<SettingsDto>((resolve) => {
						resolveSettingsB = resolve;
					})
				: Promise.resolve(projectA),
		);
		apiMocks.settingsModels.mockImplementation((cwd?: string) =>
			cwd === "/project/b"
				? new Promise<{ models: ModelInfoDto[] }>((resolve) => {
						resolveModelsB = resolve;
					})
				: Promise.resolve({ models }),
		);
		apiMocks.saveSettings.mockResolvedValueOnce({
			...projectA,
			warnings: ["warning from project a"],
		});

		const [cwd, setCwd] = createSignal<string | undefined>("/project/a");
		const root = document.createElement("div");
		document.body.append(root);
		disposers.push(
			render(
				() => <ScopedModelsEditor cwd={cwd()} projectRoots={["/project/a", "/project/b"]} onCwdChange={setCwd} />,
				root,
			),
		);
		await flush();

		modelCheckbox(root, "gpt").click();
		button(root, "save").click();
		await flush();
		expect(root.textContent).toContain("warning from project a");
		modelCheckbox(root, "opus").click();
		expect(root.textContent).toContain("unsaved changes");

		setCwd("/project/b");
		await Promise.resolve();
		expect(root.textContent).toContain("Loading scoped models");
		expect(root.querySelector(".scoped-models-grid")).toBeNull();
		expect(root.textContent).not.toContain("warning from project a");
		expect(root.textContent).not.toContain("unsaved changes");

		resolveSettingsB(projectB);
		resolveModelsB({ models });
		await flush();
		expect(modelCheckbox(root, "gpt").checked).toBe(true);
		expect(modelCheckbox(root, "sonnet").checked).toBe(false);
		expect(root.querySelector(".scoped-models-order")?.textContent).toContain("openai/gpt");
	});

	it("shows a loud no-inventory state and cannot save", async () => {
		apiMocks.settingsModels.mockResolvedValue({ models: [] });
		const root = mount();
		await flush();
		expect(root.textContent).toContain("No available models were reported for this context");
		expect(button(root, "save").disabled).toBe(true);
		expect(apiMocks.saveSettings).not.toHaveBeenCalled();
	});

	it("filters by provider/name and reports context selection", async () => {
		const onCwdChange = vi.fn();
		const root = mount({ onCwdChange });
		await flush();
		const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
		search.value = "GPT";
		search.dispatchEvent(new InputEvent("input", { bubbles: true }));
		expect(root.querySelectorAll(".scoped-model-choice")).toHaveLength(1);

		const select = root.querySelector<HTMLSelectElement>(".scoped-models-context select")!;
		select.value = "/project/b";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		expect(onCwdChange).toHaveBeenCalledWith("/project/b");
	});
});
