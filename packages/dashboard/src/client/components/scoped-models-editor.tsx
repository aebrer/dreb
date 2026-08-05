import { createEffect, createMemo, createResource, createSignal, For, type JSX, Show } from "solid-js";
import type { ModelInfoDto, SettingsDto, SettingsSaveResultDto } from "../../shared/protocol.js";
import { api } from "../api.js";

function modelKey(model: Pick<ModelInfoDto, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function groupedModels(models: ModelInfoDto[]): Array<{ provider: string; models: ModelInfoDto[] }> {
	const groups = new Map<string, ModelInfoDto[]>();
	for (const model of models) {
		const group = groups.get(model.provider) ?? [];
		group.push(model);
		groups.set(model.provider, group);
	}
	return [...groups].map(([provider, providerModels]) => ({ provider, models: providerModels }));
}

export interface ScopedModelsEditorProps {
	cwd?: string;
	projectRoots: string[];
	onCwdChange: (cwd: string | undefined) => void;
	focused?: boolean;
}

export function ScopedModelsEditor(props: ScopedModelsEditorProps): JSX.Element {
	const [query, setQuery] = createSignal("");
	const [implicitAll, setImplicitAll] = createSignal(true);
	const [ordered, setOrdered] = createSignal<string[]>([]);
	const [dirty, setDirty] = createSignal(false);
	const [saving, setSaving] = createSignal(false);
	const [saved, setSaved] = createSignal(false);
	const [saveError, setSaveError] = createSignal<string>();
	const [saveWarnings, setSaveWarnings] = createSignal<string[]>([]);
	let section: HTMLElement | undefined;
	let appliedSettings: SettingsDto | undefined;

	const [data, { mutate }] = createResource(
		() => props.cwd ?? "",
		async (cwd) => {
			const context = cwd || undefined;
			const [settings, inventory] = await Promise.all([api.settings(context), api.settingsModels(context)]);
			return { settings, models: inventory.models };
		},
	);

	function applySnapshot(settings: SettingsDto, models: ModelInfoDto[]): void {
		const all = settings.enabledModels === undefined;
		setImplicitAll(all);
		setOrdered(
			all ? models.map(modelKey) : settings.resolvedScopedModels.map((model) => `${model.provider}/${model.id}`),
		);
		setDirty(false);
		setSaveError(undefined);
	}

	createEffect(() => {
		const loaded = data();
		if (!loaded || loaded.settings === appliedSettings) return;
		appliedSettings = loaded.settings;
		applySnapshot(loaded.settings, loaded.models);
	});

	createEffect(() => {
		if (!props.focused || !section) return;
		section.scrollIntoView({ block: "start" });
		section.focus({ preventScroll: true });
	});

	const selected = createMemo(() => new Set(ordered()));
	const projectRoots = createMemo(() => {
		const roots = new Set(props.projectRoots);
		if (props.cwd) roots.add(props.cwd);
		return [...roots].sort((a, b) => a.localeCompare(b));
	});
	const filteredGroups = createMemo(() => {
		const q = query().trim().toLowerCase();
		const models = data()?.models ?? [];
		return groupedModels(
			models.filter((model) => !q || `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(q)),
		);
	});
	const validationError = createMemo(() => {
		if ((data()?.models.length ?? 0) === 0) return "No available models were reported for this context.";
		if (!implicitAll() && ordered().length === 0) return "At least one model must remain enabled.";
		return undefined;
	});
	const normalizationNotice = createMemo(() => {
		const settings = data()?.settings;
		if (!settings?.enabledModels) return undefined;
		const canonical = settings.resolvedScopedModels.map((model) => `${model.provider}/${model.id}`);
		const alreadyCanonical =
			settings.enabledModels.length === canonical.length &&
			settings.enabledModels.every((pattern, index) => pattern === canonical[index]);
		return alreadyCanonical && settings.scopeWarnings.length === 0
			? undefined
			: "Saving an edited legacy scope replaces patterns and per-pattern thinking suffixes with exact provider/model references.";
	});

	function markPartial(next: string[]): void {
		const inventory = data()?.models.map(modelKey) ?? [];
		const allSelected = inventory.length > 0 && inventory.every((key) => next.includes(key));
		setImplicitAll(allSelected);
		setOrdered(allSelected ? inventory : next);
		setDirty(true);
		setSaved(false);
		setSaveError(undefined);
	}

	function toggleModel(key: string): void {
		const current = implicitAll() ? (data()?.models.map(modelKey) ?? []) : ordered();
		markPartial(current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
	}

	function toggleProvider(provider: string): void {
		const keys = (data()?.models ?? []).filter((model) => model.provider === provider).map(modelKey);
		const current = implicitAll() ? (data()?.models.map(modelKey) ?? []) : ordered();
		const remove = keys.every((key) => current.includes(key));
		markPartial(
			remove
				? current.filter((key) => !keys.includes(key))
				: [...current, ...keys.filter((key) => !current.includes(key))],
		);
	}

	function move(index: number, delta: -1 | 1): void {
		if (implicitAll()) return;
		const target = index + delta;
		if (target < 0 || target >= ordered().length) return;
		const next = [...ordered()];
		[next[index], next[target]] = [next[target]!, next[index]!];
		setOrdered(next);
		setDirty(true);
		setSaved(false);
	}

	function reset(): void {
		const loaded = data();
		if (!loaded) return;
		applySnapshot(loaded.settings, loaded.models);
		setSaveWarnings([]);
		setSaved(false);
	}

	async function save(): Promise<void> {
		if (!dirty() || validationError()) return;
		setSaving(true);
		setSaveError(undefined);
		setSaveWarnings([]);
		setSaved(false);
		const saveCwd = props.cwd;
		try {
			const result: SettingsSaveResultDto = await api.saveSettings(
				{ enabledModels: implicitAll() ? null : ordered() },
				saveCwd,
			);
			if (props.cwd !== saveCwd) return;
			const loaded = data();
			if (loaded) {
				appliedSettings = result;
				mutate({ settings: result, models: loaded.models });
				applySnapshot(result, loaded.models);
			}
			setSaveWarnings(result.warnings ?? []);
			setSaved(true);
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	}

	return (
		<section
			class="settings-section scoped-models-editor"
			ref={section}
			tabIndex={-1}
			aria-labelledby="scoped-models-heading"
		>
			<h2 id="scoped-models-heading">scoped models</h2>
			<p class="muted small">
				Controls model cycling for new sessions only; running sessions are never changed. Writes always update
				global settings, while the selected context shows effective global-plus-project settings.
			</p>
			<label class="scoped-models-context">
				<span>project context</span>
				<select
					value={props.cwd ?? ""}
					onChange={(event) => props.onCwdChange(event.currentTarget.value || undefined)}
				>
					<option value="">global / home</option>
					<For each={projectRoots()}>{(root) => <option value={root}>{root}</option>}</For>
				</select>
			</label>

			<Show when={data.error}>
				<div class="settings-error">{data.error instanceof Error ? data.error.message : String(data.error)}</div>
			</Show>
			<Show when={data.loading}>
				<p class="muted">Loading scoped models…</p>
			</Show>
			<Show when={data()}>
				{(loaded) => (
					<>
						<Show when={loaded().settings.hasProjectEnabledModelsOverride}>
							<div class="settings-warning">
								This project defines enabledModels in .dreb/settings.json and shadows global writes.
							</div>
						</Show>
						<Show when={normalizationNotice()}>{(notice) => <div class="settings-warning">{notice()}</div>}</Show>
						<For each={loaded().settings.scopeWarnings}>
							{(warning) => <div class="settings-warning">{warning.message}</div>}
						</For>
						<For each={saveWarnings()}>{(warning) => <div class="settings-warning">{warning}</div>}</For>
						<Show when={saveError()}>{(message) => <div class="settings-error">{message()}</div>}</Show>
						<Show when={validationError()}>{(message) => <div class="settings-error">{message()}</div>}</Show>

						<div class="scoped-models-toolbar">
							<input
								type="search"
								aria-label="Search available models"
								placeholder="search provider, model, or name…"
								value={query()}
								onInput={(event) => setQuery(event.currentTarget.value)}
							/>
							<button
								type="button"
								class="btn btn-small"
								disabled={implicitAll()}
								onClick={() => markPartial(loaded().models.map(modelKey))}
							>
								enable all
							</button>
						</div>

						<div class="scoped-models-grid">
							<div class="scoped-models-order">
								<h3>cycling order</h3>
								<p class="muted small">
									{implicitAll()
										? "All available models, in registry order (future models included)."
										: `${ordered().length} enabled model${ordered().length === 1 ? "" : "s"}.`}
								</p>
								<For each={ordered()}>
									{(key, index) => (
										<div class="scoped-model-order-row">
											<span title={key}>{key}</span>
											<div class="scoped-model-move-controls">
												<button
													type="button"
													aria-label={`Move ${key} up`}
													disabled={implicitAll() || index() === 0}
													onClick={() => move(index(), -1)}
												>
													↑
												</button>
												<button
													type="button"
													aria-label={`Move ${key} down`}
													disabled={implicitAll() || index() === ordered().length - 1}
													onClick={() => move(index(), 1)}
												>
													↓
												</button>
											</div>
										</div>
									)}
								</For>
							</div>

							<div class="scoped-models-available">
								<h3>available models</h3>
								<Show
									when={filteredGroups().length > 0}
									fallback={<p class="muted small">No matching models.</p>}
								>
									<For each={filteredGroups()}>
										{(group) => (
											<section class="scoped-model-provider">
												<label class="scoped-model-provider-heading">
													<input
														type="checkbox"
														checked={(data()?.models ?? [])
															.filter((model) => model.provider === group.provider)
															.every((model) => selected().has(modelKey(model)))}
														onChange={() => toggleProvider(group.provider)}
													/>
													<span>{group.provider}</span>
												</label>
												<For each={group.models}>
													{(model) => {
														const key = modelKey(model);
														return (
															<label class="scoped-model-choice" title={key}>
																<input
																	type="checkbox"
																	checked={selected().has(key)}
																	onChange={() => toggleModel(key)}
																/>
																<span class="model-id">{model.id}</span>
																<Show when={model.name}>
																	<span class="model-name">{model.name}</span>
																</Show>
															</label>
														);
													}}
												</For>
											</section>
										)}
									</For>
								</Show>
							</div>
						</div>

						<div class="scoped-models-actions">
							<button type="button" class="btn btn-small" disabled={!dirty() || saving()} onClick={reset}>
								reset
							</button>
							<button
								type="button"
								class="btn btn-primary btn-small"
								disabled={!dirty() || saving() || Boolean(validationError())}
								onClick={() => void save()}
							>
								{saving() ? "saving…" : "save"}
							</button>
							<Show when={dirty()}>
								<span class="muted small">unsaved changes</span>
							</Show>
							<Show when={saved()}>
								<span class="muted small">✓ saved</span>
							</Show>
						</div>
					</>
				)}
			</Show>
		</section>
	);
}
